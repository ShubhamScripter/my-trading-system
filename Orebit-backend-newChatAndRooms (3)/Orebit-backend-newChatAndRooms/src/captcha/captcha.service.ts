import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import { CacheService, KEYS } from '../../redis';
import { policy } from '../../auth/limits';
import { CaptchaSettingsService } from './captcha.settings';
import {
  CAPTCHA_PROVIDERS,
  isCaptchaProvider,
  type CaptchaDescriptor,
  type CaptchaProvider,
  type CaptchaVerification,
  type CaptchaVerifier,
} from './captcha.types';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RECAPTCHA_VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';
const HCAPTCHA_VERIFY_URL = 'https://api.hcaptcha.com/siteverify';

interface ProviderResponse {
  readonly success: boolean;
  readonly hostname: string | null;
  readonly action: string | null;
  readonly score: number | null;
  readonly errorCodes: readonly string[];
}

/**
 * Server-side verifier for every captcha provider accepted by the API.
 *
 * Tokens are always verified by the provider, with the client IP included as a
 * cross-check. A provider outage, malformed response, invalid hostname, or an
 * unavailable provider is a refusal: authentication endpoints must never turn a
 * captcha failure into a bypass.
 */
@Injectable()
export class CaptchaService implements CaptchaVerifier {
  private readonly logger = new Logger('Captcha');

  constructor(
    private readonly cache: CacheService,
    private readonly settings: CaptchaSettingsService,
  ) {}

  /**
   * Every live provider and its site key. Read by `GET /auth/captcha`.
   *
   * `enabled` is `providers.length > 0` — see the note on `CaptchaDescriptor` for
   * why that is correct here and would be a captcha bypass in the admin backend.
   * It is a rendering hint and gates nothing: `verify` below runs whatever it says.
   *
   * `live()` is a field read, so this is synchronous.
   */
  describe(): CaptchaDescriptor {
    const providers = this.settings.live();
    return { enabled: providers.length > 0, providers };
  }

  async verify(input: CaptchaVerification): Promise<void> {
    // FIRST, before the provider is contacted. That ordering is the entire point
    // of the penalty: a caller serving a wait costs us nothing, where a refusal
    // issued after `siteVerify` would still spend a siteverify call — which is
    // the quota an attacker was burning in the first place.
    await this.assertNotPenalised(input.ip);

    try {
      if (!isCaptchaProvider(input.provider)) {
        throw new ProblemException({
          type: ERR.CAPTCHA_PROVIDER_UNKNOWN,
          detail: `Supported providers: ${CAPTCHA_PROVIDERS.join(', ')}`,
        });
      }

      // Named a provider an operator has taken out of rotation. A REFUSAL, and
      // deliberately the same `captcha_provider_unavailable` an unconfigured
      // provider gets: from the caller's side the two are one situation with one
      // remedy — pick another provider — and a page holding a list from before the
      // toggle is the ordinary way to arrive here, not an attack.
      //
      // One check, three entry points: login {mode:'password'}, login
      // {mode:'otp-request'} and register {step:'start'} all funnel through here.
      //
      // It must not reach `recordFailure`, and does not — the catch below counts
      // only CAPTCHA_FAILED. Charging the ladder here would penalise a caller for
      // using a provider that was live when their page loaded.
      if (!this.settings.live().some((option) => option.provider === input.provider)) {
        this.logger.warn(
          { provider: input.provider },
          'refused a captcha token for a provider that is disabled in the database',
        );
        throw new ProblemException({ type: ERR.CAPTCHA_PROVIDER_UNAVAILABLE });
      }

      // Unreachable by construction now — `live()` is a subset of the providers
      // that HAVE a secret, so the check above already refused anything this one
      // would catch. Kept anyway: it is the invariant written down where it is
      // relied on, and it costs a string comparison to keep a bypass impossible
      // rather than merely improbable.
      const secret = this.secretFor(input.provider);
      if (secret === '') {
        this.logger.error({ provider: input.provider }, 'captcha provider is not configured');
        throw new ProblemException({ type: ERR.CAPTCHA_PROVIDER_UNAVAILABLE });
      }

      const verified = await this.siteVerify(input, secret);
      if (!verified.success) {
        this.logger.warn(
          { provider: input.provider, errorCodes: verified.errorCodes },
          'captcha provider rejected token',
        );
        throw new ProblemException({ type: ERR.CAPTCHA_FAILED });
      }

      this.assertHostname(input.provider, verified.hostname);

      if (input.provider === 'RECAPTCHA_V3') {
        this.assertRecaptchaV3(input, verified);
      }
    } catch (err) {
      // Only a token the CALLER got wrong counts. `CAPTCHA_PROVIDER_UNAVAILABLE`
      // — a timeout, a provider 5xx, malformed JSON, an unconfigured secret — is
      // our fault or Cloudflare's, and counting it would turn a provider incident
      // into a self-inflicted lockout of every legitimate user within minutes.
      // This condition is the one line here that is easy to "tidy" into an
      // outage amplifier.
      if (err instanceof ProblemException && err.type === ERR.CAPTCHA_FAILED) {
        await this.recordFailure(input.ip);
      }
      throw err;
    }

    // Reached only when every check passed. Solving a captcha is proof the caller
    // is not what the penalty targets, so the streak is wiped rather than left to
    // expire — otherwise a user who fumbled twice would carry it for the rest of
    // the window despite having just proved otherwise.
    //
    // The strike count is deliberately NOT cleared: that is the ladder's memory,
    // and letting one solved token reset it would hand an attacker who can solve
    // occasionally an unlimited supply of first offences.
    await this.cache.clear(KEYS.captcha.failures(input.ip));
  }

