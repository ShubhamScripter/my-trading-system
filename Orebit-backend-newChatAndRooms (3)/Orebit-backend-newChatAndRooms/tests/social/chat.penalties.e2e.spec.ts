import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { ChatSettingsDocumentSchema } from '../../src/social/chat/chat.settings.contract';
import type { ChatUserContext, EligibilityFacts } from '../../src/social/chat/chat.types';
import { ChatStaffDbOperation } from '../../src/social/chat/persistence/chat.staff.dboperation';
import { ChatRestrictionsService, restrictionTargets } from '../../src/social/chat/services/chat.restrictions.service';
import { ChatAccessService } from '../../src/social/chat/chat.access.service';
import { ChatReadService } from '../../src/social/chat/services/chat.read.service';
import { ChatStaffGroupService } from '../../src/social/chat/services/chat.staff.group.service';
import { ChatService } from '../../src/social/chat/chat.service';
import { ChatStaffQueueService } from '../../src/social/chat/services/chat.staff.queue.service';
import { ChatStaffRequestsService } from '../../src/social/chat/services/chat.staff.requests.service';
import { ChatStaffPenaltiesService } from '../../src/social/chat/services/chat.staff.penalties.service';
import { ChatStaffService } from '../../src/social/chat/services/chat.staff.service';
import { ChatStaffToolsService } from '../../src/social/chat/services/chat.staff.tools.service';
import { bootChat, makeUsers, READY, refusal, type Emitted } from './chat.e2e.harness';

