import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ChatUtility } from '../../src/social/chat/chat.utility';
import { ChatModerationDbOperation } from '../../src/social/chat/chat-moderation.dboperation';
import { ChatStaffDbOperation } from '../../src/social/chat/persistence/chat-staff.dboperation';
import { ChatReportStatsDbOperation } from '../../src/social/chat/persistence/chat-report-stats.dboperation';
import { GetBansQuerySchema, GetReportsQuerySchema } from '../../src/social/chat/chat.dto';

/**
 * Slice I (edge-case closure), admin side: E04-34 (rows that share a time are all listed at a page edge) and E04-40
 * (the full IP in the frequent-hitter list, V2-03). Scratch database only.
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run tests/social/chat.edge-cases.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;

describe.skipIf(!url)('admin lists at a page edge and the full IP (scratch database)', () => {
  let prisma: PrismaClient;
  let moderation: ChatModerationDbOperation;
  const tag = ChatUtility.generateUuid().slice(-6);
  const users: string[] = [];

  const makeUser = async (name: string) => {
    const id = ChatUtility.generateUuid();
    await prisma.$executeRaw`
      INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
      VALUES (${id}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@e2e.test`}, ${`${name}@e2e.test`}, ${name})
    `;
    users.push(id);
    return id;
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    moderation = new ChatModerationDbOperation(prisma as never);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('E04-34: bans that share one time are all listed, once, when the page ends between them', async () => {
    const admin = ChatUtility.generateUuid();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const userId = await makeUser(`edge${i}${tag}`);
      const id = ChatUtility.generateUuid();
      await moderation.createBan({ id, userId, adminId: admin, internalReason: `Edge ${i}`, seconds: 3600 });
      ids.push(id);
    }
    // The same instant to the microsecond, on every row.
    await prisma.$executeRaw`UPDATE chat.user_bans SET banned_at = '2099-01-02T03:04:05.123456Z'::timestamptz WHERE id = ANY(${ids}::uuid[])`;

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const bans = await moderation.getBans({ limit: 2, activeOnly: false, cursor, userId: undefined });
      const mine = bans.filter((b) => ids.includes(b.id));
      seen.push(...mine.map((b) => b.id));
      if (bans.length < 2) break;
      cursor = bans.at(-1)!.cursor;
      if (seen.length >= ids.length) break;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('E04-34: the cursor keeps the microseconds, so a row that follows within the same millisecond is neither lost nor repeated', async () => {
    const admin = ChatUtility.generateUuid();
    const userA = await makeUser(`msa${tag}`);
    const userB = await makeUser(`msb${tag}`);
    const a = ChatUtility.generateUuid();
    const b = ChatUtility.generateUuid();
    await moderation.createBan({ id: a, userId: userA, adminId: admin, internalReason: 'A', seconds: 3600 });
    await moderation.createBan({ id: b, userId: userB, adminId: admin, internalReason: 'B', seconds: 3600 });
    await prisma.$executeRaw`UPDATE chat.user_bans SET banned_at = '2099-01-02T03:04:06.100100Z'::timestamptz WHERE id = ${a}::uuid`;
    await prisma.$executeRaw`UPDATE chat.user_bans SET banned_at = '2099-01-02T03:04:06.100900Z'::timestamptz WHERE id = ${b}::uuid`;
    const first = await moderation.getBans({ limit: 1, activeOnly: false, userId: userB });
    expect(first.map((x) => x.id)).toEqual([b]);
    expect(first[0]!.cursor).toBe(`2099-01-02T03:04:06.100900Z_${b}`);
    const all = (await moderation.getBans({ limit: 100, activeOnly: false })).filter((x) => [a, b].includes(x.id));
    expect(all.map((x) => x.id)).toEqual([b, a]);
    const after = await moderation.getBans({ limit: 100, activeOnly: false, cursor: all[0]!.cursor });
    expect(after.filter((x) => [a, b].includes(x.id)).map((x) => x.id)).toEqual([a]);
  });

  it('the list queries take a cursor from a previous page and nothing else', () => {
    const cursor = '2099-01-02T03:04:06.100900Z_018f0000-0000-7000-8000-000000000001';
    expect(GetBansQuerySchema.safeParse({ cursor }).success).toBe(true);
    expect(GetReportsQuerySchema.safeParse({ cursor }).success).toBe(true);
    for (const bad of ['2099-01-02T03:04:06Z', 'garbage', `${cursor}; DROP TABLE x`]) {
      expect(GetBansQuerySchema.safeParse({ cursor: bad }).success, bad).toBe(false);
      expect(GetReportsQuerySchema.safeParse({ cursor: bad }).success, bad).toBe(false);
    }
  });

  it('E04-40: every admin sees the full IP of a frequent hitter, with no masking', async () => {
    const userId = await makeUser(`hit${tag}`);
    await prisma.$executeRaw`
      INSERT INTO chat.frequent_hitters (user_id, hits, last_ip, last_hit_at) VALUES (${userId}::uuid, 7, '203.0.113.45', now())
      ON CONFLICT (user_id) DO UPDATE SET last_ip = '203.0.113.45', last_hit_at = now()
    `;
    const hitters = await new ChatStaffDbOperation(prisma as never).getFrequentHitters({ limit: 200, sort: 'date', from: null, to: null });
    expect(hitters.find((h) => h.userId === userId)?.lastIp).toBe('203.0.113.45');
  });
});

describe.skipIf(!url)('FR-253: the frequent-hitter list says what each user was doing (scratch database)', () => {
  it('returns the last 24 hours of hits by reason, most first, and sorts by count or date inside a range', async () => {
    const prisma = new PrismaClient({ datasourceUrl: url });
    try {
      const tag = ChatUtility.generateUuid().slice(-6);
      const make = async (name: string, hits: number) => {
        const id = ChatUtility.generateUuid();
        await prisma.$executeRaw`
          INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
          VALUES (${id}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@e2e.test`}, ${`${name}@e2e.test`}, ${name})
        `;
        await prisma.$executeRaw`INSERT INTO chat.frequent_hitters (user_id, last_ip, hits, last_hit_at) VALUES (${id}::uuid, '10.0.0.1', ${hits}, now())`;
        return id;
      };
      const bot = await make(`bot${tag}`, 400);
      const phone = await make(`phone${tag}`, 3);
      await prisma.$executeRaw`
        INSERT INTO chat.limit_hits_hourly (user_id, hour, reason, hits) VALUES
          (${bot}::uuid, date_trunc('hour', now()), 'flood', 300), (${bot}::uuid, date_trunc('hour', now()), 'slow_mode', 100),
          (${phone}::uuid, date_trunc('hour', now()), 'report_limit', 3),
          (${phone}::uuid, date_trunc('hour', now() - interval '2 days'), 'flood', 99)
      `;
      const db = new ChatStaffDbOperation(prisma as never);
      const byCount = await db.getFrequentHitters({ limit: 500, sort: 'count', from: null, to: null });
      const mine = byCount.filter((h) => [bot, phone].includes(h.userId));
      expect(mine.map((h) => h.userId)).toEqual([bot, phone]); // 400 hits before 3
      expect(mine[0]!.reasons).toEqual([{ reason: 'flood', hits: 300 }, { reason: 'slow_mode', hits: 100 }]);
      expect(mine[1]!.reasons).toEqual([{ reason: 'report_limit', hits: 3 }]); // the 2-day-old row is outside 24 hours
      const old = await db.getFrequentHitters({ limit: 500, sort: 'date', from: null, to: '2000-01-01T00:00:00Z' });
      expect(old.filter((h) => [bot, phone].includes(h.userId))).toEqual([]);
    } finally {
      await prisma.$disconnect();
    }
  });
});

describe.skipIf(!url)('FR-255: report statistics (scratch database)', () => {
  it('counts ACTIONED as correct and DISMISSED as false, REVIEWED apart, with by-reason, top reporters and most reported', async () => {
    const prisma = new PrismaClient({ datasourceUrl: url });
    try {
      const tag = ChatUtility.generateUuid().slice(-6);
      const user = async (name: string) => {
        const id = ChatUtility.generateUuid();
        await prisma.$executeRaw`
          INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
          VALUES (${id}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@e2e.test`}, ${`${name}@e2e.test`}, ${name})
        `;
        return id;
      };
      await prisma.$executeRaw`DELETE FROM chat.chat_message_reports WHERE reason LIKE 'ST_%' AND created_at >= '2099-01-01'`; // an earlier run's rows
      const reporter = await user(`rep${tag}`);
      const target = await user(`tgt${tag}`);
      const code = `ST_${tag.toUpperCase()}`;
      await prisma.$executeRaw`INSERT INTO chat.report_reasons (code, label, report_type) VALUES (${code}, 'Stats', 'USER')`;
      const statuses = ['ACTIONED', 'ACTIONED', 'DISMISSED', 'REVIEWED', 'PENDING'];
      for (const [i, status] of statuses.entries()) {
        await prisma.$executeRaw`
          INSERT INTO chat.chat_message_reports (id, reporter_id, reported_user_id, reason, report_type, status, created_at)
          VALUES (${ChatUtility.generateUuid()}::uuid, ${reporter}::uuid, ${target}::uuid, ${code}, 'USER', ${status}::chat."ReportStatus", '2099-03-01T00:00:00Z'::timestamptz + make_interval(secs => ${i}))
        `;
      }
      const stats = await new ChatReportStatsDbOperation(prisma as never).stats({ from: '2099-01-01T00:00:00Z', to: '2099-12-31T00:00:00Z', top: 5 });
      expect(stats.totals).toEqual({ correct: 2, falseReports: 1, reviewed: 1, pending: 1 });
      expect(stats.byReason).toEqual([{ reportType: 'USER', reason: code, total: 5, correct: 2, falseReports: 1 }]);
      expect(stats.topReporters[0]).toMatchObject({ userId: reporter, total: 5, correct: 2, falseReports: 1 });
      expect(stats.mostReported[0]).toMatchObject({ userId: target, total: 5 });
      const none = await new ChatReportStatsDbOperation(prisma as never).stats({ from: '2000-01-01T00:00:00Z', to: '2000-02-01T00:00:00Z', top: 5 });
      expect(none.totals).toEqual({ correct: 0, falseReports: 0, reviewed: 0, pending: 0 });
    } finally {
      await prisma.$disconnect();
    }
  });
});
