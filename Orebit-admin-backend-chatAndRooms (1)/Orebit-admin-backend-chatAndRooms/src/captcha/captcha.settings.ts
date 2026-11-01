import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { config } from '../config';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import { CaptchaProviderDbOperation } from './captcha.dboperation';
import {
  CAPTCHA_PROVIDERS,
  isCaptchaProvider,
  type CaptchaOption,
  type CaptchaProvider,
  type CaptchaProviderState,
} from './captcha.types';

/**
 * How often the snapshot is re-read.
 *
 * Minutes rather than seconds, and the arithmetic is the same one
 * `RateLimitPolicyService` records in the main backend: this answers a question that
 * changes a few times a year, so a five-second poll would be 17,280 queries a day per
 * instance to notice nothing. Five minutes is 288.
 *
 * There is no invalidation channel to make this faster, and adding one would be
 * pointless: a toggle is a hand-written SQL statement, so there is no publisher. The
 * propagation delay of a toggle is therefore this interval, and a restart is the way
 * to apply one immediately.
 */
export const REFRESH_INTERVAL_MS = 5 * 60_000;

/** The same interval in seconds, reported to an operator so a toggle that has not
 *  yet reached every instance reads as expected rather than as a bug. */
export const PROPAGATION_SECONDS = REFRESH_INTERVAL_MS / 1000;

/**
 * Which captcha providers this deployment currently offers.
 *
 * ═══ WHY THIS IS A SNAPSHOT AND NOT A CACHE ══════════════════════════════════
 *
 * `POST /auth/login {"step":"start"}` charges no rate-limit bucket — it has nothing
 * to guess at, so there was never a reason to meter it — and there is no global
 * throttler. Any per-request lookup here is therefore a lookup an anonymous caller
 * can drive at whatever rate they like.
 *
 * A Redis-cached answer would be worse than it first appears, because `cache.get`
 * conflates "absent" with "unreadable" and returns null for both. That is correct for
 * its other readers, but it means a degraded Redis routes EVERY anonymous login
 * request to Postgres. The failure would be safe and unbounded at the same time.
 *
 * Holding the answer in a field removes the question. The request path is a field
 * read, so Redis being down is irrelevant and Postgres being down costs a log line on
 * a timer. It is the pattern `RateLimitPolicyService` already uses in the main backend
 * for the same shape of problem.
 *
 * ═══ THE TWO DIRECTIONS THIS MUST NEVER GO ═══════════════════════════════════
 *
 * WIDER than env advertises a provider with no secret, which `step: 'start'` would
 * offer and every token it issued would then 503. Impossible by construction: the
 * database is only ever subtracted from `config.captchaProviders`.
 *
 * EMPTY while env has providers locks every admin out of the one route that could
 * undo it. Refused explicitly in `refresh`.
 */
