import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { GLOBAL_ROOM_ID } from '../../src/social/chat/chat.constants';
import { ChatAccessService } from '../../src/social/chat/chat.access.service';
import { ChatSettingsDocumentSchema } from '../../src/social/chat/chat.settings.contract';
import type { ChatUserContext } from '../../src/social/chat/chat.types';
import { ChatBus } from '../../src/social/chat/realtime/chat.bus';
import { ChatRelationsService } from '../../src/social/chat/services/chat.relations.service';
import { DmService } from '../../src/social/chat/dm/dm.service';
import { DmSignalsService } from '../../src/social/chat/dm/dm.signals.service';
import { DmCardsService } from '../../src/social/chat/dm/dm.cards.service';
import { DmInboxService } from '../../src/social/chat/dm/dm.inbox.service';
import { DmGroupsService } from '../../src/social/chat/dm/dm.groups.service';
import { DmGroupInvitesService } from '../../src/social/chat/dm/dm.groups.invites.service';
import { DmGroupsModerationService } from '../../src/social/chat/dm/dm.groups.moderation.service';
import { DmDbOperation } from '../../src/social/chat/dm/dm.dboperation';
import { DmMessagesDbOperation } from '../../src/social/chat/dm/dm.messages.dboperation';
import { DmGroupsDbOperation } from '../../src/social/chat/dm/dm.groups.dboperation';
import { bootChat, makeUsers, READY, refusal, type Emitted } from './chat.e2e.harness';

