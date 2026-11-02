import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ChatPorts, RegistrationCountryProvider } from '../../src/social/chat/chat.ports';
import { TestProviders } from '../../src/social/chat/chat.test-providers';

/**
 * The test-only stand-ins (NEW-2) answer only when all three hold: the chat setting is on, the environment
 * allows it, and NODE_ENV is not production. Anything else leaves every fact "not connected".
 */
const USER = '0192f6a0-0000-7000-8000-00000000aa01';

function make(opts: { settingOn: boolean; row?: Record<string, unknown> | null }) {
  const records = {
    testEntitlement: vi.fn(async () =>
      opts.row === undefined
        ? {
            premiumPlanIds: ['plan-1'],
            kycLevel: 2,
            isSiteOwner: true,
            level: 7,
            onCasino: true,
            wagerUsd: new Prisma.Decimal('1250.5'),
          }
        : opts.row,
    ),
  };
  const settings = { global: vi.fn(async () => ({ testProviders: { enabled: opts.settingOn } })) };
  const providers = new TestProviders(records as never, settings as never);
  const country = { effectiveCountry: vi.fn(async () => 'IN') };
  const ports = new ChatPorts(providers, country as unknown as RegistrationCountryProvider);
  return { providers, ports, records };
}

const saved = { allow: process.env.CHAT_ALLOW_TEST_PROVIDERS, env: process.env.NODE_ENV };
beforeEach(() => {
  process.env.CHAT_ALLOW_TEST_PROVIDERS = 'true';
  process.env.NODE_ENV = 'development';
});
afterEach(() => {
  if (saved.allow === undefined) delete process.env.CHAT_ALLOW_TEST_PROVIDERS;
  else process.env.CHAT_ALLOW_TEST_PROVIDERS = saved.allow;
  process.env.NODE_ENV = saved.env;
});

describe('when the stand-ins answer', () => {
  it('needs the setting, the environment switch and a non-production NODE_ENV', async () => {
    expect(await make({ settingOn: true }).providers.standInsActive()).toBe(true);
    expect(await make({ settingOn: false }).providers.standInsActive()).toBe(false);

    process.env.CHAT_ALLOW_TEST_PROVIDERS = 'false';
    expect(await make({ settingOn: true }).providers.standInsActive()).toBe(false);

    process.env.CHAT_ALLOW_TEST_PROVIDERS = 'true';
    process.env.NODE_ENV = 'production';
    expect(await make({ settingOn: true }).providers.standInsActive()).toBe(false);
  });
});

describe('what a stand-in says about a user', () => {
  it('gives the stored facts', async () => {
    const { ports } = make({ settingOn: true });
    expect(await ports.facts(USER)).toMatchObject({
      country: 'IN',
      premiumPlanIds: ['plan-1'],
      kycLevel: 2,
      isSiteOwner: true,
      level: 7,
      kycEntitlements: null,
    });
    expect(await ports.casinoFacts(USER, 30)).toEqual({
      onCasino: true,
      wagerUsd: '1250.50000000',
    });
  });

  it('treats a user with no row as having nothing (not as not connected)', async () => {
    const { ports } = make({ settingOn: true, row: null });
    expect(await ports.facts(USER)).toMatchObject({
      premiumPlanIds: [],
      kycLevel: 0,
      isSiteOwner: false,
      level: 0,
    });
    expect(await ports.casinoFacts(USER, 30)).toEqual({ onCasino: false, wagerUsd: '0' });
  });

  it('answers "not connected" when the stand-ins are off and no real module is bound', async () => {
    const { ports, records } = make({ settingOn: false });
    expect(await ports.facts(USER)).toMatchObject({
      country: 'IN',
      premiumPlanIds: null,
      kycLevel: null,
      isSiteOwner: null,
      level: null,
    });
    expect(await ports.casinoFacts(USER, 30)).toBeNull();
    expect(records.testEntitlement).not.toHaveBeenCalled();
  });
});

it('loads thousands of account zones in one batched port call and reuses the short cache', async () => {
  const providers = new TestProviders(
    { testEntitlement: vi.fn(async () => null) } as never,
    { global: vi.fn(async () => ({ testProviders: { enabled: false } })) } as never,
  );
  const country = { effectiveCountry: vi.fn(async () => null) } as unknown as RegistrationCountryProvider;
  const ids = Array.from({ length: 5_000 }, (_, i) => `user-${i}`);
  const zones = {
    timeZones: vi.fn(async (userIds: readonly string[]) => new Map(userIds.map((id) => [id, 'UTC']))),
  };
  const ports = new ChatPorts(
    providers,
    country,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    zones,
  );

  const first = await ports.accountTimeZones(ids);
  const second = await ports.accountTimeZones(ids);
  expect(zones.timeZones).toHaveBeenCalledTimes(1);
  expect(zones.timeZones.mock.calls[0]?.[0]).toHaveLength(5_000);
  expect(first.get('user-4999')).toBe('UTC');
  expect(second.size).toBe(5_000);
});
