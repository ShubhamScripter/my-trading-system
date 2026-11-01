import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../src/http';
import { DEFAULT_RAIN_CONFIG, type RainConfig } from '../../src/social/rain/rain.contract';
import { RainAdminService, formatMinor } from '../../src/social/rain/rain-admin.service';

/**
 * The admin side of RainPool: settings, ON / OFF / MAINTAIN, the manual admin verification, reverts and the Rainpool
 * trigger. The database layer is a fake; money is never moved here, only queued.
 */
const ADMIN = '0192f6a0-0000-7000-8000-00000000aa01';
const USER = '0192f6a0-0000-7000-8000-00000000bb01';
const RAIN = '0192f6a0-0000-7000-8000-00000000dd01';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose fakes of the database layers
type Fake = any;

async function problem(run: () => Promise<unknown>): Promise<ProblemException> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ProblemException) return err;
    throw err;
  }
  throw new Error('expected a problem');
}

function configWith(patch: (c: RainConfig) => void): RainConfig {
  const c = structuredClone(DEFAULT_RAIN_CONFIG);
  patch(c);
  return c;
}

function run(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: RAIN,
    kind: 'USER',
    status,
    roomId: 'room',
    roomName: 'Global',
    initiatorId: USER,
    initiator: 'bob',
    currency: 'BTC',
    potMinor: 100_000_000n,
    feeMinor: 2_000_000n,
    distributableMinor: 98_000_000n,
    usdValueMinor: null,
    recipientCount: 5,
    requestedRecipients: 5,
    recipientRule: { mode: 'SPECIFIC', count: 5 },
    repeatCount: null,
    repeatGapSeconds: null,
    security: { tier: 3, reasons: ['VPN_PROXY'], manual: true, stage: 'INITIAL' },
    rewards: null,
    reverseReason: null,
    reverseDetail: null,
    reversedAt: null,
    verifyExpiresAt: null,
    createdAt: new Date('2026-10-20T10:00:00Z'),
    ...extra,
  };
}

