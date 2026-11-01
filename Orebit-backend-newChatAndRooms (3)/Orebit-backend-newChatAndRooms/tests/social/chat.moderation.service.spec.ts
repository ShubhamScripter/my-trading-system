import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../src/http';
import {
  RoomAccessSchema,
  RoomConfigSchema,
  type RoomConfig,
  type AutoBanTier,
} from '../../src/social/chat/chat.contract';
import {
  DEFAULT_CHAT_SETTINGS,
  type ChatSettings,
} from '../../src/social/chat/chat.settings.contract';
import { ChatBus } from '../../src/social/chat/realtime/chat.bus';
import type { ChatDbOperation } from '../../src/social/chat/chat.dboperation';
import { ChatContentService } from '../../src/social/chat/services/chat.content.service';
import { ChatModerationService } from '../../src/social/chat/chat.moderation.service';
import { ChatStaffService } from '../../src/social/chat/services/chat.staff.service';
import { ChatRestrictionsService } from '../../src/social/chat/services/chat.restrictions.service';
import { ChatStaffGate } from '../../src/social/chat/services/chat.staff.gate';
import type {
  ChatUserContext,
  EligibilityFacts,
  RoomRecord,
} from '../../src/social/chat/chat.types';
import type { RedisService } from '../../redis';

/** A ladder is set here the way an admin must set one (chat-wide, V2-30): with none, nothing is counted. */
const LADDER: AutoBanTier[] = [
  { tier: 1, action: 'WARNING', resetWindowHours: 24 },
  { tier: 2, action: 'BAN', durationSeconds: 3600, resetWindowHours: 48 },
  { tier: 3, action: 'BAN', durationSeconds: 86400, resetWindowHours: 168 },
];
const withModeration = (moderation: Partial<ChatSettings['moderation']>): ChatSettings =>
  ({
    ...DEFAULT_CHAT_SETTINGS,
    moderation: { spamProtection: null, autoBanSequence: LADDER, ...moderation },
  }) as unknown as ChatSettings;
const SETTINGS = withModeration({});
const USER: ChatUserContext = {
  id: '0192f6a0-0000-7000-8000-0000000000u1',
  username: 'ada',
  publicCode: 'P1',
  staffRole: null,
};
const FACTS: EligibilityFacts = {
  staffRole: null,
  country: 'IN',
  premiumPlanIds: [],
  kycLevel: 0,
  kycEntitlements: null,
  isSiteOwner: false,
  level: 0,
  casino: null,
  excludedRoomIds: new Set(),
  includedRoomIds: new Set(),
  staffRoomBlocked: false,
};

function room(config: Partial<RoomConfig> = {}): RoomRecord {
  return {
    id: 'room-1',
    slug: 'r',
    name: 'R',
    description: null,
    type: 'GLOBAL',
    createdAt: new Date(0),
    config: RoomConfigSchema.parse(config),
    access: RoomAccessSchema.parse({}),
    regionCountries: null,
    fingerprint: '',
  };
}

function fakeRedis(opts: { failWrites?: boolean } = {}) {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k) ?? null)),
    set: vi.fn(async (k: string, v: string) => {
      if (opts.failWrites) throw new Error('lost');
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => store.delete(k)),
  };
}

function harness(
  opts: {
    failWrites?: boolean;
    bans?: { roomId: string | null; expiresAt: Date | null }[];
    target?: ChatUserContext | null;
  } = {},
) {
  const redis = fakeRedis(opts);
  const offences = new Map<string, number>();
  const db = {
    activeBans: vi.fn(async () => opts.bans ?? []),
    createBan: vi.fn(async () => ({ id: 'ban-1', expiresAt: new Date('2026-09-28T13:00:00Z') })),
    createWarning: vi.fn(async () => 'warn-1'),
    recordAction: vi.fn(async () => undefined),
    recordOffence: vi.fn(async (userId: string) => {
      const next = (offences.get(userId) ?? 0) + 1;
      offences.set(userId, next);
      return next;
    }),
    findChatUser: vi.fn(async () =>
      opts.target === undefined
        ? { ...USER, id: 'target', username: 'bob', staffRole: null }
        : opts.target,
    ),
    setPinned: vi.fn(async () => ({ roomId: 'room-1', createdAt: new Date() })),
    recordLimitHits: vi.fn(async () => new Map()),
    // Transactions run straight through in the fake; audit rows outside one go through recordActionNow.
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
    recordActionNow: vi.fn(async () => undefined),
    messageById: vi.fn(async () => ({ id: 'm1', roomId: 'room-1', userId: 'target' })),
    // Module 4: chat-wide restrictions and staff requests.
    activeRestrictions: vi.fn(async () => []),
    createRequest: vi.fn(async () => ({
      id: 'req-1',
      createdAt: new Date('2026-10-09T10:00:00Z'),
    })),
  };
  const bus = new ChatBus();
  const notices: unknown[] = [];
  bus.subscribe((c) => {
    if (c.kind === 'notice') notices.push(c.notice);
  });
  // The fake answers for both data classes: chat data (users, pins) and records (bans, warnings, audit).
  const service = new ChatModerationService(db as never, redis as unknown as RedisService, bus);
  const restrictions = new ChatRestrictionsService(db as never, bus);
  const content = new ChatContentService(
    db as never,
    redis as unknown as RedisService,
    bus,
    service,
    restrictions,
  );
  const settings = { global: async () => SETTINGS };
  const gate = new ChatStaffGate(
    settings as never,
    db as never,
    { allSockets: () => [] } as never,
    bus,
    restrictions,
    { factsFor: async () => FACTS } as never,
    { dbNow: async () => new Date() } as never,
  );
  const staff = new ChatStaffService(
    db as unknown as ChatDbOperation,
    db as never,
    service,
    bus,
    gate,
  );
  return { service, content, staff, db, redis, notices };
}

