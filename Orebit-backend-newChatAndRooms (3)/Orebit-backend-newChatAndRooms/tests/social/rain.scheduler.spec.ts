import { describe, expect, it, vi } from 'vitest';
import { isMissingRainTableError } from '../../src/social/rain/rain.scheduler';
import { RainSchedulerService } from '../../src/social/rain/rain.scheduler.service';
import { DEFAULT_RAIN_CONFIG } from '../../src/social/rain/rain.contract';
import type { RainJobRow, RainRunRow } from '../../src/social/rain/rain.types';
import { uuidv7 } from '../../src/utils/public.utils';

describe('missing rain table detection', () => {
  it('uses the wrapped PostgreSQL undefined-table code and schema', () => {
    expect(isMissingRainTableError({
      code: 'P2010',
      meta: { code: '42P01', message: 'relation "rain.schedule" does not exist' },
    })).toBe(true);
  });

  it('does not classify an unrelated failure from its message alone', () => {
    expect(isMissingRainTableError(new Error('relation rain.schedule does not exist'))).toBe(false);
    expect(isMissingRainTableError({
      code: 'P2010',
      meta: { code: '57014', message: 'canceling statement' },
    })).toBe(false);
  });
});

describe('manual system rain job retry', () => {
  it('reconciles an existing paid run instead of attempting the payment again', async () => {
    const jobId = uuidv7();
    const roomId = uuidv7();
    const config = structuredClone(DEFAULT_RAIN_CONFIG);
    config.status.overall = 'ON';
    config.status.system = 'ON';
    const run = { id: uuidv7(), kind: 'SYSTEM' } as RainRunRow;
    const db = {
      config: vi.fn().mockResolvedValue(config),
      findByKey: vi.fn().mockResolvedValue(run),
      finishJob: vi.fn().mockResolvedValue(undefined),
      audit: vi.fn().mockResolvedValue(undefined),
    };
    const payout = { afterPaid: vi.fn().mockResolvedValue(undefined) };
    const scheduler = Object.assign(Object.create(RainSchedulerService.prototype), {
      db,
      payout,
    }) as unknown as RainSchedulerService;
    const job: RainJobRow = {
      id: jobId,
      kind: 'MANUAL_SYSTEM',
      rainId: null,
      actorId: uuidv7(),
      reason: null,
      payerRefund: 'REFUND',
      shortfall: 'ZERO',
      filter: null,
      manualSystem: { currency: 'BTC', usdAmount: '5', roomId, recipients: 1 },
    };

    await scheduler.runJob(job);

    expect(db.findByKey).toHaveBeenCalledWith(`manual:${jobId}`);
    expect(payout.afterPaid).toHaveBeenCalledWith(run);
    expect(db.finishJob).toHaveBeenCalledWith(jobId, 'DONE', null);
  });

  it('clears an old scheduled pot when system rain is turned OFF', async () => {
    const config = structuredClone(DEFAULT_RAIN_CONFIG);
    config.status.system = 'OFF';
    const db = {
      config: vi.fn().mockResolvedValue(config),
      nextRainAt: vi.fn().mockResolvedValue(new Date(Date.now() - 60_000)),
      clearSchedule: vi.fn().mockResolvedValue(true),
    };
    const announceSchedule = vi.fn().mockResolvedValue(undefined);
    const scheduler = Object.assign(Object.create(RainSchedulerService.prototype), {
      db,
      announceSchedule,
    }) as unknown as RainSchedulerService;

    await scheduler.runSystemIfDue();

    expect(db.clearSchedule).toHaveBeenCalledOnce();
    expect(announceSchedule).toHaveBeenCalledOnce();
  });
});