  /**
   * Refuse outright while a penalty is running.
   *
   * The block key's TTL is the remaining wait, so the answer the caller gets is
   * exact rather than the window length rounded up.
   *
   * Fails OPEN: `cooldownRemaining` reports 0 when Redis is unreachable, so an
   * outage means no penalties are enforced rather than everyone being refused.
   * That is the right direction here and follows the same reasoning as
   * `OnCacheError: 'allow'` — there is a durable second line of defence, namely
   * that the captcha itself is still fully verified with the provider on every
   * request. Losing Redis degrades quota protection; it can never become a
   * captcha bypass.
   */
  private async assertNotPenalised(ip: string): Promise<void> {
    const remaining = await this.cache.cooldownRemaining(KEYS.captcha.block(ip));
    if (remaining <= 0) return;

    this.logger.warn({ retryAfterSeconds: remaining }, 'refused a captcha attempt during a penalty');
    throw new ProblemException({
      type: ERR.RATE_LIMITED,
      detail: 'Too many failed captcha attempts. Please wait before trying again.',
      retryAfterSeconds: remaining,
    });
  }

  /**
   * Count a rejected token, and start a penalty once the threshold is crossed.
   *
   * The request that trips the limit still fails with `captcha_failed`, not
   * `rate_limited` — it genuinely did fail a captcha, and reporting the wait it
   * has not yet been asked to serve would be a less honest answer. The next
   * attempt is the one that meets `assertNotPenalised`.
   */
  private async recordFailure(ip: string): Promise<void> {
    const { FAILURES_BY_IP, BLOCK_LADDER_SECONDS, STRIKE_TTL_SECONDS } = policy().CAPTCHA;

    const failures = await this.cache.increment(
      KEYS.captcha.failures(ip),
      FAILURES_BY_IP.windowSeconds,
    );
    if (failures < FAILURES_BY_IP.limit) return;

    // Which rung: first trip serves the first entry, and the ladder stops
    // climbing at the last one rather than running off the end.
    //
    // ─── The TTL slides from the NEWEST strike ────────────────────────────────
    //
    // `increment` sets the expiry with `NX`, so it only applies to a key that does
    // not exist yet — which meant the strike counter's lifetime was anchored to the
    // FIRST strike and expired a fixed period after it, however many strikes came
    // later. An attacker who paced themselves just under that window started every
    // campaign at rung one, so the ladder never climbed and the escalation was
    // decorative: they served the shortest wait, forever.
    //
    // Refreshed here, on the one event that should refresh it — a strike actually
    // being earned. Deliberately NOT on an ordinary request: that would let a
    // well-behaved caller sharing a NAT with an abuser keep the abuser's record
    // alive indefinitely.
    const strike = await this.cache.increment(KEYS.captcha.strikes(ip), STRIKE_TTL_SECONDS);
    await this.cache.expire(KEYS.captcha.strikes(ip), STRIKE_TTL_SECONDS);

    const rung = Math.min(Math.max(strike, 1), BLOCK_LADDER_SECONDS.length) - 1;
    const seconds = BLOCK_LADDER_SECONDS[rung] as number;

    // `cache.set` is fail-closed and throws when Redis is down. That is right for
    // the OAuth paths it was written for and wrong here: this runs inside the
    // `catch` that produces `captcha_failed`, so letting it propagate would turn a
    // Redis outage into a 500 and break the fail-open promise made above. A
    // penalty we could not write is a penalty not served, nothing more.
    try {
      await this.cache.set(KEYS.captcha.block(ip), '1', seconds);
    } catch (err) {
      this.logger.error({ err }, 'captcha penalty write failed; no block applied');
      return;
    }
    // The window that produced this penalty is spent. Left in place it would
    // still be over the limit when the block lifts, so the very next failure
    // would trip the next rung immediately.
    await this.cache.clear(KEYS.captcha.failures(ip));

    this.logger.warn(
      { failures, strike, blockedForSeconds: seconds },
      'captcha failures tripped the limit; penalty applied',
    );
  }