async function reason(
  run: () => Promise<unknown>,
): Promise<{ type: string; reason?: unknown; extra?: Record<string, unknown> }> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ProblemException)
      return { type: err.type, reason: err.extra?.reason, extra: err.extra };
    throw err;
  }
  return { type: 'ok' };
}

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 28, 12, 0, 0) + seconds * 1000);

describe('slow mode on the database clock', () => {
  it('allows 5 messages per 5 s, then a 10 s cooldown with remainingSeconds', async () => {
    const { service } = harness();
    for (let i = 0; i < 5; i += 1)
      await service.checkSendLimits(USER, '1.1.1.1', at(0), SETTINGS, false);
    const refused = await reason(() =>
      service.checkSendLimits(USER, '1.1.1.1', at(1), SETTINGS, false),
    );
    expect(refused).toMatchObject({ type: 'rate_limited', extra: { remainingSeconds: 10 } });
    expect(
      (await reason(() => service.checkSendLimits(USER, '1.1.1.1', at(5), SETTINGS, false))).type,
    ).toBe('rate_limited');
    expect(
      (await reason(() => service.checkSendLimits(USER, '1.1.1.1', at(12), SETTINGS, false))).type,
    ).toBe('ok');
  });

  it('a Redis that loses writes never locks the user out', async () => {
    const { service } = harness({ failWrites: true });
    for (let i = 0; i < 20; i += 1) {
      expect(
        (await reason(() => service.checkSendLimits(USER, '1.1.1.1', at(i), SETTINGS, false))).type,
      ).toBe('ok');
    }
  });

  it('every limiter value is written with a TTL (one SET … EX)', async () => {
    const { service, redis } = harness();
    await service.checkSendLimits(USER, '1.1.1.1', at(0), SETTINGS, false);
    for (const call of redis.set.mock.calls)
      expect(call.slice(2)).toEqual(['EX', expect.any(Number)]);
  });

  it('media cooldown is judged on database time', async () => {
    const { service } = harness();
    service.recordMediaSent(USER.id, at(0));
    expect(
      (await reason(() => service.checkSendLimits(USER, '1.1.1.1', at(10), SETTINGS, true))).type,
    ).toBe('rate_limited');
    expect(
      (await reason(() => service.checkSendLimits(USER, '1.1.1.2', at(31), SETTINGS, true))).type,
    ).toBe('ok');
  });
});

describe('spam window', () => {
  const spammy = room({ linksPolicy: 'ALL_LINKS' });
  const spamSettings = withModeration({ spamProtection: { enabled: true, repeatCount: 3, windowSeconds: 10 } });
  const send = (service: ChatContentService, s: number) =>
    reason(() =>
      service.moderate({
        user: USER,
        facts: FACTS,
        room: spammy,
        settings: spamSettings,
        text: 'same',
        media: null,
        dbNow: at(s),
      }),
    );

  it('copies at 0, 9 and 18 s do not trigger: repeats never restart the window', async () => {
    const { content: service } = harness();
    for (const s of [0, 9, 18]) expect((await send(service, s)).type).toBe('ok');
  });

  it('copies at 0, 4 and 8 s trigger and count an offence', async () => {
    const { content: service, db } = harness();
    await send(service, 0);
    await send(service, 4);
    expect(await send(service, 8)).toMatchObject({
      reason: 'content_blocked',
      extra: { rule: 'spam' },
    });
    expect(db.recordOffence).toHaveBeenCalledTimes(1);
    expect(db.createWarning).toHaveBeenCalledTimes(1);
  });
});

