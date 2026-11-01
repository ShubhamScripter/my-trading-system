import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { EmailChangeController } from '../../../src/settings/email/email.controller';
import type { EmailChangeService } from '../../../src/settings/email/email.service';
import { makePrincipal } from '../../harness';
import { FACTS } from '../../restrictions/double';

/**
 * ═══ THE PUBLIC-ROUTE BOUNDARY ══════════════════════════════════════════════
 *
 * `POST /settings/security/email` and its `/verify` sibling are the only `@Public()`
 * routes in `src/settings/`. They have to be: a completed email change sweeps every
 * session and the released address cannot sign in, so the person the recovery flow
 * exists for is precisely the person who cannot authenticate.
 *
 * The cost is that authentication moves out of the guard and into the controller, per
 * branch. That makes this file the one that matters most in the whole feature — a branch
 * that forgot `requireCaller` would be an unauthenticated email change, and it would
 * look exactly like a working one in every other test.
 *
 * So every non-recovery action is asserted to REFUSE a null principal, and every
 * recovery action is asserted to ignore a present one. Both directions, because both are
 * bugs: a change reachable without a session, and a recovery whose behaviour a session
 * could influence.
 *
 * The service is doubled wholesale. Nothing here is about policy — it is about which
 * branch reaches the service at all.
 */

const PRINCIPAL = makePrincipal();
const IP = '203.0.113.7';
const IP_CLASS = '203.0.113.0/24';

const STARTED = {
  challengeId: 'ch-1',
  userId: PRINCIPAL.userId,
  familyId: PRINCIPAL.familyId,
  newEmail: 'New@example.test',
  newEmailLower: 'new@example.test',
  method: 'none' as const,
  requiredTargets: ['current', 'new'] as const,
  retainedEmailLower: null,
  skippedRetained: false,
  expiresInSeconds: 1800,
};

const RECOVERY_STARTED = {
  challengeId: 'rc-1',
  retainedEmailId: 'ret-a',
  userId: PRINCIPAL.userId,
  intent: 'restore' as const,
  targetEmail: 'Old@example.test',
  targetEmailLower: 'old@example.test',
  reportedCompromise: false,
  expiresInSeconds: 1800,
};

let service: {
  status: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  resend: ReturnType<typeof vi.fn>;
  recoverStart: ReturnType<typeof vi.fn>;
  verifyChange: ReturnType<typeof vi.fn>;
  verifyRecovery: ReturnType<typeof vi.fn>;
};
let controller: EmailChangeController;

beforeEach(() => {
  service = {
    status: vi.fn(async () => ({})),
    start: vi.fn(async () => STARTED),
    resend: vi.fn(async () => undefined),
    recoverStart: vi.fn(async () => RECOVERY_STARTED),
    verifyChange: vi.fn(async () => ({ email: 'New@example.test' })),
    verifyRecovery: vi.fn(async () => ({ email: 'Old@example.test', intent: 'restore' })),
  };
  controller = new EmailChangeController(service as unknown as EmailChangeService);
});

const problem = async (run: Promise<unknown>): Promise<ProblemException> => {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the call to be refused');
};

// ─── the branches that REQUIRE a session ────────────────────────────────────

describe('a change is not reachable without a session', () => {
  it('refuses `start` with no principal', async () => {
    const err = await problem(
      controller.mutate(
        { action: 'start', newEmail: 'new@example.test', method: 'none' },
        null,
        IP,
        FACTS.ipClass,
      ),
    );

    expect(err.type).toBe(ERR.UNAUTHENTICATED);
    expect(service.start).not.toHaveBeenCalled();
  });

  it('refuses `resend` with no principal', async () => {
    const err = await problem(
      controller.mutate(
        { action: 'resend', challengeId: 'ch-1', target: 'new' },
        null,
        IP,
        FACTS.ipClass,
      ),
    );

    expect(err.type).toBe(ERR.UNAUTHENTICATED);
    expect(service.resend).not.toHaveBeenCalled();
  });

  it('refuses a change `verify` with no principal', async () => {
    const err = await problem(
      controller.verify(
        {
          challengeId: 'ch-1',
          currentEmailCode: '111111',
          newEmailCode: '222222',
          method: 'none',
        },
        null,
        IP,
        FACTS,
      ),
    );

    expect(err.type).toBe(ERR.UNAUTHENTICATED);
    expect(service.verifyChange).not.toHaveBeenCalled();
  });

  it('passes the principal straight through when there IS one', async () => {
    await controller.mutate(
      { action: 'start', newEmail: 'new@example.test', method: 'none' },
      PRINCIPAL,
      IP,
      FACTS.ipClass,
    );

    expect(service.start).toHaveBeenCalledWith(PRINCIPAL, IP, expect.any(Object));
  });
});

// ─── the branches that must NOT read a session ──────────────────────────────

