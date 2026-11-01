import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../src/contracts';
import { KycRenewalService } from '../../src/kyc/kyc-renewal.service';
import { makePrincipal } from '../harness';

/**
 * The renewal-settings service against doubles.
 *
 * ═══ THE WRITE THAT CAN DE-VERIFY THE PLATFORM ═════════════════════════════
 *
 * These two numbers decide, for every account at once, whether what it already proved
 * is still current. Both ship NULL — nothing expires — and the first mandatory period
 * written here invalidates the entire back book simultaneously, with no grace period.
 *
 * ═══ AND THEY ARE THE ONLY TWO ═════════════════════════════════════════════
 *
 * The configuration is `{ mandatoryPeriodDays, voluntaryPeriodDays }` in and out. There
 * is no version, no compare-and-swap, no reason, no `renewalEnabled` and no history of
 * previous configurations — the periods themselves are the whole state, and "disabled"
 * is what NULL/NULL means rather than a flag stored beside them.
 *
 * What survives from the first cut, and is proved below: the impact is still measured
 * BEFORE the write and still lands in the audit row, and a missing singleton is still
 * reported as the deployment fault it is rather than fabricated into "renewal is off".
 */

const DAY = 24 * 60 * 60;
const ACTOR = makePrincipal({ adminId: '0195f0a0-aaaa-7000-8000-000000000001' });
const CLIENT = { ip: '203.0.113.10', userAgent: 'vitest', acceptLanguage: 'en' } as never;

const REQUEST = {
  mandatoryPeriodDays: 365,
  voluntaryPeriodDays: 330,
};

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    mandatory_period_seconds: null as number | null,
    voluntary_period_seconds: null as number | null,
    ...overrides,
  };
}

let settings: {
  read: ReturnType<typeof vi.fn>;
  impactOf: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
};
let events: { record: ReturnType<typeof vi.fn> };

function build(): KycRenewalService {
  return new KycRenewalService(settings as never, events as never);
}

beforeEach(() => {
  settings = {
    read: vi.fn(async () => storedRow()),
    impactOf: vi.fn(async () => ({ levelsAffected: 0, usersAffected: 0 })),
    write: vi.fn(async () => true),
  };
  events = { record: vi.fn(async () => undefined) };
});

// ─── the contract shape ─────────────────────────────────────────────────────

describe('the payload', () => {
  it('is exactly the two business fields, on read', async () => {
    expect(await build().state()).toEqual({
      mandatoryPeriodDays: null,
      voluntaryPeriodDays: null,
    });
  });

  it('is exactly the two business fields, on write', async () => {
    settings.read.mockResolvedValue(
      storedRow({ mandatory_period_seconds: 365 * DAY, voluntary_period_seconds: 330 * DAY }),
    );

    expect(await build().update(REQUEST, ACTOR, CLIENT)).toEqual({
      mandatoryPeriodDays: 365,
      voluntaryPeriodDays: 330,
    });
  });

  it.each(['version', 'reason', 'renewalEnabled', 'updatedByAdminId', 'updatedAt', 'settings'])(
    'does not carry `%s`',
    async (field) => {
      // `renewalEnabled` in particular: it is `mandatoryPeriodDays !== null` and nothing
      // else, so shipping it would be a second copy of a fact the payload already
      // carries — and two copies of one fact eventually disagree.
      expect(await build().state()).not.toHaveProperty(field);
    },
  );
});

// ─── the shipped state ──────────────────────────────────────────────────────

describe('the state a deployment starts in', () => {
  it('reports both periods null — which IS renewal disabled', async () => {
    // Not "unconfigured pending a default". This IS the configuration, and in it no
    // account is ever asked to re-verify because time passed.
    const payload = await build().state();

    expect(payload.mandatoryPeriodDays).toBeNull();
    expect(payload.voluntaryPeriodDays).toBeNull();
  });

  it('never substitutes a default or a zero for a null period', async () => {
    const payload = await build().state();
    expect(payload.mandatoryPeriodDays).not.toBe(0);
    expect(payload.voluntaryPeriodDays).not.toBe(0);
  });

  it('reads without writing or auditing anything', async () => {
    await build().state();
    expect(settings.write).not.toHaveBeenCalled();
    expect(events.record).not.toHaveBeenCalled();
  });
});

// ─── days in, seconds stored ────────────────────────────────────────────────

describe('the unit boundary', () => {
  it('normalises days to whole seconds on the way in', async () => {
    await build().update(REQUEST, ACTOR, CLIENT);

    expect(settings.write).toHaveBeenCalledWith({
      mandatoryPeriodSeconds: 365 * DAY,
      voluntaryPeriodSeconds: 330 * DAY,
    });
  });

  it('converts stored seconds back to days on the way out', async () => {
    settings.read.mockResolvedValue(
      storedRow({ mandatory_period_seconds: 90 * DAY, voluntary_period_seconds: 30 * DAY }),
    );

    expect(await build().state()).toEqual({
      mandatoryPeriodDays: 90,
      voluntaryPeriodDays: 30,
    });
  });

  it('reports a hand-written period that is not whole days EXACTLY, not rounded', async () => {
    // This API cannot produce one, but psql during an incident can. Rounding it to a
    // whole day count would hand back a number the operator could re-submit and
    // silently change the configuration by doing so. The fraction is the truth, and the
    // DTO's `.int()` refuses it on the way back in.
    settings.read.mockResolvedValue(storedRow({ mandatory_period_seconds: 90_000 }));
    expect((await build().state()).mandatoryPeriodDays).toBeCloseTo(90_000 / DAY, 10);
  });

  it('carries a null through without turning it into zero', async () => {
    await build().update({ mandatoryPeriodDays: null, voluntaryPeriodDays: null }, ACTOR, CLIENT);

    expect(settings.write).toHaveBeenCalledWith({
      mandatoryPeriodSeconds: null,
      voluntaryPeriodSeconds: null,
    });
  });
});

