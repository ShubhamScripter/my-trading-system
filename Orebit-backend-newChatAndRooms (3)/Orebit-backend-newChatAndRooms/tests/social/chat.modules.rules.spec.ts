import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_SETTINGS,
  type ChatSettings,
} from '../../src/social/chat/chat.settings.contract';
import {
  ADMIN_PANEL_RANK,
  SYSTEM_RANK,
  canAct,
  commandsInScope,
  maxBanHoursFor,
  modeOf,
  penaltyInScope,
  restrictionMode,
  roomInScope,
} from '../../src/social/chat/services/chat.permissions';
import {
  AdPriceError,
  priceAd,
  refundForAdvertiserStop,
  refundForCancel,
  unusedParts,
  unusedRefundUsd,
} from '../../src/social/chat/services/chat.ads.pricing';
import { parseCommand, commandName } from '../../src/social/chat/services/chat.commands.parser';
import { rewardFor, rewardsFor } from '../../src/social/chat/services/chat.rewards';
import { restrictionTargets } from '../../src/social/chat/services/chat.restrictions.service';
import {
  directKey,
  directPlacement,
  effectivePrefs,
  inQuietHours,
  mayDo,
  mayText,
  outranks,
  roleFor,
  shouldNotify,
  visibleTo,
} from '../../src/social/chat/dm/dm.rules';
import type { ChatUserContext, EligibilityFacts } from '../../src/social/chat/chat.types';

/** The pure rules of Modules 4, 5, 8 and 9: one place, no database. */
const SETTINGS = DEFAULT_CHAT_SETTINGS as unknown as ChatSettings;
const with_ = (patch: Partial<ChatSettings>): ChatSettings =>
  ({ ...SETTINGS, ...patch }) as ChatSettings;

describe('Module 4: role permissions', () => {
  it('defaults: admins act on everything, moderators ask before changing rooms, support asks to warn', () => {
    expect(canAct(SETTINGS, 'ADMIN', 'ROOM_STATUS')).toBe(true);
    expect(modeOf(SETTINGS, 'MODERATOR', 'BAN')).toBe('ACT');
    expect(modeOf(SETTINGS, 'MODERATOR', 'ROOM_STATUS')).toBe('REPORT');
    expect(modeOf(SETTINGS, 'SUPPORT', 'WARN')).toBe('REPORT');
    expect(canAct(SETTINGS, 'SUPPORT', 'JOIN_STAFF_ROOM')).toBe(true);
    expect(modeOf(SETTINGS, null, 'WARN')).toBe('NONE');
  });

  it('a mute needs the ban permission; media restrictions take pictures or videos', () => {
    expect(restrictionMode(SETTINGS, 'MODERATOR', 'MUTE')).toBe('ACT');
    expect(restrictionMode(SETTINGS, 'SUPPORT', 'MUTE')).toBe('REPORT');
    expect(restrictionMode(SETTINGS, 'MODERATOR', 'RESTRICT_GIFTS')).toBe('REPORT');
    const onlyVideos = with_({
      staffRoles: {
        ...SETTINGS.staffRoles,
        MODERATOR: { ...SETTINGS.staffRoles.MODERATOR, permissions: { MANAGE_VIDEOS: 'ACT' } },
      },
    });
    expect(restrictionMode(onlyVideos, 'MODERATOR', 'RESTRICT_MEDIA')).toBe('ACT');
  });

  it('the ban maximum is the role maximum, never above the chat-wide one', () => {
    expect(maxBanHoursFor(SETTINGS, 'MODERATOR')).toBe(24);
    const tight = with_({ limits: { ...SETTINGS.limits, maxBanHours: 12 } });
    expect(maxBanHoursFor(tight, 'MODERATOR')).toBe(12);
  });

  it('penalty scope: same, below, or both; own penalties always; the admin panel never', () => {
    const scoped = (scope: 'SAME' | 'BELOW' | 'SAME_AND_BELOW') =>
      with_({
        staffRoles: {
          ...SETTINGS.staffRoles,
          MODERATOR: { ...SETTINGS.staffRoles.MODERATOR, penaltyScope: scope },
        },
      });
    expect(penaltyInScope(scoped('BELOW'), 'MODERATOR', SYSTEM_RANK, false)).toBe(true);
    expect(penaltyInScope(scoped('BELOW'), 'MODERATOR', 2, false)).toBe(false);
    expect(penaltyInScope(scoped('SAME'), 'MODERATOR', 2, false)).toBe(true);
    expect(penaltyInScope(scoped('SAME'), 'MODERATOR', 1, false)).toBe(false);
    expect(penaltyInScope(scoped('SAME_AND_BELOW'), 'MODERATOR', 1, false)).toBe(true);
    expect(penaltyInScope(scoped('SAME_AND_BELOW'), 'MODERATOR', ADMIN_PANEL_RANK, false)).toBe(
      false,
    );
    expect(penaltyInScope(scoped('SAME'), 'MODERATOR', ADMIN_PANEL_RANK, true)).toBe(true);
  });

  it('room and command scopes', () => {
    expect(roomInScope([], 'r1')).toBe(true);
    expect(roomInScope(['r2'], 'r1')).toBe(false);
    expect(commandsInScope([], [])).toBe(true);
    expect(commandsInScope(['ad'], [])).toBe(false);
    expect(commandsInScope(['ad', 'send'], ['ad'])).toBe(true);
  });

  it('a restriction targets one user by id (never by name), or a group by premium, KYC or level', () => {
    const user: ChatUserContext = { id: 'u-1', username: 'Bob', publicCode: 'P', staffRole: null };
    const facts = {
      premiumPlanIds: ['gold'],
      kycLevel: 0,
      level: 12,
    } as unknown as EligibilityFacts;
    const now = new Date('2026-10-09T12:00:00Z');
    // A name is resolved to the id when the restriction is saved: it never matches by itself (FR-088).
    expect(restrictionTargets({ targetType: 'USER', targetValue: 'bob' }, user, facts, now)).toBe(
      false,
    );
    expect(restrictionTargets({ targetType: 'USER', targetValue: 'u-1' }, user, facts, now)).toBe(
      true,
    );
    expect(restrictionTargets({ targetType: 'PREMIUM', targetValue: '-' }, user, facts, now)).toBe(
      true,
    );
    expect(restrictionTargets({ targetType: 'KYC', targetValue: '-' }, user, facts, now)).toBe(
      false,
    );
    expect(restrictionTargets({ targetType: 'LEVEL', targetValue: '10' }, user, facts, now)).toBe(
      true,
    );
    expect(restrictionTargets({ targetType: 'LEVEL', targetValue: '20' }, user, facts, now)).toBe(
      false,
    );
    expect(
      restrictionTargets(
        { targetType: 'USER', targetValue: 'u-1', expiresAt: '2026-10-09T11:00:00Z' },
        user,
        facts,
        now,
      ),
    ).toBe(false);
  });
});

