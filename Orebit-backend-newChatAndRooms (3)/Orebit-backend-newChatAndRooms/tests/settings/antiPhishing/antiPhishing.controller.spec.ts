import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { AntiPhishingController } from '../../../src/settings/antiPhishing/antiPhishing.controller';
import { makePrincipal } from '../../harness';

/**
 * Parse, dispatch, serialise — and nothing else.
 *
 * What is worth asserting of a controller in this codebase is that it adds no policy
 * and leaks no secret: the acting account comes from the `Principal` rather than the
 * body, the `action` in the response is the one the SERVER dispatched rather than the
 * one the caller claimed, and the code the caller sent never appears in what comes back.
 */

const PRINCIPAL = makePrincipal();
const IP_CLASS = '203.0.113.0/24';
const CODE = 'Ada1815';

describe('AntiPhishingController', () => {
  let service: {
    status: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    change: ReturnType<typeof vi.fn>;
    replace: ReturnType<typeof vi.fn>;
  };

  const build = () => new AntiPhishingController(service as never);

  beforeEach(() => {
    service = {
      status: vi.fn(async () => ({ configured: false })),
      set: vi.fn(async () => undefined),
      change: vi.fn(async () => undefined),
      replace: vi.fn(async () => undefined),
    };
  });

  describe('status', () => {
    it('wraps the service answer with its outcome', async () => {
      expect(await build().status(PRINCIPAL)).toEqual({
        data: { outcome: 'anti_phishing_code_status', configured: false },
      });
    });

    it('reports configured when the service says so', async () => {
      service.status.mockResolvedValue({ configured: true });

      expect(await build().status(PRINCIPAL)).toEqual({
        data: { outcome: 'anti_phishing_code_status', configured: true },
      });
    });

    it('asks about the principal‘s own account', async () => {
      await build().status(PRINCIPAL);

      expect(service.status).toHaveBeenCalledWith(PRINCIPAL.userId);
    });
  });

  describe('mutate — dispatch', () => {
    it.each([
      ['set', { action: 'set', code: CODE, emailCode: '123456' }],
      ['change', { action: 'change', currentCode: 'Old1815', code: CODE, emailCode: '123456' }],
      ['replace', { action: 'replace', code: CODE, emailCode: '123456' }],
    ])('routes %s to its own service method and echoes that action', async (action, body) => {
      const result = await build().mutate(body, PRINCIPAL, IP_CLASS);

      expect(service[action as 'set' | 'change' | 'replace']).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        data: {
          outcome: 'anti_phishing_code_updated',
          action,
          otherSessionsRevoked: false,
        },
      });
    });

    it('reports otherSessionsRevoked: false as a fact on every action', async () => {
      // Stated rather than left for a client to assume, and false because no session
      // was ever established with an anti-phishing code — so there is nothing a sweep
      // could invalidate.
      for (const body of [
        { action: 'set', code: CODE, emailCode: '123456' },
        { action: 'change', currentCode: 'Old1815', code: CODE, emailCode: '123456' },
        { action: 'replace', code: CODE, emailCode: '123456' },
      ]) {
        const result = await build().mutate(body, PRINCIPAL, IP_CLASS);
        expect(result.data.otherSessionsRevoked).toBe(false);
      }
    });

    it('passes the principal and the ip class through, and no body-supplied account', async () => {
      await build().mutate(
        { action: 'set', code: CODE, emailCode: '123456' },
        PRINCIPAL,
        IP_CLASS,
      );

      expect(service.set).toHaveBeenCalledWith(
        PRINCIPAL,
        IP_CLASS,
        expect.objectContaining({ action: 'set', code: CODE }),
      );
    });
  });

  describe('mutate — validation', () => {
    it('rejects an unknown action before touching the service', async () => {
      await expect(
        build().mutate({ action: 'remove', emailCode: '123456' }, PRINCIPAL, IP_CLASS),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });

      expect(service.set).not.toHaveBeenCalled();
      expect(service.change).not.toHaveBeenCalled();
      expect(service.replace).not.toHaveBeenCalled();
    });

    it('rejects a body claiming its own configured state', async () => {
      // `.strict()` in the DTO is what makes this an error rather than a silently
      // stripped field that leaves the caller believing the server agreed.
      await expect(
        build().mutate(
          { action: 'set', code: CODE, emailCode: '123456', configured: false },
          PRINCIPAL,
          IP_CLASS,
        ),
      ).rejects.toThrow(ProblemException);
    });

    it('rejects a malformed code before touching the service', async () => {
      await expect(
        build().mutate({ action: 'set', code: 'no', emailCode: '123456' }, PRINCIPAL, IP_CLASS),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });

      expect(service.set).not.toHaveBeenCalled();
    });
  });

  describe('what the response never carries', () => {
    it('does not echo the code back on any action', async () => {
      const results = [
        await build().mutate({ action: 'set', code: CODE, emailCode: '123456' }, PRINCIPAL, IP_CLASS),
        await build().mutate(
          { action: 'change', currentCode: 'Old1815', code: CODE, emailCode: '123456' },
          PRINCIPAL,
          IP_CLASS,
        ),
        await build().mutate(
          { action: 'replace', code: CODE, emailCode: '123456' },
          PRINCIPAL,
          IP_CLASS,
        ),
      ];

      // The user sees it in their next email, which is the channel this feature is
      // about. Echoing it here would put it in a browser cache and a proxy log for no
      // benefit.
      expect(JSON.stringify(results)).not.toContain(CODE);
      expect(JSON.stringify(results)).not.toContain('Old1815');
    });

    it('does not echo the emailed code back', async () => {
      const result = await build().mutate(
        { action: 'set', code: CODE, emailCode: '999111' },
        PRINCIPAL,
        IP_CLASS,
      );

      expect(JSON.stringify(result)).not.toContain('999111');
    });
  });
});
