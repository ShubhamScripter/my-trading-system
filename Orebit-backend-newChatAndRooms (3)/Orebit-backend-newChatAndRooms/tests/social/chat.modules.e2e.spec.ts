import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { RedisService } from '../../redis';
import { SessionService } from '../../auth/services/session.service';
import { TwoFactorService } from '../../src/2fa/2fa.service';
import { MailService } from '../../src/mail/mail.service';
import { SecurityRestrictionRiskEvaluator } from '../../src/restrictions/restrictions.evaluator';
import { SecurityRestrictionService } from '../../src/restrictions/restrictions.service';
import { uuidv7 } from '../../src/utils/public.utils';
import { ChatModule } from '../../src/social/chat/chat.module';
import { ChatSettingsService } from '../../src/social/chat/chat.settings';
import { ChatSettingsDocumentSchema } from '../../src/social/chat/chat.settings.contract';
import { ChatService } from '../../src/social/chat/chat.service';
import { ChatDelivery } from '../../src/social/chat/realtime/chat.delivery';
import { ChatCommandsService } from '../../src/social/chat/services/chat.commands.service';
import { ChatGiftsService } from '../../src/social/chat/services/chat.gifts.service';
import { ChatAdsService } from '../../src/social/chat/services/chat.ads.service';
import { ChatGiftsSettlementService } from '../../src/social/chat/services/chat.gifts.settlement';
import { moneyJobConfig } from '../../src/social/chat/services/chat.money-config';
import { ChatRelationsService } from '../../src/social/chat/services/chat.relations.service';
import { ChatStaffService } from '../../src/social/chat/services/chat.staff.service';
import { ChatStaffQueueService } from '../../src/social/chat/services/chat.staff.queue.service';
import { ChatStaffRequestsService } from '../../src/social/chat/services/chat.staff.requests.service';
import { ChatStaffToolsService } from '../../src/social/chat/services/chat.staff.tools.service';
import { ChatStaffPenaltiesService } from '../../src/social/chat/services/chat.staff.penalties.service';
import { ChatStaffInsightService } from '../../src/social/chat/services/chat.staff.insight.service';
import { ChatDbOperation } from '../../src/social/chat/chat.dboperation';
import { toPublicMessage } from '../../src/social/chat/chat.utility';
import type { ChatSettingsDocument } from '../../src/social/chat/chat.settings.contract';
import { DmService } from '../../src/social/chat/dm/dm.service';
import { DmSignalsService } from '../../src/social/chat/dm/dm.signals.service';
import { DmActionsService } from '../../src/social/chat/dm/dm.actions.service';
import { DmInboxService } from '../../src/social/chat/dm/dm.inbox.service';
import { DmPrivacyService } from '../../src/social/chat/dm/dm.privacy.service';
import { DmGroupsService } from '../../src/social/chat/dm/dm.groups.service';
import { DmGroupInvitesService } from '../../src/social/chat/dm/dm.groups.invites.service';
import { DmGroupsModerationService } from '../../src/social/chat/dm/dm.groups.moderation.service';
import type { ChatUserContext } from '../../src/social/chat/chat.types';
import { CHAT_VERIFICATION_PORT } from '../../src/social/chat/chat.feature-ports';
import { memoryRedis, READY, recordingServer, refusal, type Emitted } from './chat.e2e.harness';

/**
 * Modules 4, 5, 8 and 9 end to end: the REAL chat services wired by Nest from ChatModule's providers, on a migrated
 * scratch database. Only what chat does not own is replaced: Redis (in memory), the session service and 2FA. Test
 * providers are on, so transfers and charges are the stand-ins (code 000000) and follows come from
 * chat.test_entitlements. Socket delivery is captured from a recording server.
 *
 *   CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify npx vitest run --config vitest.chat.config.ts \
 *     tests/social/chat.modules.e2e.spec.ts
 */
const url = process.env.CHAT_TEST_DATABASE_URL;

