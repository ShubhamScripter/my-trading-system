import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { ChatSettingsDocumentSchema } from '../../src/social/chat/chat.settings.contract';
import { ChatAccessService } from '../../src/social/chat/chat.access.service';
import { ChatSettingsService } from '../../src/social/chat/chat.settings';
import type { ChatUserContext } from '../../src/social/chat/chat.types';
import { ChatContentService } from '../../src/social/chat/services/chat.content.service';
import { bootChat, makeUsers, READY, refusal, type Emitted } from './chat.e2e.harness';

/**
 * FR-098 (Module 4): ONE spam rule and ONE ban ladder for the whole chat, offences counted across rooms (V2-30), on the
 * real services and a migrated scratch database.
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run --config vitest.chat.config.ts \
 *     tests/social/chat.ladder.e2e.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;
const NAMES = ['ada', 'bob', 'cat'] as const;
const LADDER = [
  { tier: 1, action: 'WARNING', resetWindowHours: 24 },
  { tier: 2, action: 'BAN', durationSeconds: 7200, resetWindowHours: 48 },
  { tier: 3, action: 'BAN', permanent: true, resetWindowHours: 168 },
];

describe.skipIf(!url)('chat-wide spam rule and ban ladder (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  const emitted: Emitted[] = [];
  const tag = uuidv7().slice(-6);
  const rooms = { a: uuidv7(), b: uuidv7(), off: uuidv7() };
  let u: Record<(typeof NAMES)[number], ChatUserContext>;
  let document: unknown;

  const settings = (moderation: Record<string, unknown> = { autoBanSequence: LADDER }) => {
    document = ChatSettingsDocumentSchema.parse({
      global: {
        testProviders: { enabled: true },
        limits: { messagesPerWindow: 100, messageWindowSeconds: 1, cooldownSeconds: 1, mediaCooldownSeconds: 0 },
        ...READY,
        moderation,
      },
    });
  };
  /** A message with a banned word, written in a room. */
  const offend = async (user: ChatUserContext, room: keyof typeof rooms, text = 'forbidden') => {
    const access = module.get(ChatAccessService);
    const global = await module.get(ChatSettingsService).global();
    return module.get(ChatContentService).moderate({
      user,
      facts: await access.factsFor(user),
      room: await access.requireRoom(rooms[room]),
      settings: global,
      text,
      media: null,
      dbNow: new Date(),
    });
  };
  const offence = async (user: ChatUserContext) =>
    prisma.$queryRaw<{ count: number }[]>`SELECT count FROM chat.moderation_offences WHERE user_id = ${user.id}::uuid`;
  const count = async (table: 'chat_warnings' | 'user_bans', user: ChatUserContext) =>
    (await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM chat.${table} WHERE user_id = $1::uuid`, user.id))[0]!.n;

  beforeAll(async () => {
    settings();
    ({ prisma, module } = await bootChat(url!, emitted, () => document));
    u = await makeUsers(prisma, NAMES, tag);
    for (const [key, id] of Object.entries(rooms)) {
      const controls = key === 'off' ? { autoModeration: false } : { autoModeration: true };
      await prisma.$executeRaw`
        INSERT INTO chat.rooms (id, slug, name, type, config)
        VALUES (${id}::uuid, ${`lad-${key}-${tag}`}, ${key}, 'GLOBAL', ${JSON.stringify({ bannedWords: ['forbidden'], contentControls: controls })}::jsonb)
      `;
    }
  }, 60_000);

  beforeEach(() => {
    settings();
    emitted.length = 0;
  });

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  it('an offence in room A and then in room B climbs ONE ladder: warning first, then the ban', async () => {
    expect(await refusal(() => offend(u.ada, 'a'))).toBe('content_blocked');
    expect(await count('chat_warnings', u.ada)).toBe(1);
    expect(await count('user_bans', u.ada)).toBe(0);
    expect(await refusal(() => offend(u.ada, 'b'))).toBe('content_blocked');
    expect(await count('user_bans', u.ada)).toBe(1);
    expect(await offence(u.ada)).toEqual([{ count: 2 }]); // one row for the user, not one per room
    const [ban] = await prisma.$queryRaw<{ room_id: string; expires_at: Date | null }[]>`
      SELECT room_id, expires_at FROM chat.user_bans WHERE user_id = ${u.ada.id}::uuid
    `;
    expect(ban!.room_id).toBe(rooms.b); // applied where the second offence happened
    expect(ban!.expires_at).not.toBeNull();
  });

  it('a room that has auto-moderation switched off is skipped: nothing is counted there', async () => {
    expect(await refusal(() => offend(u.bob, 'off'))).toBe('ok');
    expect(await offence(u.bob)).toEqual([]);
    expect(await count('chat_warnings', u.bob)).toBe(0);
  });

  it('with no ladder set the message is refused, the offence is not counted and nobody is penalised', async () => {
    settings({ autoBanSequence: [] });
    expect(await refusal(() => offend(u.cat, 'a'))).toBe('content_blocked');
    expect(await refusal(() => offend(u.cat, 'b'))).toBe('content_blocked');
    expect(await offence(u.cat)).toEqual([]);
    expect(await count('chat_warnings', u.cat)).toBe(0);
    expect(await count('user_bans', u.cat)).toBe(0);
  });

  it('parallel offences in two rooms count exactly once each (no lost update on the user row)', async () => {
    const [d] = Object.values(await makeUsers(prisma, ['dan'] as const, tag));
    await Promise.all([offend(d!, 'a'), offend(d!, 'b'), offend(d!, 'a'), offend(d!, 'b')].map((p) => p.catch(() => undefined)));
    expect(await offence(d!)).toEqual([{ count: 4 }]);
  });

  it('a room can no longer carry its own ladder or spam rule: the stored keys are refused and the migration removed them', async () => {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.rooms WHERE config ?| ARRAY['spamProtection', 'autoBanSequence']
    `;
    expect(row!.n).toBe(0);
  });
});
