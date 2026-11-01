import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../src/http';
import { ChatModulesService } from '../../src/social/chat/services/chat-modules.service';
import { ChatMoneyService } from '../../src/social/chat/services/chat-money.service';
import { ChatStaffRequestsService } from '../../src/social/chat/services/chat-staff-requests.service';

/**
 * The admin side of chat Modules 4–5 added for the PDF gaps: editing bans and restrictions, the bot log, approving
 * the new kinds of staff request, and reverting ads and gifts in bulk. The database layers are fakes.
 */
const ADMIN = '0192f6a0-0000-7000-8000-00000000aa01';
const USER = '0192f6a0-0000-7000-8000-00000000bb01';
const ROOM = '0192f6a0-0000-7000-8000-00000000cc01';
const ID = '0192f6a0-0000-7000-8000-00000000dd01';

async function problem(run: () => Promise<unknown>): Promise<ProblemException> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ProblemException) return err;
    throw err;
  }
  throw new Error('expected a problem');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose fakes of the database layers
type Fake = any;

function moderationFake(): Fake {
  return {
    resolveUserId: vi.fn(async (handle: string) => (handle === 'bob' ? USER : null)),
    recordModerationAction: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    maxBanHours: vi.fn().mockResolvedValue(720),
    liftBan: vi.fn().mockResolvedValue({ userId: USER, roomId: null }),
  };
}

describe('ChatModulesService: editing penalties and the bot log', () => {
  let db: Fake;
  let moderation: Fake;
  let service: ChatModulesService;

  beforeEach(() => {
    db = {
      updateBan: vi.fn().mockResolvedValue({
        userId: USER,
        roomId: null,
        expiresAt: '2026-10-11T00:00:00.000Z',
        userReason: null,
        old: { expiresAt: '2026-10-10T12:00:00.000Z', internalReason: 'spam', userReason: null },
      }),
      updateRestriction: vi.fn().mockResolvedValue({
        targetType: 'USER',
        targetValue: USER,
        expiresAt: null,
      }),
      botLog: vi.fn().mockResolvedValue([]),
    };
    moderation = moderationFake();
    service = new ChatModulesService(db, moderation);
  });

  it('a ban gets a new end from now, the change is logged and the user told', async () => {
    const result = await service.changeBan(
      { banId: ID, durationHours: 12, internalReason: 'again' },
      ADMIN,
    );
    expect(result).toEqual({ banId: ID, expiresAt: '2026-10-11T00:00:00.000Z' });
    expect(db.updateBan).toHaveBeenCalledWith(ID, { seconds: 12 * 3600, internalReason: 'again', userReason: null });
    expect(moderation.recordModerationAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CHANGE_BAN', targetUserId: USER }),
    );
    expect(moderation.notify).toHaveBeenCalledWith({ kind: 'ban', userId: USER });
  });

  it('a ban change is a duration or permanent, never both, and within the chat-wide maximum', async () => {
    expect(
      (
        await problem(() =>
          service.changeBan({ banId: ID, durationHours: 2, permanent: true }, ADMIN),
        )
      ).type,
    ).toBe('validation_failed');
    expect((await problem(() => service.changeBan({ banId: ID }, ADMIN))).type).toBe(
      'validation_failed',
    );
    expect(
      (await problem(() => service.changeBan({ banId: ID, durationHours: 721 }, ADMIN))).type,
    ).toBe('validation_failed');
    await service.changeBan({ banId: ID, permanent: true }, ADMIN);
    expect(db.updateBan).toHaveBeenCalledWith(ID, { seconds: null, internalReason: null, userReason: null });
  });

  it('a ban that is no longer live is not found', async () => {
    db.updateBan.mockResolvedValue(null);
    expect(
      (await problem(() => service.changeBan({ banId: ID, durationHours: 1 }, ADMIN))).type,
    ).toBe('not_found');
  });

  it('a restriction can run until lifted; the chat server reloads restrictions', async () => {
    await service.changeRestriction({ restrictionId: ID, durationHours: null }, ADMIN);
    expect(db.updateRestriction).toHaveBeenCalledWith(ID, { hours: null, internalReason: null, userReason: null });
    expect(moderation.notify).toHaveBeenCalledWith({ kind: 'restrictions' });
  });

  it('the bot log takes a username', async () => {
    await service.botLog({ userId: 'bob', limit: '20' });
    expect(db.botLog).toHaveBeenCalledWith(USER, 20, null);
    expect((await problem(() => service.botLog({ userId: 'nobody' }))).type).toBe('not_found');
  });
});

