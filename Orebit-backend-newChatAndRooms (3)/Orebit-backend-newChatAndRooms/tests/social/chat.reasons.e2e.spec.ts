import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { ChatSettingsDocumentSchema } from '../../src/social/chat/chat.settings.contract';
import type { ChatUserContext, EligibilityFacts } from '../../src/social/chat/chat.types';
import { ChatRestrictionsService, RESTRICTED_FOR_YOU } from '../../src/social/chat/services/chat.restrictions.service';
import { ChatLimitationsService } from '../../src/social/chat/services/chat.limitations.service';
import { ChatReadService } from '../../src/social/chat/services/chat.read.service';
import { ChatStaffGroupService } from '../../src/social/chat/services/chat.staff.group.service';
import { ChatStaffPenaltiesService } from '../../src/social/chat/services/chat.staff.penalties.service';
import { ChatReportService, ChatStaffService } from '../../src/social/chat/services/chat.staff.service';
import { ChatStaffToolsService } from '../../src/social/chat/services/chat.staff.tools.service';
import { ChatModerationService } from '../../src/social/chat/chat.moderation.service';
import { ChatSettingsService } from '../../src/social/chat/chat.settings';
import { ChatBus, type ChatChange } from '../../src/social/chat/realtime/chat.bus';
import { bootChat, makeUsers, READY, type Emitted } from './chat.e2e.harness';