describe('RainAdminService', () => {
  let db: Fake;
  let moderation: Fake;
  let service: RainAdminService;
  let stored: RainConfig;

  beforeEach(() => {
    stored = structuredClone(DEFAULT_RAIN_CONFIG);
    db = {
      config: vi.fn(async () => ({ document: stored, version: 3, updatedAt: new Date() })),
      saveConfig: vi.fn().mockResolvedValue(4),
      clearSchedule: vi.fn().mockResolvedValue(undefined),
      patchStatus: vi.fn().mockResolvedValue({ before: stored.status, after: { ...stored.status, system: 'ON' } }),
      run: vi.fn(),
      requestFromUser: vi.fn().mockResolvedValue(true),
      enqueue: vi.fn().mockResolvedValue('job-1'),
      openJob: vi.fn().mockResolvedValue(false),
      countMatching: vi.fn().mockResolvedValue({ rains: 3, potMinorByCurrency: { BTC: '150000000' } }),
      isPast: vi.fn().mockResolvedValue(false),
      scheduleStatus: vi.fn().mockResolvedValue('change-1'),
      audit: vi.fn().mockResolvedValue(undefined),
      setDevPrice: vi.fn().mockResolvedValue(undefined),
      devPrices: vi.fn().mockResolvedValue([]),
    };
    moderation = {
      resolveUserId: vi.fn(async (handle: string) => (handle === 'bob' ? USER : null)),
      recordModerationAction: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn().mockResolvedValue(undefined),
    };
    service = new RainAdminService(db, moderation);
  });

  describe('RainPool Settings', () => {
    it('refuses a document the contract refuses, with the path of each problem', async () => {
      const bad = configWith((c) => (c.system.amountUsd = { min: '10', max: '1' }));
      const err = await problem(() => service.saveSettings({ config: bad }, ADMIN));
      expect(err.type).toBe('validation_failed');
      expect(db.saveConfig).not.toHaveBeenCalled();
    });

    it('saves, re-picks the next rain when the Rainpool section changed, and tells the chat server', async () => {
      const next = configWith((c) => (c.system.currencies = ['BTC']));
      await service.saveSettings({ config: next, expectedVersion: 3 }, ADMIN);
      expect(db.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ system: expect.objectContaining({ currencies: ['BTC'] }) }), 3);
      expect(db.clearSchedule).toHaveBeenCalled();
      expect(moderation.notify).toHaveBeenCalledWith({ kind: 'rain' });
      expect(moderation.recordModerationAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'RAIN_SETTINGS' }));
    });

    it('keeps the next rain when only the user rain section changed', async () => {
      const next = configWith((c) => (c.user.feePercent = 5));
      await service.saveSettings({ config: next }, ADMIN);
      expect(db.clearSchedule).not.toHaveBeenCalled();
    });

    it('refuses a save over a newer version', async () => {
      db.saveConfig.mockResolvedValue(null);
      const err = await problem(() => service.saveSettings({ config: stored, expectedVersion: 2 }, ADMIN));
      expect(err.detail).toMatch(/Another admin/);
    });
  });

  describe('ON / OFF / MAINTAIN', () => {
    it('switches a status now and tells the chat server', async () => {
      await service.setStatus({ system: 'ON' }, ADMIN);
      expect(db.patchStatus).toHaveBeenCalledWith({ system: 'ON' });
      expect(moderation.notify).toHaveBeenCalledWith({ kind: 'rain' });
    });

    it('schedules a change only in the future', async () => {
      await service.scheduleStatus({ applyAt: '2030-01-01T00:00:00Z', patch: { overall: 'MAINTENANCE', note: 'Upgrade' } }, ADMIN);
      expect(db.scheduleStatus).toHaveBeenCalledWith('2030-01-01T00:00:00Z', { overall: 'MAINTENANCE', note: 'Upgrade' }, ADMIN);
      db.isPast.mockResolvedValue(true);
      expect((await problem(() => service.scheduleStatus({ applyAt: '2020-01-01T00:00:00Z', patch: { user: 'OFF' } }, ADMIN))).type).toBe(
        'validation_failed',
      );
      expect((await problem(() => service.scheduleStatus({ applyAt: '2030-01-01T00:00:00Z', patch: {} }, ADMIN))).type).toBe(
        'validation_failed',
      );
    });
  });

  describe('MANUAL Admin Verification', () => {
    beforeEach(() => {
      stored = configWith((c) => {
        c.security.vpnProxy = { enabled: true, amountAboveUsd: null, questionnaire: 'MANUAL', kycCheck: 'MANUAL' };
        c.security.questions = [{ text: 'Is it your money?', options: ['Yes', 'No'], okOptions: [0] }];
        c.security.kycMinLevel = 2;
      });
    });

    it('approve and reject are queued for the chat server, only for a rain waiting for review', async () => {
      db.run.mockResolvedValue(run('PENDING_REVIEW'));
      expect(await service.approve({ rainId: RAIN }, ADMIN)).toEqual({ queued: true, jobId: 'job-1' });
      expect(db.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'APPROVE', rainId: RAIN }));
      await service.reject({ rainId: RAIN, reason: 'Looks like fraud' }, ADMIN);
      expect(db.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'REJECT', reason: 'Looks like fraud' }));
      db.run.mockResolvedValue(run('COMPLETED'));
      expect((await problem(() => service.approve({ rainId: RAIN }, ADMIN))).type).toBe('forbidden');
    });

    it('a double click queues nothing the second time', async () => {
      db.run.mockResolvedValue(run('PENDING_REVIEW'));
      db.enqueue.mockResolvedValue(null);
      expect((await problem(() => service.approve({ rainId: RAIN }, ADMIN))).detail).toMatch(/already waiting/);
    });

    it('sends the questionnaire and a KYC check to the user (Manual Trigger) and notifies them', async () => {
      db.run.mockResolvedValue(run('PENDING_REVIEW'));
      await service.requestVerification({ rainId: RAIN, questionnaire: true, kyc: true }, ADMIN);
      const [, security, ttl] = db.requestFromUser.mock.calls[0];
      expect(security).toMatchObject({
        stage: 'ADMIN_REQUEST',
        twoFa: false,
        email: false,
        kycLevel: 2,
        manual: true,
        questions: [{ text: 'Is it your money?' }],
      });
      expect(ttl).toBe(24 * 60 * 60);
      expect(moderation.notify).toHaveBeenCalledWith({ kind: 'rain_request', userId: USER, rainId: RAIN });
    });

    it('refuses a questionnaire or KYC check that is switched off', async () => {
      stored = configWith((c) => (c.security.vpnProxy = { enabled: true, amountAboveUsd: null, questionnaire: 'OFF', kycCheck: 'OFF' }));
      db.run.mockResolvedValue(run('PENDING_REVIEW'));
      expect((await problem(() => service.requestVerification({ rainId: RAIN, questionnaire: true }, ADMIN))).type).toBe('forbidden');
      expect((await problem(() => service.requestVerification({ rainId: RAIN, kyc: true }, ADMIN))).type).toBe('forbidden');
      expect((await problem(() => service.requestVerification({ rainId: RAIN }, ADMIN))).type).toBe('validation_failed');
    });
  });

  describe('Revert Specific Rains', () => {
    it('queues one rain with its refund and shortfall policy', async () => {
      db.run.mockResolvedValue(run('COMPLETED'));
      await service.revert({ rainId: RAIN, reason: 'Duplicate rain event', payerRefund: 'NONE', shortfall: 'NEGATIVE' }, ADMIN);
      expect(db.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'REVERT', rainId: RAIN, payerRefund: 'NONE', shortfall: 'NEGATIVE' }),
      );
      // Missing reason is rejected (V2-01)
      expect((await problem(() => service.revert({ rainId: RAIN, payerRefund: 'NONE', shortfall: 'NEGATIVE' }, ADMIN))).type).toBe('validation_failed');
      db.run.mockResolvedValue(run('REJECTED'));
      expect((await problem(() => service.revert({ rainId: RAIN, reason: 'Test reason', payerRefund: 'REFUND', shortfall: 'ZERO' }, ADMIN))).type).toBe(
        'forbidden',
      );
    });

    it('counts a bulk filter on a dry run and queues it otherwise, with users named by handle', async () => {
      const body = {
        kind: 'USER',
        from: '2026-10-01T00:00:00Z',
        to: '2026-10-02T00:00:00Z',
        currencies: ['btc'],
        who: { role: 'RECIPIENT', users: ['bob'] },
        payerRefund: 'REFUND',
        shortfall: 'ZERO',
        reason: 'Bulk cancellation due to system issue',
      };
      const dry = await service.revertBulk({ ...body, dryRun: true }, ADMIN);
      expect(dry).toMatchObject({ dryRun: true, rains: 3, potByCurrency: { BTC: '1.5' } });
      expect(db.enqueue).not.toHaveBeenCalled();
      await service.revertBulk(body, ADMIN);
      expect(db.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'REVERT',
          rainId: null,
          filter: expect.objectContaining({ currencies: ['BTC'], who: { role: 'RECIPIENT', userIds: [USER], group: null } }),
        }),
      );
      expect((await problem(() => service.revertBulk({ ...body, who: { role: 'RAINER', users: ['nobody'] } }, ADMIN))).type).toBe(
        'not_found',
      );
    });
  });

  describe('Rainpool trigger', () => {
    it('is refused unless Rainpool is ON, and queued once', async () => {
      expect((await problem(() => service.trigger(ADMIN))).detail).toMatch(/not ON/);
      stored = configWith((c) => (c.status.system = 'ON'));
      await service.trigger(ADMIN);
      expect(db.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'MANUAL_SYSTEM' }));
      db.openJob.mockResolvedValue(true);
      expect((await problem(() => service.trigger(ADMIN))).detail).toMatch(/already waiting/);
    });

    it('overall OFF ("Disable Overall Rains") stops a trigger too', async () => {
      stored = configWith((c) => {
        c.status.system = 'ON';
        c.status.overall = 'OFF';
      });
      expect((await problem(() => service.trigger(ADMIN))).detail).toMatch(/not ON/);
    });
  });

  describe('development USD rates', () => {
    it('stores rates and removes one with null, refusing a zero price', async () => {
      await service.setDevPrices({ prices: [{ currency: 'btc', usdPrice: '65000' }, { currency: 'ETH', usdPrice: null }] }, ADMIN);
      expect(db.setDevPrice).toHaveBeenCalledWith('BTC', '65000');
      expect(db.setDevPrice).toHaveBeenCalledWith('ETH', null);
      expect((await problem(() => service.setDevPrices({ prices: [{ currency: 'BTC', usdPrice: '0' }] }, ADMIN))).type).toBe(
        'validation_failed',
      );
    });
  });

  it('formats minor units', () => {
    expect(formatMinor(150_000_000n)).toBe('1.5');
    expect(formatMinor(-1n)).toBe('-0.00000001');
  });
});