// ─── the write ──────────────────────────────────────────────────────────────

describe('a write', () => {
  beforeEach(() => {
    settings.impactOf.mockResolvedValue({ levelsAffected: 12, usersAffected: 9 });
  });

  it('measures the impact BEFORE writing, and records it on the audit event', async () => {
    // Counted afterwards it would describe the new state, which is the population that
    // is already invalid rather than the one this operator just invalidated. The count
    // is NOT part of the API contract — it exists for the audit row and the warning log.
    await build().update(REQUEST, ACTOR, CLIENT);

    expect(settings.impactOf).toHaveBeenCalledWith(365 * DAY);
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ADMIN_KYC_RENEWAL_SETTINGS_UPDATED',
        adminId: ACTOR.adminId,
        metadata: {
          mandatoryPeriodSeconds: 365 * DAY,
          voluntaryPeriodSeconds: 330 * DAY,
          levelsAffected: 12,
          usersAffected: 9,
        },
      }),
    );
  });

  it('records no version and no reason on the audit event', async () => {
    await build().update(REQUEST, ACTOR, CLIENT);

    const recorded = events.record.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(recorded.metadata).not.toHaveProperty('version');
    expect(recorded.metadata).not.toHaveProperty('reason');
  });

  it('sends the persister nothing but the two periods', async () => {
    await build().update(REQUEST, ACTOR, CLIENT);

    const written = settings.write.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual([
      'mandatoryPeriodSeconds',
      'voluntaryPeriodSeconds',
    ]);
  });

  it('re-reads the row rather than echoing the request back', async () => {
    // So a CHECK that quietly refused something could never be reported as applied.
    settings.read.mockResolvedValue(storedRow({ mandatory_period_seconds: 7 * DAY }));

    const payload = await build().update(REQUEST, ACTOR, CLIENT);
    expect(payload.mandatoryPeriodDays).toBe(7);
  });

  it('updates the ONE current row — there is no second statement behind it', async () => {
    await build().update(REQUEST, ACTOR, CLIENT);
    expect(settings.write).toHaveBeenCalledTimes(1);
  });
});

// ─── refusals ───────────────────────────────────────────────────────────────

describe('a missing settings row', () => {
  it('is a 404 on read rather than a fabricated all-null default', async () => {
    // Inventing "renewal is off" here would be indistinguishable from the real thing,
    // and an operator would believe they had read a configuration that is not there.
    settings.read.mockResolvedValue(null);

    await expect(build().state()).rejects.toMatchObject({ type: ERR.NOT_FOUND });
  });

  it('is a 404 on write rather than a silent no-op', async () => {
    // The UPDATE matched nothing, which for a seeded singleton can only mean the
    // consumer migration has not been applied.
    settings.write.mockResolvedValue(false);

    await expect(build().update(REQUEST, ACTOR, CLIENT)).rejects.toMatchObject({
      type: ERR.NOT_FOUND,
    });
  });

  it('records no audit event for a write that did not land', async () => {
    settings.write.mockResolvedValue(false);

    await expect(build().update(REQUEST, ACTOR, CLIENT)).rejects.toMatchObject({
      type: ERR.NOT_FOUND,
    });
    expect(events.record).not.toHaveBeenCalled();
  });
});

// ─── what this surface cannot reach ─────────────────────────────────────────

describe('the blast radius of this module', () => {
  const source = readFileSync('src/kyc/kyc-renewal.dboperation.ts', 'utf8');
  // Comments are stripped so prose explaining the boundary is not mistaken for a breach
  // of it — executable code is what has to be clean.
  const code = source.replace(/\/\*[^]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('cannot mark any account verified or expired', () => {
    // Configuration decides when a provider's word goes stale, never whether it was
    // said. Nothing here may reach a level state or a verification.
    expect(code).not.toMatch(/UPDATE\s+"identity"\."kyc_level_states"/i);
    expect(code).not.toMatch(/UPDATE\s+"identity"\."kyc_verifications"/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+"identity"\."kyc_level_states"/i);
    expect(code).not.toMatch(/\bDELETE\b/i);
  });

  it('persists no configuration history — there is no versions table behind it', () => {
    // The one guard that would catch the history returning as an implementation detail
    // nobody put in the API.
    expect(code).not.toMatch(/kyc_renewal_settings_versions/i);
    expect(code).not.toMatch(/renewal_history/i);
    expect(code).not.toMatch(/\bINSERT\b/i);
  });

  it('writes no version, reason or actor column', () => {
    for (const column of ['"version"', '"reason"', '"updated_by_admin_id"']) {
      expect(code, column).not.toContain(column);
    }
  });
});
