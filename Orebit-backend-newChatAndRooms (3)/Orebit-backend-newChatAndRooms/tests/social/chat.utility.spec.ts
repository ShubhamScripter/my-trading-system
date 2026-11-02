import { describe, expect, it } from 'vitest';
import { USERNAME } from '../../auth/auth.constants';
import {
  RoomAccessSchema,
  RoomConfigSchema,
  type RoomAccess,
  type RoomConfig,
  type RoomType,
  type StaffRole,
} from '../../src/social/chat/chat.contract';
import {
  DEFAULT_CHAT_SETTINGS,
  type ChatSettings,
} from '../../src/social/chat/chat.settings.contract';
import { ANONYMOUS_AUTHOR_ID, GLOBAL_ROOM_ID } from '../../src/social/chat/chat.constants';
import type { EligibilityFacts, MessageRow, RoomRecord } from '../../src/social/chat/chat.types';
import {
  bannedWordMatcher,
  clientIp,
  containsEmoji,
  cutDecimal,
  decodeCursor,
  encodeCursor,
  extractTaggedUsernames,
  findLinks,
  hostAllowed,
  isAllowedGifUrl,
  isChatMediaUrl,
  normalizeContent,
  normalizeRoomRef,
  toDisplayUsd,
  toPublicMessage,
} from '../../src/social/chat/chat.utility';
import { evaluateRoomAccess } from '../../src/social/chat/services/chat.access.rules';

const SETTINGS = DEFAULT_CHAT_SETTINGS as unknown as ChatSettings;

function room(
  type: RoomType,
  access: Partial<RoomAccess> = {},
  config: Partial<RoomConfig> = {},
  extra: Partial<RoomRecord> = {},
): RoomRecord {
  return {
    id: `room-${type.toLowerCase()}`,
    slug: type.toLowerCase(),
    name: type,
    description: null,
    type,
    createdAt: new Date(0),
    config: RoomConfigSchema.parse(config),
    access: RoomAccessSchema.parse(access),
    regionCountries: null,
    fingerprint: '',
    ...extra,
  };
}

function facts(overrides: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return {
    staffRole: null,
    country: null,
    premiumPlanIds: null,
    kycLevel: null,
    kycEntitlements: null,
    isSiteOwner: null,
    level: null,
    casino: null,
    excludedRoomIds: new Set(),
    includedRoomIds: new Set(),
    staffRoomBlocked: false,
    ...overrides,
  };
}

const staff = (role: StaffRole) => facts({ staffRole: role });
const settingsWith = (patch: Partial<Record<keyof ChatSettings, object>>): ChatSettings => {
  const out = structuredClone(SETTINGS) as unknown as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(patch))
    out[key] = { ...out[key], ...(value as object) };
  return out as unknown as ChatSettings;
};

type Expect = { mode: string; view: boolean; write: boolean; listed: boolean };

/**
 * Every rule of evaluateRoomAccess has a row. Deleting any single `if` fails at least one row.
 */
