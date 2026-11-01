import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { CHAT_CHARGE_PORT, CHAT_TRANSFER_PORT } from '../../src/social/chat/chat.feature-ports';
import { RoomAccessSchema } from '../../src/social/chat/chat.contract';
import { ChatSettingsDocumentSchema } from '../../src/social/chat/chat.settings.contract';
import { ChatService } from '../../src/social/chat/chat.service';
import { ChatSettingsService } from '../../src/social/chat/chat.settings';
import type { ChatUserContext } from '../../src/social/chat/chat.types';
import { ChatAdsService } from '../../src/social/chat/services/chat.ads.service';
import { ChatGiftsService } from '../../src/social/chat/services/chat.gifts.service';
import { ChatGiftsSettlementService } from '../../src/social/chat/services/chat.gifts.settlement';
import { moneyJobConfig } from '../../src/social/chat/services/chat.money-config';
import { ChatStaffService } from '../../src/social/chat/services/chat.staff.service';
import { bootChat, makeUsers, READY, refusal, type Emitted } from './chat.e2e.harness';

/**
 * Slice I (edge-case closure) for Modules 4 and 5: the rows of `rules/edge cases/M04-edge-cases.md` and
 * `M05-edge-cases.md` that no other spec proves end to end on a real Postgres. Each test name starts with its row id.
 * The table at the end of the plan (`rules/plans/M04-M05-CLIENT-ISSUES-AND-FIX-PLAN.md`, section 4c) says which spec
 * proves every other row.
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run --config vitest.chat.config.ts \
 *     tests/social/chat.edge-cases.e2e.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;
const IP = '10.0.0.9';
const NAMES = ['boss', 'mod', 'sup', 'ada', 'bob', 'cat', 'eve', 'fay'] as const;

describe.skipIf(!url)('Module 4 and 5 edge cases (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  const emitted: Emitted[] = [];
  const tag = uuidv7().slice(-6);
  const roomId = uuidv7();
  let u: Record<(typeof NAMES)[number], ChatUserContext>;
  let document: unknown;
  const moved = { charges: new Set<string>(), transfers: new Set<string>(), reverts: [] as string[] };

  const settings = (global: Record<string, unknown> = {}) => {
    document = ChatSettingsDocumentSchema.parse({
      global: {
        testProviders: { enabled: true },
        limits: { messagesPerWindow: 100, messageWindowSeconds: 1, cooldownSeconds: 1, mediaCooldownSeconds: 0, maxBanHours: 24 * 30 },
        ...READY,
        ...global,
      },
    });
  };
  const ban = (by: ChatUserContext, target: ChatUserContext, extra: Record<string, unknown> = {}) =>
    module.get(ChatStaffService).staffBan(by, { userId: target.id, roomId: null, internalReason: 'Spam', durationHours: 2, ...extra });
  const warn = (by: ChatUserContext, target: ChatUserContext) =>
    module.get(ChatStaffService).staffWarn(by, { userId: target.id, roomId: null, internalReason: 'Careful' });
  const count = async (table: 'user_bans' | 'chat_warnings', user: ChatUserContext) =>
    (await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM chat.${table} WHERE user_id = $1::uuid`, user.id))[0]!.n;
  const post = (user: ChatUserContext, content: string) =>
    module.get(ChatService).sendMessage(user, { roomRef: roomId, content }, { ip: IP });

  beforeAll(async () => {
    settings();
    ({ prisma, module } = await bootChat(url!, emitted, () => document, [
      {
        provide: CHAT_CHARGE_PORT,
        useValue: {
          charge: async (input: { reference: string }) => {
            moved.charges.add(input.reference);
            return { ok: true as const, reference: `PAY-${input.reference}` };
          },
          refund: async () => true,
          status: async () => ({ state: 'UNKNOWN' }),
        },
      },
      {
        provide: CHAT_TRANSFER_PORT,
        useValue: {
          quote: async ({ amount }: { amount: string }) => ({ ok: true, usdValue: amount, feeAmount: '0', minUsd: null, maxUsd: null }),
          transfer: async ({ reference }: { reference: string }) => {
            moved.transfers.add(reference);
            return { status: 'COMPLETED', reference: `T-${reference}` };
          },
          status: async () => ({ state: 'UNKNOWN' }),
          isRestricted: async () => false,
          revert: async (input: { reference?: string; giftId?: string }) => {
            moved.reverts.push(String(input.reference ?? input.giftId ?? 'revert'));
            return { ok: true };
          },
        },
      },
    ]));
    u = await makeUsers(prisma, NAMES, tag);
    for (const [key, role] of [['boss', 'ADMIN'], ['mod', 'MODERATOR'], ['sup', 'SUPPORT']] as const) {
      await prisma.$executeRawUnsafe(`INSERT INTO chat.staff_roles (user_id, role) VALUES ($1::uuid, '${role}'::chat."StaffRole")`, u[key].id);
      u[key] = { ...u[key], staffRole: role };
    }
    await prisma.$executeRaw`
      INSERT INTO chat.rooms (id, slug, name, type, config)
      VALUES (${roomId}::uuid, ${`edge-${tag}`}, 'Edge', 'GLOBAL', ${JSON.stringify({ contentControls: { allowAds: true } })}::jsonb)
    `;
  }, 60_000);

  beforeEach(() => {
    settings();
    emitted.length = 0;
  });

  afterAll(async () => {
    await prisma?.$executeRawUnsafe('DROP TRIGGER IF EXISTS edge_audit_fails ON chat.moderation_actions');
    await prisma?.$executeRawUnsafe('DROP FUNCTION IF EXISTS chat.edge_audit_fails()');
    await module?.close();
    await prisma?.$disconnect();
  });

  // ─── Module 4 ────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('Module 4', () => {
    it('E04-29: when the audit row cannot be written the ban and the warning are rolled back with it', async () => {
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION chat.edge_audit_fails() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'audit insert failed (edge test)'; END $$
      `);
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER edge_audit_fails BEFORE INSERT ON chat.moderation_actions FOR EACH ROW EXECUTE FUNCTION chat.edge_audit_fails()',
      );
      try {
        await expect(ban(u.mod, u.eve)).rejects.toThrow();
        await expect(warn(u.mod, u.eve)).rejects.toThrow();
        expect(await count('user_bans', u.eve)).toBe(0);
        expect(await count('chat_warnings', u.eve)).toBe(0);
      } finally {
        await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS edge_audit_fails ON chat.moderation_actions');
      }
      // With the audit working again the same action goes through, and leaves its audit row.
      expect(await refusal(() => ban(u.mod, u.eve))).toBe('ok');
      const [audit] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chat.moderation_actions WHERE target_user_id = ${u.eve.id}::uuid AND action = 'staff.ban'
      `;
      expect(audit!.n).toBe(1);
    });

    it('E04-35 and E04-36: staff cannot act on themselves, on an equal rank or on a higher rank, and nothing is stored', async () => {
      expect(await refusal(() => ban(u.mod, u.mod))).toBe('target_outranks_you');
      expect(await refusal(() => ban(u.mod, u.boss))).toBe('target_outranks_you');
      expect(await refusal(() => ban(u.sup, u.mod))).toBe('target_outranks_you');
      expect(await refusal(() => ban(u.boss, u.boss))).toBe('target_outranks_you');
      expect(await refusal(() => warn(u.mod, u.boss))).toBe('target_outranks_you');
      for (const staff of [u.mod, u.boss, u.sup]) {
        expect(await count('user_bans', staff)).toBe(0);
        expect(await count('chat_warnings', staff)).toBe(0);
      }
    });

    it('E04-37 and E04-48: a user who is sending is stopped by the very next message after the ban, not 5 seconds later', async () => {
      expect(await refusal(() => post(u.fay, 'before the ban'))).toBe('ok');
      expect(await refusal(() => ban(u.mod, u.fay))).toBe('ok');
      // The ban version was bumped, so the cached "not banned" answer is not used.
      expect(await refusal(() => post(u.fay, 'in flight after the ban'))).toBe('chat_banned');
      const [stored] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chat.room_messages WHERE user_id = ${u.fay.id}::uuid AND content = 'in flight after the ban'
      `;
      expect(stored!.n).toBe(0);
    });
  });

  // ─── Module 5 ────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('Module 5', () => {
    const start = (from: ChatUserContext, to: ChatUserContext | string, amount: string, currency = 'USDT') =>
      module.get(ChatGiftsService).start(from, { recipient: typeof to === 'string' ? to : to.id, amount, currency });

    it('E05-15 and E05-53: a gift to yourself, or to nobody, is refused and nothing is stored or moved', async () => {
      const before = moved.transfers.size;
      expect(await refusal(() => start(u.ada, u.ada, '1'))).toBe('validation_failed');
      expect(await refusal(() => start(u.ada, uuidv7(), '1'))).toBe('not_found');
      expect(moved.transfers.size).toBe(before);
      const [rows] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM chat.gift_transfers WHERE sender_id = ${u.ada.id}::uuid`;
      expect(rows!.n).toBe(0);
    });

    it('E05-16: an amount of 0, a negative one, 19 decimals, an exponent or text is refused', async () => {
      for (const amount of ['0', '-1', '0.0000000000000000001', '1e5', '1e-19', '', 'abc', '1,5', ' ']) {
        expect(await refusal(() => start(u.ada, u.bob, amount)), `amount "${amount}"`).toBe('validation_failed');
      }
      expect(await refusal(() => start(u.ada, u.bob, '1', 'us dt'))).toBe('validation_failed');
    });

    it('E05-04 and E05-13: a gift confirmed twice at once moves money once, and a revert asked twice reverts once', async () => {
      const gifts = module.get(ChatGiftsService);
      const gift = await start(u.ada, u.bob, '2');
      const results = await Promise.all(
        [1, 2, 3].map(() => refusal(() => gifts.confirm(u.ada, gift.giftId, '000000'))),
      );
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r !== 'ok').every((r) => r === 'gift_expired')).toBe(true);
      expect([...moved.transfers].filter((ref) => ref === gift.giftId)).toHaveLength(1);

      await prisma.$executeRaw`
        UPDATE chat.gift_transfers SET status = 'REVERT_PENDING', revert_refund_fees = true, revert_requested_at = now()
        WHERE id = ${gift.giftId}::uuid
      `;
      const config = moneyJobConfig(await module.get(ChatSettingsService).global())!;
      const settlement = module.get(ChatGiftsSettlementService);
      const before = moved.reverts.length;
      await Promise.all([1, 2, 3].map(() => settlement.processReverts(config, Date.now() + 10_000)));
      await settlement.processReverts(config, Date.now() + 10_000);
      expect(moved.reverts.length - before).toBe(1);
      const [row] = await prisma.$queryRaw<{ status: string }[]>`SELECT status FROM chat.gift_transfers WHERE id = ${gift.giftId}::uuid`;
      expect(row!.status).toBe('REVERTED');
    });

    it('E05-23: every admin USD price with more than 2 decimals is refused, never rounded', () => {
      const ok = (ads: Record<string, unknown>) => ChatSettingsDocumentSchema.safeParse({ global: { ads } }).success;
      expect(ok({})).toBe(true);
      expect(ok({ basePriceUsd: '5.005' })).toBe(false);
      expect(ok({ basePriceUsd: 5.005 })).toBe(false);
      expect(ok({ basePriceUsd: '5.00' })).toBe(true);
      expect(ok({ basePriceUsd: '5.5' })).toBe(true);
      expect(ok({ basePriceUsd: '-1' })).toBe(false);
      expect(ok({ basePriceUsd: '5e2' })).toBe(false);
      // Every other ad price field follows the same rule: extras, the pinned minute, links, skins, the repeat cap.
      expect(ok({ extraRoom: { kind: 'USD', value: '1.001' } })).toBe(false);
      expect(ok({ extraRoom: { kind: 'USD', value: '1.25' } })).toBe(true);
      expect(ok({ pinned: { enabled: true, pricePerMinute: { kind: 'USD', value: '0.005' }, maxQueue: 3, minMinutes: 1, maxMinutes: 60 } })).toBe(false);
      expect(ok({ skins: [{ id: 'gold', name: 'Gold', style: {}, priceUsd: '2.999' }] })).toBe(false);
      expect(ok({ skins: [{ id: 'gold', name: 'Gold', style: {}, priceUsd: '2.99' }] })).toBe(true);
      // A percentage is not money: it keeps its own precision.
      expect(ok({ extraRoom: { kind: 'PERCENT', value: '12.5' } })).toBe(true);
      // The casino minimum wager is stored at 2 decimals as well (V2-20).
      expect(RoomAccessSchema.safeParse({ minWagerUsd: '1.005' }).success).toBe(false);
      expect(RoomAccessSchema.safeParse({ minWagerUsd: '1.5' }).success).toBe(true);
    });

    it('E05-52: a retry with the same key after the admin changed the price gets the first answer, never a new price or a second charge', async () => {
      settings({ ads: { ...READY.ads, basePriceUsd: '5' } });
      const ads = module.get(ChatAdsService);
      const key = `edge-${uuidv7()}`;
      const input = { content: 'Visit our shop', roomIds: [roomId], paymentPin: '000000' } as never;
      const first = (await ads.create(u.cat, input, IP, key)) as { adId: string; priceUsd?: string };
      settings({ ads: { ...READY.ads, basePriceUsd: '9' } });
      const second = (await ads.create(u.cat, input, IP, key)) as { adId: string; replayed?: boolean; priceUsd?: string };
      expect(second).toMatchObject({ adId: first.adId, replayed: true });
      expect([...moved.charges].filter((ref) => ref === first.adId)).toHaveLength(1);
      const [row] = await prisma.$queryRaw<{ price_usd: string }[]>`SELECT price_usd::text AS price_usd FROM chat.chat_ads WHERE id = ${first.adId}::uuid`;
      expect(Number(row!.price_usd)).toBe(5);
      // A new key is a new purchase and does use the new price.
      const third = (await ads.create(u.cat, input, IP, `edge-${uuidv7()}`)) as { adId: string };
      const [fresh] = await prisma.$queryRaw<{ price_usd: string }[]>`SELECT price_usd::text AS price_usd FROM chat.chat_ads WHERE id = ${third.adId}::uuid`;
      expect(Number(fresh!.price_usd)).toBe(9);
    });
  });
});
