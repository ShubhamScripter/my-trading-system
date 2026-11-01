import { describe, expect, it, vi } from 'vitest';
import { CredentialService } from '../../auth/services/credential.service';
import { LOCKOUT } from '../../auth/auth.constants';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { makeCredential } from '../harness';

/**
 * ═══ THE LOCKOUT LADDER ════════════════════════════════════════════════════
 *
 * `CredentialService.checkPassword` decides, and `AdminDbOperation` applies. These
 * tests drive the decision against a doubled dboperation, because what is being
 * asserted is which outcome the service ASKS for and how it reports each one — the
 * SQL that makes the transition atomic is exercised by the end-to-end run.
 *
 * The property under test, stated plainly: a second lockout inside the strike memory
 * must not be another wait. A flat policy — ten wrong passwords, one hour, repeat —
 * bounds the RATE of guessing and nothing else, so an attacker willing to wait gets a
 * thousand guesses a day indefinitely and nobody is ever told. The second rung is what
 * converts a slow attack into a visible one.
 */

const PASSWORD = 'CorrectHorse!2026';

function build(
  overrides: {
    registerFailedAttempt?: ReturnType<typeof vi.fn>;
    clearFailedAttempts?: ReturnType<typeof vi.fn>;
    verify?: boolean;
  } = {},
) {
  const admins = {
    registerFailedAttempt:
      overrides.registerFailedAttempt ?? vi.fn().mockResolvedValue({ outcome: 'counted' }),
    clearFailedAttempts: overrides.clearFailedAttempts ?? vi.fn().mockResolvedValue(undefined),
  };

  const service = new CredentialService(admins as never);

  // argon2 is the thing under test everywhere EXCEPT here: this file is about the
  // counter policy, and a real hash would add ~50ms per assertion for a boolean the
  // spec already fixes. Stubbed at `verify`, which is the seam between "is this
  // password right" and "what happens next".
  vi.spyOn(service, 'verify').mockResolvedValue(overrides.verify ?? false);

  return { service, admins };
}

async function slugOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProblemException) return err.type;
    return `unexpected: ${String(err)}`;
  }
  return 'did not throw';
}

async function problemOf(fn: () => Promise<unknown>): Promise<ProblemException> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProblemException) return err;
    throw err;
  }
  throw new Error('did not throw');
}

describe('an ordinary wrong password', () => {
  it('returns invalid rather than throwing', async () => {
    const { service } = build();
    const result = await service.checkPassword(makeCredential(), PASSWORD);
    expect(result.valid).toBe(false);
  });

  /**
   * The policy travels to the dboperation as data rather than being re-derived
   * there. A second copy of "ten attempts, one hour, thirty days" in the persistence
   * layer is a second place for it to disagree with `auth.constants.ts`, which is
   * where product policy is supposed to live and be reviewable as a diff.
   */
  it('hands the whole policy to the dboperation', async () => {
    const { service, admins } = build();

    await service.checkPassword(makeCredential(), PASSWORD);

    expect(admins.registerFailedAttempt).toHaveBeenCalledWith(makeCredential().id, {
      maxAttempts: LOCKOUT.MAX_FAILED_ATTEMPTS,
      lockDurationSeconds: LOCKOUT.DURATION_SECONDS,
      strikeMemorySeconds: LOCKOUT.STRIKE_MEMORY_SECONDS,
    });
  });
});

describe('the first lock', () => {
  const firstLock = () =>
    build({ registerFailedAttempt: vi.fn().mockResolvedValue({ outcome: 'locked' }) });

  it('answers account_locked', async () => {
    const { service } = firstLock();
    expect(await slugOf(() => service.checkPassword(makeCredential(), PASSWORD))).toBe(
      ERR.ACCOUNT_LOCKED,
    );
  });

  /**
   * One hour, and it must be REPORTED — the slug alone tells an admin they are locked
   * out without telling them for how long, which is the difference between waiting and
   * filing a support ticket. `ProblemJsonFilter` turns this into `Retry-After`.
   */
  it('reports a full hour as the wait', async () => {
    const { service } = firstLock();
    const problem = await problemOf(() => service.checkPassword(makeCredential(), PASSWORD));

    expect(problem.retryAfterSeconds).toBe(3600);
    expect(problem.retryAfterSeconds).toBe(LOCKOUT.DURATION_SECONDS);
  });

  /** 423 Locked, which is what pairs with a `Retry-After`. */
  it('answers 423', async () => {
    const { service } = firstLock();
    const problem = await problemOf(() => service.checkPassword(makeCredential(), PASSWORD));
    expect(problem.status).toBe(423);
  });
});