/**
 * FR-271 (Module 4, V2-104): every ban, restriction and warning has two reasons. The internal one is required and is
 * for staff and admins; the other is optional and is the only one the user ever sees.
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run --config vitest.chat.config.ts \
 *     tests/social/chat.reasons.e2e.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;
const NAMES = ['boss', 'mod', 'ada', 'bob', 'cat', 'dan', 'eve'] as const;
const SECRET = 'INTERNAL-NOTE-do-not-show';

describe.skipIf(!url)('two reasons: internal and for the user (real services, scratch database)', () => {
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
  /** Every change published on the chat bus: a notice for a user is one of them (the gateway turns it into a socket event). */
  const changes: ChatChange[] = [];
  const noticesTo = (user: ChatUserContext) =>
    changes.filter((c): c is Extract<ChatChange, { kind: 'notice' }> => c.kind === 'notice' && c.userId === user.id);

  beforeAll(async () => {
    settings();
    ({ prisma, module } = await bootChat(url!, emitted, () => document));
    module.get(ChatBus).subscribe((change) => void changes.push(change));
    u = await makeUsers(prisma, NAMES, tag);
    await prisma.$executeRaw`INSERT INTO chat.staff_roles (user_id, role) VALUES (${u.boss.id}::uuid, 'ADMIN'::chat."StaffRole")`;
    await prisma.$executeRaw`INSERT INTO chat.staff_roles (user_id, role) VALUES (${u.mod.id}::uuid, 'MODERATOR'::chat."StaffRole")`;
    u.boss = { ...u.boss, staffRole: 'ADMIN' };
    u.mod = { ...u.mod, staffRole: 'MODERATOR' };
  }, 60_000);

  beforeEach(() => {
    settings();
    emitted.length = 0;
    changes.length = 0;
  });

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  it('a ban stores both reasons; the user is told the user reason and never the internal one', async () => {
    const staff = module.get(ChatStaffService);
    await staff.staffBan(u.mod, { userId: u.ada.id, roomId: null, internalReason: SECRET, userReason: 'Please stop posting links', durationHours: 2 });
    const [row] = await prisma.$queryRaw<{ internal_reason: string; user_reason: string | null }[]>`
      SELECT internal_reason, user_reason FROM chat.user_bans WHERE user_id = ${u.ada.id}::uuid
    `;
    expect(row).toEqual({ internal_reason: SECRET, user_reason: 'Please stop posting links' });
    const notices = noticesTo(u.ada);
    expect(notices.length).toBeGreaterThan(0);
    expect(JSON.stringify(notices.map((n) => n.notice))).toContain('Please stop posting links');
    expect(JSON.stringify(notices.map((n) => n.notice))).not.toContain(SECRET);
  });

  it('without a user reason the notice carries none: the internal reason is not a fallback', async () => {
    await module.get(ChatStaffService).staffBan(u.mod, { userId: u.bob.id, roomId: null, internalReason: SECRET, durationHours: 2 });
    const [row] = await prisma.$queryRaw<{ user_reason: string | null }[]>`SELECT user_reason FROM chat.user_bans WHERE user_id = ${u.bob.id}::uuid`;
    expect(row!.user_reason).toBeNull();
    expect(JSON.stringify(noticesTo(u.bob).map((n) => n.notice))).not.toContain(SECRET);
  });

  it('a warning: the user reads the user reason only, and nothing when there is none', async () => {
    const staff = module.get(ChatStaffService);
    await staff.staffWarn(u.mod, { userId: u.cat.id, roomId: null, internalReason: SECRET, userReason: 'Be kind' });
    await staff.staffWarn(u.mod, { userId: u.cat.id, roomId: null, internalReason: `${SECRET} 2` });
    const page = await module.get(ChatReadService).warnings(u.cat, { limit: 20 });
    expect(page.items.map((w) => w.reason).sort()).toEqual([null, 'Be kind'].sort());
    expect(JSON.stringify(page)).not.toContain(SECRET);
    expect(JSON.stringify(noticesTo(u.cat).map((n) => n.notice))).not.toContain(SECRET);
  });

  it('a restriction tells the refused user its user reason, or a plain sentence; never the internal reason', async () => {
    const tools = module.get(ChatStaffToolsService);
    const restrictions = module.get(ChatRestrictionsService);
    const facts = {} as EligibilityFacts;
    await tools.restrict(u.boss, { targetType: 'USER', targetValue: u.dan.username, kind: 'RESTRICT_GIF', internalReason: SECRET, userReason: 'GIFs are off for you', permanent: true });
    await tools.restrict(u.boss, { targetType: 'USER', targetValue: u.dan.username, kind: 'RESTRICT_EMOJI', internalReason: SECRET, permanent: true });
    restrictions.invalidate();
    expect((await restrictions.find(u.dan, facts, 'RESTRICT_GIF', null, new Date()))?.reason).toBe('GIFs are off for you');
    expect((await restrictions.find(u.dan, facts, 'RESTRICT_EMOJI', null, new Date()))?.reason).toBe(RESTRICTED_FOR_YOU);
  });

  it('a group warning and a group ban keep both reasons too', async () => {
    const group = { targetType: 'LEVEL' as const, targetValue: String(900000 + Math.floor(Math.random() * 99999)) };
    await module.get(ChatStaffGroupService).warn(u.boss, { group, roomId: null, internalReason: SECRET, userReason: `Group note ${tag}` });
    const [warning] = await prisma.$queryRaw<{ internal_reason: string; user_reason: string | null }[]>`
      SELECT internal_reason, user_reason FROM chat.group_warnings WHERE user_reason = ${`Group note ${tag}`}
    `;
    expect(warning).toEqual({ internal_reason: SECRET, user_reason: `Group note ${tag}` });
    const banned = await module.get(ChatStaffGroupService).ban(u.boss, { group, roomId: null, internalReason: SECRET, userReason: 'This level is paused', durationHours: 2 });
    const [restriction] = await prisma.$queryRaw<{ internal_reason: string; user_reason: string | null }[]>`
      SELECT internal_reason, user_reason FROM chat.user_restrictions WHERE id = ${banned.id}::uuid
    `;
    expect(restriction).toEqual({ internal_reason: SECRET, user_reason: 'This level is paused' });
    // The group ban is a live rule on the shared scratch database: lift it so it never reaches another spec.
    await prisma.$executeRaw`UPDATE chat.user_restrictions SET lifted_at = now() WHERE id = ${banned.id}::uuid`;
  });

  it('changing a ban: the internal and user reasons change on their own, and the notice follows the user reason', async () => {
    const penalties = module.get(ChatStaffPenaltiesService);
    await module.get(ChatStaffService).staffBan(u.mod, { userId: u.eve.id, roomId: null, internalReason: 'first', userReason: 'first for you', durationHours: 5 });
    const [made] = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM chat.user_bans WHERE user_id = ${u.eve.id}::uuid`;
    const id = made!.id;
    changes.length = 0;
    await penalties.changeBan(u.boss, id, { durationHours: 5, internalReason: SECRET });
    let [row] = await prisma.$queryRaw<{ internal_reason: string; user_reason: string | null }[]>`SELECT internal_reason, user_reason FROM chat.user_bans WHERE id = ${id}::uuid`;
    expect(row).toEqual({ internal_reason: SECRET, user_reason: 'first for you' }); // the user reason is untouched
    expect(JSON.stringify(noticesTo(u.eve).map((n) => n.notice))).not.toContain(SECRET);
    await penalties.changeBan(u.boss, id, { durationHours: 5, userReason: 'second for you' });
    [row] = await prisma.$queryRaw<{ internal_reason: string; user_reason: string | null }[]>`SELECT internal_reason, user_reason FROM chat.user_bans WHERE id = ${id}::uuid`;
    expect(row).toEqual({ internal_reason: SECRET, user_reason: 'second for you' });
  });

  it('every row that existed before keeps its old reason as the internal one and shows the user nothing', async () => {
    const [empty] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.user_bans WHERE internal_reason IS NULL OR length(internal_reason) = 0
    `;
    expect(empty!.n).toBe(0);
    const [dropped] = await prisma.$queryRaw<{ gone: number }[]>`
      SELECT count(*)::int AS gone FROM information_schema.columns WHERE table_schema = 'chat' AND table_name = 'user_bans' AND column_name IN ('reason', 'admin_note')
    `;
    expect(dropped!.gone).toBe(0);
  });
});