describe('ChatStaffRequestsService: approving the new kinds of request', () => {
  let db: Fake;
  let moderation: Fake;
  let settings: Fake;
  let rain: Fake;
  let service: ChatStaffRequestsService;
  const request = (permission: string, payload: Record<string, unknown>) => ({
    id: ID,
    status: 'PENDING',
    permission,
    payload,
    requester_id: ADMIN,
    target_user_id: USER,
    target_room_id: ROOM,
  });

  beforeEach(() => {
    db = {
      staffRequestById: vi.fn(),
      resolveStaffRequest: vi.fn().mockResolvedValue(true),
      updateBan: vi
        .fn()
        .mockResolvedValue({ userId: USER, roomId: null, expiresAt: null, old: {} }),
      updateRestriction: vi
        .fn()
        .mockResolvedValue({ targetType: 'USER', targetValue: USER, expiresAt: null }),
      liftRestriction: vi.fn().mockResolvedValue({ targetType: 'USER', targetValue: USER }),
      setRoomAccess: vi.fn().mockResolvedValue(undefined),
    };
    moderation = moderationFake();
    settings = { savePatch: vi.fn().mockResolvedValue(undefined) };
    rain = {
      patchStatus: vi.fn().mockResolvedValue({ before: {}, after: {} }),
      audit: vi.fn().mockResolvedValue(undefined),
    };
    service = new ChatStaffRequestsService(db, moderation, {} as never, settings, rain);
  });

  it('a requested ban change is carried out as a change, not a lift', async () => {
    db.staffRequestById.mockResolvedValue(
      request('CHANGE_PENALTIES', { banId: ID, change: true, durationHours: 6 }),
    );
    const result = await service.resolveStaffRequest(
      { requestId: ID, approve: true },
      ADMIN,
      'ADMIN',
    );
    expect(result).toMatchObject({ status: 'APPROVED', applied: true });
    expect(db.updateBan).toHaveBeenCalledWith(ID, { seconds: 6 * 3600, internalReason: null, userReason: null });
    expect(moderation.liftBan).not.toHaveBeenCalled();
  });

  it('a requested restriction change keeps "until lifted"', async () => {
    db.staffRequestById.mockResolvedValue(
      request('CHANGE_PENALTIES', { restrictionId: ID, change: true, durationHours: null }),
    );
    await service.resolveStaffRequest({ requestId: ID, approve: true }, ADMIN, 'ADMIN');
    expect(db.updateRestriction).toHaveBeenCalledWith(ID, { hours: null, internalReason: null, userReason: null });
  });

  it('room access: ADD, REMOVE and RESTORE reach the database as asked', async () => {
    for (const action of ['ADD', 'REMOVE', 'RESTORE']) {
      db.staffRequestById.mockResolvedValue(request('ROOM_ACCESS', { action }));
      await service.resolveStaffRequest({ requestId: ID, approve: true }, ADMIN, 'ADMIN');
      expect(db.setRoomAccess).toHaveBeenLastCalledWith(ROOM, USER, action, ADMIN);
    }
  });

  it('switching sending money off is a super-admin write', async () => {
    db.staffRequestById.mockResolvedValue(request('SENDING_MONEY', { enabled: false }));
    expect(
      await service.resolveStaffRequest({ requestId: ID, approve: true }, ADMIN, 'ADMIN'),
    ).toMatchObject({ applied: false });
    expect(settings.savePatch).not.toHaveBeenCalled();

    await service.resolveStaffRequest({ requestId: ID, approve: true }, ADMIN, 'SUPER_ADMIN');
    expect(settings.savePatch).toHaveBeenCalledWith({
      patch: { global: { gifts: { enabled: false } } },
      actorId: ADMIN,
    });
  });

  it('"Disable Overall / Rainpool / User Rains" switch that RainPool status, as a super admin', async () => {
    db.staffRequestById.mockResolvedValue(request('DISABLE_RAINPOOL_RAINS', { status: 'OFF' }));
    expect(
      await service.resolveStaffRequest({ requestId: ID, approve: true }, ADMIN, 'ADMIN'),
    ).toMatchObject({ applied: false });
    expect(rain.patchStatus).not.toHaveBeenCalled();

    await service.resolveStaffRequest({ requestId: ID, approve: true }, ADMIN, 'SUPER_ADMIN');
    expect(rain.patchStatus).toHaveBeenLastCalledWith({ system: 'OFF' });
    expect(moderation.notify).toHaveBeenCalledWith({ kind: 'rain' });

    for (const [permission, field] of [
      ['DISABLE_OVERALL_RAINS', 'overall'],
      ['DISABLE_USER_RAINS', 'user'],
    ] as const) {
      db.staffRequestById.mockResolvedValue(request(permission, { status: 'ON' }));
      await service.resolveStaffRequest({ requestId: ID, approve: true }, ADMIN, 'SUPER_ADMIN');
      expect(rain.patchStatus).toHaveBeenLastCalledWith({ [field]: 'ON' });
    }
  });
});

