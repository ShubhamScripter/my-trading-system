import { z } from 'zod';
import { BOUNDS, DEFAULTS, type Policy } from './limits';

/**
 * ═══ VALIDATING A POLICY THAT ARRIVED FROM OUTSIDE THIS BUILD ═══════════════
 *
 * `Policy` is a TypeScript type, and a row read out of `rate_limit_policy_versions`
 * is `Json`. The cast between them (`row.policy as unknown as Policy`) asserts a shape
 * nothing has checked, so this file is what makes the assertion true.
 *
 * ─── What the previous check missed ─────────────────────────────────────────
 *
 * It walked the object looking for anything already shaped `{limit, windowSeconds}`
 * and bounds-checked whatever it found. That is a DISCOVERY pass, not a validation
 * pass, and the difference is everything it cannot see:
 *
 *   `{}`                        no rules found, no problems reported, goes live
 *   a section deleted           the rules that remain are all fine
 *   `limit` misspelt            the object is no longer a rule, so it is skipped
 *   every TTL and count         never shaped like a rule, so never examined at all
 *   a ladder emptied            an array of nothing yields nothing
 *
 * Each of those replaces the live policy and then fails at a request-path call site —
 * `policy().SESSION.REFRESH_SHORT` being `undefined` inside a rate-limit check — or,
 * worse, does not fail and silently stops enforcing something.
 *
 * ─── Why the schema is DERIVED from DEFAULTS ────────────────────────────────
 *
 * Because a hand-written mirror of a hundred-odd fields is a second copy of the policy
 * that has to be kept in step with the first, and the failure mode when it drifts is
 * silent: a field added to `DEFAULTS` and forgotten here is simply never validated —
 * which is exactly the bug this file exists to fix, reintroduced one field at a time.
 *
 * Deriving makes that impossible. `DEFAULTS` is the only description of the shape, and
 * `.strict()` at every level means a stored policy must have precisely the keys this
 * build knows about: no more (a typo cannot slip through as an unknown key) and no
 * fewer (a missing key is an error rather than an `undefined` at a call site).
 */

/** A single rule. `.strict()` so `{limit, windowSeconds, limt}` is an error rather
 *  than a rule with a typo'd override silently ignored. */
function rateLimitSchema(): z.ZodTypeAny {
  return z
    .object({
      limit: z.number().int().min(BOUNDS.MIN_LIMIT).max(BOUNDS.MAX_LIMIT),
      windowSeconds: z
        .number()
        .int()
        .min(BOUNDS.MIN_WINDOW_SECONDS)
        .max(BOUNDS.MAX_WINDOW_SECONDS),
    })
    .strict();
}

/**
 * Every bare number in the policy is a count or a duration in seconds, and zero is
 * never meaningful for either: a zero TTL is a value that expires before it is read,
 * and a zero count is a feature turned off by a number that looks like a typo. The
 * upper bound is the window ceiling for the same reason it applies to windows —
 * anything longer is a ban, which is a different mechanism.
 */
function boundedNumberSchema(): z.ZodTypeAny {
  return z.number().int().min(1).max(BOUNDS.MAX_WINDOW_SECONDS);
}

function isRateLimit(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { limit?: unknown }).limit === 'number' &&
    typeof (value as { windowSeconds?: unknown }).windowSeconds === 'number'
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the schema for one node of the policy by looking at the shipped default in
 * the same position.
 *
 * The two kinds of array in the policy are validated differently, because their
 * lengths mean different things:
 *
 *   A QUOTA SET (`[hourly, daily]`) is fixed at the shipped length. `quotaSet` pairs
 *   each rule with a named Redis key and throws when the two lists disagree, so a
 *   stored pair with one element is a crash at the charge site rather than a looser
 *   limit. A tuple refuses it here instead, which is where it can still be refused.
 *
 *   A LADDER (`LOCKOUT.LADDER_SECONDS`, `CAPTCHA.BLOCK_LADDER_SECONDS`) is not.
 *   Both readers clamp the strike index to the array's own length and repeat the last
 *   rung — `rungFor` in credential.service.ts and the `Math.min` in
 *   captcha.service.ts — so any non-empty length works. Adding a fourth lockout rung
 *   is exactly the kind of change this policy exists to make possible without a
 *   deploy, and a tuple would have forbidden it.
 */
