import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHAT_CONTRACT_VERSION,
  RoomAccessSchema,
  RoomConfigSchema,
  parseRoomConfig,
  defaultAccessFor,
} from '../../src/social/chat/chat.contract';
import {
  ChatSettingsDocumentSchema,
  applySettingsPatch,
  effectiveSettings,
} from '../../src/social/chat/chat.settings.contract';

/**
 * The chat contract: the same fixture is run by the user backend against its byte-identical copy,
 * so an admin save and what the chat server enforces cannot drift apart.
 */
interface Case {
  name: string;
  schema: 'roomConfig' | 'roomAccess' | 'settingsDocument';
  input: unknown;
  valid: boolean;
  expect?: Record<string, unknown>;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'chat-contract.fixture.json'), 'utf8'),
) as {
  contractVersion: number;
  cases: Case[];
};

const SCHEMAS = {
  roomConfig: RoomConfigSchema,
  roomAccess: RoomAccessSchema,
  settingsDocument: ChatSettingsDocumentSchema,
} as const;

describe('chat contract fixture', () => {
  it('matches the contract version', () => {
    expect(fixture.contractVersion).toBe(CHAT_CONTRACT_VERSION);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const result = SCHEMAS[testCase.schema].safeParse(testCase.input);
    expect(result.success).toBe(testCase.valid);
    if (result.success && testCase.expect) expect(result.data).toMatchObject(testCase.expect);
  });
});

describe('parseRoomConfig', () => {
  it('drops one malformed stored entry and keeps the rest', () => {
    const { config, problems } = parseRoomConfig({
      bannedWords: ['ok', 42],
      userRestrictions: [
        { targetType: 'USER', targetValue: 'bob', restriction: 'MUTE', internalReason: 'x' },
        { targetType: 'USER', restriction: 'MUTE' },
      ],
      staffRoles: { anything: true },
    });
    expect(config.bannedWords).toEqual(['ok']);
    expect(config.userRestrictions).toHaveLength(1);
    expect(problems.some((p) => p.startsWith('staffRoles'))).toBe(true);
    expect(problems.length).toBe(3);
  });

  it('reads a string config as the defaults', () => {
    expect(parseRoomConfig('broken').config.contentControls.allowImage).toBe(false);
  });
});

describe('room access defaults', () => {
  it('hides new STAFF and SO rooms from outsiders', () => {
    expect(defaultAccessFor('STAFF').ineligibleMode).toBe('HIDE');
    expect(defaultAccessFor('SO').ineligibleMode).toBe('HIDE');
    expect(defaultAccessFor('COUNTRY').ineligibleMode).toBe('VIEW_ONLY');
  });
});

describe('chat settings', () => {
  const document = ChatSettingsDocumentSchema.parse({
    global: { defaultRoom: { base: 'COUNTRY' }, minLevel: { global: 2 } },
    countries: { IN: { minLevel: { global: 7 }, rooms: { byCountry: false } } },
  });

  it('applies an India exception only to users in IN', () => {
    expect(effectiveSettings(document, 'IN').minLevel.global).toBe(7);
    expect(effectiveSettings(document, 'IN').rooms.byCountry).toBe(false);
    expect(effectiveSettings(document, 'US').minLevel.global).toBe(2);
    expect(effectiveSettings(document, null).rooms.byCountry).toBe(true);
  });

  it('keeps defaults for everything not set', () => {
    const settings = effectiveSettings(document, 'US');
    expect(settings.defaultRoom).toEqual({ base: 'COUNTRY', premiumFirst: false, kycFirst: false });
    expect(settings.media.gifProvider).toBe('TENOR');
    expect(settings.limits.connectionsPerAccount).toBe(5);
  });

  it('patches: keys replace inside a section, a null country removes its exceptions', () => {
    const next = applySettingsPatch(document, {
      global: { minLevel: { countryLanguage: 3 } },
      countries: { IN: null, US: { casino: { wagerWindowDays: 7 } } },
    });
    expect(next.global.minLevel).toEqual({ global: 2, countryLanguage: 3 });
    expect(next.countries.IN).toBeUndefined();
    expect(ChatSettingsDocumentSchema.safeParse(next).success).toBe(true);
  });
});