describe('Module 5: ad prices', () => {
  const ads = SETTINGS.ads;
  const room = (id: string, type: 'GLOBAL' | 'COUNTRY' | 'PREMIUM' | 'SO' = 'COUNTRY') => ({
    id,
    type,
  });

  it('one ordinary room costs the base price', () => {
    const price = priceAd(ads, {
      rooms: [room('a', 'GLOBAL')],
      allRooms: false,
      links: 0,
      repeatCount: 0,
      pinMinutes: null,
    });
    expect(price.totalUsd).toBe('5.00000000');
  });

  it('extra, premium and SO rooms add their costs', () => {
    const price = priceAd(ads, {
      rooms: [room('a', 'GLOBAL'), room('b'), room('p', 'PREMIUM'), room('s', 'SO')],
      allRooms: false,
      links: 0,
      repeatCount: 0,
      pinMinutes: null,
    });
    // 5 base + 2 extra + 4 premium + 4 SO
    expect(price.perPostUsd).toBe('15.00000000');
  });

  it('all rooms is a percentage of the base, premium and SO still added', () => {
    const price = priceAd(ads, {
      rooms: [room('a', 'GLOBAL'), room('b'), room('p', 'PREMIUM')],
      allRooms: true,
      links: 0,
      repeatCount: 0,
      pinMinutes: null,
    });
    // 5 + 200% of 5 + 4 premium
    expect(price.perPostUsd).toBe('19.00000000');
  });

  it('"ALL Rooms" by default: no room costs at all', () => {
    const price = priceAd(
      { ...ads, allRoomsByDefault: true },
      {
        rooms: [room('a'), room('p', 'PREMIUM')],
        allRooms: true,
        links: 0,
        repeatCount: 0,
        pinMinutes: null,
      },
    );
    expect(price.perPostUsd).toBe('5.00000000');
  });

  it('links beyond the free ones are paid, beyond the paid ones refused', () => {
    const price = priceAd(ads, {
      rooms: [room('a')],
      allRooms: false,
      links: 3,
      repeatCount: 0,
      pinMinutes: null,
    });
    expect(price.perPostUsd).toBe('7.00000000');
    expect(() =>
      priceAd(ads, {
        rooms: [room('a')],
        allRooms: false,
        links: 4,
        repeatCount: 0,
        pinMinutes: null,
      }),
    ).toThrow(AdPriceError);
  });

  it('every repeat gets the same flat discount (it does not grow with each repeat)', () => {
    const price = priceAd(ads, {
      rooms: [room('a')],
      allRooms: false,
      links: 0,
      repeatCount: 7,
      pinMinutes: null,
    });
    // 5 + seven repeats at 5 % off (4.75)
    expect(price.totalUsd).toBe('38.25000000');
    expect(price.lines.filter((l) => l.label.startsWith('Repeat')).every((l) => l.usd === '4.75000000')).toBe(true);
  });

  it('the flat discount never exceeds the one maximum discount (percent, and USD when set)', () => {
    const base = { rooms: [room('a')], allRooms: false, links: 0, repeatCount: 1, pinMinutes: null };
    const capped = { ...ads, repeat: { ...ads.repeat, discountPercent: 50, maxDiscountPercent: 20 } };
    // 50 % asked, 20 % allowed: 5 + 4
    expect(priceAd(capped, base).totalUsd).toBe('9.00000000');
    const cappedUsd = { ...ads, repeat: { ...ads.repeat, discountPercent: 50, maxDiscountPercent: 50, maxDiscountUsd: '1' } };
    expect(priceAd(cappedUsd, base).totalUsd).toBe('9.00000000');
    expect(priceAd(cappedUsd, { ...base, repeatCount: 5 }).totalUsd).toBe('29.00000000');
  });

  it('percentage extras compound: +10 % then +20 % on 100 is 132, not 130 (FR-107)', () => {
    const compound = {
      ...ads,
      basePriceUsd: '100',
      extraRoom: { kind: 'PERCENT' as const, value: '10' },
      pricePerExtraLink: { kind: 'PERCENT' as const, value: '20' },
      maxFreeLinks: 0,
    };
    const price = priceAd(compound, { rooms: [room('a'), room('b')], allRooms: false, links: 1, repeatCount: 0, pinMinutes: null });
    expect(price.totalUsd).toBe('132.00000000');
    // Each paid link is a step of its own: two links at +20 % are 1.2 × 1.2.
    const two = priceAd({ ...compound, maxPaidLinks: 2 }, { rooms: [room('a'), room('b')], allRooms: false, links: 2, repeatCount: 0, pinMinutes: null });
    expect(two.totalUsd).toBe('158.40000000');
  });

  it('prices the same room set identically regardless of request order', () => {
    const compound = { ...ads, extraRoom: { kind: 'PERCENT' as const, value: '10' } };
    const rooms = [room('z', 'GLOBAL'), room('b'), room('a')];
    const first = priceAd(compound, { rooms, allRooms: false, links: 0, repeatCount: 0, pinMinutes: null });
    const reversed = priceAd(compound, { rooms: [...rooms].reverse(), allRooms: false, links: 0, repeatCount: 0, pinMinutes: null });
    expect(reversed.totalUsd).toBe(first.totalUsd);
  });

  it('pinned minutes are charged once per ad per minute, not per room (V2-23)', () => {
    const one = priceAd(ads, { rooms: [room('a')], allRooms: false, links: 0, repeatCount: 0, pinMinutes: 10 });
    const two = priceAd(ads, { rooms: [room('a'), room('b')], allRooms: false, links: 0, repeatCount: 0, pinMinutes: 10 });
    // 5 + 0.5 × 10, and the second room adds only its extra-room cost
    expect(one.totalUsd).toBe('10.00000000');
    expect(two.totalUsd).toBe('12.00000000');
  });

  it('"ALL Rooms" shows what the rooms cost one by one and the saving (FR-186)', () => {
    const rooms = [room('a', 'GLOBAL'), room('b'), room('c'), room('d'), room('e')];
    const all = priceAd(ads, { rooms, allRooms: true, links: 0, repeatCount: 0, pinMinutes: null });
    // all rooms: 5 + 200 % of 5 = 15; one by one: 5 + 4 × 2 = 13, so ALL Rooms costs more and saves nothing
    expect(all.separateTotalUsd).toBe('13.00000000');
    expect(all.savedUsd).toBe('0.00000000');
    const cheaper = priceAd({ ...ads, allRooms: { kind: 'USD', value: '3' } }, { rooms, allRooms: true, links: 0, repeatCount: 0, pinMinutes: null });
    expect(cheaper.totalUsd).toBe('8.00000000');
    expect(cheaper.separateTotalUsd).toBe('13.00000000');
    expect(cheaper.savedUsd).toBe('5.00000000');
    // A quote that is not "all rooms" carries neither field.
    expect(priceAd(ads, { rooms, allRooms: false, links: 0, repeatCount: 0, pinMinutes: null }).savedUsd).toBeUndefined();
  });

  it('a premium room of particular plans costs the sub-premium price; a skin is paid once per ad', () => {
    const price = priceAd(ads, {
      rooms: [
        room('a', 'GLOBAL'),
        room('p', 'PREMIUM'),
        { id: 'v', type: 'PREMIUM', planBound: true },
      ],
      allRooms: false,
      links: 0,
      repeatCount: 1,
      pinMinutes: null,
      skinPriceUsd: '2.5',
    });
    // per post 5 + 4 premium + 6 sub-premium = 15; one repeat at 5% off = 14.25; skin 2.5 once
    expect(price.perPostUsd).toBe('15.00000000');
    expect(price.totalUsd).toBe('31.75000000');
    expect(price.lines.map((l) => l.label)).toEqual(
      expect.arrayContaining(['Premium room', 'Sub premium room', 'Ad skin']),
    );
  });

  it('a refund covers only posts not made and pinned time not shown, to the second', () => {
    expect(unusedParts({ totalPosts: 4, postedCount: 1, pinnedMinutes: 0, pinnedSecondsUsed: 0 })).toEqual({ unused: 180, units: 240 });
    expect(unusedParts({ totalPosts: 1, postedCount: 1, pinnedMinutes: 10, pinnedSecondsUsed: 240 })).toEqual({ unused: 360, units: 660 });
    expect(unusedParts({ totalPosts: 0, postedCount: 0, pinnedMinutes: 1, pinnedSecondsUsed: 10 })).toEqual({ unused: 50, units: 60 });
    expect(unusedRefundUsd('10.00000000', { unused: 180, units: 240 })).toBe('7.50000000');
    // Cut, never rounded: 2 / 3 of 10 is 6.66666666…, not 6.66666667.
    expect(unusedRefundUsd('10.00000000', { unused: 2, units: 3 })).toBe('6.66666666');
    expect(unusedRefundUsd('10.00000000', { unused: 0, units: 0 })).toBe('0.00000000');
  });

  it('refunds post and pinned value using their separate stored prices (N-008)', () => {
    const ad = {
      priceUsd: '20.00000000', repeatCount: 0, postedCount: 1, pinMinutes: 1000, roomIds: ['a', 'b', 'c'],
      breakdown: [
        { label: 'Base price', usd: '10.00000000' },
        { label: 'Pinned 1000 min', usd: '10.00000000' },
      ],
    };
    // The post is already sent; all 1000 pin minutes are still unused. Equal-counting a post and a minute
    // would return almost the entire $20, but itemized pricing returns only the pin's $10.
    expect(refundForCancel(ad, 0)).toBe('10.00000000');
    expect(refundForCancel({ ...ad, pinMinutes: 0, breakdown: [{ label: 'Base price', usd: '10.00000000' }] }, 0)).toBe('0.00000000');
  });

  it('the pinned minutes of a refund are counted once per ad, whatever the number of rooms (FR-107)', () => {
    const ad = {
      priceUsd: '12.00000000', repeatCount: 0, postedCount: 1, pinMinutes: 10, roomIds: ['a', 'b', 'c'],
      breakdown: [
        { label: 'Base price', usd: '2.00000000' },
        { label: 'Pinned 10 min', usd: '10.00000000' },
      ],
    };
    expect(refundForCancel(ad, 240)).toBe('6.00000000');
  });

  it('advertiser stop refunds only post-price lines and leaves pin/skin spend untouched', () => {
    expect(refundForAdvertiserStop({
      priceUsd: '15.00000000',
      repeatCount: 1,
      breakdown: [
        { label: 'Base price', usd: '5.00000000' },
        { label: 'Repeat 1', usd: '5.00000000' },
        { label: 'Ad skin', usd: '1.00000000' },
        { label: 'Pinned 10 min', usd: '4.00000000' },
      ],
    })).toBe('10.00000000');
  });
});

