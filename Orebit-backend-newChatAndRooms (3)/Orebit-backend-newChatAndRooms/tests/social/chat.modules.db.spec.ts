import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import type { PrismaService } from '../../db/client';
import { ChatDbOperation } from '../../src/social/chat/chat.dboperation';
import { ChatRecordsDbOperation } from '../../src/social/chat/persistence/chat.records.dboperation';
import { ChatStaffDbOperation } from '../../src/social/chat/persistence/chat.staff.dboperation';
import { ChatStaffQueueDbOperation } from '../../src/social/chat/persistence/chat.staff-queue.dboperation';
import { ChatMuteBlockDbOperation } from '../../src/social/chat/persistence/chat.mute-block.dboperation';
import { ChatAdDbOperation } from '../../src/social/chat/persistence/chat.ad.dboperation';
import { ChatAdPinsDbOperation, enqueuePin } from '../../src/social/chat/persistence/chat.ad-pins.dboperation';
import { ChatGiftDbOperation } from '../../src/social/chat/persistence/chat.gift.dboperation';
import { DmDbOperation } from '../../src/social/chat/dm/dm.dboperation';
import { DmMessagesDbOperation } from '../../src/social/chat/dm/dm.messages.dboperation';
import { DmInboxDbOperation } from '../../src/social/chat/dm/dm.inbox.dboperation';
import { DmGroupsDbOperation } from '../../src/social/chat/dm/dm.groups.dboperation';
import { DmGroupInvitesDbOperation } from '../../src/social/chat/dm/dm.group-invites.dboperation';
import { DmGroupBansDbOperation } from '../../src/social/chat/dm/dm.group-bans.dboperation';
import { directKey } from '../../src/social/chat/dm/dm.rules';

/**
 * The SQL of Modules 4, 5, 8 and 9 on real tables: restrictions and staff requests, mute and block, the command log,
 * ads and the pinned queue, gifts, direct messages, the inbox and groups. Runs against a MIGRATED scratch database
 * (never the development database); skipped unless CHAT_TEST_DATABASE_URL is set.
 */
const url = process.env.CHAT_TEST_DATABASE_URL;