describe('a recovery does not read a session, even when one is present', () => {
  it('starts a recovery with no principal at all', async () => {
    const result = await controller.mutate(
      { action: 'recover-start', recoveryId: 'token', intent: 'restore' },
      null,
      IP,
      FACTS.ipClass,
    );

    expect(result.data.outcome).toBe('email_recovery_started');
    expect(service.recoverStart).toHaveBeenCalledWith(IP, FACTS.ipClass, expect.any(Object));
  });

  it('completes a recovery with no principal at all', async () => {
    const result = await controller.verify(
      { recoveryId: 'token', retainedEmailCode: '111111' },
      null,
      IP,
      FACTS,
    );

    expect(result.data.outcome).toBe('email_recovered');
  });

  it('never hands the service a principal on the recovery path', async () => {
    // ═══ THE OTHER DIRECTION ══════════════════════════════════════════════════
    //
    // A session must not be able to influence a ceremony authorised by a mailed ticket.
    // The simplest guarantee is that the code path does not have access to one, and this
    // asserts the argument list rather than trusting the comment.
    await controller.mutate(
      { action: 'recover-start', recoveryId: 'token', intent: 'restore' },
      PRINCIPAL,
      IP,
      FACTS.ipClass,
    );
    await controller.verify(
      { recoveryId: 'token', retainedEmailCode: '111111' },
      PRINCIPAL,
      IP,
      FACTS,
    );

    for (const call of service.recoverStart.mock.calls as unknown[][]) {
      expect(call).not.toContain(PRINCIPAL);
    }
    for (const call of service.verifyRecovery.mock.calls as unknown[][]) {
      expect(call).not.toContain(PRINCIPAL);
    }
  });

  it('routes a body carrying `recoveryId` to the recovery path, never to the change path', async () => {
    await controller.verify(
      { recoveryId: 'token', retainedEmailCode: '111111' },
      PRINCIPAL,
      IP,
      FACTS,
    );

    expect(service.verifyRecovery).toHaveBeenCalled();
    expect(service.verifyChange).not.toHaveBeenCalled();
  });
});

// ─── the request cannot smuggle an account ──────────────────────────────────

describe('nothing in a request body names an account', () => {
  it('refuses a `start` carrying a userId, rather than honouring it', async () => {
    // `.strict()` on every DTO member is what makes this structural. An unknown key is a
    // validation error, not a silently stripped field — so a client cannot even express
    // the request that would need checking.
    const err = await problem(
      controller.mutate(
        {
          action: 'start',
          newEmail: 'new@example.test',
          method: 'none',
          userId: 'someone-else',
        },
        PRINCIPAL,
        IP,
        FACTS.ipClass,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
    expect(service.start).not.toHaveBeenCalled();
  });

  it('refuses a recovery carrying a userId', async () => {
    const err = await problem(
      controller.mutate(
        {
          action: 'recover-start',
          recoveryId: 'token',
          intent: 'restore',
          userId: 'someone-else',
        },
        null,
        IP,
        FACTS.ipClass,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
    expect(service.recoverStart).not.toHaveBeenCalled();
  });
});

// ─── what the responses disclose ────────────────────────────────────────────

describe('what crosses the wire', () => {
  it('masks the address in every payload', async () => {
    const started = await controller.mutate(
      { action: 'start', newEmail: 'New@example.test', method: 'none' },
      PRINCIPAL,
      IP,
      FACTS.ipClass,
    );
    const changed = await controller.verify(
      {
        challengeId: 'ch-1',
        currentEmailCode: '111111',
        newEmailCode: '222222',
        method: 'none',
      },
      PRINCIPAL,
      IP,
      FACTS,
    );

    expect(JSON.stringify(started)).not.toContain('New@example.test');
    expect(JSON.stringify(changed)).not.toContain('New@example.test');
  });

  it('masks the target of a recovery, which is returned to an unauthenticated caller', async () => {
    const started = await controller.mutate(
      { action: 'recover-start', recoveryId: 'token', intent: 'restore' },
      null,
      IP,
      FACTS.ipClass,
    );

    expect(JSON.stringify(started)).not.toContain('Old@example.test');
  });

  it('states that sessions were revoked rather than leaving a client to assume', async () => {
    const changed = await controller.verify(
      {
        challengeId: 'ch-1',
        currentEmailCode: '111111',
        newEmailCode: '222222',
        method: 'none',
      },
      PRINCIPAL,
      IP,
      FACTS,
    );

    expect(changed.data).toMatchObject({ otherSessionsRevoked: true });
  });
});

// ─── the DTO refusals that protect the tiers ────────────────────────────────

describe('conflicting proofs are refused at the door', () => {
  it.each([
    ['a password beside a passkey', { method: 'passkey', passkey: { id: 'x' }, password: 'p' }],
    ['a TOTP code beside a password', { method: 'password', password: 'p', totpCode: '123456' }],
    ['a proof on the "none" tier', { method: 'none', password: 'p' }],
  ])('refuses %s', async (_label, proof) => {
    const err = await problem(
      controller.verify(
        {
          challengeId: 'ch-1',
          currentEmailCode: '111111',
          newEmailCode: '222222',
          ...proof,
        },
        PRINCIPAL,
        IP,
        FACTS,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
    expect(service.verifyChange).not.toHaveBeenCalled();
  });

  it('refuses a replace recovery with no replacement address', async () => {
    const err = await problem(
      controller.mutate(
        { action: 'recover-start', recoveryId: 'token', intent: 'replace' },
        null,
        IP,
        FACTS.ipClass,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
  });

  it('refuses a restore recovery that names one', async () => {
    // Refused rather than ignored: a caller sending it believes the account will end up
    // somewhere it will not.
    const err = await problem(
      controller.mutate(
        {
          action: 'recover-start',
          recoveryId: 'token',
          intent: 'restore',
          newEmail: 'third@example.test',
        },
        null,
        IP,
        FACTS.ipClass,
      ),
    );

    expect(err.type).toBe(ERR.VALIDATION_FAILED);
  });
});