describe('Module 5: command parser', () => {
  it('reads every command and its aliases', () => {
    expect(parseCommand('/help')).toEqual({ kind: 'help' });
    expect(parseCommand('/mute @bob')).toEqual({ kind: 'mute', target: 'bob' });
    expect(parseCommand('/unblock bob')).toEqual({ kind: 'unblock', target: 'bob' });
    expect(parseCommand('/mutelist')).toEqual({ kind: 'mutelist' });
    expect(parseCommand('/pm @bob hello there')).toEqual({
      kind: 'dm',
      target: 'bob',
      text: 'hello there',
    });
    expect(parseCommand('/gift @bob 10.5 usdt')).toEqual({
      kind: 'send',
      target: 'bob',
      amount: '10.5',
      currency: 'USDT',
    });
    expect(parseCommand('/send @bob BTC 0.001')).toEqual({
      kind: 'send',
      target: 'bob',
      amount: '0.001',
      currency: 'BTC',
    });
  });

  it('reads /ad options before the text', () => {
    expect(
      parseCommand(
        '/ad rooms=global,india-hub pin=10 repeat=3x15 badge=love hide=in,us Buy now at shop',
      ),
    ).toEqual({
      kind: 'ad',
      text: 'Buy now at shop',
      roomIds: ['global', 'india-hub'],
      allRooms: false,
      pinMinutes: 10,
      repeatCount: 3,
      repeatGapMinutes: 15,
      badgeId: 'love',
      hiddenCountries: ['IN', 'US'],
    });
    expect(parseCommand('/ad rooms=all Hello')).toMatchObject({
      kind: 'ad',
      allRooms: true,
      roomIds: [],
    });
  });

  it('tells unknown commands, bad usage and ordinary text apart', () => {
    expect(parseCommand('/rain 5 BTC')).toMatchObject({ kind: 'invalid', name: 'rain' });
    expect(parseCommand('/rain BTC 0.01 5')).toEqual({
      kind: 'rain',
      currency: 'BTC',
      pot: '0.01',
      recipients: { mode: 'SPECIFIC', count: 5 },
      repeatCount: null,
      repeatGapSeconds: null,
    });
    expect(parseCommand('/mute')).toMatchObject({ kind: 'invalid', name: 'mute' });
    expect(parseCommand('/send @bob ten BTC')).toMatchObject({ kind: 'invalid', name: 'send' });
    expect(parseCommand('/ad wobble=1 text')).toMatchObject({ kind: 'invalid', name: 'ad' });
    expect(parseCommand('hello /mute @bob')).toEqual({ kind: 'none' });
    expect(commandName('/ hi')).toBeNull();
    expect(commandName('/PM x')).toBe('dm');
  });
});

