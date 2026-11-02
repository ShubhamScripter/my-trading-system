import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { uuidv7 } from '../../src/utils/public.utils';
import { ChatSettingsDocumentSchema, type ChatSettingsDocument } from '../../src/social/chat/chat.settings.contract';
import { ChatRelationsService } from '../../src/social/chat/services/chat.relations.service';
import type { ChatUserContext } from '../../src/social/chat/chat.types';
import { DmService } from '../../src/social/chat/dm/dm.service';
import { DmSignalsService } from '../../src/social/chat/dm/dm.signals.service';
import { DmActionsService } from '../../src/social/chat/dm/dm.actions.service';
import { DmInboxService } from '../../src/social/chat/dm/dm.inbox.service';
import { DmPrivacyService } from '../../src/social/chat/dm/dm.privacy.service';
import { DmGroupsService } from '../../src/social/chat/dm/dm.groups.service';
import { DmGroupInvitesService } from '../../src/social/chat/dm/dm.groups.invites.service';
import { DmGroupsModerationService } from '../../src/social/chat/dm/dm.groups.moderation.service';
import { DmDbOperation } from '../../src/social/chat/dm/dm.dboperation';
import { DmGroupsDbOperation } from '../../src/social/chat/dm/dm.groups.dboperation';
import { dmMemberCache } from '../../src/social/chat/dm/dm.member-cache';
import { inQuietHours } from '../../src/social/chat/dm/dm.rules';
import { bootChat, makeUsers, READY, refusal, type Emitted } from './chat.e2e.harness';