describe('ChatMoneyService: reverting ads and gifts', () => {
  let money: Fake;
  let moderation: Fake;
  let service: ChatMoneyService;
  const frame = { from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', reason: 'Administrative test revert' };

  beforeEach(() => {
    money = {
      adsForRevert: vi.fn().mockResolvedValue([
        { id: 'ad-running', status: 'ACTIVE', creator_id: USER },
        { id: 'ad-done', status: 'COMPLETED', creator_id: USER },
      ]),
      // The refund is worked out by the database inside the cancel (price × unused / units, cut), not here.
      cancelAd: vi.fn().mockResolvedValue({ cancelled: true, refundUsd: '15.00000000' }),
      markAdRewardsRevert: vi.fn().mockResolvedValue(2),
      revertGifts: vi.fn().mockResolvedValue({ count: 3, usd: '42.00' }),
    };
    moderation = moderationFake();
    service = new ChatMoneyService(money, moderation, {} as never, {} as never);
  });

  it('a dry run only lists the ads', async () => {
    expect(await service.revertAds({ ...frame, dryRun: true, revertAll: true }, ADMIN)).toEqual({
      dryRun: true,
      count: 2,
      adIds: ['ad-running', 'ad-done'],
    });
    expect(money.cancelAd).not.toHaveBeenCalled();
    expect(moderation.recordModerationAction).not.toHaveBeenCalled();
  });

  it('running ads stop with a refund of the unused part; every ad loses its rewards', async () => {
    const result = await service.revertAds({ ...frame, userIds: ['bob'], minUsd: '5' }, ADMIN);
    expect(money.adsForRevert).toHaveBeenCalledWith(
      expect.objectContaining({
        userIds: [USER],
        minUsd: '5',
        maxUsd: null,
        adIds: [],
        pinnedOnly: false,
      }),
    );
    expect(money.cancelAd).toHaveBeenCalledTimes(1);
    expect(money.cancelAd).toHaveBeenCalledWith('ad-running', ADMIN, 'Reverted by admin', 'UNUSED');
    expect(money.markAdRewardsRevert).toHaveBeenCalledWith(['ad-running', 'ad-done']);
    expect(moderation.notify).toHaveBeenCalledWith({ kind: 'ad', adId: 'ad-running' });
    expect(result).toEqual({ dryRun: false, count: 2, stopped: 1, rewardsReverted: 2 });
  });

  it('gifts: filters pass through and the revert is logged; a dry run is not', async () => {
    const result = await service.revertGifts(
      { ...frame, currencies: ['USDT'], refundFees: true, maxUsd: '100', shortfall: 'ZERO' },
      ADMIN,
    );
    expect(result).toEqual({ dryRun: false, count: 3, usdValue: '42.00' });
    expect(money.revertGifts).toHaveBeenCalledWith(
      expect.objectContaining({
        currencies: ['USDT'],
        refundFees: true,
        maxUsd: '100',
        adminId: ADMIN,
      }),
    );
    expect(moderation.recordModerationAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REVERT_GIFTS' }),
    );

    moderation.recordModerationAction.mockClear();
    await service.revertGifts(
      { ...frame, dryRun: true, revertAll: true, shortfall: 'ZERO' },
      ADMIN,
    );
    expect(moderation.recordModerationAction).not.toHaveBeenCalled();
  });

  it('the time frame must run forwards', async () => {
    expect(
      (await problem(() => service.revertGifts({ from: frame.to, to: frame.from }, ADMIN))).type,
    ).toBe('validation_failed');
  });
});

describe('ChatModulesService: reading DMs and listing groups (FR-023, FR-202)', () => {
  let db: Fake;
  let moderation: Fake;
  let service: ChatModulesService;

  beforeEach(() => {
    db = {
      conversationsOf: vi.fn().mockResolvedValue({ items: [{ id: ID }], nextCursor: 'next-page' }),
      conversationExists: vi.fn().mockResolvedValue(true),
      memberIds: vi.fn().mockResolvedValue([USER, ADMIN]),
      conversationMessages: vi.fn().mockResolvedValue({ items: [{ id: ID }], nextCursor: null }),
      groups: vi.fn().mockResolvedValue({ items: [{ id: ID }], nextCursor: 'more' }),
    };
    moderation = moderationFake();
    service = new ChatModulesService(db, moderation);
  });

  it('listing a user\'s conversations is recorded with the target and the page, and is paged', async () => {
    const out = await service.userConversations({ userId: 'bob', limit: 20, cursor: 'abc' }, ADMIN);
    expect(db.conversationsOf).toHaveBeenCalledWith(USER, 20, 'abc');
    expect(out).toMatchObject({ conversations: [{ id: ID }], nextCursor: 'next-page' });
    expect(moderation.recordModerationAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ADMIN,
        action: 'DM_LIST',
        targetUserId: USER,
        newValue: { limit: 20, cursor: 'abc' },
      }),
    );
  });

  it('reading a conversation needs a reason and records who was in it and which page was read', async () => {
    expect(
      (await problem(() => service.readConversation({ conversationId: ID, reason: 'no' }, ADMIN))).type,
    ).toBeDefined();
    await service.readConversation({ conversationId: ID, reason: 'a user complaint', limit: 50, cursor: 'c1' }, ADMIN);
    expect(moderation.recordModerationAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DM_VIEW',
        note: 'a user complaint',
        newValue: { conversationId: ID, memberIds: [USER, ADMIN], limit: 50, cursor: 'c1' },
      }),
    );
    expect(db.conversationMessages).toHaveBeenCalledWith(ID, 50, 'c1');
  });

  it('listing groups is paged and recorded', async () => {
    const out = await service.groups({ q: 'team', limit: 10 }, ADMIN);
    expect(db.groups).toHaveBeenCalledWith('team', 10, null);
    expect(out).toEqual({ groups: [{ id: ID }], nextCursor: 'more' });
    expect(moderation.recordModerationAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DM_GROUP_LIST', newValue: { q: 'team', limit: 10, cursor: null } }),
    );
  });
});
