import { describe, expect, it, vi } from 'vitest';
import type { UserFeatureRestriction } from '@prisma/client';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { RestrictionService, remainingSeconds } from '../../src/restrictions/restrictions.enforcement';

/**
 * ═══ ENFORCEMENT, AND THE OVERLAP RULE THAT MAKES IT SAFE ══════════════════
 *
 * Two things are tested here and the second is the one that matters.
 *
 * The obvious half: a live restriction refuses, an expired one does not.
 *
 * The load-bearing half: what happens when several restrictions cover the same
 * target. `max` is not an arbitrary choice between three plausible ones — summing
 * would let repeated actions compound toward a permanent lock, and taking the most
 * recent would let a SHORT restriction shorten a LONG one, which an attacker could
 * drive deliberately. Both alternatives pass every single-row test.
 *
 * Pure and doubled, so none of this needs a container, a database or a Redis.
 */

const NOW = new Date('2026-09-12T12:00:00.000Z');

function row(expiresAt: Date, over: Partial<UserFeatureRestriction> = {}): UserFeatureRestriction {
  return {
    id: 'r1',
    userId: 'user-1',
    feature: 'alpha',
    subFeature: null,
    triggerAction: 'password.change',
    classification: 'NEW_CONTEXT',
    policyContext: 'NEW_CONTEXT',
    policyVersion: 1,
    startsAt: NOW,
    expiresAt,
    ipClassAtTrigger: '203.0.113.0/24',
    deviceFingerprintAtTrigger: null,
    countryAtTrigger: null,
    requestId: null,
    createdAt: NOW,
    ...over,
  } as UserFeatureRestriction;
}

const inMinutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe('remainingSeconds — the overlap rule', () => {
  it('is zero for no rows', () => {
    expect(remainingSeconds([], NOW)).toBe(0);
  });

  it('is the distance to a single deadline', () => {
    expect(remainingSeconds([row(inMinutes(30))], NOW)).toBe(30 * 60);
  });

  /**
   * THE rule. Two restrictions, 30 minutes and 24 hours.
   *
   * `max` -> 24h. A sum would give 24.5h and would compound without bound across
   * repeated actions; taking the most recently written row could give 30 minutes and
   * would let a cheap trigger release an expensive freeze.
   */
  it('takes the LATEST deadline, never the sum and never the most recent row', () => {
    const rows = [row(inMinutes(24 * 60), { id: 'long' }), row(inMinutes(30), { id: 'short' })];

    expect(remainingSeconds(rows, NOW)).toBe(24 * 60 * 60);
    expect(remainingSeconds([...rows].reverse(), NOW)).toBe(24 * 60 * 60);
    // Explicitly NOT the sum.
    expect(remainingSeconds(rows, NOW)).not.toBe(24 * 60 * 60 + 30 * 60);
  });

  it('ignores deadlines that have already passed', () => {
    expect(remainingSeconds([row(inMinutes(-5))], NOW)).toBe(0);
    expect(remainingSeconds([row(inMinutes(-5)), row(inMinutes(10))], NOW)).toBe(10 * 60);
  });

  /** Rounded UP, matching `securityCooldownRemainingSeconds`: a caller told "1 second"
   *  who retries in one second must not be refused again. */
  it('rounds a partial second up', () => {
    expect(remainingSeconds([row(new Date(NOW.getTime() + 1500))], NOW)).toBe(2);
  });
});

describe('RestrictionService', () => {
  function service(rows: readonly UserFeatureRestriction[]) {
    const db = {
      liveRestrictionsFor: vi.fn(async () => rows),
      liveRestrictions: vi.fn(async () => rows),
    };
    return { db, service: new RestrictionService(db as never) };
  }

  it('allows when nothing is live', async () => {
    const { service: s } = service([]);
    const verdict = await s.check('user-1', 'alpha');

    expect(verdict).toEqual({ restricted: false, retryAfterSeconds: 0, availableAt: null });
    await expect(s.assertAllowed('user-1', 'alpha')).resolves.toBeUndefined();
  });

  it('refuses while a restriction is live, with the time and the instant', async () => {
    const { service: s } = service([row(new Date(Date.now() + 1_800_000))]);

    const verdict = await s.check('user-1', 'alpha');
    expect(verdict.restricted).toBe(true);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(1780);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(1800);
    expect(verdict.availableAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('throws FEATURE_RESTRICTED, never the cooldown slug', async () => {
    const { service: s } = service([row(new Date(Date.now() + 600_000))]);

    const err = await s.assertAllowed('user-1', 'alpha', 'beta').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemException);
    const problem = err as ProblemException;

    expect(problem.type).toBe(ERR.FEATURE_RESTRICTED);
    expect(problem.type).not.toBe(ERR.SECURITY_CHANGE_COOLDOWN);
    expect(problem.status).toBe(403);
    expect(problem.retryAfterSeconds).toBeGreaterThan(0);
    expect(problem.extra).toMatchObject({ feature: 'alpha', subFeature: 'beta' });
  });

  /**
   * What the client is NOT told. The row carries the trigger, the classification and
   * which signals looked unfamiliar; telling the caller any of that would hand an
   * attacker a probe for what the evaluator thinks of them.
   */
  it('discloses no security history to the client', async () => {
    const { service: s } = service([row(new Date(Date.now() + 600_000))]);
    const err = (await s.assertAllowed('user-1', 'alpha').catch((e: unknown) => e)) as ProblemException;

    const serialised = JSON.stringify({ detail: err.detail, extra: err.extra });
    for (const leak of ['password.change', 'NEW_CONTEXT', 'UNCLASSIFIED', '203.0.113', 'isNew']) {
      expect(serialised).not.toContain(leak);
    }
  });

  it('asks for the whole-feature rows as well when a sub-feature is named', async () => {
    const { db, service: s } = service([]);
    await s.check('user-1', 'alpha', 'beta');

    expect(db.liveRestrictionsFor).toHaveBeenCalledWith('user-1', 'alpha', 'beta', expect.any(Date));
  });

  it('evaluates expiry at read time rather than trusting a flag', async () => {
    // Rows the query would not have returned; the service still refuses to act on a
    // deadline that has passed.
    const { service: s } = service([row(new Date(Date.now() - 1_000))]);
    expect((await s.check('user-1', 'alpha')).restricted).toBe(false);
  });
});