describe('a lock that is still running', () => {
  const locked = makeCredential({ lockedUntil: new Date(Date.now() + 30 * 60 * 1000) });

  /**
   * === THE CORRECT PASSWORD DOES NOT LIFT A LOCK =============================
   *
   * Checked BEFORE `verify`, so a locked credential is refused without the password
   * being examined at all. Two things follow, and both matter: an attacker cannot use
   * the lock window to keep testing guesses, and — the reason it is asserted here —
   * an attacker who has ALREADY FOUND the password cannot spend it during the lock.
   * A lock that a correct password walks through is not a lock.
   */
  it('refuses even a correct password', async () => {
    const { service } = build({ verify: true });
    expect(await slugOf(() => service.checkPassword(locked, PASSWORD))).toBe(
      ERR.ACCOUNT_LOCKED,
    );
  });

  it('does not examine the password at all', async () => {
    const { service } = build({ verify: true });
    const verify = vi.spyOn(service, 'verify');

    await slugOf(() => service.checkPassword(locked, PASSWORD));

    expect(verify).not.toHaveBeenCalled();
  });

  /** The wait reported counts down from the row rather than restarting at an hour —
   *  otherwise every refused attempt would extend the lock it is reporting. */
  it('reports the remaining wait, not a fresh hour', async () => {
    const { service } = build({ verify: true });
    const problem = await problemOf(() => service.checkPassword(locked, PASSWORD));

    expect(problem.retryAfterSeconds).toBeLessThanOrEqual(30 * 60);
    expect(problem.retryAfterSeconds).toBeGreaterThan(29 * 60);
  });

  /** An EXPIRED lock is not a lock. The row keeps `lockedUntil` after it passes, and
   *  reading it as still-locked would make the first lockout permanent. */
  it('lets a lapsed lock through', async () => {
    const lapsed = makeCredential({ lockedUntil: new Date(Date.now() - 1000) });
    const { service } = build({ verify: true });

    const result = await service.checkPassword(lapsed, PASSWORD);

    expect(result.valid).toBe(true);
  });
});

describe('the second lock, inside the strike memory', () => {
  const secondLock = () =>
    build({ registerFailedAttempt: vi.fn().mockResolvedValue({ outcome: 'review-opened' }) });

  it('answers admin_login_manual_review rather than account_locked', async () => {
    const { service } = secondLock();
    expect(await slugOf(() => service.checkPassword(makeCredential(), PASSWORD))).toBe(
      ERR.ADMIN_LOGIN_MANUAL_REVIEW,
    );
  });

  /**
   * === NO RETRY-AFTER, AND THAT IS THE WHOLE DISTINCTION =====================
   *
   * This is the assertion that keeps the second rung from collapsing back into the
   * first. There is nothing to wait for: no timer restores the account, only a super
   * admin does. Sending a `Retry-After` would have the client render a countdown that
   * expires into another refusal — which is worse than no guidance, because it tells
   * the admin to keep trying instead of to ask someone.
   */
  it('reports no wait at all', async () => {
    const { service } = secondLock();
    const problem = await problemOf(() => service.checkPassword(makeCredential(), PASSWORD));

    expect(problem.retryAfterSeconds).toBeUndefined();
  });

  /** 403, not 423. A lock is temporary and 423 pairs with the wait it carries; this
   *  belongs with the refusals that time does not change. */
  it('answers 403', async () => {
    const { service } = secondLock();
    const problem = await problemOf(() => service.checkPassword(makeCredential(), PASSWORD));
    expect(problem.status).toBe(403);
  });

  /** And says so in words, because the slug is for the client and the detail is for
   *  the person reading the screen. */
  it('says that waiting will not help', async () => {
    const { service } = secondLock();
    const problem = await problemOf(() => service.checkPassword(makeCredential(), PASSWORD));

    expect(problem.detail).toMatch(/super administrator/i);
    expect(problem.detail).toMatch(/waiting will not/i);
  });
});

