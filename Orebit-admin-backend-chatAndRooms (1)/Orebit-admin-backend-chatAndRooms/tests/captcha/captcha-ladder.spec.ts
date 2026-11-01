import { describe, expect, it, vi } from 'vitest';
import { CaptchaService } from '../../src/captcha/captcha.service';
import { CAPTCHA, LIMITS } from '../../auth/auth.constants';
import { ERR, PROBLEM_CATALOGUE } from '../../src/contracts';
import { KEYS } from '../../redis';

/**
 * ═══ THE CAPTCHA PENALTY LADDER ════════════════════════════════════════════
 *
 * Five rungs now: 1m, 5m, 15m, 1h, 24h.
 *
 * Escalating rather than flat because the two populations this has to separate behave
 * differently over time. Somebody who fumbles a puzzle once waits a minute and never
 * notices; something grinding tokens trips repeatedly and is pushed to a day, which is
 * the difference between a nuisance and a cost. A flat window lets the second caller
 * pace itself and continue indefinitely.
 *
 * ─── The trade this file records rather than hides ─────────────────────────
 *
 * `STRIKE_TTL_SECONDS` is 24h, which is now EQUAL to the top rung rather than
 * comfortably longer than it. An IP that serves a full day-long block finds its strike
 * count expiring at about the moment the block lifts, and starts again at sixty
 * seconds. That is a deliberate product decision, and the reason it is tolerable is
 * that this ladder is not the defence — the provider's own verdict on every token is,
 * and it still runs. This exists to stop somebody burning our siteverify quota, and
 * one attempt per day does not burn a quota.
 */