function schemaFor(sample: unknown, path: string): z.ZodTypeAny {
  if (isRateLimit(sample)) return rateLimitSchema();
  if (Array.isArray(sample)) {
    if (sample.every((item) => typeof item === 'number')) {
      return z.array(boundedNumberSchema()).min(1);
    }
    return z.tuple(sample.map((item, index) => schemaFor(item, `${path}[${index}]`)) as []);
  }
  if (typeof sample === 'number') return boundedNumberSchema();
  if (isPlainObject(sample)) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, value] of Object.entries(sample)) {
      shape[key] = schemaFor(value, `${path}.${key}`);
    }
    return z.object(shape).strict();
  }
  // Unreachable for the current policy, and a build-time error for whoever adds a
  // string or a boolean to it without deciding how it should be validated.
  throw new Error(`limits.schema: no rule for ${path} (${typeof sample})`);
}

/** `[hourly, daily]`-style pairs. Named here so the relational rule below can find
 *  them without re-deriving which fields happen to be sets. */
const QUOTA_SET_PATHS: readonly (readonly [keyof Policy, string])[] = [
  ['REGISTRATION', 'START_BY_EMAIL'],
  ['REGISTRATION', 'START_BY_IP'],
  ['REGISTRATION', 'START_BY_DEVICE'],
  ['REGISTRATION', 'OTP_MAIL_BY_RECIPIENT'],
  ['LOGIN_OTP', 'MAIL_BY_ACCOUNT'],
  ['SECURITY_SETTINGS', 'KYC_REVERIFY_BY_ACCOUNT'],
];

interface Rule {
  limit: number;
  windowSeconds: number;
}

/**
 * Rules the shape cannot express, each of which this file's own comments already
 * assert somewhere and nothing enforced.
 *
 * These are not style preferences. Every one of them describes a configuration that
 * parses, goes live, and then silently does not do what its author intended — which is
 * the failure the bounds checks exist to prevent, one level up.
 */