describe('Modules 8–9: personal chat rules', () => {
  it('folders: Primary for friends, people you follow and whoever you wrote to; General for followers; else a request', () => {
    expect(directPlacement(true, { following: false, followedBy: false })).toEqual({
      folder: 'PRIMARY',
      state: 'ACTIVE',
    });
    expect(directPlacement(false, { following: true, followedBy: true })).toEqual({
      folder: 'PRIMARY',
      state: 'ACTIVE',
    });
    expect(directPlacement(false, { following: true, followedBy: false })).toEqual({
      folder: 'PRIMARY',
      state: 'ACTIVE',
    });
    expect(directPlacement(false, { following: false, followedBy: true })).toEqual({
      folder: 'GENERAL',
      state: 'ACTIVE',
    });
    expect(directPlacement(false, { following: false, followedBy: false })).toEqual({
      folder: 'GENERAL',
      state: 'REQUEST',
    });
  });

  it('one conversation per pair, whoever starts it', () => {
    expect(directKey('b', 'a')).toBe(directKey('a', 'b'));
  });

  it('last seen and common groups: all, friends or nobody', () => {
    expect(visibleTo('ALL', false, false)).toBe(true);
    expect(visibleTo('FRIENDS', false, false)).toBe(false);
    expect(visibleTo('FRIENDS', false, true)).toBe(true);
    expect(visibleTo('NOBODY', false, true)).toBe(false);
    expect(visibleTo('NOBODY', true, false)).toBe(true);
  });

  it('quiet mode wraps midnight and follows the time zone', () => {
    const prefs = effectivePrefs(
      // The admin sets the quiet window; there is no built-in one (V2-44).
      with_({ privacy: { ...SETTINGS.privacy, quietModeDefault: 'AUTO_NIGHT', quietStart: '22:00', quietEnd: '07:00' } }),
      {
        notifyPrimary: null,
        notifyGeneral: null,
        notifyGroups: null,
        quietMode: null,
        quietStart: null,
        quietEnd: null,
        timeZone: 'Asia/Kolkata',
      },
    );
    // 17:00 UTC = 22:30 in India: quiet. 03:00 UTC = 08:30 in India: not quiet.
    expect(inQuietHours(prefs, new Date('2026-10-09T17:00:00Z'))).toBe(true);
    expect(inQuietHours(prefs, new Date('2026-10-09T03:00:00Z'))).toBe(false);
  });

  it('a custom window needs the admin to allow it', () => {
    const stored = {
      notifyPrimary: null,
      notifyGeneral: null,
      notifyGroups: false,
      quietMode: 'CUSTOM',
      quietStart: '13:00',
      quietEnd: '14:00',
      timeZone: null,
    };
    expect(effectivePrefs(SETTINGS, stored).quietStart).toBe('13:00');
    const locked = effectivePrefs(
      with_({ privacy: { ...SETTINGS.privacy, allowQuietChange: false } }),
      stored,
    );
    // The admin's own default applies, not a mode picked in code (no hidden defaults).
    expect(locked.quietMode).toBe(SETTINGS.privacy.quietModeDefault);
    expect(locked.quietStart).toBe(SETTINGS.privacy.quietStart);
  });

  it('notify: conversation choice over folder choice, never in quiet hours or for a declined request', () => {
    const prefs = effectivePrefs(SETTINGS, {
      notifyPrimary: null,
      notifyGeneral: null,
      notifyGroups: false,
      quietMode: 'OFF',
      quietStart: null,
      quietEnd: null,
      timeZone: null,
    });
    const at = new Date('2026-10-09T12:00:00Z');
    expect(
      shouldNotify(prefs, { folder: 'GROUPS', notifications: 'DEFAULT', state: 'ACTIVE' }, at),
    ).toBe(false);
    expect(
      shouldNotify(prefs, { folder: 'GROUPS', notifications: 'ON', state: 'ACTIVE' }, at),
    ).toBe(true);
    expect(
      shouldNotify(prefs, { folder: 'PRIMARY', notifications: 'OFF', state: 'ACTIVE' }, at),
    ).toBe(false);
    expect(
      shouldNotify(prefs, { folder: 'PRIMARY', notifications: 'DEFAULT', state: 'DECLINED' }, at),
    ).toBe(false);
  });

  it('group permissions: the owner hands out only what the admin panel lets them delegate', () => {
    expect(roleFor('RENAME', {}, ['RENAME'])).toBe('ADMIN');
    expect(roleFor('RENAME', { RENAME: 'MEMBER' }, ['RENAME'])).toBe('MEMBER');
    expect(roleFor('RENAME', { RENAME: 'MEMBER' }, [])).toBe('OWNER');
    expect(mayDo('SUB_ADMIN', 'ADD_PEOPLE', {}, ['ADD_PEOPLE'])).toBe(true);
    expect(mayDo('MEMBER', 'ADD_PEOPLE', {}, ['ADD_PEOPLE'])).toBe(false);
    expect(outranks('ADMIN', 'ADMIN')).toBe(false);
    expect(outranks('OWNER', 'ADMIN')).toBe(true);
  });

  it('members can text unless the group says no or they are timed out; admins always can', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    expect(mayText('MEMBER', true, null, now)).toBe(true);
    expect(mayText('MEMBER', false, null, now)).toBe(false);
    expect(mayText('SUB_ADMIN', false, null, now)).toBe(true);
    expect(mayText('ADMIN', true, new Date('2026-10-09T13:00:00Z'), now)).toBe(false);
  });
});

describe('Module 5: rewards for adverts and gifts', () => {
  it('FIXED pays the amount every time; 0 pays nothing', () => {
    expect(rewardFor({ mode: 'FIXED', amount: 7, everyUsd: '1' }, '0.01')).toBe(7);
    expect(rewardFor({ mode: 'FIXED', amount: 0, everyUsd: '1' }, '500')).toBe(0);
  });

  it('DYNAMIC pays per every-x-USD step, rounded down, with no floor of 1 (FR-108, V2-25)', () => {
    const rule = { mode: 'DYNAMIC' as const, amount: 2, everyUsd: '10' };
    expect(rewardFor(rule, '35')).toBe(6);
    expect(rewardFor(rule, '3')).toBe(0);
    expect(
      rewardsFor({ exp: rule, currency: { mode: 'FIXED', amount: 1, everyUsd: '1' } }, '20'),
    ).toEqual({
      exp: 4,
      currency: 0,
    });
  });
});