describe('content rules', () => {
  const run = (
    service: ChatContentService,
    cfg: Partial<RoomConfig>,
    text: string,
    user = USER,
    media: 'image' | 'gif' | 'video' | null = null,
    settings: ChatSettings = SETTINGS,
  ) =>
    reason(() =>
      service.moderate({
        user,
        facts: FACTS,
        room: room(cfg),
        settings,
        text,
        media,
        dbNow: at(0),
      }),
    );

  it('links are off by default and a refusal there is never an offence', async () => {
    const { content: service, db } = harness();
    expect(await run(service, {}, 'go to https://evil.example')).toMatchObject({
      reason: 'content_blocked',
      extra: { rule: 'link' },
    });
    expect(db.recordOffence).not.toHaveBeenCalled();
  });

  it('with no ladder set by the admin a refused link, word or repeat is refused but nothing is counted (V2-30)', async () => {
    const { content: service, db } = harness();
    await run(service, { linksPolicy: 'NO_LINKS' }, 'https://evil.com/x', USER, null, withModeration({ autoBanSequence: [] }));
    expect(db.recordOffence).not.toHaveBeenCalled();
    expect(db.createWarning).not.toHaveBeenCalled();
    expect(db.createBan).not.toHaveBeenCalled();
  });

  it('a bare domain is refused without a strike; a real link under NO_LINKS strikes', async () => {
    const { content: service, db } = harness();
    expect((await run(service, { linksPolicy: 'NO_LINKS' }, 'evil.com')).reason).toBe(
      'content_blocked',
    );
    expect(db.recordOffence).not.toHaveBeenCalled();
    await run(service, { linksPolicy: 'NO_LINKS' }, 'https://evil.com/x');
    expect(db.recordOffence).toHaveBeenCalledTimes(1);
  });

  it('OREBiT-only accepts the web app host and its subdomains', async () => {
    const { content: service } = harness();
    const settings = { ...SETTINGS, links: { allowedDomains: ['orebit.io'] } };
    const ok = await reason(() =>
      service.moderate({
        user: USER,
        facts: FACTS,
        room: room({ linksPolicy: 'OREBIT_ONLY' }),
        settings,
        text: 'https://app.orebit.io/x',
        media: null,
        dbNow: at(0),
      }),
    );
    expect(ok.type).toBe('ok');
  });

  it('auto-moderation off: no word, link or spam checks', async () => {
    const { content: service } = harness();
    const cfg = {
      bannedWords: ['bad'],
      contentControls: { ...RoomConfigSchema.parse({}).contentControls, autoModeration: false },
    };
    expect((await run(service, cfg, 'bad https://evil.example')).type).toBe('ok');
  });

  it('images are refused until the room allows them', async () => {
    const { content: service } = harness();
    expect(await run(service, {}, '', USER, 'image')).toMatchObject({
      extra: { rule: 'media_type' },
    });
    expect(await run(service, {}, '', USER, 'gif')).toMatchObject({ type: 'ok' });
  });

  it('a mute applies even to staff; an expired one is ignored', async () => {
    const { content: service } = harness();
    const mod = { ...USER, staffRole: 'MODERATOR' as const };
    const mute = {
      targetType: 'USER' as const,
      // A user is named by id (a name is resolved to the id when the list is saved).
      targetValue: USER.id,
      restriction: 'MUTE' as const,
      internalReason: 'Cool off',
    };
    expect(
      await run(
        service,
        { userRestrictions: [{ ...mute, expiresAt: '2026-09-28T13:00:00Z' }] },
        'hi',
        mod,
      ),
    ).toMatchObject({
      reason: 'chat_muted',
    });
    expect(
      (
        await run(
          service,
          { userRestrictions: [{ ...mute, expiresAt: '2026-09-28T11:00:00Z' }] },
          'hi',
          mod,
        )
      ).type,
    ).toBe('ok');
  });
});

