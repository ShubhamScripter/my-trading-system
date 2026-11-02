import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { ChatMoneyService } from '../../src/social/chat/services/chat-money.service';
import { ChatMoneyDbOperation } from '../../src/social/chat/persistence/chat-money.dboperation';
import { ChatUtility } from '../../src/social/chat/chat.utility';
import { ChatModerationDbOperation } from '../../src/social/chat/chat-moderation.dboperation';
import { ChatStaffDbOperation } from '../../src/social/chat/persistence/chat-staff.dboperation';

/**
 * Admin ads (FR-110) and the admin cancel (FR-017, FR-106): "all rooms" becomes the real rooms by the user-side rule,
 * a room that does not accept ads or a bad badge is refused, and a cancel works the refund out in the database,
 * exactly, inside the transaction with the ad locked.
 */
const ADMIN = '0192f6a0-0000-7000-8000-0000000000a1';
const room = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  type: 'GLOBAL',
  status: 'ACTIVE',
  deletedAt: null,
  controlsMaintenance: [],
  contentControls: { allowAds: true },
  ...patch,
});
const ROOMS = {
  open: '0192f6a0-0000-7000-8000-000000000001',
  alsoOpen: '0192f6a0-0000-7000-8000-000000000002',
  adsOff: '0192f6a0-0000-7000-8000-000000000003',
  staff: '0192f6a0-0000-7000-8000-000000000004',
  deleted: '0192f6a0-0000-7000-8000-000000000005',
  maintenance: '0192f6a0-0000-7000-8000-000000000006',
};

describe('ChatMoneyService.createAd resolves the rooms like a user ad', () => {
  let money: { createAdminAd: ReturnType<typeof vi.fn> };
  let rooms: { getRooms: ReturnType<typeof vi.fn> };
  let settings: { preview: ReturnType<typeof vi.fn> };
  let service: ChatMoneyService;
  let ads: Record<string, unknown>;

  beforeEach(() => {
    ads = {
      allowedRoomIds: [],
      badges: [{ id: 'love' }],
      pinned: { enabled: true, minMinutes: 5, maxMinutes: 60 },
    };
    money = { createAdminAd: vi.fn().mockResolvedValue('ad-1') };
    rooms = {
      getRooms: vi.fn().mockResolvedValue([
        room(ROOMS.open),
        room(ROOMS.alsoOpen),
        room(ROOMS.adsOff, { contentControls: { allowAds: false } }),
        room(ROOMS.staff, { type: 'STAFF' }),
        room(ROOMS.deleted, { deletedAt: '2026-01-01' }),
        room(ROOMS.maintenance, { controlsMaintenance: ['ADS'] }),
      ]),
    };
    settings = { preview: vi.fn(async () => ({ ads })) };
    const moderation = { recordModerationAction: vi.fn(), notify: vi.fn(), resolveUserId: vi.fn() };
    service = new ChatMoneyService(money as never, moderation as never, rooms as never, settings as never);
  });

  const refusal = async (run: () => Promise<unknown>) =>
    run().then(
      () => 'ok',
      (e: { type?: string }) => e.type,
    );

  it('"all rooms" is stored as every room that accepts ads, not as an empty list', async () => {
    const out = await service.createAd({ content: 'Hello', allRooms: true }, ADMIN);
    expect(out.roomIds).toEqual([ROOMS.open, ROOMS.alsoOpen]);
    expect(money.createAdminAd).toHaveBeenCalledWith(expect.objectContaining({ roomIds: [ROOMS.open, ROOMS.alsoOpen], allRooms: true }));
  });

  it('the admin\'s list of allowed rooms narrows "all rooms"', async () => {
    ads.allowedRoomIds = [ROOMS.alsoOpen];
    expect((await service.createAd({ content: 'Hello', allRooms: true }, ADMIN)).roomIds).toEqual([ROOMS.alsoOpen]);
  });

  it('a named room that does not accept ads, is the Staff room, was deleted or does not exist is refused', async () => {
    for (const id of [ROOMS.adsOff, ROOMS.staff, ROOMS.deleted, ROOMS.maintenance, '0192f6a0-0000-7000-8000-0000000000ff']) {
      expect(await refusal(() => service.createAd({ content: 'Hello', roomIds: [id] }, ADMIN))).toBe(ERR.VALIDATION_FAILED);
    }
    expect(money.createAdminAd).not.toHaveBeenCalled();
    expect((await service.createAd({ content: 'Hello', roomIds: [ROOMS.open, ROOMS.open] }, ADMIN)).roomIds).toEqual([ROOMS.open]);
  });

  it('no room accepting ads, an unknown badge, and pinned minutes outside the admin\'s range are refused', async () => {
    rooms.getRooms.mockResolvedValue([room(ROOMS.adsOff, { contentControls: { allowAds: false } })]);
    expect(await refusal(() => service.createAd({ content: 'Hello', allRooms: true }, ADMIN))).toBe(ERR.VALIDATION_FAILED);
    rooms.getRooms.mockResolvedValue([room(ROOMS.open)]);
    expect(await refusal(() => service.createAd({ content: 'Hello', roomIds: [ROOMS.open], badgeId: 'nope' }, ADMIN))).toBe(ERR.VALIDATION_FAILED);
    expect(await refusal(() => service.createAd({ content: 'Hello', roomIds: [ROOMS.open], pinMinutes: 3 }, ADMIN))).toBe(ERR.VALIDATION_FAILED);
    expect(await refusal(() => service.createAd({ content: 'Hello', roomIds: [ROOMS.open], pinMinutes: 61 }, ADMIN))).toBe(ERR.VALIDATION_FAILED);
    expect(await refusal(() => service.createAd({ content: 'Hello', roomIds: [ROOMS.open], pinMinutes: 10, badgeId: 'love' }, ADMIN))).toBe('ok');
    ads.pinned = { enabled: false, minMinutes: 5, maxMinutes: 60 };
    expect(await refusal(() => service.createAd({ content: 'Hello', roomIds: [ROOMS.open], pinMinutes: 10 }, ADMIN))).toBe(ERR.VALIDATION_FAILED);
  });
});

