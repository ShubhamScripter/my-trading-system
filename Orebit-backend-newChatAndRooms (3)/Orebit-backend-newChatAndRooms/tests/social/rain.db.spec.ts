import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { RainDbOperation } from '../../src/social/rain/rain.dboperation';
import { RainRevertDbOperation } from '../../src/social/rain/rain.revert.dboperation';
import type { PrismaService } from '../../db/client';

const url = process.env.CHAT_TEST_DATABASE_URL;

describe.skipIf(!url)('rain persistence on a migrated scratch database', () => {
  let prisma: PrismaClient;
  let rain: RainDbOperation;
  let revert: RainRevertDbOperation;
  const runId = uuidv7();
  const roomId = uuidv7();
  const payerId = uuidv7();
  const recipientIds = [uuidv7(), uuidv7()];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    rain = new RainDbOperation(prisma as unknown as PrismaService);
    revert = new RainRevertDbOperation(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRaw`DELETE FROM rain.runs WHERE id = ${runId}::uuid`;
      await prisma.$executeRaw`
        UPDATE rain.schedule SET next_rain_at = NULL, next_currency = NULL, next_pot_minor = NULL,
          next_pot_usd_minor = NULL, scheduled_at = NULL, lock_owner = NULL, lock_until = NULL WHERE id = 1
      `;
      await prisma.$disconnect();
    }
  });

  it('reads rain configuration and schedule columns created by migrations', async () => {
    const config = await rain.config();
    expect(config.status).toBeDefined();

    const at = new Date(Date.now() - 1_000);
    await prisma.$executeRaw`
      INSERT INTO rain.schedule (id, next_rain_at, next_currency, next_pot_minor, next_pot_usd_minor, scheduled_at)
      VALUES (1, ${at}, 'BTC', 12345, 456, now())
      ON CONFLICT (id) DO UPDATE SET next_rain_at = EXCLUDED.next_rain_at,
        next_currency = EXCLUDED.next_currency, next_pot_minor = EXCLUDED.next_pot_minor,
        next_pot_usd_minor = EXCLUDED.next_pot_usd_minor, scheduled_at = EXCLUDED.scheduled_at
    `;
    const schedule = await rain.schedule();
    expect(schedule).toMatchObject({ currency: 'BTC', potMinor: 12345n, potUsdMinor: 456n });
    expect(schedule.scheduledAt).toBeInstanceOf(Date);
  });

  it('patches only rain status while holding a row lock', async () => {
    const before = await rain.config();
    const result = await rain.patchStatus({ system: before.status.system });
    const after = await rain.config();
    expect(result).toEqual({ before: before.status, after: before.status });
    expect(after).toEqual(before);
  });

  it('refuses a status patch when the stored config is invalid and leaves it untouched', async () => {
    const before = await prisma.$queryRaw<{ document: unknown }[]>`SELECT document FROM rain.config WHERE id = 1`;
    try {
      await prisma.$executeRaw`UPDATE rain.config SET document = '{"status":{"system":"BROKEN"}}'::jsonb WHERE id = 1`;
      await expect(rain.patchStatus({ system: 'OFF' })).rejects.toThrow();
      const after = await prisma.$queryRaw<{ document: unknown }[]>`SELECT document FROM rain.config WHERE id = 1`;
      expect(after[0]?.document).toEqual({ status: { system: 'BROKEN' } });
    } finally {
      if (before[0]) {
        await prisma.$executeRaw`UPDATE rain.config SET document = ${JSON.stringify(before[0].document)}::jsonb WHERE id = 1`;
      }
    }
  });

  it('stores recipient_count and all paid recipient shares in the payment transaction', async () => {
    await prisma.$transaction(async (tx) => {
      await rain.insertRun(tx, {
        id: runId,
        kind: 'USER',
        status: 'COMPLETED',
        roomId,
        initiatorId: payerId,
        currency: 'BTC',
        potMinor: 100n,
        feeMinor: 0n,
        distributableMinor: 100n,
        recipientCount: recipientIds.length,
        idempotencyKey: `rain-test:${runId}`,
      });
      await rain.insertShares(
        tx,
        runId,
        recipientIds.map((userId) => ({ userId, amount: 50n, tier: 'NORMAL' as const })),
      );
    });

    const runs = await prisma.$queryRaw<{ recipient_count: number }[]>`
      SELECT recipient_count FROM rain.runs WHERE id = ${runId}::uuid
    `;
    const shares = await prisma.$queryRaw<{ user_id: string }[]>`
      SELECT user_id::text FROM rain.recipients WHERE rain_id = ${runId}::uuid ORDER BY user_id
    `;
    expect(runs[0]?.recipient_count).toBe(2);
    expect(shares.map((share) => share.user_id)).toEqual([...recipientIds].sort());
    const publicRows = await rain.publicHistory(10);
    const sentRows = await rain.sentBy(payerId, 10);
    const receivedRows = await rain.receivedBy(recipientIds[0]!, 10);
    expect(() => JSON.stringify({ publicRows, sentRows, receivedRows })).not.toThrow();
    expect(typeof publicRows.find((row) => row.id === runId)?.potMinor).toBe('string');
    expect(typeof receivedRows[0]?.amountMinor).toBe('string');
  });

  it('whole-rain revert selects only open shares and records zero-reclaim shares once', async () => {
    const selected = await prisma.$transaction((tx) => revert.takeShares(tx, runId, null));
    expect(selected).toHaveLength(2);

    const jobId = uuidv7();
    await prisma.$transaction((tx) =>
      revert.setReclaimed(
        tx,
        runId,
        new Map([
          [recipientIds[0]!, 50n],
          [recipientIds[1]!, 0n],
        ]),
        jobId,
      ),
    );

    const selectedAgain = await prisma.$transaction((tx) => revert.takeShares(tx, runId, null));
    const recorded = await prisma.$queryRaw<{ user_id: string; reclaimed_minor: bigint; reversed_job_id: string }[]>`
      SELECT user_id::text, reclaimed_minor, reversed_job_id::text FROM rain.recipients
      WHERE rain_id = ${runId}::uuid ORDER BY user_id
    `;
    expect(selectedAgain).toHaveLength(0);
    expect(new Map(recorded.map((row) => [row.user_id, row.reclaimed_minor]))).toEqual(
      new Map([[recipientIds[0]!, 50n], [recipientIds[1]!, 0n]]),
    );
    expect(recorded.every((row) => row.reversed_job_id === jobId)).toBe(true);
  });

  it('clears a stale schedule without stealing a live scheduler lock', async () => {
    await prisma.$executeRaw`
      UPDATE rain.schedule SET next_rain_at = now() - interval '1 hour', next_currency = 'BTC',
        next_pot_minor = 100, next_pot_usd_minor = 200, scheduled_at = now(),
        lock_owner = 'audit-live-lock', lock_until = now() + interval '1 minute' WHERE id = 1
    `;
    expect(await rain.clearSchedule()).toBe(false);
    expect(await rain.nextRainAt()).not.toBeNull();

    await prisma.$executeRaw`UPDATE rain.schedule SET lock_owner = NULL, lock_until = NULL WHERE id = 1`;
    expect(await rain.clearSchedule()).toBe(true);
    expect(await rain.schedule()).toMatchObject({
      nextRainAt: null,
      currency: null,
      potMinor: null,
      potUsdMinor: null,
      scheduledAt: null,
    });
  });
});