  private async siteVerify(
    input: CaptchaVerification,
    secret: string,
  ): Promise<ProviderResponse> {
    const form = new URLSearchParams({
      secret,
      response: input.token,
      remoteip: input.ip,
    });

    let response: Response;
    try {
      response = await fetch(this.verifyUrlFor(input.provider), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(config.CAPTCHA_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error({ provider: input.provider, err }, 'captcha verification request failed');
      throw new ProblemException({ type: ERR.CAPTCHA_PROVIDER_UNAVAILABLE });
    }

    if (!response.ok) {
      this.logger.error(
        { provider: input.provider, status: response.status },
        'captcha verification provider returned an HTTP error',
      );
      throw new ProblemException({ type: ERR.CAPTCHA_PROVIDER_UNAVAILABLE });
    }

    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch (err) {
      this.logger.error({ provider: input.provider, err }, 'captcha provider returned invalid JSON');
      throw new ProblemException({ type: ERR.CAPTCHA_PROVIDER_UNAVAILABLE });
    }

    return parseProviderResponse(payload);
  }

  private assertHostname(provider: CaptchaProvider, hostname: string | null): void {
    const normalisedHostname = hostname?.toLowerCase() ?? null;
    if (normalisedHostname !== null && config.captchaAllowedHostnames.includes(normalisedHostname)) return;

    this.logger.warn(
      { provider, hostname: normalisedHostname, allowedHostnames: config.captchaAllowedHostnames },
      'captcha token has an untrusted hostname',
    );
    throw new ProblemException({ type: ERR.CAPTCHA_FAILED });
  }

  private assertRecaptchaV3(input: CaptchaVerification, verified: ProviderResponse): void {
    if (verified.action !== input.action || verified.score === null || verified.score < config.CAPTCHA_RECAPTCHA_V3_MIN_SCORE) {
      this.logger.warn(
        {
          action: verified.action,
          expectedAction: input.action,
          score: verified.score,
          minimumScore: config.CAPTCHA_RECAPTCHA_V3_MIN_SCORE,
        },
        'reCAPTCHA v3 token did not meet the action or score requirement',
      );
      throw new ProblemException({ type: ERR.CAPTCHA_FAILED });
    }
  }

  private secretFor(provider: CaptchaProvider): string {
    switch (provider) {
      case 'TURNSTILE':
        return config.CAPTCHA_TURNSTILE_SECRET;
      case 'RECAPTCHA_V2':
        return config.CAPTCHA_RECAPTCHA_V2_SECRET;
      case 'RECAPTCHA_V3':
        return config.CAPTCHA_RECAPTCHA_V3_SECRET;
      case 'HCAPTCHA':
        return config.CAPTCHA_HCAPTCHA_SECRET;
    }
  }

  private verifyUrlFor(provider: CaptchaProvider): string {
    switch (provider) {
      case 'TURNSTILE':
        return TURNSTILE_VERIFY_URL;
      case 'RECAPTCHA_V2':
      case 'RECAPTCHA_V3':
        return RECAPTCHA_VERIFY_URL;
      case 'HCAPTCHA':
        return HCAPTCHA_VERIFY_URL;
    }
  }
}

function parseProviderResponse(payload: unknown): ProviderResponse {
  if (!isRecord(payload) || typeof payload.success !== 'boolean') {
    throw new ProblemException({ type: ERR.CAPTCHA_PROVIDER_UNAVAILABLE });
  }

  return {
    success: payload.success,
    hostname: typeof payload.hostname === 'string' ? payload.hostname : null,
    action: typeof payload.action === 'string' ? payload.action : null,
    score: typeof payload.score === 'number' ? payload.score : null,
    errorCodes: stringArray(payload['error-codes']),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
