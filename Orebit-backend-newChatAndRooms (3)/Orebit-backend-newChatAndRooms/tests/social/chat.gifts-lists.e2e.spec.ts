import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { ChatSettingsDocumentSchema } from '../../src/social/chat/chat.settings.contract';
import type { ChatUserContext } from '../../src/social/chat/chat.types';
import { ChatGiftsService } from '../../src/social/chat/services/chat.gifts.service';
import { ChatRelationsService } from '../../src/social/chat/services/chat.relations.service';
import { bootChat, makeUsers, READY, refusal, type Emitted } from './chat.e2e.harness';

/**
 * Slice C on the REAL services and a migrated scratch database:
 *  - FR-102: a gift names a room only to post its notice there, so the user needs the same view and write rights as for
 *    a message: the Staff room answers like any outsider, a view-only room refuses, an open room works;
 *  - FR-183: the mute list and the block list have a size cap (an admin setting), refused beyond it.
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run --config vitest.chat.config.ts \
 *     tests/social/chat.gifts-lists.e2e.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;
const NAMES = ['ada', 'bob', 'cat', 'dan', 'eve'] as const;

describe.skipIf(!url)('gift notices and list caps (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  const emitted: Emitted[] = [];
  const tag = uuidv7().slice(-6);
  const open = uuidv7();
  const staff = uuidv7();
  const premium = uuidv7();
  let u: Record<(typeof NAMES)[number], ChatUserContext>;
  let document: unknown;

  const settings = (commands: Record<string, unknown> = {}) => {
    document = ChatSettingsDocumentSchema.parse({
      global: {
        testProviders: { enabled: true },
        limits: { messagesPerWindow: 100, messageWindowSeconds: 1, cooldownSeconds: 1, mediaCooldownSeconds: 0 },
        ...READY,
        commands: { enabled: true, disabled: [], maxMutes: 1000, maxBlocks: 1000, ...commands },
      },
    });
  };
  const gift = (user: ChatUserContext, to: ChatUserContext, roomId: string | null) =>
    module.get(ChatGiftsService).start(user, { recipient: to.id, amount: '1', currency: 'USDT', roomId });
  const giftRows = async (user: ChatUserContext) =>
    (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM chat.gift_transfers WHERE sender_id = ${user.id}::uuid`)[0]!.n;

  beforeAll(async () => {
    settings();
    ({ prisma, module } = await bootChat(url!, emitted, () => document));
    u = await makeUsers(prisma, NAMES, tag);
    const rooms: [string, string, string, Record<string, unknown>][] = [
      [open, `open-${tag}`, 'GLOBAL', { contentControls: { allowCommands: true } }],
      [staff, `staff-${tag}`, 'STAFF', {}],
      [premium, `prem-${tag}`, 'PREMIUM', {}],
    ];
    for (const [id, slug, type, config] of rooms) {
      await prisma.$executeRaw`
        INSERT INTO chat.rooms (id, slug, name, type, config)
        VALUES (${id}::uuid, ${slug}, ${slug}, ${type}::chat."RoomType", ${JSON.stringify(config)}::jsonb)
      `;
    }
    // A premium room a free user can open and read but not write in.
    await prisma.$executeRaw`
      INSERT INTO chat.room_access_rules (id, room_id, require_premium, ineligible_mode)
      VALUES (${uuidv7()}::uuid, ${premium}::uuid, true, 'VIEW_ONLY'::chat."IneligibleMode")
      ON CONFLICT (room_id) DO UPDATE SET require_premium = true, ineligible_mode = 'VIEW_ONLY'::chat."IneligibleMode"
    `;
    await prisma.$executeRaw`SELECT chat.ensure_message_partitions(3)`;
  }, 60_000);

  beforeEach(() => settings());

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  it('a gift to the Staff room by a normal user is refused and nothing is stored', async () => {
    expect(await refusal(() => gift(u.ada, u.bob, staff))).toBe('room_hidden');
    expect(await giftRows(u.ada)).toBe(0);
  });

  it('a room that is view-only for the user refuses the notice', async () => {
    expect(await refusal(() => gift(u.ada, u.bob, premium))).toBe('room_read_only');
    expect(await giftRows(u.ada)).toBe(0);
  });

  it('a room that does not exist is refused, and an open room, or no room, works', async () => {
    expect(await refusal(() => gift(u.ada, u.bob, uuidv7()))).not.toBe('ok');
    expect(await refusal(() => gift(u.ada, u.bob, open))).toBe('ok');
    expect(await refusal(() => gift(u.ada, u.bob, null))).toBe('ok');
    expect(await giftRows(u.ada)).toBe(2);
  });

  it('the mute list stops at its cap, and removing someone makes room', async () => {
    settings({ maxMutes: 2 });
    const relations = module.get(ChatRelationsService);
    const mute = (target: ChatUserContext) => relations.set(u.cat, target.username, 'mutes', true);
    expect((await mute(u.ada)).changed).toBe(true);
    expect((await mute(u.bob)).changed).toBe(true);
    // Muting someone already on the list is not "one more".
    expect((await mute(u.bob)).changed).toBe(false);
    expect(await refusal(() => mute(u.dan))).toBe('limit_reached');
    await relations.set(u.cat, u.ada.username, 'mutes', false);
    expect((await mute(u.dan)).changed).toBe(true);
  });

  it('the block list has its own cap, and the two caps do not count each other', async () => {
    settings({ maxMutes: 1, maxBlocks: 1 });
    const relations = module.get(ChatRelationsService);
    expect((await relations.set(u.eve, u.ada.username, 'mutes', true)).changed).toBe(true);
    expect((await relations.set(u.eve, u.ada.username, 'blocks', true)).changed).toBe(true);
    expect(await refusal(() => relations.set(u.eve, u.bob.username, 'blocks', true))).toBe('limit_reached');
    expect(await refusal(() => relations.set(u.eve, u.bob.username, 'mutes', true))).toBe('limit_reached');
  });

  it('parallel mutes cannot all pass the last place', async () => {
    settings({ maxMutes: 2 });
    const relations = module.get(ChatRelationsService);
    const results = await Promise.all(
      (['ada', 'bob', 'cat', 'eve'] as const).map((name) => refusal(() => relations.set(u.dan, u[name].username, 'mutes', true))),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(2);
    expect(results.filter((r) => r === 'limit_reached')).toHaveLength(2);
  });
});