const MATRIX: [string, EligibilityFacts, RoomRecord, ChatSettings, Expect][] = [
  [
    'global, anyone',
    facts(),
    room('GLOBAL'),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'room OFF is hidden from everyone',
    staff('ADMIN'),
    room('GLOBAL', {}, { status: 'DISABLED' }),
    SETTINGS,
    { mode: 'LOCKED', view: false, write: false, listed: false },
  ],
  [
    'maintenance: eligible user reads with the banner',
    facts(),
    room('GLOBAL', {}, { status: 'MAINTENANCE' }),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'maintenance: staff keep writing',
    staff('MODERATOR'),
    room('GLOBAL', {}, { status: 'MAINTENANCE' }),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'staff room: user never sees it',
    facts(),
    room('STAFF'),
    SETTINGS,
    { mode: 'LOCKED', view: false, write: false, listed: false },
  ],
  [
    'staff room in maintenance stays hidden',
    facts(),
    room('STAFF', {}, { status: 'MAINTENANCE' }),
    SETTINGS,
    { mode: 'LOCKED', view: false, write: false, listed: false },
  ],
  [
    'staff room: moderator writes',
    staff('MODERATOR'),
    room('STAFF'),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'staff room: support enters (until Module 4)',
    staff('SUPPORT'),
    room('STAFF'),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'SO room: not a site owner, hidden by the SO default',
    facts({ isSiteOwner: false }),
    room('SO', { ineligibleMode: 'HIDE' }),
    SETTINGS,
    { mode: 'LOCKED', view: false, write: false, listed: false },
  ],
  [
    'SO room: site owner writes',
    facts({ isSiteOwner: true }),
    room('SO'),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'SO room: excluded site owner refused',
    facts({ isSiteOwner: true, excludedRoomIds: new Set(['room-so']) }),
    room('SO'),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'SO room: moderator reads to moderate',
    staff('MODERATOR'),
    room('SO', { ineligibleMode: 'HIDE' }),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'SO room switched off in settings',
    facts({ isSiteOwner: true }),
    room('SO'),
    settingsWith({ rooms: { siteOwnerRoom: false } }),
    { mode: 'LOCKED', view: false, write: false, listed: false },
  ],
  [
    'premium room, Premium not connected: closed',
    facts(),
    room('PREMIUM'),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'premium room, any active plan',
    facts({ premiumPlanIds: ['p1'] }),
    room('PREMIUM'),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'plan-bound room admits only its plans',
    facts({ premiumPlanIds: ['p1'] }),
    room('PREMIUM', { allowedPlanIds: ['p2'] }),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'per-plan rooms switched off',
    facts({ premiumPlanIds: ['p2'] }),
    room('PREMIUM', { allowedPlanIds: ['p2'] }),
    settingsWith({ rooms: { premiumPerPlan: false } }),
    { mode: 'LOCKED', view: false, write: false, listed: false },
  ],
  [
    "slug containing 'vip' is not gated",
    facts(),
    room('GLOBAL', {}, {}, { slug: 'vipassana' }),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'KYC room, KYC not connected: closed',
    facts(),
    room('KYC'),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'KYC L1 user in an L2 room reads',
    facts({ kycLevel: 1 }),
    room('KYC', { minKycLevel: 2 }),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'KYC L2 user in an L2 room writes',
    facts({ kycLevel: 2 }),
    room('KYC', { minKycLevel: 2 }),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'country room: other country reads',
    facts({ country: 'US' }),
    room('COUNTRY', { allowedCountries: ['IN'] }),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'country room: own country writes',
    facts({ country: 'IN' }),
    room('COUNTRY', { allowedCountries: ['IN'] }),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'country room: hidden from outsiders',
    facts({ country: 'US' }),
    room('COUNTRY', { allowedCountries: ['IN'], ineligibleMode: 'HIDE' }),
    SETTINGS,
    { mode: 'LOCKED', view: false, write: false, listed: false },
  ],
  [
    'promo-only outsiders',
    facts({ country: 'US' }),
    room('COUNTRY', { allowedCountries: ['IN'], ineligibleMode: 'PROMO_ONLY' }),
    SETTINGS,
    { mode: 'PROMO_ONLY', view: true, write: false, listed: true },
  ],
  [
    'country rooms switched off',
    facts({ country: 'IN' }),
    room('COUNTRY', { allowedCountries: ['IN'] }),
    settingsWith({ rooms: { byCountry: false } }),
    { mode: 'LOCKED', view: false, write: false, listed: false },
  ],
  [
    'region room uses its region countries',
    facts({ country: 'AE' }),
    room('REGION', { allowedCountries: ['IN'] }, {}, { regionCountries: ['AE', 'SA'] }),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'India premium variant: region premium rooms off',
    facts({ country: 'IN', premiumPlanIds: ['p'] }),
    room('COUNTRY', { allowedCountries: ['IN'], requirePremium: true }),
    settingsWith({ rooms: { regionPremiumRooms: false } }),
    { mode: 'LOCKED', view: false, write: false, listed: false },
  ],
  [
    'minimum level, level unknown: reads only',
    facts(),
    room('GLOBAL', { minLevel: 5 }),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'global minimum level from settings',
    facts({ level: 3 }),
    room('GLOBAL'),
    settingsWith({ minLevel: { global: 5 } }),
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'visibility PREMIUM: others do not see it',
    facts(),
    room('GLOBAL', { visibility: { groups: ['PREMIUM'], minLevel: 0 } }),
    SETTINGS,
    { mode: 'LOCKED', view: false, write: false, listed: false },
  ],
  [
    'visibility LVL>50: level 60 sees it',
    facts({ level: 60 }),
    room('GLOBAL', { visibility: { groups: [], minLevel: 50 } }),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'casino: not on the casino reads',
    facts({ casino: { onCasino: false, wagerUsd: '100' } }),
    room('CASINO', { minWagerUsd: '10' }, { casino: { onlyUsersOnCasino: true } }),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'casino: on the casino, wager under the minimum',
    facts({ casino: { onCasino: true, wagerUsd: '9.99' } }),
    room('CASINO', { minWagerUsd: '10' }, { casino: { onlyUsersOnCasino: true } }),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'casino: on the casino above the minimum',
    facts({ casino: { onCasino: true, wagerUsd: '10' } }),
    room('CASINO', { minWagerUsd: '10' }, { casino: { onlyUsersOnCasino: true } }),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'casino: switch off ignores the wager',
    facts({ casino: { onCasino: true, wagerUsd: '0' } }),
    room('CASINO', { minWagerUsd: '10' }, { casino: { onlyUsersOnCasino: false } }),
    SETTINGS,
    { mode: 'FULL_ACCESS', view: true, write: true, listed: true },
  ],
  [
    'casino: Casino not connected, closed',
    facts(),
    room('CASINO'),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'KYC entitlements: public chat off',
    facts({ kycLevel: 0, kycEntitlements: { publicChat: false, roomIds: null } }),
    room('GLOBAL'),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
  [
    'KYC entitlements: allowed-rooms list limits entry',
    facts({ kycLevel: 1, kycEntitlements: { publicChat: true, roomIds: ['other'] } }),
    room('GLOBAL'),
    SETTINGS,
    { mode: 'VIEW_ONLY', view: true, write: false, listed: true },
  ],
];

describe('evaluateRoomAccess', () => {
  it.each(MATRIX)('%s', (_name, f, r, s, want) => {
    const got = evaluateRoomAccess(f, r, s);
    expect({
      mode: got.accessMode,
      view: got.isEligibleToView,
      write: got.isEligibleToWrite,
      listed: got.isListed,
    }).toEqual(want);
  });

  it('promo-only viewers receive no user messages', () => {
    const got = evaluateRoomAccess(
      facts({ country: 'US' }),
      room('COUNTRY', { allowedCountries: ['IN'], ineligibleMode: 'PROMO_ONLY' }),
      SETTINGS,
    );
    expect(got.receivesUserMessages).toBe(false);
  });

  it('tells the app what a locked room requires', () => {
    expect(
      evaluateRoomAccess(
        facts({ premiumPlanIds: [] }),
        room('PREMIUM', { allowedPlanIds: ['gold'] }),
        SETTINGS,
      ).requirement,
    ).toEqual({ kind: 'PREMIUM', planIds: ['gold'] });
    expect(
      evaluateRoomAccess(facts({ kycLevel: 1 }), room('KYC', { minKycLevel: 2 }), SETTINGS)
        .requirement,
    ).toEqual({ kind: 'KYC', minLevel: 2 });
    const casino = evaluateRoomAccess(
      facts({ casino: { onCasino: true, wagerUsd: '1' } }),
      room('CASINO', { minWagerUsd: '10.99' }, { casino: { onlyUsersOnCasino: true } }),
      SETTINGS,
    );
    expect(casino.requirement).toEqual({
      kind: 'CASINO',
      onCasino: true,
      minWagerUsd: '10.99',
      windowDays: 30,
    });
    expect(casino.casinoConditions).not.toHaveProperty('isAccountVerified');
  });

  it('maintenance carries the note and end time', () => {
    const got = evaluateRoomAccess(
      facts(),
      room(
        'GLOBAL',
        {},
        {
          status: 'MAINTENANCE',
          statusNote: 'Upgrading media',
          statusUntil: '2026-10-01T10:00:00Z',
        },
      ),
      SETTINGS,
    );
    expect(got.maintenance).toEqual({ note: 'Upgrading media', until: '2026-10-01T10:00:00Z' });
  });
});

describe('toPublicMessage', () => {
  const base: MessageRow = {
    id: 'm1',
    roomId: 'r1',
    userId: 'author',
    content: 'secret',
    type: 'MEDIA',
    metadata: { anonymous: true, media: { type: 'image', url: 'https://x/y' } },
    createdAt: new Date('2026-09-01T00:00:00Z'),
    createdAtText: '2026-09-01T00:00:00.000000Z',
    retractedAt: null,
    pinnedAt: null,
    authorUsername: 'ada',
    skin: null,
  };
  const retracted = { ...base, retractedAt: new Date() };

  it.each([
    [
      'non-staff sees an anonymous author as Anonymous',
      base,
      { userId: 'x', isStaff: false },
      { userId: ANONYMOUS_AUTHOR_ID, username: 'Anonymous' },
    ],
    [
      'staff see the real author',
      base,
      { userId: 'x', isStaff: true },
      { userId: 'author', username: 'ada' },
    ],
    [
      'the author sees themselves',
      base,
      { userId: 'author', isStaff: false },
      { userId: 'author', username: 'ada' },
    ],
  ] as const)('%s', (_n, row, viewer, want) => {
    expect(toPublicMessage(row, viewer)).toMatchObject(want);
  });

  it('a retracted message reaches others without content or media', () => {
    expect(toPublicMessage(retracted, { userId: 'x', isStaff: false })).toEqual({
      id: 'm1',
      roomId: 'r1',
      createdAt: '2026-09-01T00:00:00.000Z',
      isRetracted: true,
    });
  });

  it('staff and the author still see a retracted message, flagged', () => {
    expect(toPublicMessage(retracted, { userId: 'x', isStaff: true })).toMatchObject({
      content: 'secret',
      isRetracted: true,
    });
    expect(toPublicMessage(retracted, { userId: 'author', isStaff: false })).toMatchObject({
      content: 'secret',
      isRetracted: true,
    });
  });

  it('alerts show the system name and never an actor id', () => {
    const alert = toPublicMessage(
      { ...base, type: 'SYSTEM_ALERT', metadata: { alertType: 'LEVEL_UP' } },
      { userId: 'x', isStaff: false },
    );
    expect(alert).toMatchObject({ username: 'OREBiT', alertType: 'LEVEL_UP' });
    expect(JSON.stringify(alert)).not.toMatch(/retractedBy|pinnedBy|cost/);
  });

  it('shows a deleted-user label when the author account has been purged', () => {
    const deletedAuthor = { ...base, metadata: {}, authorUsername: null };
    expect(toPublicMessage(deletedAuthor, { userId: 'x', isStaff: false })).toMatchObject({
      userId: 'author',
      username: 'Deleted user',
    });
  });
});

describe('cursors', () => {
  it('round-trips microsecond database time', () => {
    const cursor = {
      createdAt: '2026-09-28T10:00:00.123456Z',
      id: '0192f6a0-0000-7000-8000-000000000001',
    };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('refuses a cursor it did not issue with validation_failed', () => {
    expect(() => decodeCursor('bm90LWEtY3Vyc29y')).toThrow(
      expect.objectContaining({ type: 'validation_failed' }),
    );
  });
});

describe('room references', () => {
  it('resolves global, lower-cases UUIDs and never treats a display name as special', () => {
    expect(normalizeRoomRef('global')).toEqual({ kind: 'id', value: GLOBAL_ROOM_ID });
    expect(normalizeRoomRef('0192F6A0-0000-7000-8000-00000000000A')).toEqual({
      kind: 'id',
      value: '0192f6a0-0000-7000-8000-00000000000a',
    });
    expect(normalizeRoomRef('India-Hub')).toEqual({ kind: 'slug', value: 'india-hub' });
  });
});

describe('text', () => {
  it('stores text as typed: no HTML escaping', () => {
    expect(normalizeContent("  don't <3 \n\n\n\nok ")).toBe("don't <3 \n\nok");
  });

  it('tags whole usernames only', () => {
    expect(extractTaggedUsernames('hi @bobby and @bob, mail a@bob.com')).toEqual(['bobby', 'bob']);
    expect(extractTaggedUsernames(`@${'a'.repeat(USERNAME.MAX_LENGTH)}`)).toEqual([
      'a'.repeat(USERNAME.MAX_LENGTH),
    ]);
    expect(extractTaggedUsernames(`@${'a'.repeat(USERNAME.MAX_LENGTH + 1)}`)).toEqual([]);
  });
});

describe('links', () => {
  const allowed = ['orebit.io'];
  const blocked = (text: string) => findLinks(text).filter((l) => !hostAllowed(l.host, allowed));

  it('checks the exact host, not a word in the address', () => {
    expect(blocked('see https://orebit.evil.example/x')).toHaveLength(1);
    expect(blocked('see https://evil.example/?orebit')).toHaveLength(1);
    expect(blocked('see https://orebit.io/x and https://app.orebit.io')).toHaveLength(0);
  });

  it('bare domains count as links only with a real TLD, and are marked bare', () => {
    expect(findLinks('evil.com.')).toEqual([{ host: 'evil.com', bare: true }]);
    expect(findLinks('node.js e.g. v1.2 and 1.5')).toEqual([]);
    expect(findLinks('orebit-support.xyz')[0]).toMatchObject({
      host: 'orebit-support.xyz',
      bare: true,
    });
  });
});

describe('banned words', () => {
  it('matches case-insensitively as a whole word in any script', () => {
    const m = bannedWordMatcher(['Pink Flower', 'बुरा', '坏蛋'])!;
    expect(m.test('a PINK flower here')).toBe(true);
    expect(m.test('pinkflowers')).toBe(false);
    expect(m.test('वह बुरा है')).toBe(true);
    expect(m.test('बुराई')).toBe(false);
    expect(m.test('你是坏蛋吗')).toBe(true);
  });

  it('catches a phrase however its words are spaced, in the list and in the message (FR-175)', () => {
    const m = bannedWordMatcher(['free money', '  big   win  '])!;
    expect(m.test('get free  money now')).toBe(true);
    expect(m.test('get free\tmoney now')).toBe(true);
    expect(m.test('get free\n\nmoney now')).toBe(true);
    expect(m.test('a BIG win today')).toBe(true);
    // Still whole words: a longer word or a different phrase is not caught.
    expect(m.test('freemoney')).toBe(false);
    expect(m.test('free moneyline')).toBe(false);
    expect(bannedWordMatcher(['sex'])!.test('sexy')).toBe(false);
  });

  it('compiles one matcher per word list', () => {
    expect(bannedWordMatcher(['a', 'b'])).toBe(bannedWordMatcher(['a', 'b']));
  });
});

describe('emoji', () => {
  it('counts pictographs but not © ® ™', () => {
    expect(containsEmoji('nice ⭐')).toBe(true);
    expect(containsEmoji('© ® ™ 123 #')).toBe(false);
  });
});

describe('media URLs (NEW-3)', () => {
  it('accepts only https GIFs of the chosen provider', () => {
    expect(isAllowedGifUrl('https://media.tenor.com/x.gif', 'TENOR')).toBe(true);
    expect(isAllowedGifUrl('https://media.giphy.com/x.gif', 'TENOR')).toBe(false);
    expect(isAllowedGifUrl('https://media2.giphy.com/x.gif', 'GIPHY')).toBe(true);
    expect(isAllowedGifUrl('http://media.tenor.com/x.gif', 'TENOR')).toBe(false);
    expect(isAllowedGifUrl('javascript:alert(1)', 'TENOR')).toBe(false);
  });

  it('accepts images only from the chat media route', () => {
    const base = 'https://api.orebit.io';
    expect(
      isChatMediaUrl(
        'https://api.orebit.io/social/chat/media/0192f6a0-0000-7000-8000-000000000001',
        base,
      ),
    ).toBe(true);
    expect(
      isChatMediaUrl(
        'https://evil.example/social/chat/media/0192f6a0-0000-7000-8000-000000000001',
        base,
      ),
    ).toBe(false);
    expect(isChatMediaUrl('data:image/png;base64,AAA', base)).toBe(false);
  });
});

describe('money', () => {
  it('cuts, never rounds', () => {
    expect(toDisplayUsd('9.999')).toBe('9.99');
    expect(toDisplayUsd('10')).toBe('10.00');
    expect(cutDecimal('0.123456789', 8)).toBe('0.12345678');
  });
});

describe('client IP', () => {
  it('walks X-Forwarded-For from the right, past trusted proxies only', () => {
    expect(clientIp('1.1.1.1, 10.0.0.2', '10.0.0.1', ['10.0.0.0/8'])).toBe('1.1.1.1');
    expect(clientIp('9.9.9.9', '1.2.3.4', ['10.0.0.0/8'])).toBe('1.2.3.4');
    expect(clientIp(undefined, '::ffff:5.6.7.8', [])).toBe('5.6.7.8');
  });
});
