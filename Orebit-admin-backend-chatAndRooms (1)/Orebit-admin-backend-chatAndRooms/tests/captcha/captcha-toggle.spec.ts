import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptchaAdminController } from '../../src/captcha/captcha.controller';
import { CaptchaRoutes } from '../../src/captcha/captcha.routes';
import { CaptchaSettingsService } from '../../src/captcha/captcha.settings';
import { ERR, PROBLEM_CATALOGUE } from '../../src/contracts';

/**
 * ═══ THE OPERATOR SURFACE FOR THE CAPTCHA TOGGLE ═══════════════════════════
 *
 * `GET /captcha/providers` answers "which are on, which are off, and why".
 * `POST /captcha/providers` changes one.
 *
 * The property this file exists for is the write-time refusal. The read path already
 * ignores a table that disables everything, so nothing here can produce an outage —
 * but "ignored" means an operator disables the last provider, gets a 200, and the
 * system quietly keeps using it. Refusing the WRITE is what makes the system tell
 * them, and that is the difference this suite protects.
 */

/**
 * Only `captchaProviders` is overridden; the rest of config is passed through with
 * `importActual`. Replacing the module wholesale does not work here — importing
 * `CaptchaRoutes` pulls in security/guards.ts -> session.service -> jwt.ts, which
 * reads `config.JWT_PRIVATE_KEY` at module load and refuses to load without a real
 * one. tests/setup.ts supplies that; this file only needs a provider set to narrow.
 *
 * Only three of the four are configured. HCAPTCHA has no secret, which is what lets
 * this file assert that "not configured" and "disabled" stay distinct answers.
 */
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    captchaProviders: [
      { provider: 'TURNSTILE', siteKey: 'site-turnstile' },
      { provider: 'RECAPTCHA_V2', siteKey: 'site-v2' },
      { provider: 'RECAPTCHA_V3', siteKey: 'site-v3' },
    ] as { provider: string; siteKey: string }[],
  },
}));

vi.mock('../../src/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/config')>('../../src/config');
  return {
    ...actual,
    config: { ...actual.config, captchaProviders: mockConfig.captchaProviders },
  };
});

const ENV_SET = [...mockConfig.captchaProviders];
const ACTOR = { adminId: 'admin-1', sessionId: 'session-1' } as never;

interface Row {
  provider: string;
  enabled: boolean;
  reason: string | null;
  updatedByAdminId: string | null;
  updatedAt: Date;
}

/** The toggle table, as an in-memory map so a write is visible to the next read —
 *  which is the whole point of the ordering `toggle` promises. */
function makeDb(initial: readonly Row[] = []) {
  const rows = new Map(initial.map((r) => [r.provider, { ...r }]));
  return {
    rows,
    list: vi.fn(async () => [...rows.values()].sort((a, b) => a.provider.localeCompare(b.provider))),
    disabled: vi.fn(async () =>
      [...rows.values()].filter((r) => !r.enabled).map((r) => r.provider),
    ),
    setEnabled: vi.fn(async (input: Omit<Row, 'updatedAt'>) => {
      const row = { ...input, updatedAt: new Date('2026-09-02T00:00:00Z') };
      rows.set(input.provider, row);
      return row;
    }),
  };
}

function makeSettings(db: ReturnType<typeof makeDb>) {
  return new CaptchaSettingsService(db as never);
}

/** The controller, which is where the behaviour is. `CaptchaRoutes` only resolves
 *  the principal off the request and delegates, so it is exercised separately below
 *  for the thing it actually owns: which guards it declares. */
function makeController(db: ReturnType<typeof makeDb>) {
  return new CaptchaAdminController(makeSettings(db));
}

const row = (provider: string, enabled: boolean, reason: string | null = null): Row => ({
  provider,
  enabled,
  reason,
  updatedByAdminId: null,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
});

beforeEach(() => {
  mockConfig.captchaProviders = [...ENV_SET];
  vi.restoreAllMocks();
});