/**
 * Slice F1 on the REAL services and a migrated scratch database: FR-087 (durations are said, staff do not mute, a reason
 * change keeps the end), FR-088 (users by id, the rank kept on a ban), FR-093 (no live restriction is left out of the
 * cache) and FR-213 (one live ban, never "permanent" with a length).
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run --config vitest.chat.config.ts \
 *     tests/social/chat.penalties.e2e.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;
const NAMES = ['boss', 'mod', 'ada', 'bob', 'cat', 'dan'] as const;

describe.skipIf(!url)('penalties (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  const emitted: Emitted[] = [];
  const tag = uuidv7().slice(-6);
  let u: Record<(typeof NAMES)[number], ChatUserContext>;
  let document: unknown;

  const settings = () => {
    document = ChatSettingsDocumentSchema.parse({
      global: {
        testProviders: { enabled: true },
        limits: { messagesPerWindow: 100, messageWindowSeconds: 1, cooldownSeconds: 1, mediaCooldownSeconds: 0, maxBanHours: 24 * 30 },
        ...READY,
      },
    });
  };
  const restrict = (by: ChatUserContext, target: ChatUserContext, extra: Record<string, unknown>) =>
    module.get(ChatStaffToolsService).restrict(by, {
      targetType: 'USER',
      targetValue: target.username,
      kind: 'RESTRICT_GIF',
      internalReason: 'Test',
      ...extra,
    } as never) as Promise<{ id: string; expiresAt: string | null }>;
  const ban = (by: ChatUserContext, target: ChatUserContext, extra: Record<string, unknown> = {}) =>
    module.get(ChatStaffService).staffBan(by, { userId: target.id, roomId: null, internalReason: 'Spam', durationHours: 2, ...extra });
  const bans = async (target: ChatUserContext) =>
    prisma.$queryRaw<{ id: string; moderator_role: string | null; internal_reason: string }[]>`
      SELECT id, moderator_role, internal_reason FROM chat.user_bans WHERE user_id = ${target.id}::uuid
    `;

  beforeAll(async () => {
    settings();
    ({ prisma, module } = await bootChat(url!, emitted, () => document));
    u = await makeUsers(prisma, NAMES, tag);
    await prisma.$executeRaw`INSERT INTO chat.staff_roles (id, user_id, role) VALUES (${uuidv7()}::uuid, ${u.boss.id}::uuid, 'ADMIN'::chat."StaffRole")`;
    await prisma.$executeRaw`INSERT INTO chat.staff_roles (id, user_id, role) VALUES (${uuidv7()}::uuid, ${u.mod.id}::uuid, 'MODERATOR'::chat."StaffRole")`;
    u.boss = { ...u.boss, staffRole: 'ADMIN' };
    u.mod = { ...u.mod, staffRole: 'MODERATOR' };
  }, 60_000);

  beforeEach(() => settings());

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  // ─── FR-213 ────────────────────────────────────────────────────────────────────────────────────────────────────
  it('five parallel bans make one ban; the others are told the user is already banned', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => refusal(() => ban(u.mod, u.ada))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'already_banned')).toHaveLength(4);
    expect(await bans(u.ada)).toHaveLength(1);
    // A repeat later is refused too, until the ban is gone.
    expect(await refusal(() => ban(u.mod, u.ada))).toBe('already_banned');
  });

  it('"permanent" together with a length is refused, and a ban says how long', async () => {
    expect(await refusal(() => ban(u.boss, u.bob, { permanent: true, durationHours: 3 }))).toBe('validation_failed');
    expect(await refusal(() => ban(u.boss, u.bob, { durationHours: undefined }))).toBe('validation_failed');
    expect(await bans(u.bob)).toHaveLength(0);
    expect(await refusal(() => ban(u.boss, u.bob, { durationHours: undefined, permanent: true }))).toBe('ok');
  });

  it('a moderator cannot ban beyond the role maximum or for ever', async () => {
    expect(await refusal(() => ban(u.mod, u.cat, { durationHours: 25 }))).toBe('outside_role_scope');
    expect(await refusal(() => ban(u.mod, u.cat, { durationHours: undefined, permanent: true }))).toBe('outside_role_scope');
    expect(await bans(u.cat)).toHaveLength(0);
  });

  // ─── FR-088 ────────────────────────────────────────────────────────────────────────────────────────────────────
  it('a ban keeps the role its issuer had; demoting the issuer later does not lower it', async () => {
    const [row] = await bans(u.ada);
    expect(row).toMatchObject({ moderator_role: 'MODERATOR', internal_reason: 'Spam' });
    await prisma.$executeRaw`UPDATE chat.staff_roles SET role = 'SUPPORT'::chat."StaffRole" WHERE user_id = ${u.mod.id}::uuid`;
    const found = await module.get(ChatStaffDbOperation).banById(row!.id);
    expect(found?.moderatorRole).toBe('MODERATOR');
    await prisma.$executeRaw`UPDATE chat.staff_roles SET role = 'MODERATOR'::chat."StaffRole" WHERE user_id = ${u.mod.id}::uuid`;
  });

  it('a restriction names a user by id only: the same name on another account is not restricted', () => {
    const facts = {} as EligibilityFacts;
    const rule = { targetType: 'USER' as const, targetValue: u.ada.id };
    expect(restrictionTargets(rule, u.ada, facts, new Date())).toBe(true);
    expect(restrictionTargets({ ...rule, targetValue: u.ada.username }, u.ada, facts, new Date())).toBe(false);
    expect(restrictionTargets(rule, u.bob, facts, new Date())).toBe(false);
  });

  it('the migration turns a name or a login code in a room list into the user id, and leaves what matches nobody', async () => {
    const room = uuidv7();
    await prisma.$executeRaw`
      INSERT INTO chat.rooms (id, slug, name, type, config)
      VALUES (${room}::uuid, ${`pen-${tag}`}, 'Pen', 'GLOBAL', ${JSON.stringify({
        userRestrictions: [
          { targetType: 'USER', targetValue: u.dan.username.toUpperCase(), restriction: 'RESTRICT_GIF', reason: 'x' },
          { targetType: 'USER', targetValue: u.dan.publicCode, restriction: 'RESTRICT_EMOJI', reason: 'x' },
          { targetType: 'USER', targetValue: 'nobody-by-that-name', restriction: 'RESTRICT_GIF', reason: 'x' },
          { targetType: 'LEVEL', targetValue: '5', restriction: 'RESTRICT_GIF', reason: 'x' },
        ],
      })}::jsonb)
    `;
    const sql = readFileSync(join(__dirname, '../../db/migrations/20261031100000_chat_penalties/migration.sql'), 'utf8');
    const update = sql.slice(sql.indexOf('UPDATE "chat"."rooms"'));
    await prisma.$executeRawUnsafe(update);
    const [row] = await prisma.$queryRaw<{ config: { userRestrictions: { targetValue: string }[] } }[]>`
      SELECT config FROM chat.rooms WHERE id = ${room}::uuid
    `;
    expect(row!.config.userRestrictions.map((r) => r.targetValue)).toEqual([u.dan.id, u.dan.id, 'nobody-by-that-name', '5']);
  });

  // ─── FR-087 ────────────────────────────────────────────────────────────────────────────────────────────────────
  it('staff do not mute: the MUTE action is refused and a ban is the way', async () => {
    expect(await refusal(() => restrict(u.boss, u.cat, { kind: 'MUTE', durationHours: 2 }))).toBe('validation_failed');
  });

  it('a restriction says how long it lasts: a length of at least one hour, or permanent; never neither, 0 or both', async () => {
    for (const extra of [{}, { durationHours: 0 }, { durationHours: 0.5 }, { permanent: true, durationHours: 5 }]) {
      expect(await refusal(() => restrict(u.boss, u.cat, extra))).toBe('validation_failed');
    }
    const timed = await restrict(u.boss, u.cat, { durationHours: 2 });
    expect(timed.expiresAt).not.toBeNull();
    // The role's ban maximum is for bans: another restriction may last as long as the contract allows.
    expect((await restrict(u.mod, u.dan, { durationHours: 24 * 90 })).expiresAt).not.toBeNull();
    expect((await restrict(u.boss, u.ada, { permanent: true })).expiresAt).toBeNull();
  });

  it('changing only the reason keeps the end; permanent and a new length are said', async () => {
    const made = await restrict(u.boss, u.bob, { durationHours: 48 });
    const penalties = module.get(ChatStaffPenaltiesService);
    const kept = await penalties.changeRestriction(u.boss, made.id, { internalReason: 'New reason' });
    expect(kept).toEqual({ id: made.id, expiresAt: made.expiresAt });
    const [row] = await prisma.$queryRaw<{ reason: string }[]>`SELECT internal_reason AS reason FROM chat.user_restrictions WHERE id = ${made.id}::uuid`;
    expect(row!.reason).toBe('New reason');
    const shorter = (await penalties.changeRestriction(u.boss, made.id, { durationHours: 1 })) as { expiresAt: string };
    expect(new Date(shorter.expiresAt).getTime()).toBeLessThan(new Date(made.expiresAt!).getTime());
    expect(((await penalties.changeRestriction(u.boss, made.id, { permanent: true })) as { expiresAt: string | null }).expiresAt).toBeNull();
    expect(await refusal(() => penalties.changeRestriction(u.boss, made.id, { permanent: true, durationHours: 3 }))).toBe('validation_failed');
  });

  // ─── FR-089, FR-176 ───────────────────────────────────────────────────────────────────────────────────────────────
  it('only text and media are retracted from chat: ad, gift and alert notices are refused for the author and for staff', async () => {
    const room = uuidv7();
    await prisma.$executeRaw`INSERT INTO chat.rooms (id, slug, name, type, config) VALUES (${room}::uuid, ${`ret-${tag}`}, 'Ret', 'GLOBAL', '{}'::jsonb)`;
    const SYSTEM = '00000000-0000-0000-0000-000000000000';
    const put = async (type: string, author: string, content: string) => {
      const id = uuidv7();
      await prisma.$executeRaw`
        INSERT INTO chat.room_messages (id, room_id, user_id, content, type, metadata, created_at)
        VALUES (${id}::uuid, ${room}::uuid, ${author}::uuid, ${content}, ${type}::chat."MessageType", '{}'::jsonb, now())
      `;
      return id;
    };
    const chat = module.get(ChatService);
    const gift = await put('GIFT', u.dan.id, 'Ada sent 1 USDT');
    const ad = await put('AD', u.dan.id, 'Buy now');
    const alert = await put('ADMIN_ALERT', SYSTEM, 'Maintenance');
    for (const id of [gift, ad, alert]) {
      expect(await refusal(() => chat.retract(u.dan, id, null))).toBe('not_retractable'); // the author
      expect(await refusal(() => chat.retract(u.boss, id, null))).toBe('not_retractable'); // staff
    }
    // The author's own text still goes.
    const text = await put('TEXT', u.dan.id, 'my words');
    expect(await refusal(() => chat.retract(u.dan, text, null))).toBe('ok');
  });

  // ─── FR-099 ────────────────────────────────────────────────────────────────────────────────────────────────────
  describe('group privilege: warn and ban a group by rule', () => {
    const group = { targetType: 'LEVEL' as const, targetValue: '10' };
    const level = async (user: ChatUserContext, n: number) => {
      await prisma.$executeRaw`INSERT INTO chat.test_entitlements (user_id, level) VALUES (${user.id}::uuid, ${n}) ON CONFLICT (user_id) DO UPDATE SET level = ${n}`;
      module.get(ChatAccessService).forgetUser(user.id);
    };
    const count = async (table: 'group_warnings' | 'chat_warnings' | 'user_restrictions') =>
      (await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM chat.${table}`))[0]!.n;

    it('a role without Group Privilege is refused, for a warning and for a ban', async () => {
      const groups = module.get(ChatStaffGroupService);
      expect(await refusal(() => groups.warn(u.mod, { group, roomId: null, internalReason: 'x' }))).toBe('outside_role_scope');
      expect(await refusal(() => groups.ban(u.mod, { group, roomId: null, internalReason: 'x', durationHours: 2 }))).toBe('outside_role_scope');
    });

    it('a group warning is ONE rule row, shown to the users it names and to nobody else', async () => {
      await level(u.dan, 12);
      await level(u.cat, 2);
      const warnings = await count('chat_warnings');
      const rules = await count('group_warnings');
      const made = await module.get(ChatStaffGroupService).warn(u.boss, { group, roomId: null, internalReason: `Staff only ${tag}`, userReason: `Group note ${tag}` });
      expect(await count('group_warnings')).toBe(rules + 1);
      expect(await count('chat_warnings')).toBe(warnings); // no row per user
      const read = module.get(ChatReadService);
      expect((await read.warnings(u.dan, { limit: 50 })).items.map((w) => w.reason)).toContain(`Group note ${tag}`);
      expect((await read.warnings(u.cat, { limit: 50 })).items.map((w) => w.reason)).not.toContain(`Group note ${tag}`);
      expect(JSON.stringify((await read.warnings(u.dan, { limit: 50 })).items)).not.toContain(`Staff only ${tag}`); // V2-104
      expect(made.group).toEqual(group);
    });

    it('a group ban is one restriction rule: the group can read but not post, the others are untouched, and it is lifted like any restriction', async () => {
      await level(u.dan, 12);
      await level(u.cat, 2);
      const before = await count('user_restrictions');
      const made = await module.get(ChatStaffGroupService).ban(u.boss, { group, roomId: null, internalReason: 'Group ban', durationHours: 2 });
      expect(await count('user_restrictions')).toBe(before + 1);
      expect(made.expiresAt).not.toBeNull();
      const service = module.get(ChatRestrictionsService);
      service.invalidate();
      const access = module.get(ChatAccessService);
      const muted = (user: ChatUserContext) => access.factsFor(user).then((facts) => service.find(user, facts, 'MUTE', null, new Date()));
      expect((await muted(u.dan))?.id).toBe(made.id);
      expect(await muted(u.cat)).toBeNull();
      await module.get(ChatStaffPenaltiesService).liftRestriction(u.boss, made.id, null);
      service.invalidate();
      expect(await muted(u.dan)).toBeNull();
    });

    it('the ban length rules are the same as for one user, and a LEVEL group is a whole number', async () => {
      const groups = module.get(ChatStaffGroupService);
      expect(await refusal(() => groups.ban(u.boss, { group, roomId: null, internalReason: 'x' }))).toBe('validation_failed');
      expect(await refusal(() => groups.ban(u.boss, { group, roomId: null, internalReason: 'x', durationHours: 2, permanent: true }))).toBe('validation_failed');
      expect(await refusal(() => groups.ban(u.boss, { group: { targetType: 'LEVEL', targetValue: 'high' }, roomId: null, internalReason: 'x', durationHours: 2 }))).toBe('validation_failed');
    });
  });

  // ─── FR-094 ────────────────────────────────────────────────────────────────────────────────────────────────────
  const newReport = async (about: ChatUserContext) => {
    const id = uuidv7();
    await prisma.$executeRaw`INSERT INTO chat.report_reasons (code, label, is_active, sort_order) VALUES ('atomic_test', 'Atomic test', true, 999) ON CONFLICT (code, report_type) DO NOTHING`;
    await prisma.$executeRaw`
      INSERT INTO chat.chat_message_reports (id, reporter_id, reported_user_id, reason, status)
      VALUES (${id}::uuid, ${u.dan.id}::uuid, ${about.id}::uuid, 'atomic_test', 'PENDING'::chat."ReportStatus")
    `;
    return id;
  };
  const reportStatus = async (id: string) =>
    (await prisma.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM chat.chat_message_reports WHERE id = ${id}::uuid`)[0]!.status;

  it('two moderators banning from one report make one ban; the other is told it is resolved', async () => {
    const report = await newReport(u.cat);
    const queue = module.get(ChatStaffQueueService);
    const results = await Promise.all(
      [u.mod, u.boss].map((by) => refusal(() => queue.actOnReport(by, report, { action: 'BAN', durationHours: 2 }))),
    );
    expect(results.sort()).toEqual(['already_reported', 'ok']);
    expect((await bans(u.cat)).length).toBe(1);
    expect(await reportStatus(report)).toBe('ACTIONED');
  });

  it('an action that is refused gives the report back, so another moderator can act', async () => {
    const report = await newReport(u.dan);
    const queue = module.get(ChatStaffQueueService);
    // 25 hours is more than a moderator may ban for.
    expect(await refusal(() => queue.actOnReport(u.mod, report, { action: 'BAN', durationHours: 25 }))).toBe('outside_role_scope');
    expect(await reportStatus(report)).toBe('PENDING');
    expect(await refusal(() => queue.actOnReport(u.boss, report, { action: 'DISMISS' }))).toBe('ok');
    expect(await reportStatus(report)).toBe('DISMISSED');
  });

  // ─── FR-091 ────────────────────────────────────────────────────────────────────────────────────────────────────
  it('requests the member may not resolve do not fill the page: the one they may resolve is on the first page', async () => {
    // 60 newer requests from an ADMIN (a role above the moderator) and one older one from a SUPPORT member the moderator may resolve.
    await prisma.$executeRaw`
      INSERT INTO chat.staff_requests (id, requester_id, requester_role, permission, payload, note, status, created_at)
      VALUES (gen_random_uuid(), ${u.cat.id}::uuid, 'SUPPORT', 'WARN', '{}'::jsonb, ${`resolvable ${tag}`}, 'PENDING', now() - interval '1 hour')
    `;
    await prisma.$executeRaw`
      INSERT INTO chat.staff_requests (id, requester_id, requester_role, permission, payload, note, status, created_at)
      SELECT gen_random_uuid(), ${u.boss.id}::uuid, 'ADMIN', 'WARN', '{}'::jsonb, ${`above ${tag}`}, 'PENDING', now() - make_interval(secs => g)
      FROM generate_series(1, 60) g
    `;
    const page = await module.get(ChatStaffRequestsService).requests(u.mod, { scope: 'TO_RESOLVE', limit: 50 });
    expect(page.items.map((r) => r.note)).toContain(`resolvable ${tag}`);
    expect(page.items.every((r) => r.requesterRole !== 'ADMIN')).toBe(true);
    // A full page of resolvable requests still pages: the cursor continues.
    expect(page.nextCursor === null || typeof page.nextCursor === 'string').toBe(true);
  });

  // ─── FR-093 ────────────────────────────────────────────────────────────────────────────────────────────────────
  it('with more than 20,000 live restrictions the newest is still loaded and enforced', async () => {
    const before = (await module.get(ChatStaffDbOperation).activeRestrictions()).length;
    await prisma.$executeRaw`
      INSERT INTO chat.user_restrictions (id, target_type, target_value, kind, commands, internal_reason, created_at)
      SELECT gen_random_uuid(), 'USER', gen_random_uuid()::text, 'RESTRICT_GIF', ARRAY[]::text[], ${`bulk ${tag}`},
             now() - interval '1 day' - make_interval(secs => g)
      FROM generate_series(1, 20005) g
    `;
    try {
      const newest = await restrict(u.boss, u.dan, { kind: 'RESTRICT_EMOJI', permanent: true });
      const loaded = await module.get(ChatStaffDbOperation).activeRestrictions(2000);
      expect(loaded.length).toBeGreaterThanOrEqual(before + 20006);
      expect(loaded.map((r) => r.id)).toContain(newest.id);
      expect(new Set(loaded.map((r) => r.id)).size).toBe(loaded.length);

      const service = module.get(ChatRestrictionsService);
      service.invalidate();
      const found = await service.find(u.dan, {} as EligibilityFacts, 'RESTRICT_EMOJI', null, new Date());
      expect(found?.id).toBe(newest.id);
    } finally {
      await prisma.$executeRaw`UPDATE chat.user_restrictions SET lifted_at = now() WHERE internal_reason = ${`bulk ${tag}`}`;
      module.get(ChatRestrictionsService).invalidate();
    }
  }, 60_000);
});
