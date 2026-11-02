import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';
import { FEATURE_DEFAULTS } from '../../src/social/chat/chat.features.defaults';
import { ChatSettingsDocumentSchema } from '../../src/social/chat/chat.settings.contract';
import type { ChatUserContext } from '../../src/social/chat/chat.types';
import { ChatActionGate } from '../../src/social/chat/services/chat.action-gate.service';
import { ChatStaffToolsService } from '../../src/social/chat/services/chat.staff.tools.service';
import { bootChat, makeUsers, refusal, type Emitted } from './chat.e2e.harness';

/**
 * The shared gate in front of mute, block, gift and ad actions (FR-103) and the pace limit on them (FR-173): the same
 * rules for a typed command, an HTTP route and a button, on the REAL services and a migrated scratch database.
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run --config vitest.chat.config.ts \
 *     tests/social/chat.platform.gate.e2e.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;
const IP = '10.0.0.1';
const NAMES = ['ada', 'bob', 'cat', 'dan', 'eve', 'mod'] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!url)('chat action gate and pace limit (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  let gate: ChatActionGate;
  const emitted: Emitted[] = [];
  const tag = uuidv7().slice(-6);
  const u = {} as Record<Name, ChatUserContext>;
  let document: unknown;

  const settings = (patch: { commands?: Record<string, unknown>; maintenance?: Record<string, unknown>; limits?: Record<string, unknown> } = {}) => {
    document = ChatSettingsDocumentSchema.parse({
      global: {
        testProviders: { enabled: true },
        limits: { messagesPerWindow: 3, messageWindowSeconds: 60, cooldownSeconds: 30, mediaCooldownSeconds: 0, ...patch.limits },
        commands: { ...FEATURE_DEFAULTS.commands, enabled: true, ...patch.commands },
        maintenance: { ...FEATURE_DEFAULTS.maintenance, ...patch.maintenance },
      },
    });
  };

  beforeAll(async () => {
    settings();
    ({ prisma, module } = await bootChat(url!, emitted, () => document));
    gate = module.get(ChatActionGate);
    Object.assign(u, await makeUsers(prisma, NAMES, tag));
    await prisma.$executeRaw`INSERT INTO chat.staff_roles (id, user_id, role) VALUES (${uuidv7()}::uuid, ${u.mod.id}::uuid, 'MODERATOR'::chat."StaffRole")`;
    u.mod = { ...u.mod, staffRole: 'MODERATOR' };
  }, 60_000);

  beforeEach(() => settings());

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  it('a command the admin switched off is refused over HTTP and as a button, not only when typed', async () => {
    settings({ commands: { disabled: ['mute', 'send', 'ad'] } });
    expect(await refusal(() => gate.assert(u.ada, 'mute', { ip: IP }))).toBe('command_disabled');
    expect(await refusal(() => gate.assert(u.ada, 'send', { ip: IP }))).toBe('command_disabled');
    expect(await refusal(() => gate.assert(u.ada, 'ad', { ip: IP, limitKey: 'ad_quote' }))).toBe('command_disabled');
    // Others are untouched.
    expect(await refusal(() => gate.assert(u.ada, 'block', { ip: IP }))).toBe('ok');
  });

  it('all commands off, or one under maintenance, refuses at once', async () => {
    settings({ commands: { enabled: false } });
    expect(await refusal(() => gate.assert(u.bob, 'block', { ip: IP }))).toBe('command_disabled');
    expect(await refusal(() => gate.assert(u.bob, 'mutelist', { ip: IP, limit: false }))).toBe('command_disabled');
    settings({ maintenance: { commandsInMaintenance: ['unblock'], note: 'Back soon' } });
    expect(await refusal(() => gate.assert(u.bob, 'unblock', { ip: IP }))).toBe('feature_maintenance');
    expect(await refusal(() => gate.assert(u.bob, 'block', { ip: IP }))).toBe('ok');
  });

  it('a restriction on a command stops that command everywhere and no other', async () => {
    await module.get(ChatStaffToolsService).restrict(u.mod, {
      targetType: 'USER',
      targetValue: u.cat.username,
      kind: 'RESTRICT_COMMANDS',
      commands: ['send'],
      internalReason: 'Gift abuse',
      durationHours: 1,
    });
    expect(await refusal(() => gate.assert(u.cat, 'send', { ip: IP }))).toBe('restricted');
    expect(await refusal(() => gate.assert(u.cat, 'mute', { ip: IP }))).toBe('ok');
  });

  it('mute, block, ad and gift actions are paced per user; mute and unmute share one counter', async () => {
    // max 3 per 60 s, then a 30 s cooldown (the admin's chat limits).
    expect(await refusal(() => gate.assert(u.dan, 'mute', { ip: IP }))).toBe('ok');
    expect(await refusal(() => gate.assert(u.dan, 'unmute', { ip: IP }))).toBe('ok');
    expect(await refusal(() => gate.assert(u.dan, 'mute', { ip: IP }))).toBe('ok');
    const caught = await gate.assert(u.dan, 'unmute', { ip: IP }).then(
      () => null,
      (e: unknown) => e as { extra?: { reason?: string; remainingSeconds?: number } },
    );
    expect(caught?.extra?.reason).toBe('action_limit');
    expect(caught?.extra?.remainingSeconds).toBeGreaterThan(0);
    expect(caught?.extra?.remainingSeconds).toBeLessThanOrEqual(30);
    // Another kind of action and another user are not slowed by it.
    expect(await refusal(() => gate.assert(u.dan, 'send', { ip: IP }))).toBe('ok');
    expect(await refusal(() => gate.assert(u.eve, 'mute', { ip: IP }))).toBe('ok');
  });

  it('asking for an ad quote does not use up ad creation', async () => {
    for (let i = 0; i < 3; i += 1) expect(await refusal(() => gate.assert(u.eve, 'ad', { ip: IP, limitKey: 'ad_quote' }))).toBe('ok');
    expect(await refusal(() => gate.assert(u.eve, 'ad', { ip: IP, limitKey: 'ad_quote' }))).toBe('action_limit');
    expect(await refusal(() => gate.assert(u.eve, 'ad', { ip: IP }))).toBe('ok');
  });

  it('parallel requests cannot all pass the last places (the counter is atomic)', async () => {
    settings({ limits: { messagesPerWindow: 5 } });
    const results = await Promise.all(Array.from({ length: 20 }, () => refusal(() => gate.assert(u.bob, 'send', { ip: IP }))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(5);
    expect(results.filter((r) => r === 'action_limit')).toHaveLength(15);
  });

  it('lists are not paced (only the switches apply)', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect(await refusal(() => gate.assert(u.ada, 'blocklist', { ip: IP, limit: false }))).toBe('ok');
    }
  });
});