function makeCache() {
  return {
    consume: vi.fn().mockResolvedValue(undefined),
    refund: vi.fn().mockResolvedValue(undefined),
    cooldownRemaining: vi.fn().mockResolvedValue(0),
    startCooldown: vi.fn().mockResolvedValue(true),
    clear: vi.fn().mockResolvedValue(undefined),
    increment: vi.fn().mockResolvedValue(1),
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    take: vi.fn().mockResolvedValue(null),
    flag: vi.fn().mockResolvedValue(false),
    setFlag: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * `CaptchaService` now takes the provider snapshot as well as the cache.
 *
 * Nothing in this file exercises it — the ladder is about `recordFailure`'s
 * arithmetic — so it answers with the env set, which under tests/setup.ts is empty.
 * Kept as a factory rather than a shared object so no test can leak a mutated
 * snapshot into the next one.
 */
function makeSettings() {
  return { live: vi.fn().mockReturnValue([]) };
}

/** One door for constructing the subject, so a fourth constructor argument is one
 *  edit here rather than eight down the file. */
function makeService(cache: ReturnType<typeof makeCache>): CaptchaService {
  return new CaptchaService(cache as never, makeSettings() as never);
}

const IP = '203.0.113.7';

/**
 * Drive `recordFailure` through its only public door.
 *
 * `verify` short-circuits when no provider is configured — which is the state
 * tests/setup.ts leaves the environment in — so the penalty path is reached by calling
 * the private method directly rather than by standing up a fake Cloudflare. That is
 * the honest seam here: what is under test is the ladder arithmetic, not the HTTP.
 */
function recordFailure(service: CaptchaService, ip: string): Promise<void> {
  return (service as unknown as { recordFailure(ip: string): Promise<void> }).recordFailure(ip);
}

describe('the ladder', () => {
  it('has five rungs, ending at twenty-four hours', () => {
    expect(CAPTCHA.BLOCK_LADDER_SECONDS).toEqual([60, 300, 900, 3600, 86400]);
  });

  it('climbs strictly', () => {
    const rungs = [...CAPTCHA.BLOCK_LADDER_SECONDS];
    expect(rungs).toEqual([...rungs].sort((a, b) => a - b));
    expect(new Set(rungs).size).toBe(rungs.length);
  });

  /**
   * Each strike serves the matching rung. `increment` returns the strike count, so
   * driving it 1..5 walks the ladder.
   */
  it('serves each rung in order', async () => {
    for (const [index, expected] of CAPTCHA.BLOCK_LADDER_SECONDS.entries()) {
      const cache = makeCache();
      // At the limit, so the failure trips the penalty.
      cache.increment
        .mockResolvedValueOnce(LIMITS.CAPTCHA_FAILURE_BY_IP.limit) // failures
        .mockResolvedValueOnce(index + 1); // strikes
      const service = makeService(cache);

      await recordFailure(service, IP);

      expect(cache.set).toHaveBeenCalledWith(KEYS.captcha.block(IP), '1', expected, 'allow');
    }
  });

  /**
   * The last rung repeats rather than running off the end of the array. Without the
   * clamp a sixth strike indexes past the end and the block length becomes `undefined`
   * — which Redis would reject, so the penalty would silently not be applied at all,
   * turning the most-offending caller into the only unpenalised one.
   */
  it('repeats the last rung rather than running off the end', async () => {
    const cache = makeCache();
    cache.increment
      .mockResolvedValueOnce(LIMITS.CAPTCHA_FAILURE_BY_IP.limit)
      .mockResolvedValueOnce(99);
    const service = makeService(cache);

    await recordFailure(service, IP);

    expect(cache.set).toHaveBeenCalledWith(KEYS.captcha.block(IP), '1', 86400, 'allow');
  });

  /** Below the threshold nothing happens — a single wrong token is not a penalty. */
  it('does not penalise below the failure threshold', async () => {
    const cache = makeCache();
    cache.increment.mockResolvedValueOnce(LIMITS.CAPTCHA_FAILURE_BY_IP.limit - 1);
    const service = makeService(cache);

    await recordFailure(service, IP);

    expect(cache.set).not.toHaveBeenCalled();
  });

  /**
   * The window that produced the penalty is spent. Left in place it would still be
   * over the limit when the block lifts, so the very next failure would trip the next
   * rung immediately — turning one bad minute into an escalation to a day.
   */
  it('clears the failure window it just acted on', async () => {
    const cache = makeCache();
    cache.increment
      .mockResolvedValueOnce(LIMITS.CAPTCHA_FAILURE_BY_IP.limit)
      .mockResolvedValueOnce(1);
    const service = makeService(cache);

    await recordFailure(service, IP);

    expect(cache.clear).toHaveBeenCalledWith(KEYS.captcha.failures(IP));
  });

  /**
   * The STRIKE count is not cleared, and that is what makes the ladder a ladder.
   * Letting one solved token reset it would hand an attacker who can solve
   * occasionally an unlimited supply of first offences.
   */
  it('does not clear the strike count', async () => {
    const cache = makeCache();
    cache.increment
      .mockResolvedValueOnce(LIMITS.CAPTCHA_FAILURE_BY_IP.limit)
      .mockResolvedValueOnce(2);
    const service = makeService(cache);

    await recordFailure(service, IP);

    const cleared = cache.clear.mock.calls.map(([key]) => key as string);
    expect(cleared).not.toContain(KEYS.captcha.strikes(IP));
  });
});

describe('the three keys have three lifetimes', () => {
  /**
   * The strike count must outlive the block, or the ladder resets between penalties.
   * It is EQUAL to the top rung here rather than longer — see the file header for why
   * that is accepted — so this asserts the weaker property that actually holds, and
   * the stronger one for every rung below the top.
   */
  it('remembers a strike at least as long as the longest block', () => {
    const longest = Math.max(...CAPTCHA.BLOCK_LADDER_SECONDS);
    expect(CAPTCHA.STRIKE_TTL_SECONDS).toBeGreaterThanOrEqual(longest);
  });

  it('outlives every rung below the top', () => {
    const belowTop = [...CAPTCHA.BLOCK_LADDER_SECONDS].slice(0, -1);
    for (const rung of belowTop) {
      expect(CAPTCHA.STRIKE_TTL_SECONDS).toBeGreaterThan(rung);
    }
  });

  /** The strike TTL is passed on every increment, so the memory is refreshed as it is
   *  used rather than expiring a fixed time after the first offence. */
  it('sets the strike TTL from the constant', async () => {
    const cache = makeCache();
    cache.increment
      .mockResolvedValueOnce(LIMITS.CAPTCHA_FAILURE_BY_IP.limit)
      .mockResolvedValueOnce(1);
    const service = makeService(cache);

    await recordFailure(service, IP);

    expect(cache.increment).toHaveBeenCalledWith(
      KEYS.captcha.strikes(IP),
      CAPTCHA.STRIKE_TTL_SECONDS,
    );
  });
});

describe('a penalty that cannot be written', () => {
  /**
   * `allow`, and it is the only `allow` among the `cache.set` call sites in the
   * service. A penalty we could not write costs enforcement, never correctness: the
   * real defence is the provider's own verdict, which still runs with Redis down.
   *
   * The rest of the penalty path is fail-open for the same reason — `increment`
   * returns 0 when Redis is unreachable, which reads as "no failures recorded", so a
   * cache we cannot write must not be able to penalise anyone either.
   */
  it('fails open', async () => {
    const cache = makeCache();
    cache.increment
      .mockResolvedValueOnce(LIMITS.CAPTCHA_FAILURE_BY_IP.limit)
      .mockResolvedValueOnce(1);
    const service = makeService(cache);

    await recordFailure(service, IP);

    const setCall = cache.set.mock.calls[0];
    expect(setCall?.[3]).toBe('allow');
  });

  /** An unreachable cache reports zero failures, which is below the threshold, so no
   *  penalty is applied at all. */
  it('penalises nobody when the counter cannot be read', async () => {
    const cache = makeCache();
    cache.increment.mockResolvedValue(0);
    const service = makeService(cache);

    await recordFailure(service, IP);

    expect(cache.set).not.toHaveBeenCalled();
  });
});

describe('a provider outage is not a failure', () => {
  /**
   * ═══ THE LINE THAT IS EASY TO "TIDY" INTO AN OUTAGE AMPLIFIER ═══════════════
   *
   * Only a token the CALLER got wrong counts. A timeout, a provider 5xx or malformed
   * JSON is our fault or Cloudflare's, and counting it would turn a provider incident
   * into a self-inflicted lockout of every legitimate admin within minutes — each one
   * failing, each failure climbing the ladder, until the whole population is serving
   * twenty-four hour blocks for an outage they had nothing to do with.
   *
   * The service enforces this by narrowing on `CAPTCHA_FAILED` specifically before
   * calling `recordFailure`. This asserts the catalogue entries stay distinct, which
   * is what that narrowing depends on.
   */
  it('keeps the caller-fault and provider-fault slugs distinct', () => {
    expect(ERR.CAPTCHA_FAILED).not.toBe(ERR.CAPTCHA_PROVIDER_UNAVAILABLE);
    expect(ERR.CAPTCHA_FAILED).not.toBe(ERR.CAPTCHA_PROVIDER_UNKNOWN);
  });

  /**
   * And the provider-unavailable slug answers 503, not 400 — a 4xx would tell the
   * client it had done something wrong and invite it to change the request, when the
   * correct action is to retry unchanged.
   */
  it('answers 503 for a provider outage', () => {
    expect(PROBLEM_CATALOGUE[ERR.CAPTCHA_PROVIDER_UNAVAILABLE].status).toBe(503);
    expect(PROBLEM_CATALOGUE[ERR.CAPTCHA_FAILED].status).toBe(400);
  });
});
