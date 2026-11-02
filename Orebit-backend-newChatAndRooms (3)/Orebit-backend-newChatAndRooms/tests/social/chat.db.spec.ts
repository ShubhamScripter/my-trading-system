import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { ChatDbOperation } from '../../src/social/chat/chat.dboperation';
import { ChatHistoryDbOperation } from '../../src/social/chat/persistence/chat.history.dboperation';
import { ChatRecordsDbOperation } from '../../src/social/chat/persistence/chat.records.dboperation';
import { ChatBus } from '../../src/social/chat/realtime/chat.bus';
import { ChatSettingsService } from '../../src/social/chat/chat.settings';
import { ChatSettingsDbOperation } from '../../src/social/chat/persistence/chat.settings.dboperation';
import type { PrismaService } from '../../db/client';

/**
 * Database-backed checks on real tables: partitions, the history cursor, atomic retract, report
 * uniqueness, append-only moderation records, history protected from deletes, scheduled settings on the database
 * clock. Runs against a MIGRATED database named by CHAT_TEST_DATABASE_URL (never the development database); skipped
 * when it is not set:
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run tests/social/chat.db.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;

describe.skipIf(!url)('chat on a real database', () => {
  let prisma: PrismaClient;
  let db: ChatDbOperation;
  let history: ChatHistoryDbOperation;
  let records: ChatRecordsDbOperation;
  const roomId = uuidv7();
  const userA = uuidv7();
  const userB = uuidv7();

  const user = (id: string, name: string) => prisma.$executeRaw`
    INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
    VALUES (${id}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@t.test`}, ${`${name}@t.test`}, ${name})
  `;
  const message = (at: string, text = 'x') => prisma.$executeRaw`
    INSERT INTO chat.room_messages (id, room_id, user_id, content, type, created_at)
    VALUES (${uuidv7()}::uuid, ${roomId}::uuid, ${userA}::uuid, ${text}, 'TEXT', ${at}::timestamptz)
  `;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    db = new ChatDbOperation(prisma as unknown as PrismaService);
    history = new ChatHistoryDbOperation(prisma as unknown as PrismaService);
    records = new ChatRecordsDbOperation(prisma as unknown as PrismaService);
    const tag = roomId.slice(-8);
    await user(userA, `dba${tag}`);
    await user(userB, `dbb${tag}`);
    await prisma.$executeRaw`
      INSERT INTO chat.rooms (id, slug, name, type, config) VALUES (${roomId}::uuid, ${`db-${tag}`}, 'DB test', 'GLOBAL', '{}')
    `;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('keeps next months ready and a second call creates nothing (NEW-1)', async () => {
    await records.ensurePartitions(3);
    expect((await records.ensurePartitions(3)).created).toBe(0);
  });

  it('puts the last second of a month and the first of the next into their own partitions', async () => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const lastDay = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59)).toISOString();
    const firstDay = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0)).toISOString();
    await message(lastDay, 'end of month');
    await message(firstDay, 'start of month');
    const rows = await prisma.$queryRaw<{ content: string; part: string }[]>`
      SELECT content, tableoid::regclass::text AS part FROM chat.room_messages
      WHERE room_id = ${roomId}::uuid AND content IN ('end of month', 'start of month') ORDER BY created_at
    `;
    const pad = (n: number) => String(n).padStart(2, '0');
    const next = new Date(Date.UTC(y, m + 1, 1));
    expect(rows.map((r) => r.part)).toEqual([
      `chat.room_messages_${y}_${pad(m + 1)}`,
      `chat.room_messages_${next.getUTCFullYear()}_${pad(next.getUTCMonth() + 1)}`,
    ]);
  });

  it('pages history by (created_at, id) without skipping rows that share a time', async () => {
    // This month, so the rows land in a monthly partition and never in DEFAULT.
    const day = `${new Date().toISOString().slice(0, 7)}-01`;
    const same = `${day}T10:00:00.000000Z`;
    for (let i = 0; i < 3; i += 1) await message(same, `same-${i}`);
    await message(`${day}T09:59:59.9995Z`, 'half-ms-earlier');
    const seen: string[] = [];
    let cursor: { createdAt: string; id: string } | null = null;
    for (;;) {
      const page = await history.history(roomId, 1, cursor, false);
      const first = page[0];
      if (!first) break;
      if (first.content.startsWith('same-') || first.content === 'half-ms-earlier')
        seen.push(first.content);
      cursor = { createdAt: first.createdAtText, id: first.id };
      if (page.length === 1) break;
    }
    expect(seen.sort()).toEqual(['half-ms-earlier', 'same-0', 'same-1', 'same-2']);
  });

  it('two parallel retracts: one wins, the other changes nothing', async () => {
    const { row } = await db.insertMessage({
      roomId,
      userId: userA,
      content: 'race',
      type: 'TEXT',
      skinId: null,
      metadata: {},
      taggedUserIds: [],
    });
    const [a, b] = await Promise.all([db.retract(row.id, userA), db.retract(row.id, userB)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('one report per user per message, and users can be reported', async () => {
    const { row } = await db.insertMessage({
      roomId,
      userId: userB,
      content: 'bad',
      type: 'TEXT',
      skinId: null,
      metadata: {},
      taggedUserIds: [],
    });
    const first = await records.insertReport({
      messageId: row.id,
      messageCreatedAt: row.createdAtText,
      reporterId: userA,
      reportedUserId: userB,
      reason: 'SPAM',
      details: null,
    });
    const again = await records.insertReport({
      messageId: row.id,
      messageCreatedAt: row.createdAtText,
      reporterId: userA,
      reportedUserId: userB,
      reason: 'SCAM',
      details: null,
    });
    const aboutUser = await records.insertReport({
      messageId: null,
      messageCreatedAt: null,
      reporterId: userA,
      reportedUserId: userB,
      reason: 'OTHER',
      details: null,
    });
    const systemAdMessageReport = await records.insertReport({
      messageId: row.id,
      messageCreatedAt: row.createdAtText,
      reporterId: userB,
      reportedUserId: null,
      reason: 'SPAM',
      details: 'Admin-created ad',
    });
    expect(first).not.toBeNull();
    expect(again).toBeNull();
    expect(aboutUser).not.toBeNull();
    expect(systemAdMessageReport).not.toBeNull();
  });

  it('a send retried with the same client id is stored once', async () => {
    const clientMessageId = uuidv7();
    const input = {
      roomId,
      userId: userA,
      content: 'once',
      type: 'TEXT' as const,
      skinId: null,
      metadata: {},
      taggedUserIds: [userB],
      clientMessageId,
    };
    const first = await db.insertMessage(input);
    const second = await db.insertMessage(input);
    expect(second.duplicateOf).toBe(first.row.id);
    const feed = await history.tagFeed(userB, 50, null);
    expect(feed.scanned.filter((k) => k.messageId === first.row.id)).toHaveLength(1);
  });

  it('moderation records are append-only', async () => {
    await records.recordAction(prisma as never, {
      actorType: 'SYSTEM',
      actorId: null,
      action: 'test.append',
      targetRoomId: roomId,
    });
    await expect(
      prisma.$executeRaw`UPDATE chat.moderation_actions SET note = 'x' WHERE action = 'test.append'`,
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRaw`DELETE FROM chat.moderation_actions WHERE action = 'test.append'`,
    ).rejects.toThrow(/append-only/);
  });

  it('a room with messages cannot be deleted; history is never erased', async () => {
    await expect(
      prisma.$executeRaw`DELETE FROM chat.rooms WHERE id = ${roomId}::uuid`,
    ).rejects.toThrow();
  });

  it('bans are judged by the database clock; NULL end is permanent', async () => {
    await records.createBan(prisma as never, {
      userId: userB,
      roomId: null,
      internalReason: 'perm',
      seconds: null,
      moderatorId: null,
    });
    await records.createBan(prisma as never, {
      userId: userB,
      roomId,
      internalReason: 'gone',
      seconds: 1,
      moderatorId: null,
    });
    await new Promise((r) => setTimeout(r, 1500));
    const bans = await records.activeBans(userB);
    expect(bans).toContainEqual({ roomId: null, expiresAt: null });
    expect(bans.some((b) => b.roomId === roomId)).toBe(false);
  });

  it('the offence ladder climbs, and lapses back to 1', async () => {
    expect(await records.recordOffence(userA, () => 24)).toBe(1);
    expect(await records.recordOffence(userA, () => 24)).toBe(2);
    await prisma.$executeRaw`UPDATE chat.moderation_offences SET expires_at = now() - interval '1 second' WHERE user_id = ${userA}::uuid`;
    expect(await records.recordOffence(userA, () => 24)).toBe(1);
  });

  it('applies a scheduled settings change only once the database clock passes it', async () => {
    await prisma.$executeRaw`UPDATE chat.settings SET document = '{"global":{},"countries":{}}' WHERE id = 1`;
    const settings = new ChatSettingsService(
      new ChatSettingsDbOperation(prisma as unknown as PrismaService),
      new ChatBus(),
    );
    const later = uuidv7();
    const due = uuidv7();
    await prisma.$executeRaw`
      INSERT INTO chat.settings_changes (id, target, patch, effective_at, status)
      VALUES (${later}::uuid, 'SETTINGS', '{"global":{"minLevel":{"global":9}}}', now() + interval '1 hour', 'SCHEDULED'),
             (${due}::uuid, 'SETTINGS', '{"global":{"casino":{"wagerWindowDays":7}}}', now() - interval '1 second', 'SCHEDULED')
    `;
    await settings.applyDueChanges();
    const rows = await prisma.$queryRaw<{ id: string; status: string }[]>`
      SELECT id::text, status FROM chat.settings_changes WHERE id IN (${later}::uuid, ${due}::uuid)
    `;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [later]: 'SCHEDULED',
      [due]: 'APPLIED',
    });
    settings.invalidate();
    expect((await settings.global()).casino.wagerWindowDays).toBe(7);
    await prisma.$executeRaw`UPDATE chat.settings_changes SET status = 'CANCELLED' WHERE id = ${later}::uuid`;
    await prisma.$executeRaw`UPDATE chat.settings SET document = '{"global":{},"countries":{}}' WHERE id = 1`;
  });
});
