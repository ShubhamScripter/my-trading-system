import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { config } from '../config';
import { CaptchaProviderDbOperation } from './captcha.dboperation';
import { isCaptchaProvider, type CaptchaOption } from './captcha.types';

/**
 * How often the snapshot is re-read.
 *
 * Minutes rather than seconds, on the same arithmetic `RateLimitPolicyService`
 * records: this answers a question that changes a few times a year, so a
 * five-second poll would be 17,280 queries a day per instance to notice nothing.
 *
 * There is no invalidation channel and adding one would be pointless — a toggle is
 * a hand-written SQL statement, so there is no publisher. The propagation delay of
 * a toggle is therefore this interval, and a restart applies one immediately.
 */
const REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * Which captcha providers this deployment currently offers.
 *
 * A near-copy of the admin backend's service of the same name, and deliberately a
 * copy rather than a shared package: these two repos already duplicate the whole
 * captcha module — `CAPTCHA_PROVIDERS`, the verifier, the penalty ladder — and one
 * shared library for one settings read would be the only coupling between them.
 * What IS shared is the database table, which is the coupling that was wanted.
 *
 * ═══ WHY THIS IS A SNAPSHOT AND NOT A CACHE ══════════════════════════════════
 *
 * The alternative was a Redis-cached lookup on each call. `CacheService.get` returns
 * null for "absent" and "unreadable" alike, so a degraded Redis would route every
 * unauthenticated login, OTP request and registration to Postgres. Holding the
 * answer in a field removes the question: the request path is a field read, Redis
 * is irrelevant to it, and Postgres being down costs a log line on a timer.
 *
 * ═══ THE NEVER-EMPTY RULE MATTERS MORE HERE THAN IN THE ADMIN ════════════════
 *
 * There is no `captchaEnabled` skip in this service — `verify` always runs. An
 * empty provider set would therefore 503 sign-in AND registration, with nothing to
 * soften it. `refresh` refuses to produce one.
 */
@Injectable()
export class CaptchaSettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('CaptchaSettings');
  private refreshTimer: NodeJS.Timeout | null = null;

  /**
   * Seeded with the full env set, so this answers correctly BEFORE the first
   * refresh and keeps answering correctly if every refresh that ever runs fails.
   * There is no "not loaded yet" state for a caller to handle, which is the point.
   */
  private snapshot: readonly CaptchaOption[] = config.captchaProviders;

  constructor(private readonly providers: CaptchaProviderDbOperation) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();

    // The mechanism, not a backstop — nothing else converges this instance.
    // `unref` so an operational timer never holds a process or a test runner open.
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /**
   * Every live provider, in `CAPTCHA_PROVIDERS` order.
   *
   * Synchronous on purpose: it is a field read, and a promise here would suggest
   * there is I/O to be afraid of, or to be tempted to skip.
   */
  live(): readonly CaptchaOption[] {
    return this.snapshot;
  }

  /**
   * Re-read the disabled set and recompute the snapshot.
   *
   * Every failure leaves the PREVIOUS snapshot in place, which on the first run is
   * the env set. That is what turns an empty table, a table that does not exist
   * yet, a revoked SELECT and an unreachable database into one answer — "nothing is
   * disabled" — and it is why `disabled()` throws instead of swallowing its own
   * errors: this is the only layer that knows the env set, so it is the only layer
   * that can safely make that conflation.
   */
  async refresh(): Promise<void> {
    let disabled: readonly string[];
    try {
      disabled = await this.providers.disabled();
    } catch (err) {
      this.logger.error(
        { err },
        'could not read the captcha provider toggles; retaining the current provider set',
      );
      return;
    }

    // Unknown names are dropped rather than trusted. Harmless either way — the set
    // is only ever subtracted from — but a typo an operator expected to disable
    // something should be visible in the log rather than silently doing nothing.
    const unknown = disabled.filter((provider) => !isCaptchaProvider(provider));
    if (unknown.length > 0) {
      this.logger.warn({ unknown }, 'ignoring captcha provider toggles that name no known provider');
    }

    const off = new Set(disabled.filter((provider) => isCaptchaProvider(provider)));
    const live = config.captchaProviders.filter((option) => !off.has(option.provider));

    // ═══ THE ANTI-LOCKOUT RULE ═════════════════════════════════════════════════
    //
    // Disabling every configured provider is refused, not obeyed. Here that would
    // take down sign-in and registration together — every gated entry point funnels
    // through `verify`, which has no skip path — so one SQL statement would be a
    // full authentication outage. A database row must not be able to do that.
    //
    // Checked against the env set rather than a bare `length === 0`, so a
    // development machine with no secrets configured is untouched: there is nothing
    // to narrow, and those requests already refuse at the secret check.
    if (live.length === 0 && config.captchaProviders.length > 0) {
      this.logger.error(
        { disabled: [...off] },
        'every configured captcha provider is disabled in the database; ignoring the ' +
          'rows and using the env set, because an empty set would stop every sign-in ' +
          'and registration',
      );
      this.snapshot = config.captchaProviders;
      return;
    }

    this.snapshot = live;
  }
}