/**
 * Modules 8–9, the last open items on the REAL services and a migrated scratch database: public-group auto-moderation
 * (V2-51), coalesced join/leave lines (FR-131), the follow event (FR-200), the typing pace setting (FR-125), gift cards
 * (FR-269), the merchant message cap (V2-113/114), retry de-duplication on the partitioned table (FR-060), the group
 * member counter, the archive notice and the paged inbox (FR-201).
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run --config vitest.chat.config.ts \
 *     tests/social/chat.dm-complete.e2e.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;
const IP = '10.0.0.1';
const NAMES = ['ada', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus', 'hal', 'ivy', 'jon', 'kim', 'lee', 'mia', 'nat', 'oli'] as const;
type Name = (typeof NAMES)[number];
type Patch = { dm?: Record<string, unknown>; groups?: Record<string, unknown> };

describe.skipIf(!url)('chat Modules 8–9 completion (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  const emitted: Emitted[] = [];
  const tag = uuidv7().slice(-6);
  const u = {} as Record<Name, ChatUserContext>;
  let document: unknown;
  let dm: DmService;
  let signals: DmSignalsService;
  let cards: DmCardsService;
  let inbox: DmInboxService;
  let groups: DmGroupsService;
  let groupInvites: DmGroupInvitesService;
  let admin: DmGroupsModerationService;
  let dmDb: DmDbOperation;
  let dmMessagesDb: DmMessagesDbOperation;
  let groupsDb: DmGroupsDbOperation;

  const settings = (patch: Patch = {}) => {
    document = ChatSettingsDocumentSchema.parse({
      global: {
        testProviders: { enabled: true },
        commands: { enabled: true, disabled: [] },
        gifts: { enabled: true },
        limits: { messagesPerWindow: 100, messageWindowSeconds: 1, mediaCooldownSeconds: 0 },
        dm: { ...READY.dm, ...patch.dm },
        groups: { ...READY.groups, maxCreatePublic: 100, maxCreatePrivate: 100, maxJoinPublic: 100, maxJoinPrivate: 100, ...patch.groups },
        privacy: { ...READY.privacy },
      },
    });
  };
  const msg = (content: string, clientMessageId?: string) => ({ content, ...(clientMessageId ? { clientMessageId } : {}) });
  const sent = (event: string) => emitted.filter((e) => e.event === event);
  const publicGroup = async (owner: Name, ...members: Name[]) => {
    const { groupId } = await groups.create(u[owner], { name: `C${uuidv7().slice(-5)}`, visibility: 'PUBLIC' });
    for (const m of members) await groups.join(u[m], groupId);
    return groupId;
  };

  beforeAll(async () => {
    settings();
    ({ prisma, module } = await bootChat(url!, emitted, () => document));
    dm = module.get(DmService);
    signals = module.get(DmSignalsService);
    cards = module.get(DmCardsService);
    inbox = module.get(DmInboxService);
    groups = module.get(DmGroupsService);
    groupInvites = module.get(DmGroupInvitesService);
    admin = module.get(DmGroupsModerationService);
    dmDb = module.get(DmDbOperation);
    dmMessagesDb = module.get(DmMessagesDbOperation);
    groupsDb = module.get(DmGroupsDbOperation);
    Object.assign(u, await makeUsers(prisma, NAMES, tag));
  }, 60_000);

  beforeEach(() => settings());

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  // ─── V2-51 ────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('a public group gets the public chat\'s auto-moderation on its name, description and messages; a private one does not', async () => {
    const before = await prisma.$queryRaw<{ config: unknown }[]>`SELECT config FROM chat.rooms WHERE id = ${GLOBAL_ROOM_ID}::uuid`;
    const config = JSON.stringify({ contentControls: { autoModeration: true }, bannedWords: ['forbiddenword'] });
    await prisma.$executeRaw`
      INSERT INTO chat.rooms (id, slug, name, type, config) VALUES (${GLOBAL_ROOM_ID}::uuid, 'global-e2e', 'Global', 'GLOBAL', ${config}::jsonb)
      ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config
    `;
    await module.get(ChatAccessService).reloadRooms();
    try {
      expect(await refusal(() => groups.create(u.ada, { name: 'my forbiddenword group', visibility: 'PUBLIC' }))).toBe('content_blocked');
      expect(
        await refusal(() => groups.create(u.ada, { name: 'fine name', description: 'a FORBIDDENWORD here', visibility: 'PUBLIC' })),
      ).toBe('content_blocked');
      expect(await refusal(() => groups.create(u.ada, { name: 'private forbiddenword club', visibility: 'PRIVATE' }))).toBe('ok');

      const gid = await publicGroup('bob', 'cat');
      expect(await refusal(() => dm.send(u.cat, gid, msg('say forbiddenword now'), IP))).toBe('content_blocked');
      expect(await refusal(() => dm.send(u.cat, gid, msg('a clean message'), IP))).toBe('ok');
      // Renaming to a banned word is refused too.
      expect(await refusal(() => groups.update(u.bob, gid, { name: 'forbiddenword' }))).toBe('content_blocked');

      const { groupId } = await groups.create(u.dan, { name: `P${uuidv7().slice(-5)}`, visibility: 'PRIVATE' });
      await groupInvites.invite(u.dan, groupId, [u.eve.username]);
      const invite = (await groupInvites.invites(u.eve)).items.find((i) => i.groupId === groupId)!;
      await groupInvites.respondToInvite(u.eve, invite.id, true);
      expect(await refusal(() => dm.send(u.eve, groupId, msg('forbiddenword in private'), IP))).toBe('ok');
    } finally {
      const previous = before[0]?.config ?? { contentControls: {}, bannedWords: [] };
      await prisma.$executeRaw`UPDATE chat.rooms SET config = ${JSON.stringify(previous)}::jsonb WHERE id = ${GLOBAL_ROOM_ID}::uuid`;
      await module.get(ChatAccessService).reloadRooms();
    }
  });

  // ─── FR-131 ───────────────────────────────────────────────────────────────────────────────────────────────────────
  it('people joining close together are one line whose counts grow, announced as an update', async () => {
    const { groupId } = await groups.create(u.fay, { name: `N${uuidv7().slice(-5)}`, visibility: 'PUBLIC' });
    emitted.length = 0;
    for (const who of ['gus', 'hal', 'ivy'] as const) await groups.join(u[who], groupId);
    await groups.leave(u.ivy, groupId);
    const lines = await prisma.$queryRaw<{ metadata: { event: { joined: number; left: number } } }[]>`
      SELECT metadata FROM chat.dm_messages WHERE conversation_id = ${groupId}::uuid AND metadata #>> '{event,kind}' = 'membership'
    `;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.metadata.event).toMatchObject({ joined: 3, left: 1 });
    expect(sent('dm_message_updated').length).toBeGreaterThanOrEqual(1);
    // None of these lines is unread for anyone.
    expect((await inbox.unread(u.fay)).groups).toBe(0);
  });

  // ─── FR-200 ───────────────────────────────────────────────────────────────────────────────────────────────────────
  it('the Social module\'s follow event moves the direct chat into the right folder', async () => {
    const opened = await dm.openDirect(u.jon, u.kim.username, msg('hello kim'), IP);
    const cid = opened.conversationId;
    expect(await dmDb.member(cid, u.kim.id)).toMatchObject({ state: 'REQUEST' });
    await prisma.$executeRaw`
      INSERT INTO chat.test_entitlements (user_id, follows) VALUES (${u.kim.id}::uuid, ARRAY[${u.jon.id}::uuid])
      ON CONFLICT (user_id) DO UPDATE SET follows = EXCLUDED.follows
    `;
    module.get(ChatBus).publish({ kind: 'follow', userA: u.kim.id, userB: u.jon.id });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await dmDb.member(cid, u.kim.id)).toMatchObject({ state: 'ACTIVE', folder: 'PRIMARY' });
  });

  // ─── FR-125 ───────────────────────────────────────────────────────────────────────────────────────────────────────
  it('the typing pace is the admin\'s number', async () => {
    settings({ dm: { typingEverySeconds: 30 } });
    const opened = await dm.openDirect(u.lee, u.mia.username, msg('typing pace'), IP);
    await dm.respondToRequest(u.mia, opened.conversationId, true);
    expect(await signals.typing(u.lee, opened.conversationId, true)).toBe(true);
    await signals.typing(u.lee, opened.conversationId, false);
    expect(await signals.typing(u.lee, opened.conversationId, true)).toBe(true);
    // Within the pace a second "typing" does not go out.
    expect(await signals.typing(u.lee, opened.conversationId, true)).toBe(false);
  });

  // ─── FR-269 ───────────────────────────────────────────────────────────────────────────────────────────────────────
  it('a gift card goes to an accepted contact, shows its title and value and never a code, and a retry gives it once', async () => {
    const opened = await dm.openDirect(u.ada, u.bob.username, msg('cards test'), IP);
    const cid = opened.conversationId;
    // Still a request: not yet.
    expect(await refusal(() => cards.send(u.ada, cid, { couponId: 'card-1', clientMessageId: uuidv7() }, IP))).toBe('friends_only');
    await dm.respondToRequest(u.bob, cid, true);
    const clientMessageId = uuidv7();
    const first = await cards.send(u.ada, cid, { couponId: 'card-1', clientMessageId }, IP);
    expect(first.duplicate).toBe(false);
    const again = await cards.send(u.ada, cid, { couponId: 'card-1', clientMessageId }, IP);
    expect(again).toEqual({ messageId: first.messageId, duplicate: true });
    const view = (await dm.history(u.bob, cid, {})).items.find((m) => m.id === first.messageId)!;
    expect(view.type).toBe('CARD');
    expect(view.card).toMatchObject({ title: 'Test gift card', amount: '5', currency: 'USDT', receiverUsername: u.bob.username });
    expect(JSON.stringify(view)).not.toMatch(/code/i);
    // A block ends it, like money.
    await module.get(ChatRelationsService).set(u.bob, u.ada.username, 'blocks', true);
    expect(await refusal(() => cards.send(u.ada, cid, { couponId: 'card-2', clientMessageId: uuidv7() }, IP))).toBe('blocked');
  });

  // ─── V2-113 / V2-114 ──────────────────────────────────────────────────────────────────────────────────────────────
  it('in a merchant app chat a customer may send y messages until each reply', async () => {
    settings({ dm: { merchantMessageCap: 2 } });
    await prisma.$executeRaw`
      INSERT INTO chat.test_entitlements (user_id, is_site_owner) VALUES (${u.nat.id}::uuid, true)
      ON CONFLICT (user_id) DO UPDATE SET is_site_owner = true
    `;
    const opened = await dm.openDirect(u.oli, u.nat.username, msg('question one'), IP, 'app-1');
    const cid = opened.conversationId;
    expect(await dmDb.member(cid, u.nat.id)).toMatchObject({ folder: 'MERCHANT', state: 'ACTIVE' });
    expect(await refusal(() => dm.send(u.oli, cid, msg('question two'), IP))).toBe('ok');
    expect(await refusal(() => dm.send(u.oli, cid, msg('question three'), IP))).toBe('request_cap_reached');
    await dm.send(u.nat, cid, msg('here is the answer'), IP);
    expect(await refusal(() => dm.send(u.oli, cid, msg('thanks, one more'), IP))).toBe('ok');
  });

  // ─── FR-060: retry de-duplication on the partitioned table ────────────────────────────────────────────────────────
  it('parallel retries of one client message id store exactly one message', async () => {
    const opened = await dm.openDirect(u.eve, u.fay.username, null, IP);
    const cid = opened.conversationId;
    const clientMessageId = uuidv7();
    const results = await Promise.all(Array.from({ length: 6 }, () => dm.send(u.eve, cid, msg('same message', clientMessageId), IP)));
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const stored = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM chat.dm_messages WHERE conversation_id = ${cid}::uuid`;
    expect(stored[0]!.n).toBe(1);
  });

  // ─── The group member counter (FR-201, FR-202, FR-024) ────────────────────────────────────────────────────────────
  it('the member counter follows every join, leave, removal and ban', async () => {
    const gid = await publicGroup('gus', 'hal', 'ivy', 'jon');
    const real = async () =>
      (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM chat.dm_members WHERE conversation_id = ${gid}::uuid AND state = 'ACTIVE'`)[0]!.n;
    const counter = async () => (await groupsDb.group(gid))!.memberCount;
    expect(await counter()).toBe(await real());
    expect(await counter()).toBe(4);
    await groups.leave(u.ivy, gid);
    await admin.remove(u.gus, gid, u.hal.id);
    await admin.ban(u.gus, gid, u.jon.id, 'test', true);
    expect(await counter()).toBe(1);
    expect(await counter()).toBe(await real());
    await groups.join(u.hal, gid);
    expect(await counter()).toBe(2);
    expect(await counter()).toBe(await real());
  });

  // ─── The paged inbox (FR-201) ─────────────────────────────────────────────────────────────────────────────────────
  it('the inbox pages without skipping or repeating, with the right unread counts', async () => {
    const others: Name[] = ['bob', 'cat', 'dan', 'eve', 'fay'];
    for (const who of others) await dm.openDirect(u[who], u.mia.username, msg(`hi mia from ${who}`), IP);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await inbox.conversations(u.mia, { folder: 'REQUESTS', limit: 2, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(2);
      for (const item of page.items) {
        expect(item.unread).toBe(1);
        seen.push(item.id);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(others.length);
  });

  // ─── V2-143: the archive notice ───────────────────────────────────────────────────────────────────────────────────
  it('a history that reaches its end says where the archive starts', async () => {
    const opened = await dm.openDirect(u.hal, u.ivy.username, msg('archive notice'), IP);
    await dmMessagesDb.archiveOldMonths(12);
    await prisma.$executeRaw`
      INSERT INTO chat.archive_state (id, dm_messages_archived_before) VALUES (true, '2025-01-01T00:00:00Z')
      ON CONFLICT (id) DO UPDATE SET dm_messages_archived_before = EXCLUDED.dm_messages_archived_before
    `;
    await dmMessagesDb.archiveOldMonths(12);
    try {
      const page = await dm.history(u.hal, opened.conversationId, {});
      expect(page.archivedBefore).toBe('2025-01-01T00:00:00.000000Z');
    } finally {
      await prisma.$executeRaw`UPDATE chat.archive_state SET dm_messages_archived_before = NULL`;
      await dmMessagesDb.archiveOldMonths(12);
    }
    expect((await dm.history(u.hal, opened.conversationId, {})).archivedBefore).toBeNull();
  });
});