describe('GET /captcha/providers', () => {
  it('lists every provider, including ones with no secret and no row', async () => {
    const { data } = await makeController(makeDb()).list();

    // All four, not just the three configured: an operator trying to turn HCAPTCHA on
    // has to be able to see that it is missing a secret, and a list of what already
    // exists could not tell them.
    expect(data.providers.map((p) => p.provider)).toEqual([
      'TURNSTILE',
      'RECAPTCHA_V2',
      'RECAPTCHA_V3',
      'HCAPTCHA',
    ]);
  });

  it('keeps "not configured" and "disabled" as separate answers', async () => {
    const { data } = await makeController(makeDb([row('TURNSTILE', false, 'vendor incident')])).list();
    const byName = Object.fromEntries(data.providers.map((p) => [p.provider, p]));

    // Off because an operator said so. Fixable from this API.
    expect(byName['TURNSTILE']).toMatchObject({
      configured: true,
      disabled: true,
      live: false,
      reason: 'vendor incident',
      siteKey: 'site-turnstile',
    });

    // Off because there is no secret. NOT fixable from this API — the database can
    // only ever subtract — and collapsing the two into one "off" would tell an
    // operator to look in the wrong place.
    expect(byName['HCAPTCHA']).toMatchObject({
      configured: false,
      disabled: false,
      live: false,
      reason: null,
      siteKey: null,
    });
  });

  it('reads the table rather than the cached snapshot', async () => {
    // An operator must see their own write, not whatever this instance last cached.
    const db = makeDb();
    const controller = makeController(db);

    await controller.list();
    expect(db.list).toHaveBeenCalled();
  });

  it('states how long a change takes to reach every instance', async () => {
    const { data } = await makeController(makeDb()).list();

    // In the payload rather than the docs, because "I disabled it, why is it still
    // being offered" is the next question and a screen that cannot answer it invites
    // a second write.
    expect(data.propagationSeconds).toBe(300);
  });
});

describe('POST /captcha/providers', () => {
  it('disables a provider and returns the table as it now stands', async () => {
    const db = makeDb();
    const { data } = await makeController(db).toggle(
      { provider: 'RECAPTCHA_V2', enabled: false, reason: 'vendor incident' },
      ACTOR,
    );

    expect(db.setEnabled).toHaveBeenCalledWith({
      provider: 'RECAPTCHA_V2',
      enabled: false,
      reason: 'vendor incident',
      // From the principal, never the body.
      actorAdminId: 'admin-1',
    });
    expect(data.providers.find((p) => p.provider === 'RECAPTCHA_V2')?.live).toBe(false);
    expect(data.providers.find((p) => p.provider === 'TURNSTILE')?.live).toBe(true);
  });

  it('re-enables by writing the row back, not by deleting it', async () => {
    const db = makeDb([row('RECAPTCHA_V2', false, 'vendor incident')]);
    const { data } = await makeController(db).toggle(
      { provider: 'RECAPTCHA_V2', enabled: true },
      ACTOR,
    );

    expect(data.providers.find((p) => p.provider === 'RECAPTCHA_V2')).toMatchObject({
      live: true,
      disabled: false,
      // Cleared with the toggle: a stale "vendor incident" on a provider that is now
      // live would be worse than no reason at all.
      reason: null,
    });
  });

  it('refreshes this instance immediately, so the sign-in path is current', async () => {
    const db = makeDb();
    const settings = makeSettings(db);
    await settings.refresh();
    expect(settings.live().map((o) => o.provider)).toEqual([
      'TURNSTILE',
      'RECAPTCHA_V2',
      'RECAPTCHA_V3',
    ]);

    await settings.toggle({
      provider: 'RECAPTCHA_V2',
      enabled: false,
      reason: 'vendor incident',
      actorAdminId: 'admin-1',
    });

    // Without this the operator's own instance would keep accepting a provider they
    // just withdrew, for up to a full refresh interval.
    expect(settings.live().map((o) => o.provider)).toEqual(['TURNSTILE', 'RECAPTCHA_V3']);
  });
});