describe('bans', () => {
  it('a permanent ban never expires and carries expiresAt null', async () => {
    const { service } = harness({ bans: [{ roomId: null, expiresAt: null }] });
    expect(await reason(() => service.assertNotBanned(USER.id, 'room-1', at(99999)))).toMatchObject(
      {
        reason: 'chat_banned',
        extra: { expiresAt: null },
      },
    );
  });

  it('a timed ban is judged by database time and reports its end as ISO', async () => {
    const end = at(3600);
    const { service } = harness({ bans: [{ roomId: 'room-1', expiresAt: end }] });
    expect(await reason(() => service.assertNotBanned(USER.id, 'room-1', at(10)))).toMatchObject({
      extra: { expiresAt: end.toISOString() },
    });
    expect((await reason(() => service.assertNotBanned(USER.id, 'room-1', at(3601)))).type).toBe(
      'ok',
    );
    expect((await reason(() => service.assertNotBanned(USER.id, 'room-2', at(10)))).type).toBe(
      'ok',
    );
  });

  it('a new ban version makes the next check read Postgres again', async () => {
    const { service, db } = harness();
    await service.bumpBanVersion(USER.id);
    await service.assertNotBanned(USER.id, null, at(0));
    await service.assertNotBanned(USER.id, null, at(0));
    expect(db.activeBans).toHaveBeenCalledTimes(1);
    await service.bumpBanVersion(USER.id);
    await service.assertNotBanned(USER.id, null, at(0));
    expect(db.activeBans).toHaveBeenCalledTimes(2);
  });
});

describe('staff actions', () => {
  it('SUPPORT asks a higher role to warn (REPORT mode) and may not pin (Module 4 defaults)', async () => {
    const { staff: service, db } = harness();
    const support = { ...USER, staffRole: 'SUPPORT' as const };
    const warned = await service.staffWarn(support, {
      userId: 'target',
      roomId: null,
      internalReason: 'Spamming links',
    });
    expect(warned).toMatchObject({ requested: true, requestId: 'req-1', permission: 'WARN' });
    expect(db.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: 'WARN',
        targetUserId: 'target',
        note: 'Spamming links',
      }),
    );
    expect(db.createWarning).not.toHaveBeenCalled();
    expect((await reason(() => service.staffPin(support, 'm1', true, null))).reason).toBe(
      'permission_denied',
    );
  });

  it('a user without a chat role is staff_only', async () => {
    const { staff: service } = harness();
    expect(
      (await reason(() => service.staffWarn(USER, { userId: 'target', roomId: null, internalReason: 'x' })))
        .reason,
    ).toBe('staff_only');
  });

  it("a moderator's ban is capped by the role's maximum; permanent is the chat admin's", async () => {
    const { staff: service } = harness();
    const mod = { ...USER, staffRole: 'MODERATOR' as const };
    const tooLong = await reason(() =>
      service.staffBan(mod, { userId: 'target', roomId: null, internalReason: 'x', durationHours: 25 }),
    );
    expect(tooLong.reason).toBe('outside_role_scope');
    expect(tooLong.extra?.maxBanHours).toBe(24);
    expect(
      (
        await reason(() =>
          service.staffBan(mod, { userId: 'target', roomId: null, internalReason: 'x', permanent: true }),
        )
      ).reason,
    ).toBe('outside_role_scope');
  });

  it('a moderator cannot ban an admin', async () => {
    const { staff: service } = harness({ target: { ...USER, id: 'boss', staffRole: 'ADMIN' } });
    const mod = { ...USER, staffRole: 'MODERATOR' as const };
    expect(
      (
        await reason(() =>
          service.staffBan(mod, { userId: 'boss', roomId: null, internalReason: 'x', durationHours: 1 }),
        )
      ).reason,
    ).toBe('target_outranks_you');
  });

  it('ban length must be 1 to the maximum, or permanent; each ban is recorded', async () => {
    const { staff: service, db, notices } = harness();
    const mod = { ...USER, staffRole: 'ADMIN' as const };
    expect(
      (
        await reason(() =>
          service.staffBan(mod, { userId: 'target', roomId: null, internalReason: 'x', durationHours: 0 }),
        )
      ).type,
    ).toBe('validation_failed');
    expect(
      (
        await reason(() =>
          service.staffBan(mod, {
            userId: 'target',
            roomId: null,
            internalReason: 'x',
            durationHours: SETTINGS.limits.maxBanHours + 1,
          }),
        )
      ).type,
    ).toBe('validation_failed');
    await service.staffBan(mod, {
      userId: 'target',
      roomId: null,
      internalReason: 'Spam',
      permanent: true,
    });
    expect(db.createBan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ seconds: null }),
    );
    expect(db.recordAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorType: 'STAFF', action: 'staff.ban', note: 'Spam' }),
    );
    // The notice carries the user reason only; none was given, so no note (the internal one never leaves, V2-104).
    expect(notices).toContainEqual(expect.objectContaining({ action: 'ban', note: null }));
  });

  it('an unknown or deleted target is 404', async () => {
    const { staff: service } = harness({ target: null });
    expect(
      (
        await reason(() =>
          service.staffWarn(
            { ...USER, staffRole: 'ADMIN' },
            { userId: 'x', roomId: null, internalReason: 'x' },
          ),
        )
      ).type,
    ).toBe('not_found');
  });
});