/**
 * Modules 8 and 9 hardening (handoff FR-090, 119-131, 171, 196-204, 229, 235, 267): every fix is proved on the REAL
 * services and a migrated scratch database; only what chat does not own is replaced (see chat.e2e.harness.ts).
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run --config vitest.chat.config.ts \
 *     tests/social/chat.dm-groups.e2e.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;
const IP = '10.0.0.1';
const NAMES = ['ada', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus', 'hal', 'ivy', 'jon', 'kim', 'lee', 'mia'] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!url)('chat Modules 8–9 hardening (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  const emitted: Emitted[] = [];
  const tag = uuidv7().slice(-6);
  const u = {} as Record<Name, ChatUserContext>;
  let document: ChatSettingsDocument;
  let dm: DmService;
  let signals: DmSignalsService;
  let inbox: DmInboxService;
  let privacyService: DmPrivacyService;
  let actions: DmActionsService;
  let groups: DmGroupsService;
  let groupInvites: DmGroupInvitesService;
  let admin: DmGroupsModerationService;
  let dmDb: DmDbOperation;
  let groupsDb: DmGroupsDbOperation;

  /** Chat settings for the next steps: DM and group values over the defaults. */
  const settings = (
    patch: { dm?: Record<string, unknown>; groups?: Record<string, unknown>; privacy?: Record<string, unknown> } = {},
  ) => {
    document = ChatSettingsDocumentSchema.parse({
      global: {
        testProviders: { enabled: true },
        limits: { messagesPerWindow: 100, messageWindowSeconds: 1, mediaCooldownSeconds: 0 },
        dm: { ...READY.dm, ...patch.dm },
        privacy: { ...READY.privacy, ...patch.privacy },
        // Roomy by default so one shared owner can make many groups; a test narrows exactly the limit it proves.
        groups: {
          ...READY.groups,
          maxCreatePublic: 100,
          maxCreatePrivate: 100,
          maxJoinPublic: 100,
          maxJoinPrivate: 100,
          ...patch.groups,
        },
      },
    });
  };
  const follows = async (who: Name, ...others: Name[]) => {
    await prisma.$executeRaw`
      INSERT INTO chat.test_entitlements (user_id, follows) VALUES (${u[who].id}::uuid, ${others.map((o) => u[o].id)}::uuid[])
      ON CONFLICT (user_id) DO UPDATE SET follows = EXCLUDED.follows
    `;
  };
  const sent = (event: string) => emitted.filter((e) => e.event === event);
  const msg = (content: string, clientMessageId?: string) => ({ content, ...(clientMessageId ? { clientMessageId } : {}) });
  /** A public group with the owner and these members already in. */
  const publicGroup = async (owner: Name, ...members: Name[]) => {
    const { groupId } = await groups.create(u[owner], { name: `G${uuidv7().slice(-5)}`, visibility: 'PUBLIC' });
    for (const m of members) await groups.join(u[m], groupId);
    return groupId;
  };

  beforeAll(async () => {
    settings();
    ({ prisma, module } = await bootChat(url!, emitted, () => document));
    dm = module.get(DmService);
    signals = module.get(DmSignalsService);
    inbox = module.get(DmInboxService);
    privacyService = module.get(DmPrivacyService);
    actions = module.get(DmActionsService);
    groups = module.get(DmGroupsService);
    groupInvites = module.get(DmGroupInvitesService);
    admin = module.get(DmGroupsModerationService);
    dmDb = module.get(DmDbOperation);
    groupsDb = module.get(DmGroupsDbOperation);
    Object.assign(u, await makeUsers(prisma, NAMES, tag));
  }, 60_000);

  beforeEach(() => settings());

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  // ─── The one guard: DM OFF / MAINTENANCE (FR-120, V2-131) ─────────────────────────────────────────────────────────
  it('DM maintenance stops every write path (send, typing, read, pins, nickname, folders, settings); reads follow the switch', async () => {
    const opened = await dm.openDirect(u.ada, u.bob.username, msg('hello bob'), IP);
    await dm.respondToRequest(u.bob, opened.conversationId, true);
    const first = opened.message!;

    settings({ dm: { status: 'MAINTENANCE' } });
    const cid = opened.conversationId;
    const writes: Record<string, () => Promise<unknown>> = {
      send: () => dm.send(u.ada, cid, msg('x'), IP),
      typing: () => signals.typing(u.ada, cid, true),
      markRead: () => signals.markRead(u.bob, cid, first.id),
      respond: () => dm.respondToRequest(u.bob, cid, true),
      moveFolder: () => inbox.moveFolder(u.ada, cid, 'GENERAL'),
      pinPerson: () => inbox.pinPerson(u.ada, cid, true),
      nickname: () => inbox.setNickname(u.ada, cid, 'Bobby'),
      notifications: () => inbox.setNotifications(u.ada, cid, 'ON'),
      privacy: () => privacyService.updatePrivacy(u.ada, { notifyPrimary: false }),
      pinMessage: () => actions.pin(u.ada, first.id, true),
      retract: () => actions.retract(u.ada, first.id),
      forward: () => actions.forward(u.ada, first.id, [cid], IP),
    };
    for (const [name, run] of Object.entries(writes)) {
      expect(await refusal(run), name).toBe('dm_unavailable');
    }
    // Reading still works in MAINTENANCE.
    expect((await inbox.conversations(u.ada, {})).items.length).toBeGreaterThan(0);
    expect((await dm.history(u.ada, cid, {})).items.length).toBe(1);

    settings({ dm: { status: 'DISABLED' } });
    expect(await refusal(() => inbox.conversations(u.ada, {}))).toBe('dm_unavailable');
    expect(await refusal(() => inbox.unread(u.ada))).toBe('dm_unavailable');
    expect(await refusal(() => privacyService.privacy(u.ada))).toBe('dm_unavailable');
    settings();
  });

  // ─── Requests: decline, reopen, accept (FR-121, FR-198, V2-42) ────────────────────────────────────────────────────
  it('a declined request stops the sender; the decliner writing later makes a normal two-way chat', async () => {
    const opened = await dm.openDirect(u.ada, u.dan.username, msg('hi dan'), IP);
    expect(await dm.respondToRequest(u.dan, opened.conversationId, false)).toMatchObject({ state: 'DECLINED' });
    expect(await refusal(() => dm.send(u.ada, opened.conversationId, msg('again'), IP))).toBe('dm_request_declined');

    await dm.send(u.dan, opened.conversationId, msg('ok, now we can talk'), IP);
    expect((await dmDb.member(opened.conversationId, u.dan.id))?.state).toBe('ACTIVE');
    expect(await refusal(() => dm.send(u.ada, opened.conversationId, msg('thanks'), IP))).toBe('ok');
  });

  it('replying to a request accepts it into General in the same step as the reply', async () => {
    const opened = await dm.openDirect(u.eve, u.cat.username, msg('hello cat'), IP);
    expect((await dmDb.member(opened.conversationId, u.cat.id))?.state).toBe('REQUEST');
    await dm.send(u.cat, opened.conversationId, msg('hi eve'), IP);
    expect(await dmDb.member(opened.conversationId, u.cat.id)).toMatchObject({ state: 'ACTIVE', folder: 'GENERAL' });
  });

  // ─── Message ids, unread (FR-197, FR-126) ─────────────────────────────────────────────────────────────────────────
  it('a client message id is unique per conversation, not across all of a sender\'s conversations', async () => {
    const one = await dm.openDirect(u.fay, u.gus.username, null, IP);
    const two = await dm.openDirect(u.fay, u.hal.username, null, IP);
    const id = uuidv7();
    const a = await dm.send(u.fay, one.conversationId, msg('same id', id), IP);
    const b = await dm.send(u.fay, two.conversationId, msg('same id, other chat', id), IP);
    const again = await dm.send(u.fay, one.conversationId, msg('retry', id), IP);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
    expect(b.message.id).not.toBe(a.message.id);
    expect(again).toMatchObject({ duplicate: true, message: { id: a.message.id } });
  });

  it('unread counts only what others wrote: not my own messages, not system lines', async () => {
    const gid = await publicGroup('ivy', 'jon', 'kim');
    await dm.send(u.jon, gid, msg('hello group'), IP);
    // ivy has system lines (created, joined x2) and jon's one message: only jon's counts.
    expect((await inbox.unread(u.ivy)).groups).toBe(1);
    // jon wrote it himself; the system lines never count.
    expect((await inbox.unread(u.jon)).groups).toBe(0);
  });

  // ─── The new-DM limit (FR-171, V2-61) ─────────────────────────────────────────────────────────────────────────────
  it('the new-DM limit holds under parallel requests and says how long to wait', async () => {
    settings({ dm: { newDmFollowerCount: 1, newDmFollowerWindowHours: 1, newDmNonFollowerCount: 1, newDmNonFollowerWindowHours: 1 } });
    const results = await Promise.allSettled([
      dm.openDirect(u.mia, u.ada.username, null, IP),
      dm.openDirect(u.mia, u.bob.username, null, IP),
      dm.openDirect(u.mia, u.cat.username, null, IP),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(2);
    for (const r of refused) {
      expect(r.reason).toMatchObject({ extra: { reason: 'new_dm_limit' } });
      expect((r.reason as { extra: { remainingSeconds: number } }).extra.remainingSeconds).toBeGreaterThan(0);
    }
    settings();
  });

  // ─── Typing and read receipts: one switch, both ways, never across a block (FR-196, FR-235, V2-43, V2-133) ───────
  it('the typing/read switch works both ways and a block silences both', async () => {
    const opened = await dm.openDirect(u.ada, u.eve.username, msg('typing test'), IP);
    const cid = opened.conversationId;
    await dm.respondToRequest(u.eve, cid, true);
    const typedTo = async (who: Name, typing = true) => {
      emitted.length = 0;
      await signals.typing(u[who], cid, typing);
      return sent('dm_typing').flatMap((e) => e.to);
    };

    expect(await typedTo('ada')).toEqual([`user:${u.eve.id}`]);
    await signals.typing(u.ada, cid, false);

    await privacyService.updatePrivacy(u.eve, { typingReceiptsEnabled: false });
    // eve switched off: she neither sends nor receives (V2-133).
    expect(await typedTo('ada')).toEqual([]);
    await signals.typing(u.ada, cid, false);
    expect(await typedTo('eve')).toEqual([]);
    await signals.typing(u.eve, cid, false);

    await privacyService.updatePrivacy(u.eve, { typingReceiptsEnabled: true });
    expect(await typedTo('eve')).toEqual([`user:${u.ada.id}`]);
    await signals.typing(u.eve, cid, false);

    // Read receipts follow the same switch.
    const last = (await dm.history(u.ada, cid, {})).items[0]!;
    await privacyService.updatePrivacy(u.ada, { typingReceiptsEnabled: false });
    emitted.length = 0;
    await signals.markRead(u.eve, cid, last.id);
    expect(sent('dm_read').flatMap((e) => e.to)).not.toContain(`user:${u.ada.id}`);
    await privacyService.updatePrivacy(u.ada, { typingReceiptsEnabled: true });

  });

  it('a block silences typing and read ticks both ways', async () => {
    const opened = await dm.openDirect(u.kim, u.lee.username, msg('about to be blocked'), IP);
    const cid = opened.conversationId;
    await dm.respondToRequest(u.lee, cid, true);
    await module.get(ChatRelationsService).set(u.lee, u.kim.username, 'blocks', true);
    emitted.length = 0;
    await signals.typing(u.kim, cid, true);
    await signals.typing(u.lee, cid, true);
    await signals.markRead(u.lee, cid, opened.message!.id);
    expect(sent('dm_typing')).toEqual([]);
    expect(sent('dm_read').flatMap((e) => e.to)).not.toContain(`user:${u.kim.id}`);
  });

  // ─── Delivery cost (FR-024, FR-125) ───────────────────────────────────────────────────────────────────────────────
  it('a message to a group is a few emits, not one per member', async () => {
    const gid = await publicGroup('ivy', 'jon', 'kim', 'lee', 'mia', 'bob', 'cat');
    emitted.length = 0;
    await dm.send(u.ivy, gid, msg('to everyone'), IP);
    await vi.waitFor(() => {
      const events = sent('dm_message');
      // The sender's own view and the view every other member shares: two emits for seven members.
      expect(events.length).toBeLessThanOrEqual(2);
      expect(new Set(events.flatMap((e) => e.to)).size).toBe(7);
    }, { timeout: 5_000, interval: 25 });
  });

  // ─── Forward (FR-204) ─────────────────────────────────────────────────────────────────────────────────────────────
  it('forwarding tries every target and reports each one', async () => {
    const one = await dm.openDirect(u.fay, u.cat.username, msg('forward me'), IP);
    const target = await dm.openDirect(u.fay, u.dan.username, null, IP);
    const stranger = uuidv7();
    const result = await actions.forward(u.fay, one.message!.id, [target.conversationId, stranger], IP);
    expect(result.results).toMatchObject([
      { conversationId: target.conversationId, ok: true },
      { conversationId: stranger, ok: false },
    ]);
    expect(result.forwarded).toHaveLength(1);
  });

  // ─── Lookup by username only (FR-199, V2-08) ──────────────────────────────────────────────────────────────────────
  it('lookup is by username only; a blocked person looks like an unknown one; only the username is returned', async () => {
    expect(await privacyService.resolveUser(u.gus, u.hal.username)).toEqual({ username: u.hal.username });
    // Whatever the handle, only the username comes back: no id, no login code.
    expect(Object.keys(await privacyService.resolveUser(u.gus, u.hal.id))).toEqual(['username']);
    expect(await refusal(() => privacyService.resolveUser(u.gus, `nobody-${tag}`))).toBe(ERR.NOT_FOUND);
    await module.get(ChatRelationsService).set(u.hal, u.gus.username, 'blocks', true);
    expect(await refusal(() => privacyService.resolveUser(u.gus, u.hal.username))).toBe(ERR.NOT_FOUND);
    expect(await privacyService.commonGroups(u.gus, u.hal.username)).toEqual({ visible: false, items: [] });
  });

  // ─── Quiet mode (FR-124, V2-45) ───────────────────────────────────────────────────────────────────────────────────
  it('quiet mode follows the account time zone; without a zone there is no auto-night', () => {
    const prefs = { notifyPrimary: true, notifyGeneral: true, notifyGroups: true, quietMode: 'CUSTOM', quietStart: '22:00', quietEnd: '07:00' } as const;
    const at = new Date('2026-10-26T17:30:00Z'); // 23:00 in Asia/Kolkata, 17:30 in UTC
    expect(inQuietHours({ ...prefs, timeZone: 'Asia/Kolkata' }, at)).toBe(true);
    expect(inQuietHours({ ...prefs, timeZone: 'UTC' }, at)).toBe(false);
    expect(inQuietHours({ ...prefs, timeZone: null }, at)).toBe(false);
    expect(inQuietHours({ ...prefs, quietMode: 'AUTO_NIGHT', timeZone: null }, at)).toBe(false);
  });

  // ─── A follow changes the folder (FR-200, V2-47) ──────────────────────────────────────────────────────────────────
  it('"I follow X, X writes first" lands in Primary once I follow; a chosen folder is never moved', async () => {
    const opened = await dm.openDirect(u.hal, u.ivy.username, msg('hi ivy'), IP);
    const cid = opened.conversationId;
    expect(await dmDb.member(cid, u.ivy.id)).toMatchObject({ state: 'REQUEST', folder: 'GENERAL' });
    await follows('ivy', 'hal');
    await privacyService.onFollowChanged(u.ivy.id, u.hal.id);
    expect(await dmDb.member(cid, u.ivy.id)).toMatchObject({ state: 'ACTIVE', folder: 'PRIMARY' });

    // A folder the user chose stays.
    await inbox.moveFolder(u.ivy, cid, 'GENERAL');
    await privacyService.onFollowChanged(u.ivy.id, u.hal.id);
    expect((await dmDb.member(cid, u.ivy.id))?.folder).toBe('GENERAL');
  });

  // ─── Groups: limits under parallel requests (FR-090) ──────────────────────────────────────────────────────────────
  it('parallel joins into the last free place: exactly one gets in', async () => {
    settings({ groups: { memberLimitPublic: 2 } });
    const gid = await publicGroup('ivy');
    const results = await Promise.all([
      refusal(() => groups.join(u.jon, gid)),
      refusal(() => groups.join(u.kim, gid)),
      refusal(() => groups.join(u.lee, gid)),
    ]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'limit_reached')).toHaveLength(2);
    expect(await groupsDb.memberCount(gid)).toBe(2);
    settings();
  });

  it('the per-user join limit holds when two joins arrive together', async () => {
    settings({ groups: { maxJoinPublic: 1 } });
    const g1 = await publicGroup('gus');
    const g2 = await publicGroup('hal');
    const results = await Promise.all([refusal(() => groups.join(u.fay, g1)), refusal(() => groups.join(u.fay, g2))]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'limit_reached')).toHaveLength(1);
    settings();
  });

  it('the admin cap holds when two promotions arrive together', async () => {
    settings({ groups: { maxAdmins: 1 } });
    const gid = await publicGroup('ivy', 'jon', 'kim');
    const results = await Promise.all([
      refusal(() => admin.setRole(u.ivy, gid, u.jon.id, 'ADMIN')),
      refusal(() => admin.setRole(u.ivy, gid, u.kim.id, 'ADMIN')),
    ]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'limit_reached')).toHaveLength(1);
    settings();
  });

  // ─── Ownership without a code (V2-144, FR-090) ────────────────────────────────────────────────────────────────────
  it('ownership moves at once, asks no code, stays one owner, and obeys x times in y hours', async () => {
    settings({ groups: { transfersPerWindow: 1, transferWindowHours: 24 } });
    const gid = await publicGroup('ivy', 'jon', 'kim');
    expect(await admin.startTransfer(u.ivy, gid, u.jon.username)).toEqual({ groupId: gid, ownerId: u.jon.id });
    expect((await groupsDb.group(gid))?.ownerId).toBe(u.jon.id);
    expect(await dmDb.member(gid, u.ivy.id)).toMatchObject({ role: 'ADMIN' });
    expect(await refusal(() => admin.startTransfer(u.jon, gid, u.kim.id))).toBe('limit_reached');
    // Two transfers started together: still one owner.
    const owners = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.dm_members WHERE conversation_id = ${gid}::uuid AND role = 'OWNER'
    `;
    expect(owners[0]!.n).toBe(1);
    // A transfer to someone who is not a member is refused and changes nothing.
    expect(await refusal(() => admin.startTransfer(u.jon, gid, u.mia.id))).not.toBe('ok');
    settings();
  });

  // ─── Bans, unbans, leaving, closing, timeouts (FR-128, FR-203, FR-129, V2-119, V2-122) ────────────────────────────
  it('a member who left can be banned; a ban is lifted only by a role not below the banner; the ban list is paged', async () => {
    const gid = await publicGroup('ivy', 'jon', 'kim', 'lee');
    await admin.setRole(u.ivy, gid, u.jon.username, 'ADMIN');
    expect(await refusal(() => admin.remove(u.ivy, gid, 'missing-user'))).toBe('not_a_member');
    await groups.leave(u.lee, gid);
    expect(await admin.ban(u.ivy, gid, u.lee.username, 'spam', true)).toMatchObject({ banned: true });
    expect(await refusal(() => groups.join(u.lee, gid))).toBe('group_banned');
    // The admin may not lift a ban the owner set.
    expect(await refusal(() => admin.ban(u.jon, gid, u.lee.id, null, false))).toBe('target_outranks_you');
    // A ban on someone who is not banned says so.
    expect(await refusal(() => admin.ban(u.ivy, gid, u.kim.id, null, false))).toBe('group_ban_not_found');
    await admin.ban(u.jon, gid, u.kim.id, 'flood', true);
    const page = await admin.bans(u.ivy, gid, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect((await admin.bans(u.ivy, gid, { limit: 1, cursor: page.nextCursor! })).items).toHaveLength(1);
    expect(await admin.ban(u.ivy, gid, u.lee.id, null, false)).toMatchObject({ banned: false });
    expect(await refusal(() => groups.join(u.lee, gid))).toBe('ok');
  });

  it('the last member leaving closes the group: it is not listed, not counted, not joinable, and the role is cleared', async () => {
    const gid = await publicGroup('mia');
    expect(await groupsDb.createdCount(u.mia.id, 'PUBLIC')).toBeGreaterThan(0);
    const before = await groupsDb.createdCount(u.mia.id, 'PUBLIC');
    expect(await groups.leave(u.mia, gid)).toMatchObject({ left: true, closed: true });
    expect(await groupsDb.createdCount(u.mia.id, 'PUBLIC')).toBe(before - 1);
    expect((await groupsDb.group(gid))?.closedAt).not.toBeNull();
    expect((await groups.publicGroups(u.ada, { q: undefined })).items.map((g) => g.id)).not.toContain(gid);
    expect(await refusal(() => groups.join(u.ada, gid))).toBe(ERR.NOT_FOUND);
    expect(await dmDb.member(gid, u.mia.id)).toMatchObject({ state: 'LEFT', role: 'MEMBER' });
  });

  it('leaving and coming back does not end a running timeout; others do not see it, admins and the member do', async () => {
    const gid = await publicGroup('ivy', 'kim', 'lee', 'mia');
    await admin.timeout(u.ivy, gid, u.kim.id, 30);
    await groups.leave(u.kim, gid);
    await groups.join(u.kim, gid);
    const kim = await dmDb.member(gid, u.kim.id);
    expect(kim?.timeoutUntil && kim.timeoutUntil.getTime() > Date.now()).toBe(true);
    expect(await refusal(() => dm.send(u.kim, gid, msg('let me talk'), IP))).not.toBe('ok');

    const seenBy = async (who: Name) => {
      const out = await inbox.groupMembers(u[who], gid, {});
      return out.items.find((m) => m.username === u.kim.username)?.timeoutUntil ?? null;
    };
    expect(await seenBy('lee')).toBeNull();
    expect(await seenBy('ivy')).not.toBeNull();
    expect(await seenBy('kim')).not.toBeNull();
  });

  it('the member list is paged, never the whole group', async () => {
    const gid = await publicGroup('ivy', 'jon', 'kim', 'lee', 'mia');
    const first = await inbox.groupMembers(u.ivy, gid, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.memberCount).toBe(5);
    expect(first.nextCursor).not.toBeNull();
    const second = await inbox.groupMembers(u.ivy, gid, { limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((m) => m.username)).size).toBe(4);
    // The group detail is constant in size: the count and the caller's own row, whatever the group's size.
    const detail = await inbox.conversation(u.ivy, gid);
    expect(detail.members).toHaveLength(1);
    expect(detail.members[0]).toMatchObject({ username: u.ivy.username, role: 'OWNER' });
    expect(detail.memberCount).toBe(5);
  });

  // ─── What admins may change (FR-229, V2-49) ───────────────────────────────────────────────────────────────────────
  it('an admin changes only the permissions the owner lets admins change', async () => {
    const gid = await publicGroup('ivy', 'jon');
    await admin.setRole(u.ivy, gid, u.jon.id, 'ADMIN');
    expect(await refusal(() => groups.setPermissions(u.jon, gid, { permissions: { RENAME: 'MEMBER' } }))).toBe('permission_denied');
    await groups.setPermissions(u.ivy, gid, { adminManageable: ['RENAME'] });
    expect(await refusal(() => groups.setPermissions(u.jon, gid, { permissions: { RENAME: 'MEMBER' } }))).toBe('ok');
    expect(await refusal(() => groups.setPermissions(u.jon, gid, { permissions: { BAN: 'MEMBER' } }))).toBe('permission_denied');
    // Only the owner decides what admins may change.
    expect(await refusal(() => groups.setPermissions(u.jon, gid, { adminManageable: ['BAN'] }))).toBe('permission_denied');
    expect((await groupsDb.group(gid))?.adminManageable).toEqual(['RENAME']);
  });

  // ─── Invites (FR-130) ─────────────────────────────────────────────────────────────────────────────────────────────
  it('one pending invite per person; a blocked person looks unknown; the member cache is exact after writes', async () => {
    const { groupId } = await groups.create(u.ivy, { name: `P${uuidv7().slice(-5)}`, visibility: 'PRIVATE' });
    await module.get(ChatRelationsService).set(u.mia, u.ivy.username, 'blocks', true);
    const [a, b] = await Promise.all([
      groupInvites.invite(u.ivy, groupId, [u.jon.username]),
      groupInvites.invite(u.ivy, groupId, [u.jon.username]),
    ]);
    expect(a.invited[0]!.inviteId).toBe(b.invited[0]!.inviteId);
    const pending = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.dm_group_invites WHERE conversation_id = ${groupId}::uuid AND status = 'PENDING'
    `;
    expect(pending[0]!.n).toBe(1);

    const blocked = await groupInvites.invite(u.ivy, groupId, [u.mia.username, `nobody-${tag}`]);
    expect(blocked.invited).toEqual([]);
    expect(blocked.skipped.map((s) => s.reason)).toEqual(['not_found', 'not_found']);

    // Accepting adds the member, and the cached list (filled before) shows it at once.
    const invite = (await groupInvites.invites(u.jon)).items.find((i) => i.groupId === groupId)!;
    expect((await dmDb.members(groupId)).some((m) => m.userId === u.jon.id)).toBe(false);
    await groupInvites.respondToInvite(u.jon, invite.id, true);
    expect(dmMemberCache.get(groupId)?.find((m) => m.userId === u.jon.id)?.state).toBe('ACTIVE');
    expect((await dmDb.member(groupId, u.jon.id))?.state).toBe('ACTIVE');
  });
});
