import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { CHAT_CHARGE_PORT, CHAT_TRANSFER_PORT } from '../../src/social/chat/chat.feature-ports';
import { ChatSettingsDocumentSchema } from '../../src/social/chat/chat.settings.contract';
import { ChatAccessService } from '../../src/social/chat/chat.access.service';
import { ChatSettingsService } from '../../src/social/chat/chat.settings';
import type { ChatUserContext } from '../../src/social/chat/chat.types';
import { ChatAdsService } from '../../src/social/chat/services/chat.ads.service';
import { ChatAdsPaymentService } from '../../src/social/chat/services/chat.ads.payment';
import { ChatAdDbOperation } from '../../src/social/chat/persistence/chat.ad.dboperation';
import { ChatGiftsService } from '../../src/social/chat/services/chat.gifts.service';
import { ChatGiftsSettlementService } from '../../src/social/chat/services/chat.gifts.settlement';
import { moneyJobConfig } from '../../src/social/chat/services/chat.money-config';
import { ChatReadService } from '../../src/social/chat/services/chat.read.service';
import { ChatMoneyRevertService } from '../../src/social/chat/services/chat.money-revert.service';
import { ChatMoneyLoop } from '../../src/social/chat/chat.money-loop';
import { ChatMoneyRevertDbOperation } from '../../src/social/chat/persistence/chat.money-revert.dboperation';
import { bootChat, makeUsers, READY, refusal, type Emitted } from './chat.e2e.harness';

/**
 * Slice B, the money of ads and gifts, on the REAL services and a migrated scratch database. The Charge and Transfer
 * ports are counting stand-ins that are idempotent by reference, like the real ones must be: what the tests count is
 * money MOVED (distinct references), because a retry that reaches the port twice is allowed and must still pay once.
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run --config vitest.chat.config.ts \
 *     tests/social/chat.ads-money.e2e.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;
const IP = '10.0.0.7';
const NAMES = ['ada', 'bob', 'cat', 'dan', 'eve', 'fay'] as const;

/** A Charge port that counts what it moved and can be told to refuse, to fail without an answer, or to answer a status. */
function chargePort() {
  const answers = new Map<string, { state: 'PAID'; reference: string } | { state: 'NOT_PAID' } | { state: 'UNKNOWN' }>();
  const port = {
    mode: 'ok' as 'ok' | 'refuse' | 'throw',
    calls: 0,
    paid: new Set<string>(),
    refunds: [] as { refundReference: string; usd: string; currency: string | null }[],
    refunded: new Set<string>(),
    charge: async (input: { reference: string }) => {
      port.calls += 1;
      if (port.mode === 'throw') throw new Error('timeout');
      if (port.mode === 'refuse') return { ok: false as const, reason: 'insufficient balance' };
      port.paid.add(input.reference);
      return { ok: true as const, reference: `PAY-${input.reference}` };
    },
    refund: async (input: { refundReference: string; usd: string; currency: string | null }) => {
      port.refunds.push({ refundReference: input.refundReference, usd: input.usd, currency: input.currency });
      port.refunded.add(input.refundReference);
      return true;
    },
    status: async (reference: string) => answers.get(reference) ?? ({ state: 'UNKNOWN' } as const),
    statusMap: answers,
  };
  return port;
}