describe('a successful password', () => {
  /**
   * === WHAT A SUCCESS CLEARS, AND WHAT IT DOES NOT ===========================
   *
   * It clears the streak. It does NOT clear the strikes — and `clearFailedAttempts`
   * is the only method it may call, precisely because that method does not touch
   * them.
   *
   * The reasoning is the crux of the whole ladder: a correct password proves the
   * account's owner turned up, not that whatever produced the previous lockout has
   * stopped. If a success reset the memory, an attacker who can occasionally guess
   * right — or who simply waits for the real admin to sign in — gets an unlimited
   * supply of first offences, and the second rung becomes unreachable.
   */
  it('clears the streak when there is one', async () => {
    const { service, admins } = build({ verify: true });
    const dirty = makeCredential({ failedAttempts: 4 });

    await service.checkPassword(dirty, PASSWORD);

    expect(admins.clearFailedAttempts).toHaveBeenCalledWith(dirty.id);
  });

  /** A clean sign-in is the common case, and an unconditional write would make every
   *  sign-in a write for no change. */
  it('writes nothing when there was nothing to clear', async () => {
    const { service, admins } = build({ verify: true });

    await service.checkPassword(makeCredential(), PASSWORD);

    expect(admins.clearFailedAttempts).not.toHaveBeenCalled();
  });

  /**
   * The streak that WAS standing, captured before it was wiped.
   *
   * `LoginService` records `ADMIN_LOGIN_PASSWORD_SUCCESS_AFTER_FAILURES` from this,
   * and after the clear there is no other way to reconstruct it — which makes the
   * difference between "an admin fumbled and remembered" and "a clean sign-in"
   * unanswerable for a reviewer looking at the account later.
   */
  it('reports the streak it just cleared', async () => {
    const { service } = build({ verify: true });

    const result = await service.checkPassword(makeCredential({ failedAttempts: 7 }), PASSWORD);

    expect(result).toEqual({ valid: true, priorFailures: 7 });
  });

  it('reports zero prior failures on a clean sign-in', async () => {
    const { service } = build({ verify: true });
    const result = await service.checkPassword(makeCredential(), PASSWORD);
    expect(result).toEqual({ valid: true, priorFailures: 0 });
  });
});

/**
 * === THE TIMING MASK IS REAL WORK =========================================
 *
 * `verifyDummy` exists so an unknown address costs the same as a known one. These
 * assertions are about the mechanism rather than the duration — a unit test cannot
 * meaningfully assert that two argon2 calls take the same time, and asserting it with
 * a stopwatch would be flaky by construction. What CAN be pinned is that the work is
 * genuinely performed against a real hash produced with this deployment's own
 * parameters and pepper, which is what makes the durations match in production.
 */
describe('the timing mask', () => {
  it('verifies against a real argon2id hash of the configured shape', async () => {
    const { service } = build();
    vi.restoreAllMocks();

    const verify = vi.spyOn(service, 'verify');
    await service.verifyDummy(PASSWORD);

    expect(verify).toHaveBeenCalledOnce();
    const [hash, password] = verify.mock.calls[0] as [string, string];
    expect(password).toBe(PASSWORD);
    // The encoded string argon2 produces, carrying the parameters this service hashes
    // real passwords with. A placeholder or a truncated value would verify far faster
    // than the real thing and leave the tell it exists to remove.
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  /** It must never succeed. Nothing verifies against this hash, so a `true` here
   *  would mean the mask had become an authentication bypass. */
  it('never reports a match', async () => {
    const { service } = build();
    vi.restoreAllMocks();

    await expect(service.verifyDummy(PASSWORD)).resolves.toBeUndefined();
  });

  /** Reused across calls rather than recomputed. Hashing on every unknown address
   *  would make the mask itself a denial-of-service lever: one request, 19 MiB. */
  it('computes the hash once and reuses it', async () => {
    const { service } = build();
    vi.restoreAllMocks();

    const hash = vi.spyOn(service, 'hash');
    await service.verifyDummy('a');
    await service.verifyDummy('b');
    await service.verifyDummy('c');

    expect(hash).toHaveBeenCalledOnce();
  });
});