describe.skipIf(!url)('FR-225: GET chat/limitations (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  const tag = uuidv7().slice(-6);
  let u: Record<'boss' | 'ada' | 'bob', ChatUserContext>;
  let document: unknown;

  beforeAll(async () => {
    document = ChatSettingsDocumentSchema.parse({ global: { testProviders: { enabled: true }, ...READY } });
    ({ prisma, module } = await bootChat(url!, [], () => document));
    u = await makeUsers(prisma, ['boss', 'ada', 'bob'] as const, tag);
    await prisma.$executeRaw`INSERT INTO chat.staff_roles (user_id, role) VALUES (${u.boss.id}::uuid, 'ADMIN'::chat."StaffRole")`;
    u.boss = { ...u.boss, staffRole: 'ADMIN' };
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  it('lists the caller\'s own bans and restrictions with the user reason only, never the issuer or the internal reason', async () => {
    await module.get(ChatStaffService).staffBan(u.boss, { userId: u.ada.id, roomId: null, internalReason: SECRET, userReason: 'Links are not allowed', durationHours: 3 });
    await module.get(ChatStaffToolsService).restrict(u.boss, { targetType: 'USER', targetValue: u.ada.username, kind: 'RESTRICT_GIF', internalReason: SECRET, permanent: true });
    await module.get(ChatStaffService).staffBan(u.boss, { userId: u.bob.id, roomId: null, internalReason: 'bob only', durationHours: 3 });
    const mine = await module.get(ChatLimitationsService).list(u.ada, {});
    expect(mine.items.map((i) => i.kind).sort()).toEqual(['BAN', 'RESTRICT_GIF']);
    expect(mine.items.find((i) => i.kind === 'BAN')).toMatchObject({ status: 'ACTIVE', reason: 'Links are not allowed' });
    expect(mine.items.find((i) => i.kind === 'RESTRICT_GIF')).toMatchObject({ status: 'ACTIVE', reason: null });
    const text = JSON.stringify(mine);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(u.boss.id); // never who issued it
    expect(text).not.toContain('bob only'); // nobody else's records
  });

  it('pages newest first by a cursor and takes a date range', async () => {
    const service = module.get(ChatLimitationsService);
    const first = await service.list(u.ada, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(u.ada, { limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect((await service.list(u.ada, { to: '2000-01-01T00:00:00Z' })).items).toEqual([]);
  });
});

describe.skipIf(!url)('FR-250: report reasons per report type (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  const tag = uuidv7().slice(-6).toUpperCase();
  let u: Record<'ada' | 'bob', ChatUserContext>;
  let document: unknown;

  beforeAll(async () => {
    document = ChatSettingsDocumentSchema.parse({ global: { testProviders: { enabled: true }, ...READY } });
    ({ prisma, module } = await bootChat(url!, [], () => document));
    u = await makeUsers(prisma, ['ada', 'bob'] as const, tag.toLowerCase());
    await prisma.$executeRaw`INSERT INTO chat.report_reasons (code, label, report_type) VALUES (${`MSG_${tag}`}, 'Spam in a message', 'MESSAGE'), (${`USR_${tag}`}, 'Fake profile', 'USER')`;
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  it('each report type lists only its own reasons; the message list is the default', async () => {
    const reports = module.get(ChatReportService);
    const codes = async (type?: 'MESSAGE' | 'USER') => (await reports.reportReasons(type)).map((r) => r.code);
    expect(await codes()).toContain(`MSG_${tag}`);
    expect(await codes()).not.toContain(`USR_${tag}`);
    expect(await codes('MESSAGE')).not.toContain(`USR_${tag}`);
    expect(await codes('USER')).toEqual(expect.arrayContaining([`USR_${tag}`]));
    expect(await codes('USER')).not.toContain(`MSG_${tag}`);
  });

  it('reporting a user takes a user-profile reason; a message reason is refused there, and the other way round', async () => {
    const reports = module.get(ChatReportService);
    const outcome = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return 'ok';
      } catch (err) {
        return (err as { type?: string }).type ?? 'error';
      }
    };
    expect(await outcome(() => reports.reportUser(u.ada, u.bob.username, { reason: `MSG_${tag}` }))).not.toBe('ok');
    expect(await outcome(() => reports.reportUser(u.ada, u.bob.username, { reason: `USR_${tag}` }))).toBe('ok');
  });
});

describe.skipIf(!url)('FR-253: limit hits are counted per user, reason and hour (real services, scratch database)', () => {
  it('a flush writes one row per reason with the counts, and a second flush adds to them', async () => {
    const document = ChatSettingsDocumentSchema.parse({ global: { testProviders: { enabled: true }, ...READY } });
    const { prisma, module } = await bootChat(url!, [], () => document);
    try {
      const [user] = Object.values(await makeUsers(prisma, ['hit'] as const, uuidv7().slice(-6)));
      const moderation = module.get(ChatModerationService);
      moderation.noteFlood(user!.id, '10.1.1.1');
      moderation.noteFlood(user!.id, '10.1.1.1');
      moderation.noteHit(user!.id, 'report_limit');
      moderation.noteHit(user!.id, 'new_dm_limit');
      const effective = await module.get(ChatSettingsService).global();
      await moderation.flushLimitHits(effective);
      moderation.noteHit(user!.id, 'report_limit');
      await moderation.flushLimitHits(effective);
      const rows = await prisma.$queryRaw<{ reason: string; hits: number }[]>`
        SELECT reason, sum(hits)::int AS hits FROM chat.limit_hits_hourly WHERE user_id = ${user!.id}::uuid GROUP BY reason ORDER BY reason
      `;
      expect(rows).toEqual([
        { reason: 'flood', hits: 2 },
        { reason: 'new_dm_limit', hits: 1 },
        { reason: 'report_limit', hits: 2 },
      ]);
      const [hitter] = await prisma.$queryRaw<{ hits: number; last_ip: string }[]>`SELECT hits, last_ip FROM chat.frequent_hitters WHERE user_id = ${user!.id}::uuid`;
      expect(hitter).toEqual({ hits: 5, last_ip: '10.1.1.1' }); // a hit without an address keeps the one on record
    } finally {
      await module.close();
      await prisma.$disconnect();
    }
  });
});