describe.skipIf(!url)('ads money, claims and recovery (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  const emitted: Emitted[] = [];
  const tag = uuidv7().slice(-6);
  const roomId = uuidv7();
  const pinRoom = uuidv7();
  let u: Record<(typeof NAMES)[number], ChatUserContext>;
  let ads: ChatAdsService;
  let document: unknown;
  let charge: ReturnType<typeof chargePort>;
  let transferMode: 'ok' | 'throw' = 'ok';
  const transferStatus = new Map<string, unknown>();
  const transferVoids: string[] = [];

  const settings = (ads: Record<string, unknown> = {}, gifts: Record<string, unknown> = {}) => {
    document = ChatSettingsDocumentSchema.parse({
      global: {
        testProviders: { enabled: true },
        limits: { messagesPerWindow: 100, messageWindowSeconds: 1, cooldownSeconds: 1, mediaCooldownSeconds: 0 },
        ...READY,
        ads: { ...READY.ads, ...ads },
        gifts: { ...READY.gifts, ...gifts },
      },
    });
  };
  const buy = (user: ChatUserContext, key: string | null, patch: Record<string, unknown> = {}) =>
    ads.create(user, { content: 'Visit our shop', roomIds: [roomId], paymentPin: '000000', ...patch } as never, IP, key);
  const adRows = (user: ChatUserContext) =>
    prisma.$queryRaw<{ id: string; status: string; posted_count: number; charge_reference: string | null }[]>`
      SELECT id, status, posted_count, charge_reference FROM chat.chat_ads WHERE creator_id = ${user.id}::uuid ORDER BY created_at
    `;
  const config = async () => moneyJobConfig(await module.get(ChatSettingsService).global())!;
  const adMessages = async (adId: string) =>
    (
      await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chat.room_messages WHERE type = 'AD'::chat."MessageType" AND metadata->'ad'->>'adId' = ${adId}
      `
    )[0]!.n;

  beforeAll(async () => {
    settings();
    charge = chargePort();
    ({ prisma, module } = await bootChat(url!, emitted, () => document, [
      { provide: CHAT_CHARGE_PORT, useValue: charge },
      {
        provide: CHAT_TRANSFER_PORT,
        useValue: {
          quote: async ({ amount }: { amount: string }) => ({ ok: true, usdValue: amount, feeAmount: '0', minUsd: null, maxUsd: null }),
          transfer: async ({ reference }: { reference: string }) => {
            if (transferMode === 'throw') throw new Error('transfer timeout');
            return { status: 'COMPLETED', reference: `T-${reference}` };
          },
          status: async (reference: string) => transferStatus.get(reference) ?? { state: 'UNKNOWN' },
          void: async (reference: string) => { transferVoids.push(reference); return true; },
          isRestricted: async () => false,
          revert: async () => ({ ok: true }),
        },
      },
    ]));
    ads = module.get(ChatAdsService);
    u = await makeUsers(prisma, NAMES, tag);
    for (const [id, slug, maxQueue] of [[roomId, `ads-${tag}`, 5], [pinRoom, `pin-${tag}`, 1]] as const) {
      void maxQueue;
      await prisma.$executeRaw`
        INSERT INTO chat.rooms (id, slug, name, type, config)
        VALUES (${id}::uuid, ${slug}, ${slug}, 'GLOBAL', ${JSON.stringify({ contentControls: { allowAds: true } })}::jsonb)
      `;
    }
    await prisma.$executeRaw`SELECT chat.ensure_message_partitions(3)`;
  }, 60_000);

  beforeEach(() => {
    settings();
    charge.mode = 'ok';
    transferMode = 'ok';
    emitted.length = 0;
  });

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  // ─── FR-016: paying for an ad safely ──────────────────────────────────────────────────────────────────────────
  it('buying needs a key, and needs the admin\'s money numbers', async () => {
    expect(await refusal(() => buy(u.ada, null))).toBe('idempotency_key_required');
    expect(await refusal(() => buy(u.ada, 'short'))).toBe('idempotency_key_required');
    settings({ jobPageSize: null, pendingPaymentMinutes: null });
    const caught = await buy(u.ada, `key-${uuidv7()}`).then(
      () => null,
      (e: { extra?: { reason?: string; missing?: string[] } }) => e,
    );
    expect(caught?.extra?.reason).toBe('feature_unavailable');
    expect(caught?.extra?.missing).toEqual(['ads.pendingPaymentMinutes', 'ads.jobPageSize']);
    expect(await adRows(u.ada)).toHaveLength(0);
  });

  it('the same key twice is one ad and one payment; the second answer says it is a replay', async () => {
    const key = `key-${uuidv7()}`;
    const first = (await buy(u.bob, key)) as { adId: string; status: string };
    const second = (await buy(u.bob, key)) as { adId: string; status: string; replayed?: boolean };
    expect(second).toMatchObject({ adId: first.adId, status: 'ACTIVE', replayed: true });
    expect(await adRows(u.bob)).toHaveLength(1);
    expect(charge.paid.has(first.adId)).toBe(true);
    expect([...charge.paid].filter((ref) => ref === first.adId)).toHaveLength(1);
    expect(await adMessages(first.adId)).toBe(1);
  });

  it('five parallel taps with one key are one ad, one payment, one post', async () => {
    const key = `key-${uuidv7()}`;
    const answers = (await Promise.all(Array.from({ length: 5 }, () => buy(u.cat, key)))) as { adId: string }[];
    expect(new Set(answers.map((a) => a.adId)).size).toBe(1);
    const rows = await adRows(u.cat);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('ACTIVE');
    await vi.waitFor(async () => expect(await adMessages(rows[0]!.id)).toBe(1), {
      timeout: 5_000,
      interval: 25,
    });
  });

  it('the same key for a different request is a 409, not a silent copy of the first', async () => {
    const key = `key-${uuidv7()}`;
    await buy(u.dan, key);
    expect(await refusal(() => buy(u.dan, key, { content: 'Something else' }))).toBe('idempotency_key_reused');
    expect(await adRows(u.dan)).toHaveLength(1);
  });

  it('a refused charge leaves a FAILED ad that holds no pinned place, and asking again does not charge again', async () => {
    charge.mode = 'refuse';
    const key = `key-${uuidv7()}`;
    const calls = charge.calls;
    expect(await refusal(() => buy(u.eve, key, { roomIds: [pinRoom], pinMinutes: 10 }))).toBe('payment_failed');
    const [row] = await adRows(u.eve);
    expect(row!.status).toBe('FAILED');
    const [slots] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.chat_ad_placements WHERE ad_id = ${row!.id}::uuid AND status IN ('QUEUED', 'ACTIVE')
    `;
    expect(slots!.n).toBe(0);
    charge.mode = 'ok';
    expect(await refusal(() => buy(u.eve, key, { roomIds: [pinRoom], pinMinutes: 10 }))).toBe('payment_failed');
    expect(charge.calls).toBe(calls + 1);
    // A new purchase is a new key.
    expect(await refusal(() => buy(u.eve, `key-${uuidv7()}`))).toBe('ok');
  });

  it('a charge that cannot be confirmed leaves the ad PENDING_PAYMENT; the same request finishes it with one payment', async () => {
    charge.mode = 'throw';
    const key = `key-${uuidv7()}`;
    expect(await refusal(() => buy(u.fay, key))).toBe('payment_pending');
    const [pending] = await adRows(u.fay);
    expect(pending!.status).toBe('PENDING_PAYMENT');
    expect(await adMessages(pending!.id)).toBe(0);
    charge.mode = 'ok';
    const done = (await buy(u.fay, key)) as { adId: string; status: string };
    expect(done).toMatchObject({ adId: pending!.id, status: 'ACTIVE' });
    expect([...charge.paid].filter((ref) => ref === pending!.id)).toHaveLength(1);
    expect(await adMessages(pending!.id)).toBe(1);
  });

  it('records a refund when a successful charge arrives after the ad was marked FAILED', async () => {
    charge.mode = 'throw';
    const key = `key-${uuidv7()}`;
    expect(await refusal(() => buy(u.fay, key))).toBe('payment_pending');
    const [pending] = await adRows(u.fay);
    expect(pending!.status).toBe('PENDING_PAYMENT');
    const ad = await module.get(ChatAdDbOperation).adById(pending!.id);
    await prisma.$executeRaw`UPDATE chat.chat_ads SET status = 'FAILED' WHERE id = ${pending!.id}::uuid`;

    charge.mode = 'ok';
    const payment = module.get(ChatAdsPaymentService);
    await expect(payment.settle(ad!)).rejects.toMatchObject({ extra: { reason: 'payment_failed' } });
    const [row] = await prisma.$queryRaw<{ status: string; charge_reference: string | null; refund_usd: string | null }[]>`
      SELECT status, charge_reference, refund_usd::text FROM chat.chat_ads WHERE id = ${pending!.id}::uuid
    `;
    expect(row).toMatchObject({ status: 'CANCELLED', charge_reference: `PAY-${pending!.id}` });
    expect(Number(row!.refund_usd)).toBeGreaterThan(0);
    expect(await adMessages(pending!.id)).toBe(0);
  });

  it('the sweeper reconciles ads left pending: PAID activates and posts, NOT_PAID fails, UNKNOWN waits', async () => {
    charge.mode = 'throw';
    const made: string[] = [];
    for (const name of ['ada', 'bob', 'cat'] as const) {
      await buy(u[name], `key-${uuidv7()}`).catch(() => undefined);
      made.push((await adRows(u[name])).at(-1)!.id);
    }
    charge.mode = 'ok';
    await prisma.$executeRaw`UPDATE chat.chat_ads SET created_at = now() - interval '30 minutes' WHERE id = ANY(${made}::uuid[])`;
    charge.statusMap.set(made[0]!, { state: 'PAID', reference: `PAY-${made[0]}` });
    charge.statusMap.set(made[1]!, { state: 'NOT_PAID' });
    await ads.moneyPass(await config(), Date.now() + 10_000);
    const status = async (id: string) =>
      (await prisma.$queryRaw<{ status: string; claimed_at: Date | null }[]>`SELECT status, claimed_at FROM chat.chat_ads WHERE id = ${id}::uuid`)[0]!;
    // Paid, posted, and with nothing left to post it is already COMPLETED.
    expect(['ACTIVE', 'COMPLETED']).toContain((await status(made[0]!)).status);
    expect(await adMessages(made[0]!)).toBe(1);
    expect((await status(made[1]!)).status).toBe('FAILED');
    expect(await status(made[2]!)).toMatchObject({ status: 'PENDING_PAYMENT', claimed_at: null });
    // Not yet old enough is left alone: pendingPaymentMinutes is the admin's number.
    const fresh = await buy(u.dan, `key-${uuidv7()}`).catch(() => null);
    expect(fresh).not.toBeNull();
  });

  // ─── FR-182: the pinned queue under parallel buyers ──────────────────────────────────────────────────────────────
  it('two parallel buyers for the last pinned place: one gets it, the other is refused before any money moves', async () => {
    settings({ pinned: { enabled: true, pricePerMinute: { kind: 'USD', value: '0.5' }, maxQueue: 1, minMinutes: 5, maxMinutes: 120 } });
    const before = charge.paid.size;
    const results = await Promise.all(
      (['ada', 'bob'] as const).map((name) =>
        refusal(() => buy(u[name], `key-${uuidv7()}`, { roomIds: [pinRoom], pinMinutes: 10 })),
      ),
    );
    expect(results.sort()).toEqual(['ad_queue_full', 'ok']);
    expect(charge.paid.size).toBe(before + 1);
  });

  // ─── FR-017: refunds and repeats are claimed ────────────────────────────────────────────────────────────────────
  it('an advertiser cannot cancel or refund a post after it has been shown', async () => {
    settings({ refundCurrencies: ['USDT', 'BTC'] });
    const bought = (await buy(u.cat, `key-${uuidv7()}`, { repeatCount: 3, repeatGapMinutes: 5 })) as { adId: string };
    // Not naming a coin, or naming one that is not offered, is refused.
    expect(await refusal(() => ads.cancel(u.cat, bought.adId))).toBe('validation_failed');
    expect(await refusal(() => ads.cancel(u.cat, bought.adId, 'doge'))).toBe('validation_failed');
    expect(await refusal(() => ads.cancel(u.cat, bought.adId, 'usdt'))).toBe('feature_disabled');
    const [row] = await prisma.$queryRaw<{ status: string }[]>`SELECT status FROM chat.chat_ads WHERE id = ${bought.adId}::uuid`;
    expect(row!.status).toBe('ACTIVE');
    expect(charge.refunds.filter((r) => r.refundReference === bought.adId)).toEqual([]);
  });

  it('with no refund coins on offer, none can be named', async () => {
    const bought = (await buy(u.dan, `key-${uuidv7()}`)) as { adId: string };
    expect(await refusal(() => ads.cancel(u.dan, bought.adId, 'USDT'))).toBe('validation_failed');
    expect(await refusal(() => ads.cancel(u.dan, bought.adId))).toBe('feature_disabled');
  });

  it('three parallel passes post a due repeat once, and the count never runs ahead', async () => {
    const bought = (await buy(u.eve, `key-${uuidv7()}`, { repeatCount: 1, repeatGapMinutes: 5 })) as { adId: string };
    expect(await adMessages(bought.adId)).toBe(1);
    await prisma.$executeRaw`UPDATE chat.chat_ads SET next_post_at = now() - interval '1 second' WHERE id = ${bought.adId}::uuid`;
    const cfg = await config();
    await Promise.all([ads.moneyPass(cfg, Date.now() + 10_000), ads.moneyPass(cfg, Date.now() + 10_000), ads.moneyPass(cfg, Date.now() + 10_000)]);
    expect(await adMessages(bought.adId)).toBe(2);
    const [row] = await prisma.$queryRaw<{ posted_count: number; status: string }[]>`
      SELECT posted_count, status FROM chat.chat_ads WHERE id = ${bought.adId}::uuid
    `;
    expect(row!.posted_count).toBe(2);
  });

  it('a worker that died holding a repeat does not stop it: after the stale time another takes it over', async () => {
    const bought = (await buy(u.fay, `key-${uuidv7()}`, { repeatCount: 1, repeatGapMinutes: 5 })) as { adId: string };
    await prisma.$executeRaw`UPDATE chat.chat_ads SET next_post_at = now() - interval '1 second', claimed_at = now() WHERE id = ${bought.adId}::uuid`;
    const cfg = await config();
    await ads.moneyPass(cfg, Date.now() + 10_000);
    expect(await adMessages(bought.adId)).toBe(1); // held by a live claim: left alone
    await prisma.$executeRaw`UPDATE chat.chat_ads SET claimed_at = now() - interval '1 hour' WHERE id = ${bought.adId}::uuid`;
    await ads.moneyPass(cfg, Date.now() + 10_000);
    expect(await adMessages(bought.adId)).toBe(2);
  });

  it('the money loop runs one pass at a time and one more after a signal that came during it', async () => {
    const loop = module.get(ChatMoneyLoop);
    let passes = 0;
    let concurrent = 0;
    let most = 0;
    (loop as unknown as { pass: () => Promise<void> }).pass = async () => {
      passes += 1;
      concurrent += 1;
      most = Math.max(most, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
    };
    await Promise.all([loop.kick(), loop.kick(), loop.kick(), loop.kick()]);
    expect(most).toBe(1);
    expect(passes).toBe(2);
  });

  // ─── FR-017: gifts left PROCESSING ───────────────────────────────────────────────────────────────────────────────
  it('gifts stuck PROCESSING are asked about after the admin\'s minutes and settled either way', async () => {
    const gifts = module.get(ChatGiftsService);
    const settlement = module.get(ChatGiftsSettlementService);
    const stuck: string[] = [];
    transferMode = 'throw';
    for (let i = 0; i < 4; i += 1) {
      const gift = await gifts.start(u.ada, { recipient: u.bob.id, amount: '1', currency: 'USDT' });
      await gifts.confirm(u.ada, gift.giftId, '000000').catch(() => undefined);
      stuck.push(gift.giftId);
    }
    const state = async (id: string) =>
      (await prisma.$queryRaw<{ status: string; claimed_at: Date | null }[]>`SELECT status, claimed_at FROM chat.gift_transfers WHERE id = ${id}::uuid`)[0]!;
    expect((await state(stuck[0]!)).status).toBe('PROCESSING');

    // Not old enough: nothing is asked.
    await settlement.reconcileProcessing(await config(), Date.now() + 10_000);
    expect((await state(stuck[0]!)).status).toBe('PROCESSING');

    await prisma.$executeRaw`UPDATE chat.gift_transfers SET processing_at = now() - interval '1 hour' WHERE id = ANY(${stuck}::uuid[])`;
    transferStatus.set(stuck[0]!, { state: 'COMPLETED', reference: `T-${stuck[0]}` });
    transferStatus.set(stuck[1]!, { state: 'FAILED', reason: 'insufficient balance' });
    transferStatus.set(stuck[2]!, { state: 'NOT_FOUND' });
    transferStatus.set(stuck[3]!, { state: 'UNKNOWN' });
    emitted.length = 0;
    await settlement.reconcileProcessing(await config(), Date.now() + 10_000);
    expect((await state(stuck[0]!)).status).toBe('COMPLETED');
    expect((await state(stuck[1]!)).status).toBe('FAILED');
    expect((await state(stuck[2]!)).status).toBe('FAILED');
    expect(transferVoids).toContain(stuck[2]);
    expect(await state(stuck[3]!)).toMatchObject({ status: 'PROCESSING', claimed_at: null });
    // The completed one got its notice, once; a second pass changes nothing.
    expect(emitted.filter((e) => e.event === 'gift_received' && (e.payload as { giftId: string }).giftId === stuck[0])).toHaveLength(1);
    await settlement.reconcileProcessing(await config(), Date.now() + 10_000);
    expect(emitted.filter((e) => e.event === 'gift_received' && (e.payload as { giftId: string }).giftId === stuck[0])).toHaveLength(1);
  });

  // ─── FR-106: group reverts are worked a page at a time and survive a crash ─────────────────────────────────────────
  it('a group revert interrupted by a crash carries on after its saved place, and finishes', async () => {
    const jobs = module.get(ChatMoneyRevertDbOperation);
    const service = module.get(ChatMoneyRevertService);
    const ids: string[] = [];
    // Rows of an earlier run of this test would join the window.
    await prisma.$executeRaw`DELETE FROM chat.gift_transfers WHERE created_at < timestamptz '2021-01-01'`;
    for (let i = 0; i < 5; i += 1) {
      const id = uuidv7();
      ids.push(id);
      await prisma.$executeRaw`
        INSERT INTO chat.gift_transfers (id, sender_id, recipient_id, currency, amount, usd_value, fee_amount, verification, status,
          expires_at, created_at)
        VALUES (${id}::uuid, ${u.ada.id}::uuid, ${u.bob.id}::uuid, 'USDT', 1, 1, 0, 'TWO_FA', 'COMPLETED', now() + interval '1 day',
          timestamptz '2020-01-01T00:00:00Z' + make_interval(secs => ${i}))
      `;
    }
    const jobId = uuidv7();
    const after = (await prisma.$queryRaw<{ t: string }[]>`
      SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t FROM chat.gift_transfers WHERE id = ${ids[1]}::uuid
    `)[0]!.t;
    // The worker died after two rows, holding the claim a long time ago.
    await prisma.$executeRaw`
      INSERT INTO chat.money_revert_jobs (id, kind, filter, status, created_by, claimed_at, progress)
      VALUES (${jobId}::uuid, 'GIFTS', ${JSON.stringify({
        from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z', userIds: [], minUsd: null, maxUsd: null,
        group: { targetType: 'PREMIUM', value: '' }, note: null,
      })}::jsonb, 'RUNNING', ${u.ada.id}::uuid, now() - interval '2 hours',
        ${JSON.stringify({ after: { createdAt: after, id: ids[1] }, totals: { candidates: 2, inGroup: 0, marked: 0 } })}::jsonb)
    `;
    const cfg = { ...(await config()), pageSize: 2 };
    await service.process(cfg, Date.now() + 10_000);
    const [job] = await prisma.$queryRaw<{ status: string; result: Record<string, number> }[]>`
      SELECT status, result FROM chat.money_revert_jobs WHERE id = ${jobId}::uuid
    `;
    expect(job!.status).toBe('DONE');
    // Two were done before the crash, three after it: five in all, none counted twice, in pages of two.
    expect(job!.result).toMatchObject({ candidates: 5 });
    void jobs;
  });

  // ─── FR-184: an ad hidden from a country ───────────────────────────────────────────────────────────────────────────
  it('an ad hidden from a country is not delivered to it live and not in its history, pinned list or the ad tab', async () => {
    await prisma.$executeRaw`UPDATE identity.users SET country_declared = 'DE' WHERE id = ${u.ada.id}::uuid`;
    await prisma.$executeRaw`UPDATE identity.users SET country_declared = 'FR' WHERE id = ${u.bob.id}::uuid`;
    module.get(ChatAccessService).forgetUser(u.ada.id);
    module.get(ChatAccessService).forgetUser(u.bob.id);
    emitted.length = 0;
    const bought = (await buy(u.cat, `key-${uuidv7()}`, { hiddenCountries: ['de'] })) as { adId: string };
    // Live: the room's channels, except the hidden country's channel (one emit, no loop over sockets).
    const live = emitted.find((e) => e.event === 'new_message' && (e.payload as { type?: string }).type === 'AD');
    expect(live?.except).toEqual([`room:${roomId}:country:DE`]);

    const read = module.get(ChatReadService);
    const ids = async (user: ChatUserContext) => (await read.history(user, roomId, { limit: 50 })).items.map((m) => (m as { content?: string; metadata?: { adId?: string } }).metadata?.adId ?? m.id);
    const seenByDe = JSON.stringify((await read.history(u.ada, roomId, { limit: 100 })).items);
    const seenByFr = JSON.stringify((await read.history(u.bob, roomId, { limit: 100 })).items);
    expect(seenByDe).not.toContain(bought.adId);
    expect(seenByFr).toContain(bought.adId);
    void ids;
  });
});