@Injectable()
export class CaptchaSettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('CaptchaSettings');
  private refreshTimer: NodeJS.Timeout | null = null;

  /**
   * Seeded with the full env set, so this service answers correctly BEFORE the first
   * refresh and keeps answering correctly if every refresh that ever runs fails.
   * There is no "not loaded yet" state for a caller to handle, which is the point.
   */
  private snapshot: readonly CaptchaOption[] = config.captchaProviders;

  constructor(private readonly providers: CaptchaProviderDbOperation) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();

    // The mechanism, not a backstop — there is nothing else to converge this
    // instance. `unref` so an operational timer never holds a process or a test
    // runner open.
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
   * Synchronous on purpose: it is a field read, and making it a promise would invite
   * a caller to think there is I/O here to be afraid of, or to be tempted to skip it.
   */
  live(): readonly CaptchaOption[] {
    return this.snapshot;
  }

  /**
   * Every provider and why it is or is not live — the OPERATOR's view.
   *
   * Reads the table directly rather than the snapshot, deliberately. The snapshot is
   * up to `REFRESH_INTERVAL_MS` stale by design, which is right for the sign-in path
   * and wrong for a settings screen: an operator who has just written a row must see
   * their own write, not the value this instance happened to cache.
   *
   * Every provider in `CAPTCHA_PROVIDERS` appears, including ones with no secret and
   * ones with no row. A screen that only listed what exists could not show an
   * operator the provider they are trying to turn on.
   */
  async state(): Promise<readonly CaptchaProviderState[]> {
    const rows = await this.providers.list();
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    const configured = new Map(config.captchaProviders.map((o) => [o.provider, o.siteKey]));

    return CAPTCHA_PROVIDERS.map((provider) => {
      const row = byProvider.get(provider);
      const siteKey = configured.get(provider);
      const isConfigured = siteKey !== undefined;
      const isDisabled = row !== undefined && !row.enabled;

      return {
        provider,
        configured: isConfigured,
        disabled: isDisabled,
        live: isConfigured && !isDisabled,
        siteKey: siteKey ?? null,
        reason: row?.reason ?? null,
        updatedByAdminId: row?.updatedByAdminId ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  /**
   * Switch one provider on or off.
   *
   * ═══ THE ANTI-LOCKOUT RULE IS ENFORCED HERE TOO, AND THAT IS THE POINT ═════
   *
   * `refresh` already ignores a table that disables everything, so the read path is
   * safe whatever this does. But "safe" there means the operator's write is silently
   * not honoured — they disable the last provider, get a 200, and the system quietly
   * keeps using it. Refusing at the WRITE is the difference between a system that
   * protects itself and one that also tells you it did.
   *
   * So the rule is stated twice on purpose: here it is an error an operator can read,
   * there it is a backstop for the rows this method never saw — a psql write, or a
   * provider whose secret was removed from env after the row was written.
   *
   * ─── Ordering ─────────────────────────────────────────────────────────────
   *
   * Check, WRITE, then refresh. The refresh cannot fail in a way that matters — it
   * re-reads what was just committed — and putting it after the write means a failed
   * write leaves the snapshot untouched rather than briefly reflecting a change that
   * did not happen.
   *
   * Only THIS instance is immediately current. Others converge within
   * `REFRESH_INTERVAL_MS`, which is stated in the payload so an operator is not left
   * guessing why a second tab still offers the provider they just disabled.
   */
  async toggle(input: {
    readonly provider: CaptchaProvider;
    readonly enabled: boolean;
    readonly reason: string | null;
    readonly actorAdminId: string;
  }): Promise<readonly CaptchaProviderState[]> {
    if (!input.enabled) await this.assertNotLastLiveProvider(input.provider);

    await this.providers.setEnabled(input);
    this.logger.warn(
      {
        provider: input.provider,
        enabled: input.enabled,
        reason: input.reason,
        actorAdminId: input.actorAdminId,
      },
      'captcha provider toggled',
    );

    await this.refresh();
    return this.state();
  }

  /**
   * Refuse a disable that would leave nothing live.
   *
   * Computed from the DATABASE plus env rather than from `this.snapshot`, because the
   * snapshot may be up to a refresh interval stale and this decision must be made on
   * the current truth — two operators disabling different providers within the same
   * interval would otherwise each see one provider left and both be allowed through.
   *
   * A provider that is not configured in env is not a candidate to be "the last one":
   * it was never live, so disabling it changes nothing and is allowed. That is why
   * this counts LIVE providers rather than rows.
   */
  private async assertNotLastLiveProvider(provider: CaptchaProvider): Promise<void> {
    const current = await this.state();
    const remaining = current.filter((entry) => entry.live && entry.provider !== provider);
    if (remaining.length > 0) return;

    const target = current.find((entry) => entry.provider === provider);
    // Disabling something that is already off, or was never configured, is a no-op
    // rather than a lockout — do not refuse it.
    if (target === undefined || !target.live) return;

    this.logger.warn(
      { provider, actor: 'super-admin' },
      'refused a captcha toggle that would have disabled the last live provider',
    );
    throw new ProblemException({
      type: ERR.CAPTCHA_LAST_PROVIDER,
      detail:
        `${provider} is the only captcha provider still live, so disabling it would ` +
        'leave no way to sign in — including for whoever would have to sign in to ' +
        'undo it. Configure and enable another provider first.',
    });
  }

  /**
   * Re-read the disabled set and recompute the snapshot.
   *
   * Every failure leaves the PREVIOUS snapshot in place, which on the first run is
   * the full env set. That is what turns an empty table, a missing table, a revoked
   * SELECT and an unreachable database into one answer — "nothing is disabled" —
   * and it is the reason `disabled()` throws rather than swallowing its own errors:
   * this is the only layer that knows the env set, so it is the only layer that can
   * safely make that conflation.
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

    // Unknown names are dropped rather than trusted. Harmless either way — the set is
    // only ever subtracted from — but a typo an operator expected to disable something
    // should be visible in the log rather than silently doing nothing.
    const unknown = disabled.filter((provider) => !isCaptchaProvider(provider));
    if (unknown.length > 0) {
      this.logger.warn(
        { unknown },
        'ignoring captcha provider toggles that name no known provider',
      );
    }

    const off = new Set(disabled.filter((provider) => isCaptchaProvider(provider)));
    const live = config.captchaProviders.filter((option) => !off.has(option.provider));

    // ═══ THE ANTI-LOCKOUT RULE ═════════════════════════════════════════════════
    //
    // Disabling every configured provider is refused, not obeyed. On this service it
    // would take away every captcha the login page could render, which means no admin
    // could sign in — including the one who would have to sign in to write the row
    // that undid it. A database row must not be able to do that.
    //
    // Checked against the env set rather than a bare `length === 0`, so a development
    // machine with no provider configured at all is untouched: there is nothing to
    // narrow, and `config.captchaEnabled` is already false there.
    if (live.length === 0 && config.captchaProviders.length > 0) {
      this.logger.error(
        { disabled: [...off] },
        'every configured captcha provider is disabled in the database; ignoring the ' +
          'rows and using the env set, because an empty set would lock out every admin',
      );
      this.snapshot = config.captchaProviders;
      return;
    }

    this.snapshot = live;
  }
}
