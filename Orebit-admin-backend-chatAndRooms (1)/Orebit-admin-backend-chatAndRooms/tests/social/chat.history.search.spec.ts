import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { GetRoomMessagesQuerySchema } from '../../src/social/chat/chat.dto';
import { ChatRoomDbOperation } from '../../src/social/chat/chat-room.dboperation';
import { ChatUtility } from '../../src/social/chat/chat.utility';
import { ChatModerationDbOperation } from '../../src/social/chat/chat-moderation.dboperation';

/**
 * FR-095: admin message history by user across rooms, with date range, type, sort and a cursor that never skips or repeats
 * a message, served by the (user_id, created_at DESC, id DESC) index.
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run tests/social/chat.history.search.spec.ts
 */
describe('the history query', () => {
  const id = ChatUtility.generateUuid();
  const base = { roomId: id };
  it('needs a room or a user: a search with neither would read every message', () => {
    expect(GetRoomMessagesQuerySchema.safeParse({}).success).toBe(false);
    expect(GetRoomMessagesQuerySchema.safeParse({ limit: 10 }).success).toBe(false);
    expect(GetRoomMessagesQuerySchema.safeParse(base).success).toBe(true);
    expect(GetRoomMessagesQuerySchema.safeParse({ userId: 'ada' }).success).toBe(true);
  });

  it('takes dates in order, a known type, a known sort, and a cursor from a page before; nothing else', () => {
    expect(GetRoomMessagesQuerySchema.safeParse({ ...base, from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success).toBe(false);
    expect(GetRoomMessagesQuerySchema.safeParse({ ...base, type: 'NOPE' }).success).toBe(false);
    expect(GetRoomMessagesQuerySchema.safeParse({ ...base, sort: 'sideways' }).success).toBe(false);
    expect(GetRoomMessagesQuerySchema.safeParse({ ...base, cursor: 'not a cursor' }).success).toBe(false);
    expect(GetRoomMessagesQuerySchema.safeParse({ ...base, limit: 101 }).success).toBe(false);
    expect(GetRoomMessagesQuerySchema.safeParse({ ...base, other: 1 }).success).toBe(false);
    const ok = GetRoomMessagesQuerySchema.parse({ ...base, type: 'TEXT', sort: 'asc', from: '2026-01-01T00:00:00Z' });
    expect(ok).toMatchObject({ sort: 'asc', limit: 50 });
  });
});

const url = process.env.CHAT_TEST_DATABASE_URL;

describe.skipIf(!url)('the history search on a real database', () => {
  let prisma: PrismaClient;
  let db: ChatRoomDbOperation;
  const tag = ChatUtility.generateUuid().slice(-6);
  const ada = ChatUtility.generateUuid();
  const bob = ChatUtility.generateUuid();
  const [roomA, roomB] = [ChatUtility.generateUuid(), ChatUtility.generateUuid()];
  const ids: string[] = [];
  // Days of the current month, so the rows land in a month partition (never in the DEFAULT one).
  const now = new Date();
  const at = (n: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), n, 10)).toISOString().replace('.000Z', '.000000Z');

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    db = new ChatRoomDbOperation(prisma as never);
    await prisma.$executeRaw`SELECT chat.ensure_message_partitions(3)`;
    for (const [uid, name] of [[ada, `hsa${tag}`], [bob, `hsb${tag}`]] as const) {
      await prisma.$executeRaw`
        INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
        VALUES (${uid}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@e2e.test`}, ${`${name}@e2e.test`}, ${name})
      `;
    }
    for (const [rid, slug] of [[roomA, `hsa-${tag}`], [roomB, `hsb-${tag}`]] as const) {
      await prisma.$executeRaw`INSERT INTO chat.rooms (id, slug, name, type, config) VALUES (${rid}::uuid, ${slug}, ${slug}, 'GLOBAL', '{}')`;
    }
    // Ada writes 5 messages in A and 3 in B; two share one instant (the cursor must not lose either). Bob writes 2.
    const rows: [string, string, string, string, string][] = [
      [ada, roomA, 'TEXT', at(1), 'a1'], [ada, roomA, 'TEXT', at(2), 'a2'], [ada, roomA, 'TEXT', at(3), 'a3'],
      [ada, roomA, 'TEXT', at(3), 'a3b'], [ada, roomA, 'MEDIA', at(4), 'a4'],
      [ada, roomB, 'TEXT', at(5), 'b1'], [ada, roomB, 'AD', at(6), 'b2'], [ada, roomB, 'TEXT', at(7), 'b3'],
      [bob, roomA, 'TEXT', at(2), 'x1'], [bob, roomB, 'TEXT', at(8), 'x2'],
    ];
    for (const [uid, rid, type, when, content] of rows) {
      const mid = ChatUtility.generateUuid();
      ids.push(mid);
      await prisma.$executeRaw`
        INSERT INTO chat.room_messages (id, room_id, user_id, content, type, metadata, created_at)
        VALUES (${mid}::uuid, ${rid}::uuid, ${uid}::uuid, ${content}, ${type}::chat."MessageType", '{}'::jsonb, ${when}::timestamptz)
      `;
    }
  });

  afterAll(async () => prisma?.$disconnect());

  const search = (extra: Record<string, unknown>) =>
    db.searchMessages({ sort: 'desc', limit: 50, ...extra } as never);
  const contents = (r: { messages: { content: string }[] }) => r.messages.map((m) => m.content);

  it('follows one user across rooms, newest first', async () => {
    expect(contents(await search({ userId: ada }))).toEqual(['b3', 'b2', 'b1', 'a4', expect.stringMatching(/^a3b?$/), expect.stringMatching(/^a3b?$/), 'a2', 'a1']);
  });

  it('a room alone, and a user inside a room, narrow the same list', async () => {
    expect(contents(await search({ roomId: roomB }))).toEqual(['x2', 'b3', 'b2', 'b1']);
    expect(contents(await search({ roomId: roomB, userId: ada }))).toEqual(['b3', 'b2', 'b1']);
  });

  it('date range and type narrow it; sort asc reverses it', async () => {
    expect(contents(await search({ userId: ada, from: at(2).replace('10:00:00.000000', '00:00:00.000'), to: at(4).replace('10:00:00.000000', '00:00:00.000') }))).toHaveLength(3);
    expect(contents(await search({ userId: ada, type: 'AD' }))).toEqual(['b2']);
    expect(contents(await search({ userId: ada, type: 'MEDIA' }))).toEqual(['a4']);
    expect(contents(await search({ userId: ada, sort: 'asc' }))[0]).toBe('a1');
    expect(contents(await search({ userId: ada, sort: 'asc' })).at(-1)).toBe('b3');
  });

  it('pages by cursor in both directions without skipping or repeating, also across two messages of one instant', async () => {
    for (const sort of ['desc', 'asc'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const r = await search({ userId: ada, sort, limit: 3, cursor });
        seen.push(...r.messages.map((m) => m.id));
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      expect(seen).toHaveLength(8);
      expect(new Set(seen).size).toBe(8);
    }
  });

  it('the user filter is served by the (user_id, created_at, id) index', async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Record<string, string>[]>`
        EXPLAIN SELECT m.id FROM chat.room_messages m WHERE m.user_id = ${ada}::uuid ORDER BY m.created_at DESC, m.id DESC LIMIT 51
      `;
    });
    const text = plan.map((row) => Object.values(row)[0]).join('\n');
    // Each partition answers from its copy of the index, and no partition is read in full.
    expect(text).toContain('user_id_created_at_id_idx');
    expect(text).not.toContain('Seq Scan');
  });
});

describe.skipIf(!url)('a broadcast is one transaction with one small notice (FR-058)', () => {
  it('300 rooms: every room has its alert, the audit row exists, and a failing broadcast writes nothing', async () => {
    const prisma = new PrismaClient({ datasourceUrl: url });
    try {
      const db = new ChatModerationDbOperation(prisma as never);
      const tag = ChatUtility.generateUuid().slice(-6);
      const rooms = Array.from({ length: 300 }, () => ChatUtility.generateUuid());
      await prisma.$executeRaw`
        INSERT INTO chat.rooms (id, slug, name, type, config)
        SELECT t.id, 'bc-' || ${tag} || '-' || t.id::text, 'Broadcast', 'GLOBAL', '{}'::jsonb FROM unnest(${rooms}::uuid[]) AS t(id)
      `;
      const system = '00000000-0000-0000-0000-000000000000';
      const broadcastId = ChatUtility.generateUuid();
      await db.createBroadcast({
        broadcastId,
        roomIds: rooms,
        userId: system,
        content: '[Hello] everyone',
        metadata: { broadcast: true },
        audit: { actorId: ChatUtility.generateUuid(), action: 'BROADCAST', newValue: { roomIds: rooms } },
      });
      const [alerts] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chat.room_messages WHERE metadata->>'broadcastId' = ${broadcastId}
      `;
      expect(alerts!.n).toBe(300);
      const [audit] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chat.moderation_actions WHERE action = 'BROADCAST' AND new_value->>'broadcastId' = ${broadcastId}
      `;
      expect(audit!.n).toBe(1);
      // The live notice names only the broadcast id: far under the 8,000 bytes a database notice may carry.
      expect(JSON.stringify({ kind: 'alert', broadcastId }).length).toBeLessThan(100);

      // A failing broadcast (an unknown room breaks the foreign key) leaves no alert and no audit row behind.
      const failed = ChatUtility.generateUuid();
      await expect(
        db.createBroadcast({
          broadcastId: failed,
          roomIds: [rooms[0]!, ChatUtility.generateUuid()],
          userId: system,
          content: '[Bad] x',
          metadata: {},
          audit: { actorId: ChatUtility.generateUuid(), action: 'BROADCAST', newValue: {} },
        }),
      ).rejects.toThrow();
      const [left] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT (SELECT count(*) FROM chat.room_messages WHERE metadata->>'broadcastId' = ${failed})::int
             + (SELECT count(*) FROM chat.moderation_actions WHERE new_value->>'broadcastId' = ${failed})::int AS n
      `;
      expect(left!.n).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  }, 60_000);
});