function relational(value: unknown, ctx: z.RefinementCtx): void {
  const policy = value as Policy;

  const problem = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };

  // A wider window with a smaller-or-equal allowance is the narrow window, twice. The
  // pair exists so a burst and a sustained rate can be bounded separately, and this
  // ordering is what makes the second one reachable at all.
  for (const [section, field] of QUOTA_SET_PATHS) {
    const pair = (policy[section] as Record<string, unknown>)[field] as Rule[];
    const [tight, wide] = pair;
    if (tight === undefined || wide === undefined) continue;
    if (wide.windowSeconds <= tight.windowSeconds) {
      problem(
        [section, field],
        `the second window (${wide.windowSeconds}s) must be longer than the first ` +
          `(${tight.windowSeconds}s) — they are ordered tight-to-wide`,
      );
    }
    if (wide.limit < tight.limit) {
      problem(
        [section, field],
        `the wider window's limit (${wide.limit}) is below the tighter one's ` +
          `(${tight.limit}), so the tighter window can never be the binding constraint`,
      );
    }
  }

  // The same rule for the refresh pair, which is two named fields rather than a set.
  const { REFRESH_SHORT, REFRESH_HOURLY } = policy.SESSION;
  if (REFRESH_HOURLY.windowSeconds <= REFRESH_SHORT.windowSeconds) {
    problem(
      ['SESSION', 'REFRESH_HOURLY'],
      `must span a longer window than REFRESH_SHORT (${REFRESH_SHORT.windowSeconds}s)`,
    );
  }
  if (REFRESH_HOURLY.limit < REFRESH_SHORT.limit) {
    problem(
      ['SESSION', 'REFRESH_HOURLY'],
      `limit ${REFRESH_HOURLY.limit} is below REFRESH_SHORT's ${REFRESH_SHORT.limit}, ` +
        'so the short window could never be reached',
    );
  }

  // An escalation ladder that does not ascend does not escalate. A flat or descending
  // one is the exact defect the ladders were introduced to fix — see the notes on
  // LOCKOUT and CAPTCHA in limits.ts.
  const ladders: [string[], readonly number[]][] = [
    [['LOCKOUT', 'LADDER_SECONDS'], policy.LOCKOUT.LADDER_SECONDS],
    [['CAPTCHA', 'BLOCK_LADDER_SECONDS'], policy.CAPTCHA.BLOCK_LADDER_SECONDS],
  ];
  for (const [path, rungs] of ladders) {
    if (rungs.length === 0) {
      problem(path, 'must have at least one rung, or the penalty is never applied');
      continue;
    }
    for (let i = 1; i < rungs.length; i += 1) {
      if ((rungs[i] as number) <= (rungs[i - 1] as number)) {
        problem(
          path,
          `rung ${i} (${rungs[i]}s) does not exceed rung ${i - 1} (${rungs[i - 1]}s) — ` +
            'a ladder that does not ascend does not escalate',
        );
        break;
      }
    }
  }

  // Strike memory shorter than the longest penalty resets the ladder between
  // penalties, so every lock is the first one again and the ladder never climbs. Both
  // sections say so in prose; neither enforced it.
  const lockoutMax = Math.max(0, ...policy.LOCKOUT.LADDER_SECONDS);
  if (policy.LOCKOUT.STRIKE_TTL_SECONDS <= lockoutMax) {
    problem(
      ['LOCKOUT', 'STRIKE_TTL_SECONDS'],
      `must outlast the longest rung (${lockoutMax}s), or the ladder resets between ` +
        'penalties and every lockout is the first one again',
    );
  }
  const captchaMax = Math.max(0, ...policy.CAPTCHA.BLOCK_LADDER_SECONDS);
  if (policy.CAPTCHA.STRIKE_TTL_SECONDS <= captchaMax) {
    problem(
      ['CAPTCHA', 'STRIKE_TTL_SECONDS'],
      `must outlast the longest rung (${captchaMax}s), or a sustained campaign waits ` +
        'out the window and starts again at rung one',
    );
  }

  // Asking for a challenge is not a guess: a reloaded tab or a switch from platform
  // authenticator to security key legitimately costs one. If the challenge budget did
  // not exceed the proof budget, it — not the proof cap — would be what ends a
  // ceremony, and the attempt counter would stop meaning anything.
  if (policy.MFA.PASSKEY_CHALLENGES_PER_CEREMONY <= policy.MFA.PROOF_ATTEMPTS) {
    problem(
      ['MFA', 'PASSKEY_CHALLENGES_PER_CEREMONY'],
      `must exceed PROOF_ATTEMPTS (${policy.MFA.PROOF_ATTEMPTS}), or the challenge ` +
        'budget ends the ceremony before the attempt cap does',
    );
  }
}

/**
 * The complete check: shape, then bounds, then the rules between fields.
 *
 * Built on first use and memoised, rather than at import.
 *
 * ─── Why lazily ────────────────────────────────────────────────────────────
 *
 * This module and `limits.ts` import each other — the schema is derived from
 * `DEFAULTS`, and `validatePolicy` is the natural place for callers to reach the
 * schema from. A cycle is fine as long as nothing reads across it while the other
 * module is still evaluating, and building the schema at import time did exactly
 * that: `limits.ts` loads, reaches its import of this file before it has assigned
 * `BOUNDS`, and this file reads `BOUNDS.MIN_LIMIT` off a half-initialised module.
 *
 * Deferring the read to the first `validatePolicy` call moves it to well after both
 * modules have finished loading. Worth noting that `tsc` cannot catch this: the cycle
 * is legal TypeScript and the failure is purely an evaluation-order one, so it shows
 * up as a `TypeError` at import in whichever suite happens to load `limits.ts` first.
 */
let compiled: z.ZodTypeAny | null = null;

export function policySchema(): z.ZodTypeAny {
  compiled ??= schemaFor(DEFAULTS, 'policy').superRefine(relational);
  return compiled;
}

/** One problem, rendered as `SECTION.FIELD: what is wrong`. */
export function describeIssue(issue: z.ZodIssue): string {
  const path = issue.path.join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}