describe('the anti-lockout rule, at the write', () => {
  /** Everything off except `keep`. */
  function allDisabledExcept(keep: string) {
    return makeDb(
      ENV_SET.filter((o) => o.provider !== keep).map((o) => row(o.provider, false, 'testing')),
    );
  }

  it('refuses to disable the last live provider', async () => {
    const db = allDisabledExcept('TURNSTILE');
    vi.spyOn(Logger.prototype, 'warn').mockReturnValue(undefined);

    await expect(
      makeController(db).toggle({ provider: 'TURNSTILE', enabled: false, reason: 'testing' }, ACTOR),
    ).rejects.toMatchObject({ type: ERR.CAPTCHA_LAST_PROVIDER });

    // ═══ AND NOTHING WAS WRITTEN ═════════════════════════════════════════════
    //
    // The refusal is before the write, not a rollback after it. A row that lands and
    // is then ignored by the read path is the silent failure this whole rule exists
    // to turn into a visible one.
    expect(db.setEnabled).not.toHaveBeenCalled();
  });

  it('answers 409 rather than a validation error', async () => {
    // Nothing about the request was malformed — it was denied on policy, and the
    // status has to say which so a client does not render it as a bad field.
    expect(PROBLEM_CATALOGUE[ERR.CAPTCHA_LAST_PROVIDER].status).toBe(409);
  });

  it('allows disabling the second-to-last one', async () => {
    const db = makeDb([row('RECAPTCHA_V3', false, 'testing')]);

    await expect(
      makeController(db).toggle({ provider: 'RECAPTCHA_V2', enabled: false, reason: 'testing' }, ACTOR),
    ).resolves.toBeDefined();
  });

  it('allows disabling a provider that was never live anyway', async () => {
    // HCAPTCHA has no secret, so it is not a candidate to be "the last one" — turning
    // it off changes nothing and refusing would be a rule with no purpose behind it.
    const db = allDisabledExcept('TURNSTILE');

    await expect(
      makeController(db).toggle({ provider: 'HCAPTCHA', enabled: false, reason: 'testing' }, ACTOR),
    ).resolves.toBeDefined();
  });

  it('never blocks an ENABLE, however many are already off', async () => {
    const db = makeDb(ENV_SET.map((o) => row(o.provider, false, 'testing')));

    // The way out of a table that disabled everything has to stay open.
    await expect(
      makeController(db).toggle({ provider: 'TURNSTILE', enabled: true }, ACTOR),
    ).resolves.toBeDefined();
  });

  it('decides on the database, not on the possibly-stale snapshot', async () => {
    const db = allDisabledExcept('TURNSTILE');
    const settings = makeSettings(db);

    // This instance last refreshed when everything was still live, so its snapshot
    // says four providers remain. Deciding from it would let this write through and
    // strand every admin — two operators toggling inside one refresh interval would
    // each see "plenty left".
    expect(settings.live()).toHaveLength(3);

    await expect(
      settings.toggle({
        provider: 'TURNSTILE',
        enabled: false,
        reason: 'testing',
        actorAdminId: 'admin-1',
      }),
    ).rejects.toMatchObject({ type: ERR.CAPTCHA_LAST_PROVIDER });
  });
});

describe('the route declares its own gates', () => {
  /**
   * ═══ THE SECURITY PROPERTY OF captcha.routes.ts IS ITS DECORATORS ══════════
   *
   * This controller checks no authorisation itself — deliberately, because the gate
   * is the same for every caller and can therefore be declared rather than
   * remembered. Which means a deleted decorator is a silent privilege escalation
   * with no failing assertion anywhere, unless there is one here.
   *
   * Read from Nest's own metadata rather than a hand-written list, for the same
   * reason app.routes.spec.ts does: a hand-written list is a second thing to forget.
   */
  const guardsOn = (handler: object): string[] =>
    ((Reflect.getMetadata('__guards__', handler) as { name: string }[] | undefined) ?? []).map(
      (g) => g.name,
    );

  it.each([
    ['list', CaptchaRoutes.prototype.list],
    ['toggle', CaptchaRoutes.prototype.toggle],
  ])('puts SuperAdminGuard on %s', (_name, handler) => {
    // The role is re-read from the DATABASE by this guard, so a demoted admin is
    // refused even while their fifteen-minute access token is still valid. Losing
    // this decorator would open platform configuration to any signed-in admin.
    expect(guardsOn(handler)).toContain('SuperAdminGuard');
  });

  it('requires NO elevation ticket, on either handler', () => {
    // ─── An assertion for an ABSENCE, which is unusual and deliberate ─────────
    //
    // The write carried `@UseGuards(ElevationGuard)` and
    // `@RequiresElevation('admin.captcha.toggle')` when first written. That was
    // reviewed and dropped as a product decision: an operator disabling a provider is
    // usually mid-incident, and making them re-prove a factor then costs more than it
    // buys.
    //
    // Asserted rather than left implicit so the requirement cannot drift back in
    // unnoticed — a re-added guard would break every client that stopped sending a
    // ticket, and the failure would surface as an opaque `reauth_required` rather
    // than as a decision someone made.
    expect(guardsOn(CaptchaRoutes.prototype.list)).toEqual(['SuperAdminGuard']);
    expect(guardsOn(CaptchaRoutes.prototype.toggle)).toEqual(['SuperAdminGuard']);
  });
});