describe.skipIf(!url)('chat Modules 4–9 on a real database', () => {
  let prisma: PrismaClient;
  let chat: ChatDbOperation;
  let records: ChatRecordsDbOperation;
  let staff: ChatStaffDbOperation;
  let queue: ChatStaffQueueDbOperation;
  let relations: ChatMuteBlockDbOperation;
  let ads: ChatAdDbOperation;
  let pins: ChatAdPinsDbOperation;
  let gifts: ChatGiftDbOperation;
  let dm: DmDbOperation;
  let dmMessages: DmMessagesDbOperation;
  let inbox: DmInboxDbOperation;
  let groups: DmGroupsDbOperation;
  let invites: DmGroupInvitesDbOperation;
  let bans: DmGroupBansDbOperation;
  const roomId = uuidv7();
  const [a, b, c] = [uuidv7(), uuidv7(), uuidv7()];
  const tag = roomId.slice(-8);

  const user = (id: string, name: string) => prisma.$executeRaw`
    INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
    VALUES (${id}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@t.test`}, ${`${name}@t.test`}, ${name})
  `;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    const p = prisma as unknown as PrismaService;
    chat = new ChatDbOperation(p);
    records = new ChatRecordsDbOperation(p);
    staff = new ChatStaffDbOperation(p);
    queue = new ChatStaffQueueDbOperation(p);
    relations = new ChatMuteBlockDbOperation(p);
    ads = new ChatAdDbOperation(p);
    pins = new ChatAdPinsDbOperation(p);
    gifts = new ChatGiftDbOperation(p);
    dm = new DmDbOperation(p);
    dmMessages = new DmMessagesDbOperation(p, dm);
    inbox = new DmInboxDbOperation(p);
    groups = new DmGroupsDbOperation(p);
    invites = new DmGroupInvitesDbOperation(p);
    bans = new DmGroupBansDbOperation(p);
    await user(a, `ma${tag}`);
    await user(b, `mb${tag}`);
    await user(c, `mc${tag}`);
    await prisma.$executeRaw`
      INSERT INTO chat.rooms (id, slug, name, type, config)
      VALUES (${roomId}::uuid, ${`m-${tag}`}, 'Modules test', 'GLOBAL', '{"contentControls":{"allowAds":true}}')
    `;
    await records.ensurePartitions(3);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  // ─── Module 4 ───────────────────────────────────────────────────────────────────────────────────────────────────
  it('restrictions: live ones are listed, lifted and expired ones are not', async () => {
    const live = await staff.createRestriction(prisma, {
      targetType: 'USER',
      targetValue: b,
      kind: 'RESTRICT_COMMANDS',
      commands: ['ad'],
      roomId: null,
      internalReason: 'Ad spam',
      createdBy: a,
      createdByRole: 'MODERATOR',
      hours: 2,
    });
    const lifted = await staff.createRestriction(prisma, {
      targetType: 'KYC',
      targetValue: '-',
      kind: 'RESTRICT_DM',
      commands: [],
      roomId,
      internalReason: 'x',
      createdBy: a,
      createdByRole: 'ADMIN',
      hours: null,
    });
    expect(live.expiresAt).not.toBeNull();
    expect(await staff.liftRestriction(prisma, lifted.id, a)).toBe(true);
    expect(await staff.liftRestriction(prisma, lifted.id, a)).toBe(false);
    const ids = (await staff.activeRestrictions()).map((r) => r.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(lifted.id);
    expect((await staff.restrictionById(live.id))?.commands).toEqual(['ad']);
  });

  it('staff requests: created pending, claimed once, reopened on failure', async () => {
    const { id } = await staff.createRequest({
      requesterId: c,
      requesterRole: 'SUPPORT',
      permission: 'BAN',
      targetUserId: b,
      targetRoomId: roomId,
      payload: { durationHours: 2 },
      note: 'Please ban, spamming',
    });
    const pending = await staff.requests({ status: 'PENDING', limit: 50, before: null });
    expect(pending.find((r) => r.id === id)).toMatchObject({
      permission: 'BAN',
      requesterRole: 'SUPPORT',
    });
    expect(await staff.resolveRequest(id, 'APPROVED', a, 'ok')).toBe(true);
    expect(await staff.resolveRequest(id, 'REJECTED', a, null)).toBe(false);
    await staff.reopenRequest(id);
    expect((await staff.requestById(id))?.status).toBe('PENDING');
  });

  it('role lookup, room access and room config written by staff', async () => {
    // Roles are given in the admin panel only (FR-002): the test writes the row the panel would.
    await prisma.$executeRaw`INSERT INTO chat.staff_roles (user_id, role, assigned_by) VALUES (${c}::uuid, 'MODERATOR'::chat."StaffRole", ${a}::uuid)`;
    expect((await chat.findChatUser(c))?.staffRole).toBe('MODERATOR');
    await staff.setRoomAccess(prisma, roomId, b, 'REMOVE', a);
    expect(await chat.excludedRoomIds(b)).toContain(roomId);
    await staff.setRoomAccess(prisma, roomId, b, 'ADD', a);
    expect(await chat.excludedRoomIds(b)).not.toContain(roomId);
    expect(await chat.includedRoomIds(b)).toContain(roomId);
    await staff.setRoomAccess(prisma, roomId, b, 'RESTORE', a);
    expect(await chat.excludedRoomIds(b)).not.toContain(roomId);
    expect(await chat.includedRoomIds(b)).not.toContain(roomId);
    const before = await staff.patchRoomConfig(prisma, roomId, {
      status: 'MAINTENANCE',
      statusNote: 'Brb',
    });
    expect(before).toEqual({ status: null, statusNote: null });
    expect(await staff.patchRoomConfig(prisma, uuidv7(), { status: 'ACTIVE' })).toBeNull();
    await staff.patchRoomConfig(prisma, roomId, { status: 'ACTIVE' });
  });

  it("staff history: a user's messages and tags within the day window", async () => {
    const { row } = await chat.insertMessage({
      roomId,
      userId: b,
      content: `hey @ma${tag}`,
      type: 'TEXT',
      skinId: null,
      metadata: { taggedUsernames: [`ma${tag}`] },
      taggedUserIds: [a],
    });
    expect((await queue.userMessages(b, 1, 10, null)).map((m) => m.id)).toContain(row.id);
    expect((await queue.userTags(a, 1, 10, null)).map((m) => m.id)).toContain(row.id);
    expect((await queue.roomMessages(roomId, 1, 10, null)).map((m) => m.id)).toContain(row.id);
    const report = await records.insertReport({
      messageId: row.id,
      messageCreatedAt: row.createdAtText,
      reporterId: a,
      reportedUserId: b,
      reason: 'SPAM',
      details: null,
    });
    if (report) {
      const listed = await queue.reports({ status: 'PENDING', limit: 50, before: null });
      expect(listed.find((r) => r.id === report.id)?.room_id).toBe(roomId);
      expect(await queue.resolveReport(report.id, 'WARN', c)).toBe(true);
      expect((await queue.reportById(report.id))?.status).toBe('ACTIONED');
    }
  });

  // ─── Module 5 ───────────────────────────────────────────────────────────────────────────────────────────────────
  it('mute and block: idempotent, both directions, hidden authors', async () => {
    expect(await relations.add('mutes', a, b, 1000)).toBe('ADDED');
    expect(await relations.add('mutes', a, b, 1000)).toBe('EXISTS');
    expect(await relations.add('blocks', b, c, 1000)).toBe('ADDED');
    expect(await relations.hiddenAuthorIds(a)).toEqual([b]);
    expect(await relations.relation(c, b)).toEqual({
      iMuted: false,
      iBlocked: false,
      mutedMe: false,
      blockedMe: true,
    });
    expect([...(await relations.blockedEitherWay(c, [a, b]))]).toEqual([b]);
    expect((await relations.list('mutes', a, 10, null)).map((e) => e.userId)).toEqual([b]);
    expect(await relations.remove('mutes', a, b)).toBe(true);
    expect(await relations.remove('blocks', b, c)).toBe(true);
    await expect(relations.add('mutes', a, a, 1000)).rejects.toThrow();
  });

  it('removing a mute, block, room-access entry or chat role marks it removed; it is never erased (FR-237)', async () => {
    // Mute: add, remove, add again, remove: two rows of history, none live, and the cap does not count removed ones.
    expect(await relations.add('mutes', b, a, 1)).toBe('ADDED');
    expect(await relations.remove('mutes', b, a)).toBe(true);
    expect(await relations.remove('mutes', b, a)).toBe(false);
    expect(await relations.hiddenAuthorIds(b)).not.toContain(a);
    expect((await relations.relation(b, a)).iMuted).toBe(false);
    expect(await relations.add('mutes', b, a, 1)).toBe('ADDED');
    expect(await relations.remove('mutes', b, a)).toBe(true);
    const mutes = await prisma.$queryRaw<{ removed_by: string | null; live: boolean }[]>`
      SELECT removed_by, removed_at IS NULL AS live FROM chat.user_mutes WHERE user_id = ${b}::uuid AND target_id = ${a}::uuid
    `;
    expect(mutes).toHaveLength(2);
    expect(mutes.every((row) => !row.live && row.removed_by === b)).toBe(true);
    expect((await relations.list('mutes', b, 10, null)).map((e) => e.userId)).not.toContain(a);
    // Block: a removed block no longer blocks either way.
    expect(await relations.add('blocks', b, a, 5)).toBe('ADDED');
    expect([...(await relations.blockedEitherWay(a, [b]))]).toEqual([b]);
    expect(await relations.remove('blocks', b, a)).toBe(true);
    expect([...(await relations.blockedEitherWay(a, [b]))]).toEqual([]);

    // Room access: a REMOVE then a RESTORE leaves the REMOVE on record, marked removed by whoever restored.
    await staff.setRoomAccess(prisma, roomId, c, 'REMOVE', a);
    expect(await chat.excludedRoomIds(c)).toContain(roomId);
    await staff.setRoomAccess(prisma, roomId, c, 'RESTORE', b);
    expect(await chat.excludedRoomIds(c)).not.toContain(roomId);
    const [history] = await prisma.$queryRaw<{ n: number; by: string | null }[]>`
      SELECT count(*)::int AS n, max(removed_by::text) AS by FROM chat.room_excluded_users
      WHERE room_id = ${roomId}::uuid AND user_id = ${c}::uuid AND removed_at IS NOT NULL
    `;
    expect(history).toEqual({ n: 1, by: b });
  });

  it('a mute or block list stops at its cap, also when the adds arrive together (FR-183)', async () => {
    // c has never muted anyone; the cap is 1.
    expect(await relations.add('mutes', c, a, 1)).toBe('ADDED');
    expect(await relations.add('mutes', c, a, 1)).toBe('EXISTS');
    expect(await relations.add('mutes', c, b, 1)).toBe('FULL');
    expect(await relations.remove('mutes', c, a)).toBe(true);
    const raced = await Promise.all([relations.add('blocks', a, b, 1), relations.add('blocks', a, c, 1)]);
    expect(raced.sort()).toEqual(['ADDED', 'FULL']);
    // A list is counted per user and per kind.
    expect(await relations.add('mutes', a, b, 1)).not.toBe('FULL');
  });

  it('the command log and AD and GIFT message types', async () => {
    await records.logCommand({
      userId: a,
      roomId,
      command: 'mute',
      args: { targetId: b },
      result: 'EXECUTED',
      reason: null,
    });
    const { row } = await chat.insertMessage({
      roomId,
      userId: a,
      content: 'Buy now',
      type: 'AD',
      skinId: null,
      metadata: { ad: { adId: uuidv7() } },
      taggedUserIds: [],
    });
    expect(row.type).toBe('AD');
  });

  const newAd = (id: string, patch: Partial<Parameters<ChatAdDbOperation['insertAd']>[1]> = {}) =>
    ads.insertAd(prisma, {
      id,
      creatorId: a,
      content: 'Ad',
      roomIds: [roomId],
      allRooms: false,
      pinMinutes: 5,
      repeatCount: 1,
      repeatGapMin: 1,
      hiddenCountries: ['US'],
      badgeId: null,
      skinId: null,
      priceUsd: '10',
      breakdown: [],
      chargeReference: `ref-${id}`,
      status: 'ACTIVE',
      idempotencyKey: `key-${id}`,
      requestFingerprint: 'fp',
      ...patch,
    });

  it('ads: one pinned slot per room at a time, repeats on the database clock, cancel and refund', async () => {
    const first = uuidv7();
    const second = uuidv7();
    for (const id of [first, second]) {
      await newAd(id);
      await enqueuePin(prisma, id, roomId, 5);
    }
    expect((await pins.queueLengths([roomId])).get(roomId)).toBe(2);
    const started = await pins.startQueuedPins();
    expect(started.filter((x) => x.roomId === roomId).map((x) => x.adId)).toEqual([first]);
    expect((await pins.startQueuedPins()).filter((x) => x.roomId === roomId)).toEqual([]);
    expect((await pins.activePin(roomId))?.ad_id).toBe(first);

    // The first slot ends; the next one starts.
    await prisma.$executeRaw`UPDATE chat.chat_ad_placements SET ends_at = now() - interval '1 second' WHERE ad_id = ${first}::uuid`;
    expect((await pins.endExpiredPins()).map((x) => x.adId)).toContain(first);
    expect((await pins.startQueuedPins()).filter((x) => x.roomId === roomId).map((x) => x.adId)).toEqual([second]);

    // An ACTIVE ad is due its first post at once; posting counts only from the number it was claimed at.
    expect((await ads.claimDueRepeats(10, 600, first)).map((x) => x.id)).toContain(first);
    expect(await ads.recordPosted(first, 0)).toBe(true);
    expect(await ads.recordPosted(first, 0)).toBe(false);
    const ad = await ads.adById(first);
    expect(ad).toMatchObject({ postedCount: 1, status: 'ACTIVE' });
    expect(ad?.nextPostAt).not.toBeNull();
    await prisma.$executeRaw`UPDATE chat.chat_ads SET next_post_at = now() - interval '1 second' WHERE id = ${first}::uuid`;
    expect((await ads.claimDueRepeats(10, 600, first)).map((x) => x.id)).toContain(first);
    expect(await ads.recordPosted(first, 1)).toBe(true);
    expect((await ads.adById(first))?.nextPostAt).toBeNull();
    await ads.completeFinished();
    expect((await ads.adById(first))?.status).toBe('COMPLETED');

    // The refund is worked out inside the cancel, from the locked ad.
    const cancelled = await ads.cancel(second, a, 'stop', (locked) => (locked.chargeReference ? '4.5' : null), 'USDT');
    expect(cancelled).toEqual({ cancelled: true, unpinnedRoomIds: [roomId], refundUsd: '4.5' });
    expect((await ads.claimRefundsDue(10, 600)).map((x) => x.id)).toContain(second);
    expect(await ads.markRefunded(second)).toBe(true);
    expect(await ads.markRefunded(second)).toBe(false);
    const done = await ads.adById(second);
    expect(done).toMatchObject({ status: 'REFUNDED', refundCurrency: 'USDT' });
    expect((await ads.adsByCreator(a, 10, null)).length).toBeGreaterThanOrEqual(2);
  });

  it('ads: a key buys once, a reference is unique, a room shows one ACTIVE slot (FR-016, FR-182)', async () => {
    const id = uuidv7();
    const key = `key-once-${id}`;
    await newAd(id, { status: 'PENDING_PAYMENT', chargeReference: null, idempotencyKey: key });
    expect((await ads.adByKey(a, key))?.id).toBe(id);
    expect(await ads.adByKey(b, key)).toBeNull();
    await expect(newAd(uuidv7(), { idempotencyKey: key })).rejects.toThrow();
    await expect(newAd(uuidv7(), { chargeReference: `ref-${id}` })).resolves.toBeUndefined(); // no row holds that one yet
    // PENDING_PAYMENT → ACTIVE once, and only once.
    expect(await ads.activate(id, `paid-${id}`)).toBe(true);
    expect(await ads.activate(id, `paid-again-${id}`)).toBe(false);
    expect(await ads.fail(id, 'late')).toBe(false);
    expect(await ads.adById(id)).toMatchObject({ status: 'ACTIVE', chargeReference: `paid-${id}` });
    await expect(newAd(uuidv7(), { chargeReference: `paid-${id}` })).rejects.toThrow();

    // A failed ad gives up its queued slots at once.
    const failed = uuidv7();
    await newAd(failed, { status: 'PENDING_PAYMENT', chargeReference: null });
    await enqueuePin(prisma, failed, roomId, 5);
    const before = (await pins.queueLengths([roomId])).get(roomId) ?? 0;
    expect(await ads.fail(failed, 'refused')).toBe(true);
    expect((await pins.queueLengths([roomId])).get(roomId) ?? 0).toBe(before - 1);
    expect(await ads.adById(failed)).toMatchObject({ status: 'FAILED', failureReason: 'refused' });

    // Two ACTIVE slots in one room are refused by the database itself.
    const room = uuidv7();
    await prisma.$executeRaw`INSERT INTO chat.rooms (id, slug, name, type, config) VALUES (${room}::uuid, ${'s-' + room}, 'Pin room', 'GLOBAL', '{}'::jsonb)`;
    const x = uuidv7();
    const y = uuidv7();
    await newAd(x, { roomIds: [room] });
    await newAd(y, { roomIds: [room] });
    await enqueuePin(prisma, x, room, 5);
    await enqueuePin(prisma, y, room, 5);
    await prisma.$executeRaw`UPDATE chat.chat_ad_placements SET status = 'ACTIVE', starts_at = now(), ends_at = now() + interval '5 minutes' WHERE ad_id = ${x}::uuid`;
    await expect(
      prisma.$executeRaw`UPDATE chat.chat_ad_placements SET status = 'ACTIVE', starts_at = now(), ends_at = now() + interval '5 minutes' WHERE ad_id = ${y}::uuid`,
    ).rejects.toThrow();
  });

  it('claims: two workers never take the same ad repeat, refund or pending payment; a dead worker is taken over', async () => {
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    for (const id of ids) await newAd(id, { pinMinutes: null, repeatCount: 0 });
    // The shared scratch database holds other runs' ads; only this test's three are due.
    await prisma.$executeRaw`UPDATE chat.chat_ads SET next_post_at = NULL WHERE id <> ALL(${ids}::uuid[])`;
    const [one, two] = await Promise.all([ads.claimDueRepeats(2, 600), ads.claimDueRepeats(2, 600)]);
    const mine = new Set(ids);
    const claimed = [...one, ...two].map((row) => row.id).filter((id) => mine.has(id));
    expect(new Set(claimed).size).toBe(claimed.length);
    // A claim that is not stale is not taken again; an old one is.
    const held = claimed[0]!;
    expect((await ads.claimDueRepeats(50, 600)).map((row) => row.id)).not.toContain(held);
    await prisma.$executeRaw`UPDATE chat.chat_ads SET claimed_at = now() - interval '2 hours' WHERE id = ${held}::uuid`;
    expect((await ads.claimDueRepeats(50, 600)).map((row) => row.id)).toContain(held);
    for (const id of ids) await ads.cancel(id, a, null, () => null);
  });

  it('gifts: claimed once, only before they expire', async () => {
    const id = uuidv7();
    await gifts.insert({
      id,
      senderId: a,
      recipientId: b,
      currency: 'USDT',
      amount: '10.50',
      usdValue: '10.5',
      feeAmount: '0',
      roomId,
      conversationId: null,
      verification: 'TWO_FA',
      minutes: 10,
    });
    expect(await gifts.byId(id)).toMatchObject({
      amount: '10.5',
      status: 'PENDING_VERIFICATION',
      expired: false,
    });
    expect(await gifts.claim(id)).toBe(true);
    expect(await gifts.claim(id)).toBe(false);
    expect(await gifts.finish(id, 'COMPLETED', `ref-${id}`, null)).toBe(true);
    // Settled once: a second answer changes nothing.
    expect(await gifts.finish(id, 'FAILED', null, 'late')).toBe(false);
    expect((await gifts.byId(id))?.status).toBe('COMPLETED');
    const late = uuidv7();
    await gifts.insert({
      id: late,
      senderId: a,
      recipientId: b,
      currency: 'BTC',
      amount: '0.1',
      usdValue: '1',
      feeAmount: '0',
      roomId: null,
      conversationId: null,
      verification: 'PAYMENT_PIN',
      minutes: 0,
    });
    expect(await gifts.claim(late)).toBe(false);
    expect(await gifts.cancel(late, a)).toBe(true);
  });

  // ─── Module 8 ───────────────────────────────────────────────────────────────────────────────────────────────────
  it('direct conversations: one per pair, folders and requests per member', async () => {
    const key = directKey(a, b);
    const direct = async (data: Parameters<typeof dm.createDirect>[0]) => {
      const result = await dm.createDirect(data);
      if ('limited' in result) throw new Error('the new-DM limit was reached');
      return result;
    };
    const made = await direct({
      key,
      createdBy: a,
      members: [
        { userId: a, folder: 'PRIMARY', state: 'ACTIVE' },
        { userId: b, folder: 'GENERAL', state: 'REQUEST' },
      ],
    });
    const again = await direct({
      key,
      createdBy: b,
      members: [
        { userId: b, folder: 'PRIMARY', state: 'ACTIVE' },
        { userId: a, folder: 'GENERAL', state: 'ACTIVE' },
      ],
    });
    expect(made.created).toBe(true);
    expect(again).toEqual({ id: made.id, created: false });
    expect(await dm.newDirectCount(a, 1)).toBe(1);
    expect((await dm.member(made.id, b))?.state).toBe('REQUEST');

    const clientId = uuidv7();
    const sent = await dmMessages.insertMessage({
      conversationId: made.id,
      senderId: a,
      content: 'hello there friend',
      type: 'TEXT',
      metadata: { links: [] },
      clientMessageId: clientId,
    });
    const retry = await dmMessages.insertMessage({
      conversationId: made.id,
      senderId: a,
      content: 'hello there friend',
      type: 'TEXT',
      metadata: {},
      clientMessageId: clientId,
    });
    expect(retry).toMatchObject({ duplicate: true, row: { id: sent.row.id } });
    await dmMessages.insertMessage({
      conversationId: made.id,
      senderId: a,
      content: 'photo',
      type: 'MEDIA',
      metadata: {
        media: { type: 'image', url: 'http://x/social/chat/media/1' },
        links: ['orebit.io'],
      },
    });

    expect(
      (await inbox.conversations(b, 'REQUESTS', 10, null)).map((r) => r.conversationId),
    ).toContain(made.id);
    const primary = await inbox.conversations(a, 'PRIMARY', 10, null);
    expect(primary.find((r) => r.conversationId === made.id)).toMatchObject({
      otherUserId: b,
      unread: 0,
    });
    expect((await inbox.unreadSummary(b)).REQUESTS).toBe(1);

    expect(await dmMessages.markRead(made.id, b, sent.row.id)).not.toBeNull();
    expect(await dmMessages.markRead(made.id, b, sent.row.id)).toBeNull();
    expect((await dmMessages.history(made.id, 10, null, null)).length).toBe(2);
    expect((await dmMessages.search(a, 'there FRIEND', null, 10, null)).map((m) => m.id)).toEqual([
      sent.row.id,
    ]);
    expect((await dmMessages.shared(made.id, 'media', 10, null, null)).length).toBe(1);
    expect((await dmMessages.shared(made.id, 'links', 10, null, null)).length).toBe(1);

    expect(await dmMessages.setPinned(sent.row.id, a)).toBe(true);
    expect((await dmMessages.pinnedMessages(made.id)).map((m) => m.id)).toEqual([sent.row.id]);
    expect(await dmMessages.retract(sent.row.id, a)).not.toBeNull();
    expect(await dmMessages.retract(sent.row.id, a)).toBeNull();

    await dm.updateMember(made.id, b, {
      state: 'ACTIVE',
      folder: 'GENERAL',
      pinned: true,
      nickname: 'Ada',
    });
    expect(await dm.pinnedPeople(b, 'GENERAL')).toBe(1);
    expect((await dm.member(made.id, b))?.nickname).toBe('Ada');

    const report = await records.insertDmReport({
      dmMessageId: sent.row.id,
      reporterId: b,
      reportedUserId: a,
      reason: 'SPAM',
      details: null,
    });
    expect(report).not.toBeNull();
    expect(
      await records.insertDmReport({
        dmMessageId: sent.row.id,
        reporterId: b,
        reportedUserId: a,
        reason: 'SPAM',
        details: null,
      }),
    ).toBeNull();
  });

  it('privacy preferences: NULL until set, then stored', async () => {
    expect((await inbox.prefs([c])).get(c)?.lastSeenVisibility).toBeNull();
    await inbox.savePrefs(c, {
      lastSeenVisibility: 'NOBODY',
      quietMode: 'CUSTOM',
      quietStart: '23:00',
      timeZone: 'Asia/Kolkata',
    });
    expect((await inbox.prefs([c])).get(c)).toMatchObject({
      lastSeenVisibility: 'NOBODY',
      quietStart: '23:00',
    });
  });

  // ─── Module 9 ───────────────────────────────────────────────────────────────────────────────────────────────────
  it('groups: owner, invites, counts, bans, common groups and an ownership transfer', async () => {
    const groupId = await groups.createGroup({
      ownerId: a,
      name: `G ${tag}`,
      description: null,
      logoUrl: null,
      visibility: 'PUBLIC',
    });
    expect(await groups.group(groupId)).toMatchObject({
      ownerId: a,
      creatorId: a,
      visibility: 'PUBLIC',
      membersCanText: true,
    });
    expect(await groups.createdCount(a, 'PUBLIC')).toBe(1);
    expect((await dm.member(groupId, a))?.role).toBe('OWNER');

    const limits = { perWindow: 2, windowHours: 1, pendingPerPerson: 1, expiryHours: 24 };
    const made = await invites.createInvite(groupId, a, b, limits);
    if ('refused' in made) throw new Error('the invite was refused');
    const inviteId = made.inviteId;
    // V2-121: asking again gives the same invite; a second group's invite hits the pending cap.
    expect(await invites.createInvite(groupId, a, b, limits)).toEqual({ inviteId });
    const other = await groups.createGroup({ ownerId: a, name: `H ${tag}`, description: null, logoUrl: null, visibility: 'PRIVATE' });
    expect(await invites.createInvite(other, a, b, limits)).toEqual({ refused: 'pending_cap' });
    expect(await invites.createInvite(other, a, c, { ...limits, perWindow: 1 })).toEqual({ refused: 'window_limit' });
    expect((await invites.pendingInvite(groupId, b))?.id).toBe(inviteId);
    expect((await invites.invitesFor(b)).map((i) => i.id)).toContain(inviteId);
    expect(await invites.answerInvite(inviteId, 'ACCEPTED')).toBe(true);
    expect(await invites.answerInvite(inviteId, 'DECLINED')).toBe(false);
    await dm.insertMember(groupId, b, { folder: 'GROUPS', state: 'ACTIVE', role: 'MEMBER' });
    await dm.insertMember(groupId, c, { folder: 'GROUPS', state: 'ACTIVE', role: 'MEMBER' });
    expect(await groups.memberCount(groupId)).toBe(3);
    expect(await groups.joinedCount(b, 'PUBLIC')).toBe(1);
    expect((await inbox.commonGroups(a, b)).map((g) => g.id)).toEqual([groupId]);
    expect((await groups.publicGroups(c, tag, 10, null)).map((g) => g.id)).toContain(groupId);

    await groups.updateGroup(groupId, {
      permissions: { RENAME: 'MEMBER' },
      membersCanText: false,
      visibility: 'PRIVATE',
    });
    expect(await groups.group(groupId)).toMatchObject({
      permissions: { RENAME: 'MEMBER' },
      membersCanText: false,
      visibility: 'PRIVATE',
    });
    // V2-50: a type change still counts by the type the group was created as.
    expect(await groups.createdCount(a, 'PUBLIC')).toBe(1);
    // Only the private group made above for the invite check counts as private; the type change added nothing.
    expect(await groups.createdCount(a, 'PRIVATE')).toBe(1);

    await bans.banMember(groupId, c, { userId: a, role: 'OWNER' }, 'spam');
    expect(await bans.isBanned(groupId, c)).toBe(true);
    expect((await dm.member(groupId, c))?.state).toBe('BANNED');
    // FR-203: only a role not below the banner lifts the ban.
    expect(await bans.unban(groupId, c, 'ADMIN', b)).toBe('outranked');
    expect(await bans.unban(groupId, c, 'OWNER', a)).toBe('ok');
    expect(await bans.unban(groupId, c, 'OWNER', a)).toBe('not_banned');
    // FR-237: the ban is marked removed (and by whom), not erased; a new ban can follow it.
    const [gone] = await prisma.$queryRaw<{ removed_by: string | null }[]>`
      SELECT removed_by FROM chat.dm_group_bans WHERE conversation_id = ${groupId}::uuid AND user_id = ${c}::uuid AND removed_at IS NOT NULL
    `;
    expect(gone!.removed_by).toBe(a);
    expect(await bans.isBanned(groupId, c)).toBe(false);
    await dm.insertMember(groupId, c, { folder: 'GROUPS', state: 'ACTIVE', role: 'MEMBER' });

    await dm.updateMember(groupId, c, { timeoutMinutes: 5 });
    expect((await dm.member(groupId, c))?.timeoutUntil).not.toBeNull();
    await dm.updateMember(groupId, c, { timeoutMinutes: null });
    expect((await dm.member(groupId, c))?.timeoutUntil).toBeNull();

    // V2-144: ownership moves at once, no code; one OWNER at all times; x times in y hours.
    expect(await groups.transferOwnership(groupId, a, b, { count: 1, windowHours: 24 })).toEqual({ ok: true });
    expect(await groups.transferOwnership(groupId, a, b, { count: 1, windowHours: 24 })).toEqual({
      ok: false,
      reason: 'not_owner',
    });
    expect((await groups.group(groupId))?.ownerId).toBe(b);
    expect((await dm.member(groupId, a))?.role).toBe('ADMIN');
    expect((await dm.member(groupId, b))?.role).toBe('OWNER');
    expect(await groups.transferOwnership(groupId, b, a, { count: 1, windowHours: 24 })).toEqual({
      ok: false,
      reason: 'limit',
    });

    const hidden = await dmMessages.insertMessage({
      conversationId: groupId,
      senderId: c,
      content: 'oops',
      type: 'TEXT',
      metadata: {},
    });
    expect(await dmMessages.hide(hidden.row.id, b)).toBe(true);
    expect((await dmMessages.messageById(hidden.row.id))?.hiddenAt).not.toBeNull();
    expect(
      (await inbox.conversations(c, 'GROUPS', 10, null)).map((r) => r.conversationId),
    ).toContain(groupId);
  });

  it('test follows (NEW-2) are read for several users at once', async () => {
    await prisma.$executeRaw`
      INSERT INTO chat.test_entitlements (user_id, follows) VALUES (${a}::uuid, ARRAY[${b}::uuid])
      ON CONFLICT (user_id) DO UPDATE SET follows = EXCLUDED.follows
    `;
    expect((await records.testFollows([a, b])).get(a)).toEqual([b]);
  });
});