const url = process.env.CHAT_TEST_DATABASE_URL;

describe.skipIf(!url)('ChatMoneyDbOperation.cancelAd (scratch database)', () => {
  let prisma: PrismaClient;
  let db: ChatMoneyDbOperation;
  const tag = ChatUtility.generateUuid().slice(-6);
  const user = ChatUtility.generateUuid();
  const roomA = ChatUtility.generateUuid();
  const roomB = ChatUtility.generateUuid();

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    db = new ChatMoneyDbOperation(prisma as never);
    const name = `adm${tag}`;
    await prisma.$executeRaw`
      INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
      VALUES (${user}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@e2e.test`}, ${`${name}@e2e.test`}, ${name})
    `;
    for (const [id, slug] of [[roomA, `adm-a-${tag}`], [roomB, `adm-b-${tag}`]] as const) {
      await prisma.$executeRaw`INSERT INTO chat.rooms (id, slug, name, type, config) VALUES (${id}::uuid, ${slug}, ${slug}, 'GLOBAL', '{}')`;
    }
  });

  afterAll(async () => prisma?.$disconnect());

  const ad = async (price: string, repeat: number, posted: number, pin: number | null, charged = true) => {
    const id = ChatUtility.generateUuid();
    await prisma.$executeRaw`
      INSERT INTO chat.chat_ads (id, creator_id, content, room_ids, pin_minutes, repeat_count, posted_count, price_usd, breakdown,
        charge_reference, status)
      VALUES (${id}::uuid, ${user}::uuid, 'x', ${[roomA, roomB]}::uuid[], ${pin}::int, ${repeat}, ${posted}, ${price}::numeric, '[]'::jsonb,
        ${charged ? `pay-${id}` : null}, 'ACTIVE')
    `;
    return id;
  };

  it('refunds the unused share, cut and never rounded', async () => {
    // 3 posts (1 made): 2/3 of 10 is 6.666…, cut to 6.66666666
    const id = await ad('10', 2, 1, null);
    expect(await db.cancelAd(id, user, null, 'UNUSED')).toEqual({ cancelled: true, refundUsd: '6.66666666' });
    expect(await db.cancelAd(id, user, null, 'UNUSED')).toEqual({ cancelled: false, refundUsd: null });
  });

  it('FULL gives the whole price, NONE gives nothing, an ad that was never charged gives nothing', async () => {
    expect((await db.cancelAd(await ad('12.5', 0, 1, null), user, null, 'FULL')).refundUsd).toBe('12.50000000');
    expect((await db.cancelAd(await ad('12.5', 0, 0, null), user, null, 'NONE')).refundUsd).toBeNull();
    expect((await db.cancelAd(await ad('12.5', 0, 0, null, false), user, null, 'UNUSED')).refundUsd).toBeNull();
  });

  it('the pinned minutes count once per ad, however many rooms, and a showing slot counts as used', async () => {
    // 1 post (made) + 10 pinned minutes in two rooms = 11 units; room A has shown 4 minutes, room B none: 6 of 11 unused.
    const id = await ad('11', 0, 1, 10);
    await prisma.$executeRaw`
      INSERT INTO chat.chat_ad_placements (id, ad_id, room_id, minutes, duration_seconds, status, starts_at, ends_at)
      VALUES (${ChatUtility.generateUuid()}::uuid, ${id}::uuid, ${roomA}::uuid, 10, 600, 'DONE', now() - interval '1 hour', now() - interval '56 minutes'),
             (${ChatUtility.generateUuid()}::uuid, ${id}::uuid, ${roomB}::uuid, 10, 600, 'QUEUED', NULL, NULL)
    `;
    // DONE counts its full 10 minutes in room A: so 0 pinned minutes are unused, only posts (0): refund 0
    expect((await db.cancelAd(id, user, null, 'UNUSED')).refundUsd).toBe('0.00000000');
    const other = await ad('11', 0, 1, 10);
    await prisma.$executeRaw`
      INSERT INTO chat.chat_ad_placements (id, ad_id, room_id, minutes, duration_seconds, status) VALUES
        (${ChatUtility.generateUuid()}::uuid, ${other}::uuid, ${roomA}::uuid, 10, 600, 'QUEUED'),
        (${ChatUtility.generateUuid()}::uuid, ${other}::uuid, ${roomB}::uuid, 10, 600, 'QUEUED')
    `;
    // nothing shown anywhere: 10 of 11 units unused, not 20 of 21
    expect((await db.cancelAd(other, user, null, 'UNUSED')).refundUsd).toBe('10.00000000');
  });
});

describe.skipIf(!url)('ChatModerationDbOperation.getBans (scratch database)', () => {
  it('shows the note kept on the ban, with no search of the moderation log (FR-092)', async () => {
    const prisma = new PrismaClient({ datasourceUrl: url });
    try {
      const tag = ChatUtility.generateUuid().slice(-6);
      const userId = ChatUtility.generateUuid();
      const admin = ChatUtility.generateUuid();
      const name = `ban${tag}`;
      await prisma.$executeRaw`
        INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
        VALUES (${userId}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@e2e.test`}, ${`${name}@e2e.test`}, ${name})
      `;
      const db = new ChatModerationDbOperation(prisma as never);
      await db.createBan({ id: ChatUtility.generateUuid(), userId, adminId: admin, internalReason: 'Internal: repeat offender', userReason: 'For the user', seconds: 3600 });
      // A different note in the log within seconds must not be picked up any more.
      await prisma.$executeRaw`
        INSERT INTO chat.moderation_actions (id, actor_type, action, target_user_id, note)
        VALUES (${ChatUtility.generateUuid()}::uuid, 'STAFF', 'staff.ban', ${userId}::uuid, 'Another ban note')
      `;
      const [ban] = await db.getBans({ limit: 5, userId: name, activeOnly: false });
      expect(ban).toMatchObject({ userReason: 'For the user', internalReason: 'Internal: repeat offender' });
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe.skipIf(!url)('ChatStaffDbOperation.setRole keeps the history of a removed role (FR-237)', () => {
  it('a removed role is marked removed, a later role is a new row, and only the live one is listed', async () => {
    const prisma = new PrismaClient({ datasourceUrl: url });
    try {
      const tag = ChatUtility.generateUuid().slice(-6);
      const userId = ChatUtility.generateUuid();
      const admin = ChatUtility.generateUuid();
      const name = `role${tag}`;
      await prisma.$executeRaw`
        INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
        VALUES (${userId}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@e2e.test`}, ${`${name}@e2e.test`}, ${name})
      `;
      const db = new ChatStaffDbOperation(prisma as never);
      const give = (role: string | null) => db.setRole({ userId, role, adminId: admin, action: role ? 'ASSIGN_ROLE' : 'REMOVE_ROLE', note: 'test' });
      expect(await give('MODERATOR')).toBeNull();
      expect(await give('SUPPORT')).toBe('MODERATOR'); // a change of role is the same live row
      expect(await give(null)).toBe('SUPPORT');
      expect((await db.getStaffRoles()).some((r) => r.userId === userId)).toBe(false);
      expect(await give(null)).toBeNull();
      expect(await give('ADMIN')).toBeNull();
      expect((await db.getStaffRoles()).find((r) => r.userId === userId)?.role).toBe('ADMIN');
      const rows = await prisma.$queryRaw<{ role: string; live: boolean; removed_by: string | null }[]>`
        SELECT role::text AS role, removed_at IS NULL AS live, removed_by::text AS removed_by FROM chat.staff_roles
        WHERE user_id = ${userId}::uuid ORDER BY assigned_at
      `;
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.live).map((r) => r.role)).toEqual(['ADMIN']);
      expect(rows.find((r) => !r.live)).toMatchObject({ role: 'SUPPORT', removed_by: admin });
    } finally {
      await prisma.$disconnect();
    }
  });
});