describe.skipIf(!url)('chat Modules 4–9 end to end (real services, scratch database)', () => {
  let prisma: PrismaClient;
  let module: TestingModule;
  const emitted: Emitted[] = [];
  const tag = uuidv7().slice(-6);
  const roomId = uuidv7();
  const users: Record<'ada' | 'bob' | 'cat' | 'mod' | 'sup' | 'boss', ChatUserContext> =
    {} as never;
  let document: ChatSettingsDocument;
  let commands: ChatCommandsService;
  let chat: ChatService;
  let delivery: ChatDelivery;

  const make = async (
    key: keyof typeof users,
    role: 'ADMIN' | 'MODERATOR' | 'SUPPORT' | null = null,
  ) => {
    const id = uuidv7();
    const name = `${key}${tag}`;
    await prisma.$executeRaw`
      INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
      VALUES (${id}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@e2e.test`}, ${`${name}@e2e.test`}, ${name})
    `;
    if (role) {
      await prisma.$executeRaw`INSERT INTO chat.staff_roles (user_id, role) VALUES (${id}::uuid, ${role}::chat."StaffRole")`;
    }
    users[key] = { id, username: name, publicCode: name, staffRole: role };
  };
  const sent = (event: string) => emitted.filter((e) => e.event === event);

  beforeAll(async () => {
    process.env.CHAT_ALLOW_TEST_PROVIDERS = 'true';
    prisma = new PrismaClient({ datasourceUrl: url });
    const providers = Reflect.getMetadata('providers', ChatModule) as unknown[];
    module = await Test.createTestingModule({
      providers: [
        ...(providers as never[]),
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: memoryRedis() },
        { provide: SessionService, useValue: {} },
        // RainEmailCode (rain, not exercised here) needs a mail sender to be built.
        { provide: MailService, useValue: {} },
        { provide: TwoFactorService, useValue: { proveTotpCode: async (_u: string, code: string) => code === '000000' } },
        // Rain's security check (Modules 6–7) is not exercised here.
        { provide: SecurityRestrictionService, useValue: {} },
        { provide: SecurityRestrictionRiskEvaluator, useValue: {} },
        {
          provide: CHAT_VERIFICATION_PORT,
          useValue: {
            hasPaymentPin: async (u: string) => u === users.ada?.id,
            verify: async (_u: string, _m: string, code: string) => (code === '000000' ? true : false),
          },
        },
      ],
    }).compile();

    // Fixed chat settings for this file: the shared scratch database's settings row is left alone.
    document = ChatSettingsDocumentSchema.parse({
      global: {
        testProviders: { enabled: true },
        limits: { messagesPerWindow: 100, messageWindowSeconds: 1, mediaCooldownSeconds: 0 },
        ...READY,
      },
    });
    (module.get(ChatSettingsService) as unknown as { document: () => Promise<unknown> }).document =
      async () => document;

    delivery = module.get(ChatDelivery);
    delivery.attach(recordingServer(emitted) as never);
    commands = module.get(ChatCommandsService);
    chat = module.get(ChatService);

    await make('ada');
    await make('bob');
    await make('cat');
    await make('mod', 'MODERATOR');
    await make('sup', 'SUPPORT');
    await make('boss', 'ADMIN');
    await prisma.$executeRaw`
      INSERT INTO chat.rooms (id, slug, name, type, config)
      VALUES (${roomId}::uuid, ${`e2e-${tag}`}, 'E2E', 'GLOBAL',
              ${JSON.stringify({ contentControls: { allowCommands: true, allowAds: true } })}::jsonb)
    `;
    await prisma.$executeRaw`SELECT chat.ensure_message_partitions(3)`;
  }, 60_000);

  afterAll(async () => {
    await module?.close();
    await prisma?.$disconnect();
  });

  // ─── Module 5: commands, mute and block ─────────────────────────────────────────────────────────────────────────
  it('/help lists the commands of the room; an unknown command is refused', async () => {
    const help = await commands.run(users.ada, { roomRef: roomId, text: '/help', ip: '10.0.0.1' });
    expect(
      (help.result as { commands: { command: string }[] }).commands.map((c) => c.command),
    ).toContain('mute');
    expect(
      (help.result as { commands: { command: string }[] }).commands.map((c) => c.command),
    ).toContain('rain');
    expect(
      await refusal(() =>
        commands.run(users.ada, { roomRef: roomId, text: '/rain 5 BTC', ip: '10.0.0.1' }),
      ),
    ).toBe('validation_failed');
    expect(
      await refusal(() =>
        commands.run(users.ada, { roomRef: roomId, text: '/xyz', ip: '10.0.0.1' }),
      ),
    ).toBe('unknown_command');
  });

  it('/mute hides the author from the muter in the live broadcast and in history; /mutelist lists them', async () => {
    const relations = module.get(ChatRelationsService);
    await relations.load(users.ada.id);
    await commands.run(users.ada, {
      roomRef: roomId,
      text: `/mute @${users.bob.username}`,
      ip: '10.0.0.1',
    });
    const list = await commands.run(users.ada, {
      roomRef: roomId,
      text: '/mutelist',
      ip: '10.0.0.1',
    });
    expect((list.result as { items: { userId: string }[] }).items.map((i) => i.userId)).toEqual([
      users.bob.id,
    ]);

    emitted.length = 0;
    const { row } = await chat.sendMessage(
      users.bob,
      { roomRef: roomId, content: 'hello room' },
      { ip: '10.0.0.2' },
    );
    delivery.publish(row);
    const broadcast = sent('new_message').at(-1)!;
    expect(broadcast.to).toContain(`room:${roomId}`);
    expect(broadcast.except).toContain(`user:${users.ada.id}`);

    await commands.run(users.ada, {
      roomRef: roomId,
      text: `/unmute @${users.bob.username}`,
      ip: '10.0.0.1',
    });
    relations.unload(users.ada.id);
  });

  it('a moderator restricts a command; the user is refused it, other commands still work', async () => {
    const tools = module.get(ChatStaffToolsService);
    const made = await tools.restrict(users.mod, {
      targetType: 'USER',
      targetValue: users.cat.username,
      kind: 'RESTRICT_COMMANDS',
      commands: ['block'],
      internalReason: 'Abusing /block',
      durationHours: 1,
    });
    expect(made).toMatchObject({ kind: 'RESTRICT_COMMANDS' });
    expect(
      await refusal(() =>
        commands.run(users.cat, {
          roomRef: roomId,
          text: `/block @${users.ada.username}`,
          ip: '10.0.0.3',
        }),
      ),
    ).toBe('restricted');
    await commands.run(users.cat, {
      roomRef: roomId,
      text: `/mute @${users.ada.username}`,
      ip: '10.0.0.3',
    });
    // The moderator lifts it again (their own penalty).
    await module
      .get(ChatStaffPenaltiesService)
      .liftRestriction(users.mod, (made as { id: string }).id, 'ok');
    await commands.run(users.cat, {
      roomRef: roomId,
      text: `/unmute @${users.ada.username}`,
      ip: '10.0.0.3',
    });
  });

  // ─── Module 5: gifts and ads ────────────────────────────────────────────────────────────────────────────────────
  it('/send waits for the code, then completes, posts a GIFT notice and tells the recipient', async () => {
    const started = await commands.run(users.ada, {
      roomRef: roomId,
      text: `/send @${users.bob.username} 10.5 USDT`,
      ip: '10.0.0.1',
    });
    const gift = started.result as { giftId: string; verification: string; status: string };
    expect(gift.status).toBe('PENDING_VERIFICATION');
    expect(['TWO_FA', 'PAYMENT_PIN']).toContain(gift.verification);
    const gifts = module.get(ChatGiftsService);
    expect(await refusal(() => gifts.confirm(users.ada, gift.giftId, '111111'))).toBe(
      'verification_failed',
    );
    emitted.length = 0;
    expect(await gifts.confirm(users.ada, gift.giftId, '000000')).toMatchObject({
      status: 'COMPLETED',
    });
    expect(sent('gift_received')[0]?.to).toEqual([`user:${users.bob.id}`]);
    expect(sent('new_message').some((e) => (e.payload as { type: string }).type === 'GIFT')).toBe(
      true,
    );
  });

  it('a gift to someone you muted is refused', async () => {
    await commands.run(users.ada, {
      roomRef: roomId,
      text: `/mute @${users.cat.username}`,
      ip: '10.0.0.1',
    });
    expect(
      await refusal(() =>
        commands.run(users.ada, {
          roomRef: roomId,
          text: `/gift @${users.cat.username} 1 USDT`,
          ip: '10.0.0.1',
        }),
      ),
    ).toBe('blocked');
    await commands.run(users.ada, {
      roomRef: roomId,
      text: `/unmute @${users.cat.username}`,
      ip: '10.0.0.1',
    });
  });

  it('/ad posts an AD message, pins it, and a cancel refunds the unused part', async () => {
    emitted.length = 0;
    const result = await commands.run(users.bob, {
      roomRef: roomId,
      text: '/ad pin=5 repeat=1x5 Visit our shop today',
      ip: '10.0.0.2',
      clientMessageId: uuidv7(),
    });
    const ad = result.result as { adId: string; price: { totalUsd: string } };
    expect(Number(ad.price.totalUsd)).toBeGreaterThan(0);
    const posted = sent('new_message').find((e) => (e.payload as { type: string }).type === 'AD' && e.to.includes(`room:${roomId}`));
    expect(posted?.to).toEqual(expect.arrayContaining([`room:${roomId}`, `room:${roomId}:promo`]));
    const ads = module.get(ChatAdsService);
    expect((await ads.activePin(roomId, null))?.adId).toBe(ad.adId);
    // The shared scratch database may hold other rooms' queued slots that start in the same pass.
    expect(sent('ad_pinned').find((e) => e.to.includes(`room:${roomId}`))).toBeDefined();
    const cancelled = await ads.cancel(users.bob, ad.adId);
    expect(Number(cancelled.refundUsd)).toBeGreaterThan(0);
    expect(await ads.activePin(roomId, null)).toBeNull();
  });

  // ─── Module 4: REPORT mode ──────────────────────────────────────────────────────────────────────────────────────
  it('support asks to warn; a moderator approves and the warning is written', async () => {
    const asked = await module
      .get(ChatStaffService)
      .staffWarn(users.sup, { userId: users.cat.id, roomId, internalReason: 'Rude to others' });
    expect(asked).toMatchObject({ requested: true, permission: 'WARN' });
    const queue = module.get(ChatStaffRequestsService);
    const pending = await queue.requests(users.mod, {});
    const request = pending.items.find((r) => r.id === (asked as { requestId: string }).requestId);
    expect(request).toBeDefined();
    const resolved = await queue.resolveRequest(users.mod, request!.id, {
      approve: true,
      note: 'Agreed',
    });
    expect(resolved.status).toBe('APPROVED');
    const warnings = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM chat.chat_warnings WHERE user_id = ${users.cat.id}::uuid
    `;
    expect(warnings[0]!.n).toBe(1);
  });

  // ─── Module 8: direct messages ──────────────────────────────────────────────────────────────────────────────────
  it("a stranger's DM is a request; replying accepts it; links need friends; read receipts reach the sender", async () => {
    const dm = module.get(DmService);
    const inbox = module.get(DmInboxService);
    const privacyService = module.get(DmPrivacyService);
    const opened = await dm.openDirect(
      users.ada,
      users.cat.username,
      { content: 'Hi Cat' },
      '10.0.0.1',
    );
    expect(
      (await inbox.conversations(users.cat, { folder: 'REQUESTS' })).items.map((c) => c.id),
    ).toContain(opened.conversationId);
    expect(
      (await inbox.conversations(users.ada, { folder: 'PRIMARY' })).items.map((c) => c.id),
    ).toContain(opened.conversationId);
    expect(
      await refusal(() =>
        dm.send(users.ada, opened.conversationId, { content: 'see orebit.io/shop' }, '10.0.0.1'),
      ),
    ).toBe('links_media_friends_only');

    // Cat replies: the request is accepted into General.
    const reply = await dm.send(
      users.cat,
      opened.conversationId,
      { content: 'Hi Ada' },
      '10.0.0.3',
    );
    expect(
      (await inbox.conversations(users.cat, { folder: 'GENERAL' })).items.map((c) => c.id),
    ).toContain(opened.conversationId);

    // Friends (both follow each other in the test stand-in): links are fine.
    await prisma.$executeRaw`INSERT INTO chat.test_entitlements (user_id, follows) VALUES (${users.ada.id}::uuid, ARRAY[${users.cat.id}::uuid])`;
    await prisma.$executeRaw`INSERT INTO chat.test_entitlements (user_id, follows) VALUES (${users.cat.id}::uuid, ARRAY[${users.ada.id}::uuid])`;
    await dm.send(users.ada, opened.conversationId, { content: 'see orebit.io/shop' }, '10.0.0.1');

    emitted.length = 0;
    const signals = module.get(DmSignalsService);
    await signals.markRead(users.ada, opened.conversationId, reply.message.id);
    expect(sent('dm_read').some((e) => e.to.includes(`user:${users.cat.id}`))).toBe(true);
    await signals.typing(users.ada, opened.conversationId, true);
    expect(sent('dm_typing')[0]?.to).toEqual([`user:${users.cat.id}`]);
    expect((await inbox.search(users.cat, { q: 'shop' })).items.length).toBe(1);
  });

  it('a block stops DMs both ways; last seen follows privacy', async () => {
    const dm = module.get(DmService);
    const inbox = module.get(DmInboxService);
    const opened = await dm.openDirect(users.bob, users.ada.username, null, '10.0.0.2');
    await commands.run(users.ada, {
      roomRef: roomId,
      text: `/block @${users.bob.username}`,
      ip: '10.0.0.1',
    });
    expect(
      await refusal(() =>
        dm.send(users.bob, opened.conversationId, { content: 'hey' }, '10.0.0.2'),
      ),
    ).toBe('blocked');
    await commands.run(users.ada, {
      roomRef: roomId,
      text: `/unblock @${users.bob.username}`,
      ip: '10.0.0.1',
    });

    expect(
      (await inbox.presenceFor(users.bob.id, [users.ada.id])).get(users.ada.id),
    ).not.toBeNull();
    await module.get(DmPrivacyService).updatePrivacy(users.ada, { lastSeenVisibility: 'NOBODY' });
    expect((await inbox.presenceFor(users.bob.id, [users.ada.id])).get(users.ada.id)).toBeNull();
  });

  it('forward, pinned messages, the gift button and a DM report in the staff queue', async () => {
    const dm = module.get(DmService);
    const actions = module.get(DmActionsService);
    const opened = await dm.openDirect(users.ada, users.cat.username, null, '10.0.0.1');
    const other = await dm.openDirect(users.ada, users.mod.username, null, '10.0.0.1');
    const first = await dm.send(
      users.cat,
      opened.conversationId,
      { content: 'pin me please' },
      '10.0.0.3',
    );

    const forwarded = await actions.forward(
      users.ada,
      first.message.id,
      [other.conversationId],
      '10.0.0.1',
    );
    const copy = (await dm.history(users.mod, other.conversationId, {})).items.find(
      (m) => m.id === forwarded.forwarded[0]!.messageId,
    );
    expect(copy?.forwarded).toEqual({ fromUsername: users.cat.username });

    await actions.pin(users.ada, first.message.id, true);
    expect(
      (await actions.pinnedMessages(users.cat, opened.conversationId)).items.map((m) => m.id),
    ).toEqual([first.message.id]);

    const gift = await actions.startGift(
      users.ada,
      opened.conversationId,
      { amount: '2', currency: 'USDT' },
      '10.0.0.1',
    );
    await module.get(ChatGiftsService).confirm(users.ada, gift.giftId, '000000');
    const last = (await dm.history(users.cat, opened.conversationId, { limit: 1 })).items[0]!;
    expect(last).toMatchObject({ type: 'GIFT', gift: { amount: '2', currency: 'USDT' } });

    const report = await actions.report(users.ada, first.message.id, { reason: 'SPAM' });
    const queue = await module.get(ChatStaffQueueService).reports(users.mod, {});
    expect(queue.items.find((r) => r.id === report.reportId)).toMatchObject({
      dmMessageId: first.message.id,
      messageContent: 'pin me please',
    });
  });

  it('public groups: anyone joins, a banned member cannot come back', async () => {
    const groups = module.get(DmGroupsService);
    const groupAdmin = module.get(DmGroupsModerationService);
    const created = await groups.create(users.bob, { name: `Open ${tag}`, visibility: 'PUBLIC' });
    expect(
      (await groups.publicGroups(users.cat, { q: `Open ${tag}` })).items.map((g) => g.id),
    ).toEqual([created.groupId]);
    await groups.join(users.cat, created.groupId);
    await groupAdmin.ban(users.bob, created.groupId, users.cat.id, 'spam', true);
    expect(await refusal(() => groups.join(users.cat, created.groupId))).toBe('group_banned');
  });

  // ─── Module 9: groups ───────────────────────────────────────────────────────────────────────────────────────────
  it('a private group: invite, accept, roles, members-can-text, and an ownership transfer behind 2FA', async () => {
    const groups = module.get(DmGroupsService);
    const groupAdmin = module.get(DmGroupsModerationService);
    const dm = module.get(DmService);
    const groupInvites = module.get(DmGroupInvitesService);
    const created = await groups.create(users.ada, { name: `Traders ${tag}`, visibility: 'PRIVATE' });
    const sentInvites = await groupInvites.invite(users.ada, created.groupId, [users.bob.username, users.cat.username]);
    expect(sentInvites.invited.map((i) => i.username).sort()).toEqual(
      [users.bob.username, users.cat.username].sort(),
    );
    expect(await refusal(() => groups.join(users.mod, created.groupId))).toBe('invite_only');

    for (const who of [users.bob, users.cat]) {
      const invite = (await groupInvites.invites(who)).items.find((i) => i.groupId === created.groupId)!;
      await groupInvites.respondToInvite(who, invite.id, true);
    }
    await groupAdmin.setRole(users.ada, created.groupId, users.bob.id, 'SUB_ADMIN');
    await groups.update(users.ada, created.groupId, { membersCanText: false });
    expect(
      await refusal(() => dm.send(users.cat, created.groupId, { content: 'hi all' }, '10.0.0.3')),
    ).toBe('group_text_off');
    await dm.send(users.bob, created.groupId, { content: 'sub-admins still talk' }, '10.0.0.2');
    expect(
      await refusal(() => groupAdmin.setRole(users.bob, created.groupId, users.cat.id, 'ADMIN')),
    ).toBe('permission_denied');

    // V2-144: ownership moves at once and asks no code.
    expect(await groupAdmin.startTransfer(users.ada, created.groupId, users.bob.id)).toEqual({
      groupId: created.groupId,
      ownerId: users.bob.id,
    });
    // No longer the owner, the old owner may leave.
    expect(await groups.leave(users.ada, created.groupId)).toEqual({
      groupId: created.groupId,
      left: true,
      closed: false,
    });
  });

  // ─── The PDF gap items: editing penalties, stats, bot log, room access, receiving and reverting gifts ──────────
  it('a moderator changes a ban within their limit; stats show only what the role may see; the bot log', async () => {
    const penalties = module.get(ChatStaffPenaltiesService);
    const insight = module.get(ChatStaffInsightService);
    const ban = (await module.get(ChatStaffService).staffBan(users.mod, {
      userId: users.cat.id,
      roomId,
      internalReason: 'flood',
      durationHours: 1,
    })) as { id: string };
    const changed = (await penalties.changeBan(users.mod, ban.id, {
      durationHours: 5,
      internalReason: 'flood again',
    })) as { expiresAt: string };
    const hours = (Date.parse(changed.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(4.9);
    expect(hours).toBeLessThan(5.1);
    // A moderator bans for at most 24 hours (the default role limit), so a change cannot go past it either.
    expect(await refusal(() => penalties.changeBan(users.mod, ban.id, { durationHours: 48 }))).toBe(
      'outside_role_scope',
    );

    const stats = await insight.userStats(users.mod, users.cat.id);
    expect(Object.keys(stats.stats).sort()).toEqual([
      'BANS',
      'MESSAGES',
      'REPORTS',
      'RESTRICTIONS',
      'WARNINGS',
    ]);
    expect(stats.stats.BANS).toMatchObject({ active: 1 });
    await penalties.liftBan(users.mod, ban.id, null);

    await prisma.$executeRaw`
      INSERT INTO chat.moderation_actions (id, actor_type, action, target_user_id, target_room_id, new_value)
      VALUES (${uuidv7()}::uuid, 'SYSTEM', 'auto.flood_mute', ${users.cat.id}::uuid, ${roomId}::uuid, '{"seconds":60}')
    `;
    const log = await insight.botLog(users.mod, users.cat.id, {});
    expect(log.items[0]).toMatchObject({
      action: 'auto.flood_mute',
      roomId,
      detail: { seconds: 60 },
    });
  });

  it('room access: a moderator asks to remove a user, the chat admin approves; ADD lets a user in, RESTORE undoes', async () => {
    const tools = module.get(ChatStaffToolsService);
    const db = module.get(ChatDbOperation);
    const asked = (await tools.setRoomAccess(users.mod, roomId, {
      userId: users.cat.id,
      action: 'REMOVE',
    })) as { requested: true; requestId: string };
    expect(asked.requested).toBe(true);
    await module
      .get(ChatStaffRequestsService)
      .resolveRequest(users.boss, asked.requestId, { approve: true });
    expect(await db.excludedRoomIds(users.cat.id)).toContain(roomId);

    await tools.setRoomAccess(users.boss, roomId, { userId: users.cat.id, action: 'ADD' });
    expect(await db.excludedRoomIds(users.cat.id)).not.toContain(roomId);
    expect(await db.includedRoomIds(users.cat.id)).toContain(roomId);
    await tools.setRoomAccess(users.boss, roomId, { userId: users.cat.id, action: 'RESTORE' });
    expect(await db.includedRoomIds(users.cat.id)).not.toContain(roomId);
  });

  it('a user restricted from receiving money gets no gifts; a revert queued by an admin is carried out', async () => {
    const gifts = module.get(ChatGiftsService);
    const made = (await module.get(ChatStaffToolsService).restrict(users.boss, {
      targetType: 'USER',
      targetValue: users.bob.username,
      kind: 'RESTRICT_RECEIVE_GIFTS',
      internalReason: 'Under review',
      durationHours: 1,
    })) as { id: string };
    expect(
      await refusal(() =>
        gifts.start(users.ada, { recipient: users.bob.id, amount: '1', currency: 'USDT' }),
      ),
    ).toBe('restricted');
    await module.get(ChatStaffPenaltiesService).liftRestriction(users.boss, made.id, null);

    const gift = await gifts.start(users.ada, {
      recipient: users.bob.id,
      amount: '3',
      currency: 'USDT',
    });
    await gifts.confirm(users.ada, gift.giftId, '000000');
    // What the admin panel's "Revert ALL Transfers" writes; the chat server's tick does the rest.
    await prisma.$executeRaw`
      UPDATE chat.gift_transfers
      SET status = 'REVERT_PENDING', revert_refund_fees = true, revert_requested_at = now()
      WHERE id = ${gift.giftId}::uuid
    `;
    emitted.length = 0;
    const config = moneyJobConfig(await module.get(ChatSettingsService).global())!;
    await module.get(ChatGiftsSettlementService).processReverts(config, Date.now() + 10_000);
    const [row] = await prisma.$queryRaw<{ status: string; reverted_at: Date | null }[]>`
      SELECT status, reverted_at FROM chat.gift_transfers WHERE id = ${gift.giftId}::uuid
    `;
    expect(row).toMatchObject({ status: 'REVERTED' });
    expect(row!.reverted_at).not.toBeNull();
    // Only this gift's notices: the shared scratch database may hold other queued reverts.
    expect(
      sent('moderation_notice')
        .filter((e) => (e.payload as { giftId?: string }).giftId === gift.giftId)
        .map((e) => e.to[0])
        .sort(),
    ).toEqual([`user:${users.ada.id}`, `user:${users.bob.id}`].sort());
  });

  it('the Channels tab lists public groups only; automated alerts carry the assigned bot profile', async () => {
    const groups = module.get(DmGroupsService);
    const open = await groups.create(users.ada, { name: `Channel ${tag}`, visibility: 'PUBLIC' });
    const closed = await groups.create(users.ada, { name: `Club ${tag}`, visibility: 'PRIVATE' });
    const inbox = module.get(DmInboxService);
    const channels = (await inbox.conversations(users.ada, { folder: 'CHANNELS' })).items.map(
      (c) => c.id,
    );
    expect(channels).toContain(open.groupId);
    expect(channels).not.toContain(closed.groupId);
    const all = (await inbox.conversations(users.ada, { folder: 'GROUPS' })).items.map((c) => c.id);
    expect(all).toEqual(expect.arrayContaining([open.groupId, closed.groupId]));

    document.global.bot = { profileUserId: users.mod.id };
    try {
      const row = await chat.postSystemAlert('LEVEL_UP', 'Level 10!', roomId);
      expect(toPublicMessage(row, { userId: users.ada.id, isStaff: false })).toMatchObject({
        username: users.mod.username,
        bot: { userId: users.mod.id, username: users.mod.username },
        alertType: 'LEVEL_UP',
      });
    } finally {
      document.global.bot = { profileUserId: null };
    }
  });
});
