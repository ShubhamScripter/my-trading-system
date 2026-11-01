import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { ChatSettingsDocumentSchema } from '../../src/social/chat/chat.settings.contract';
import type { ChatUserContext } from '../../src/social/chat/chat.types';
import { DmService } from '../../src/social/chat/dm/dm.service';
import { DmSignalsService } from '../../src/social/chat/dm/dm.signals.service';
import { DmInboxService } from '../../src/social/chat/dm/dm.inbox.service';
import { DmPrivacyService } from '../../src/social/chat/dm/dm.privacy.service';
import { DmGroupsService } from '../../src/social/chat/dm/dm.groups.service';
import { DmGroupInvitesService } from '../../src/social/chat/dm/dm.groups.invites.service';
import { DmGroupsModerationService } from '../../src/social/chat/dm/dm.groups.moderation.service';
import { inQuietHours } from '../../src/social/chat/dm/dm.rules';
import { bootChat, makeUsers, READY, refusal, type Emitted } from './chat.e2e.harness';

/**
 * Modules 8–9, slice 2: the admin-set values and the rules that use them (V2-44, V2-46, V2-61, V2-113, V2-121,
 * V2-135, V2-146) on the REAL services and a migrated scratch database.
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run --config vitest.chat.config.ts \
 *     tests/social/chat.dm-limits.e2e.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;
const IP = '10.0.0.1';
const NAMES = ['ada', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus', 'hal', 'ivy', 'jon', 'kim', 'lee'] as const;
type Name = (typeof NAMES)[number];
type Patch = { dm?: Record<string, unknown>; groups?: Record<string, unknown>; privacy?: Record<string, unknown> };

describe.skipIf(!url)('chat Modules 8–9 slice 2: admin-set limits (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  const emitted: Emitted[] = [];
  const tag = uuidv7().slice(-6);
  const u = {} as Record<Name, ChatUserContext>;
  let document: unknown;
  let dm: DmService;
  let signals: DmSignalsService;
  let inbox: DmInboxService;
  let privacyService: DmPrivacyService;
  let groups: DmGroupsService;
  let groupInvites: DmGroupInvitesService;
  let admin: DmGroupsModerationService;

  const layer = (patch: Patch) => ({
    testProviders: { enabled: true },
    limits: { messagesPerWindow: 100, messageWindowSeconds: 1, mediaCooldownSeconds: 0 },
    dm: { ...READY.dm, ...patch.dm },
    groups: { ...READY.groups, maxCreatePublic: 100, maxCreatePrivate: 100, maxJoinPublic: 100, maxJoinPrivate: 100, ...patch.groups },
    privacy: { ...READY.privacy, ...patch.privacy },
  });
  /** Settings as the admin backend would accept them (the contract refuses an ACTIVE DM with a gap). */
  const settings = (patch: Patch = {}) => {
    document = ChatSettingsDocumentSchema.parse({ global: layer(patch) });
  };
  /** Settings as they could still be stored by an older save: no validation, so a gap can exist. */
  const stored = (patch: Patch) => {
    document = { global: layer(patch), countries: {} };
  };
  const follows = async (who: Name, ...others: Name[]) => {
    await prisma.$executeRaw`
      INSERT INTO chat.test_entitlements (user_id, follows) VALUES (${u[who].id}::uuid, ${others.map((o) => u[o].id)}::uuid[])
      ON CONFLICT (user_id) DO UPDATE SET follows = EXCLUDED.follows
    `;
  };
  const msg = (content: string) => ({ content });
  const group = async (owner: Name, options: { channel?: boolean; visibility?: 'PUBLIC' | 'PRIVATE' } = {}) =>
    (
      await groups.create(u[owner], {
        name: `S${uuidv7().slice(-5)}`,
        visibility: options.visibility ?? 'PUBLIC',
        isChannel: options.channel ?? false,
      })
    ).groupId;

  beforeAll(async () => {
    settings();
    ({ prisma, module } = await bootChat(url!, emitted, () => document));
    dm = module.get(DmService);
    signals = module.get(DmSignalsService);
    inbox = module.get(DmInboxService);
    privacyService = module.get(DmPrivacyService);
    groups = module.get(DmGroupsService);
    groupInvites = module.get(DmGroupInvitesService);
    admin = module.get(DmGroupsModerationService);
    Object.assign(u, await makeUsers(prisma, NAMES, tag));
  }, 60_000);

  beforeEach(() => settings());

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  // ─── V2-44: no built-in DM values ─────────────────────────────────────────────────────────────────────────────────
  it('a stored ACTIVE DM with an unset value refuses every DM call and names what is missing', async () => {
    stored({ dm: { newDmNonFollowerCount: null, strangerMessageCap: null }, privacy: { lastSeenDefault: null } });
    for (const run of [
      () => dm.openDirect(u.ada, u.bob.username, msg('hi'), IP),
      () => inbox.conversations(u.ada, {}),
      () => privacyService.privacy(u.ada),
    ]) {
      const caught = (await run().then(
        () => null,
        (e: unknown) => e,
      )) as { extra?: { reason?: string; missing?: string[] } } | null;
      expect(caught?.extra?.reason).toBe('dm_not_configured');
      expect(caught?.extra?.missing).toEqual(
        expect.arrayContaining(['dm.newDmNonFollowerCount', 'dm.strangerMessageCap', 'privacy.lastSeenDefault']),
      );
    }
  });

  it('the contract refuses to save DM as ACTIVE while a value is unset', () => {
    const bad = ChatSettingsDocumentSchema.safeParse({ global: { dm: { status: 'ACTIVE' } } });
    expect(bad.success).toBe(false);
    const ok = ChatSettingsDocumentSchema.safeParse({ global: layer({}) });
    expect(ok.success).toBe(true);
  });

  it('a limit that is not set refuses the action it limits (pins, group joins, invites)', async () => {
    stored({ groups: { memberLimitPublic: null, invitesPerWindow: null } });
    const gid = await group('ada');
    expect(await refusal(() => groups.join(u.bob, gid))).toBe('limit_not_set');
    expect(await refusal(() => groupInvites.invite(u.ada, gid, [u.cat.username]))).toBe('limit_not_set');
  });

  // ─── V2-61: new-DM limits for followers and non-followers ─────────────────────────────────────────────────────────
  it('new DMs are counted separately for people who follow the starter and for people who do not', async () => {
    settings({
      dm: {
        newDmFollowerCount: 1,
        newDmFollowerWindowHours: 1,
        newDmNonFollowerCount: 2,
        newDmNonFollowerWindowHours: 1,
      },
    });
    await follows('bob', 'ada');
    await follows('cat', 'ada');
    const open = (who: Name) => refusal(() => dm.openDirect(u.ada, u[who].username, null, IP));
    expect(await open('bob')).toBe('ok');
    expect(await open('cat')).toBe('new_dm_limit');
    expect(await open('dan')).toBe('ok');
    expect(await open('eve')).toBe('ok');
    expect(await open('fay')).toBe('new_dm_limit');
  });

  // ─── V2-113: messages before acceptance or reply ──────────────────────────────────────────────────────────────────
  it('a stranger may send only x messages until the receiver replies; then the cap no longer applies', async () => {
    settings({ dm: { strangerMessageCap: 2 } });
    const opened = await dm.openDirect(u.gus, u.hal.username, msg('one'), IP);
    const cid = opened.conversationId;
    expect(await refusal(() => dm.send(u.gus, cid, msg('two'), IP))).toBe('ok');
    expect(await refusal(() => dm.send(u.gus, cid, msg('three'), IP))).toBe('request_cap_reached');
    await dm.send(u.hal, cid, msg('hello, go on'), IP);
    expect(await refusal(() => dm.send(u.gus, cid, msg('three, finally'), IP))).toBe('ok');
  });

  it('pinned people are limited by the admin number', async () => {
    settings({ dm: { maxPinnedPeople: 1 } });
    const one = await dm.openDirect(u.ivy, u.jon.username, msg('pin test'), IP);
    const two = await dm.openDirect(u.ivy, u.kim.username, msg('pin test 2'), IP);
    expect(await refusal(() => inbox.pinPerson(u.ivy, one.conversationId, true))).toBe('ok');
    expect(await refusal(() => inbox.pinPerson(u.ivy, two.conversationId, true))).toBe('limit_reached');
  });

  // ─── V2-46, V2-135: channels and group sizes ──────────────────────────────────────────────────────────────────────
  it('only admins post in a channel; a channel has its own member limit and its own admin cap', async () => {
    settings({ groups: { memberLimitChannel: 3, maxChannelAdmins: 1 } });
    const gid = await group('ada', { channel: true });
    await groups.join(u.bob, gid);
    await groups.join(u.cat, gid);
    expect(await refusal(() => dm.send(u.bob, gid, msg('can I post?'), IP))).toBe('channel_admins_only');
    expect(await refusal(() => dm.send(u.ada, gid, msg('announcement'), IP))).toBe('ok');
    // The channel is full at 3 (limit of channels, not of public groups).
    expect(await refusal(() => groups.join(u.dan, gid))).toBe('limit_reached');
    // One channel admin at most.
    const results = await Promise.all([
      refusal(() => admin.setRole(u.ada, gid, u.bob.id, 'ADMIN')),
      refusal(() => admin.setRole(u.ada, gid, u.cat.id, 'ADMIN')),
    ]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'limit_reached')).toHaveLength(1);
  });

  it('a channel can be private; an unset channel admin cap refuses promotions', async () => {
    stored({ groups: { maxChannelAdmins: null } });
    const gid = await group('ada', { channel: true, visibility: 'PRIVATE' });
    expect(await refusal(() => groups.join(u.bob, gid))).toBe('invite_only');
    const open = await group('eve', { channel: true });
    await groups.join(u.fay, open);
    expect(await refusal(() => admin.setRole(u.eve, open, u.fay.id, 'ADMIN'))).toBe('limit_not_set');
  });

  it('per-person typing is sent only in groups below the admin-set size', async () => {
    settings({ groups: { receiptGroupSize: 3 } });
    const small = await group('gus');
    await groups.join(u.hal, small);
    emitted.length = 0;
    await signals.typing(u.gus, small, true);
    expect(emitted.filter((e) => e.event === 'dm_typing').flatMap((e) => e.to)).toEqual([`user:${u.hal.id}`]);

    const big = await group('ivy');
    await groups.join(u.jon, big);
    await groups.join(u.kim, big);
    emitted.length = 0;
    await signals.typing(u.ivy, big, true);
    expect(emitted.filter((e) => e.event === 'dm_typing')).toEqual([]);
  });

  // ─── V2-121: invites ──────────────────────────────────────────────────────────────────────────────────────────────
  it('invites obey the per-window limit and the pending cap; an invite ends by time and can be revoked', async () => {
    settings({ groups: { invitesPerWindow: 2, maxPendingInvitesPerPerson: 1 } });
    const g1 = await group('lee', { visibility: 'PRIVATE' });
    const g2 = await group('lee', { visibility: 'PRIVATE' });

    const first = await groupInvites.invite(u.lee, g1, [u.ada.username, u.bob.username]);
    expect(first.invited).toHaveLength(2);
    // The same person again for the same group is the same invite, and costs nothing more.
    const again = await groupInvites.invite(u.lee, g1, [u.ada.username]);
    expect(again.invited[0]!.inviteId).toBe(first.invited[0]!.inviteId);
    // ada already has a pending invite elsewhere: the cap is one per person.
    expect((await groupInvites.invite(u.lee, g2, [u.ada.username])).skipped).toEqual([
      { username: u.ada.username, reason: 'too_many_pending_invites' },
    ]);
    // The window allows two invites: both are used.
    expect((await groupInvites.invite(u.lee, g2, [u.cat.username])).skipped).toEqual([
      { username: u.cat.username, reason: 'invite_limit_reached' },
    ]);

    // An invite ends by itself after the admin-set time.
    const invite = first.invited[0]!;
    await prisma.$executeRaw`UPDATE chat.dm_group_invites SET expires_at = now() - interval '1 minute' WHERE id = ${invite.inviteId}::uuid`;
    const who = invite.username === u.ada.username ? u.ada : u.bob;
    expect((await groupInvites.invites(who)).items.map((i) => i.id)).not.toContain(invite.inviteId);
    expect(await refusal(() => groupInvites.respondToInvite(who, invite.inviteId, true))).not.toBe('ok');

    // Revoke: the other invite is withdrawn and can no longer be accepted.
    const other = first.invited[1]!;
    expect(await groupInvites.revokeInvite(u.lee, g1, other.inviteId)).toEqual({ inviteId: other.inviteId, revoked: true });
    const otherUser = other.username === u.ada.username ? u.ada : u.bob;
    expect(await refusal(() => groupInvites.respondToInvite(otherUser, other.inviteId, true))).not.toBe('ok');
  });

  // ─── V2-44: the quiet window is the admin's ───────────────────────────────────────────────────────────────────────
  it('no quiet window set means quiet hours never apply', () => {
    const prefs = { notifyPrimary: true, notifyGeneral: true, notifyGroups: true, quietMode: 'AUTO_NIGHT', timeZone: 'Asia/Kolkata' } as const;
    const at = new Date('2026-10-26T17:30:00Z');
    expect(inQuietHours({ ...prefs, quietStart: null, quietEnd: null }, at)).toBe(false);
    expect(inQuietHours({ ...prefs, quietStart: '22:00', quietEnd: '07:00' }, at)).toBe(true);
  });
});
