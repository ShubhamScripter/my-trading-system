import https from 'node:https';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { CAPTCHA, LIMITS } from '../../auth/auth.constants';
import { CacheService, KEYS } from '../../redis';
import { config } from '../config';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
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
 * ═══ CONNECTION REUSE FOR THE SITEVERIFY CALL ════════════════════════════════
 *
 * Beside the transport rather than in auth.constants.ts, which is where the
 * security limits live — the same split `MailService.POOL` makes, and for the same
 * reason: nobody changes these in response to a risk review.
 *
 * ─── What this fixes ───────────────────────────────────────────────────────
 *
 * `siteVerify` used a bare `fetch()`, which goes through undici's global
 * dispatcher and its four-second `keepAliveTimeout`. Measured against Turnstile:
 * 15ms when a connection was already open, 45ms after six seconds of idle, because
 * the pool had dropped it and the request paid DNS + TCP + TLS again. Admin
 * sign-ins are minutes apart, so in practice EVERY sign-in paid it — about 50ms,
 * on the one request an admin is actually waiting on.
 *
 * A `node:https` agent rather than an undici dispatcher because undici is not a
 * dependency of this repository — it is bundled inside Node and not exposed as an
 * importable module, so reaching it would mean adding a second copy of a library
 * the runtime already has. `https.Agent` is built in and pools per origin, which is
 * what this needs.
 *
 * ─── What it deliberately does NOT do ──────────────────────────────────────
 *
 * It reuses the SOCKET and nothing else. Every request still carries the secret,
 * still names the provider, and still gets that provider's own verdict. No response
 * is cached, no token is reused, and there is still no retry — see `postForm`.
 */
const POOL = {
  /**
   * Concurrent verifications in flight to one provider.
   *
   * Bounded rather than Node's default of `Infinity`, so a burst cannot open a
   * socket per request against a provider that rate-limits on connections. Set well
   * above the service's realistic concurrency, because a request that has to WAIT
   * for a socket has had latency added by the very thing meant to remove it — this
   * is a ceiling, not a throttle.
   */
  MAX_SOCKETS: 24,
  /**
   * Idle sockets kept warm per provider.
   *
   * Four rather than one so that concurrent sign-ins do not each find the pool
   * empty. There is no value in more: this is an admin panel, and a fifth idle
   * socket to Cloudflare would sit unused until the provider closed it.
   */
  MAX_FREE_SOCKETS: 4,
  /**
   * How long an idle socket is kept before we close it.
   *
   * ═══ WHY THIS IS BOUNDED AT ALL, AND WHY THE NUMBER IS BELOW THE PROVIDER'S ══
   *
   * The hazard of pooling is a socket the SERVER has already closed: reusing one
   * fails the request, and `siteVerify` has no retry (deliberately — see there), so
   * it would surface as `captcha_provider_unavailable` on a legitimate sign-in.
   * Closing first, comfortably inside the provider's own keep-alive, is what keeps
   * that from happening.
   *
   * Two minutes because all three providers were measured holding a connection open
   * across a 60-second idle gap and beyond, while typical edge keep-alive timeouts
   * are several minutes. It is also far past the point of diminishing returns: the
   * gap between four seconds and two minutes is where essentially all of the benefit
   * is, and stretching it further buys little while moving closer to the provider's
   * own limit.
   *
   * Applies to in-flight sockets too, but is not the request timeout — that stays
   * `AbortSignal.timeout(config.CAPTCHA_TIMEOUT_MS)`, capped at 15 seconds, which
   * always fires first.
   */
  FREE_SOCKET_TIMEOUT_MS: 2 * 60_000,
} as const;

/** What `postForm` returns: the slice of a `fetch` Response this file actually
 *  used, so the branches below are unchanged. */
interface FormPostResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
}

/**
 * Server-side verifier for every captcha provider this deployment accepts.
 *
 * Tokens are always verified with the provider that issued them — named by the
 * caller, checked against that provider's own secret — with the client IP
 * included as a cross-check. A provider outage, malformed response, invalid
 * hostname, or an unconfigured provider is a refusal: authentication endpoints
 * must never turn a captcha failure into a bypass.
 */
@Injectable()
export class CaptchaService implements CaptchaVerifier, OnModuleDestroy {
  private readonly logger = new Logger('Captcha');

  /**
   * The pooled HTTPS agent every siteverify call goes through.
   *
   * An instance field rather than a module-level singleton: this class is provided
   * once (`CaptchaModule` binds `CAPTCHA_VERIFIER` to it with `useExisting`), so the
   * agent is a singleton by construction AND has an owner whose lifecycle Nest
   * already manages. A module-level agent would be a singleton too, but nothing
   * would be responsible for closing it.
   *
   * One agent for all three providers: `https.Agent` keys its pools by origin, so
   * Cloudflare, Google and hCaptcha get separate socket pools out of this one object.
   */
  private readonly agent = new https.Agent({
    keepAlive: true,
    maxSockets: POOL.MAX_SOCKETS,
    maxFreeSockets: POOL.MAX_FREE_SOCKETS,
    timeout: POOL.FREE_SOCKET_TIMEOUT_MS,
  });

  constructor(
    private readonly cache: CacheService,
    private readonly settings: CaptchaSettingsService,
  ) {}

  /**
   * Close the pooled sockets on shutdown.
   *
   * `main.ts` calls `enableShutdownHooks()`, and a keep-alive agent holds open
   * sockets that would otherwise keep the process alive past its last request —
   * turning a deploy into a container the orchestrator has to kill. The same reason
   * `MailService` closes its SMTP pool.
   */
  onModuleDestroy(): void {
    this.agent.destroy();
  }

  /**
   * Every live provider and its site key. Read at `step: 'start'`.
   *
   * ═══ `enabled` IS `config.captchaEnabled`, AND NOTHING ELSE ════════════════
   *
   * NOT `providers.length > 0`. The two used to be the same number, because the
   * provider list came only from env — and now that a database can narrow that
   * list, deriving one from the other would mean a bad row, a failed query or an
   * empty table could report `enabled: false` on the public login route. `verify`
   * treats that as "skip verification entirely", so the tidier-looking expression
   * turns a database hiccup into a captcha bypass.
   *
   * Whether verification RUNS is an env question and is answered by env.
   * WHICH providers are offered is the database's question. Merging them is the
   * one mistake this whole mechanism is built to make impossible.
   *
   * `live()` is a field read, so this stays synchronous.
   */
  describe(): CaptchaDescriptor {
    return {
      enabled: config.captchaEnabled,
      providers: this.settings.live(),
    };
  }

  async verify(input: CaptchaVerification): Promise<void> {
    // Development with NO provider configured at all. Production cannot reach
    // this branch — config.ts refuses to boot with an empty provider list — so
    // this can never silently disable a live defence, which is the only reason it
    // is tolerable to have a "skip verification" path in an auth service at all.
    if (!config.captchaEnabled) {
      this.logger.warn('no captcha provider is configured; skipping verification');
      return;
    }

    // FIRST, before the provider is contacted. That ordering is the entire point
    // of the penalty: a caller serving a wait costs us nothing, where a refusal
    // issued after `siteVerify` would still spend a siteverify call — which is
    // the quota an attacker was burning in the first place.
    await this.assertNotPenalised(input.ip);

    try {
      // Reached only when a provider IS configured, so an absent one is a refusal
      // rather than the local-development skip handled above.
      if (input.provider === null || !isCaptchaProvider(input.provider)) {
        throw new ProblemException({
          type: ERR.CAPTCHA_PROVIDER_UNKNOWN,
          detail: `captchaProvider is required and must be one of: ${CAPTCHA_PROVIDERS.join(', ')}`,
        });
      }

      // Named a provider an operator has taken out of rotation. A REFUSAL, and
      // deliberately the same `captcha_provider_unavailable` an unconfigured
      // provider gets: from the caller's side the two are one situation with one
      // remedy — pick another provider — and a page holding a list from before the
      // toggle is the ordinary way to arrive here, not an attack.
      //
      // It must not reach `recordFailure`, and does not: the catch below counts
      // only CAPTCHA_FAILED. Charging the ladder here would penalise a caller for
      // using a provider that was live when their page loaded.
      if (!this.settings.live().some((option) => option.provider === input.provider)) {
        this.logger.warn(
          { provider: input.provider },
          'refused a captcha token for a provider that is disabled in the database',
        );
        throw new ProblemException({ type: ERR.CAPTCHA_PROVIDER_UNAVAILABLE });
      }

      // The line that keeps a client-named provider from being a bypass: naming a
      // provider this deployment has no secret for is a REFUSAL, never a skip.
      //
      // Unreachable by construction now — `live()` is a subset of the providers
      // that HAVE a secret, so the check above already refused anything this one
      // would catch. Kept anyway, for the same reason `isCaptchaProvider` is kept
      // after the null check: it is the invariant written down where it is relied
      // on, and it costs a string comparison to keep a bypass impossible rather
      // than merely improbable.
      const secret = secretFor(input.provider);
      if (secret === '') {
        this.logger.error({ provider: input.provider }, 'captcha provider is not configured');
        throw new ProblemException({ type: ERR.CAPTCHA_PROVIDER_UNAVAILABLE });
      }

      const verified = await this.siteVerify(input.provider, input, secret);
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
      // — a timeout, a provider 5xx, malformed JSON — is our fault or
      // Cloudflare's, and counting it would turn a provider incident into a
      // self-inflicted lockout of every legitimate admin within minutes. This
      // condition is the one line here that is easy to "tidy" into an outage
      // amplifier.
      if (err instanceof ProblemException && err.type === ERR.CAPTCHA_FAILED) {
        await this.recordFailure(input.ip);
      }
      throw err;
    }

    // Reached only when every check passed. Solving a captcha is proof the caller
    // is not what the penalty targets, so the streak is wiped rather than left to
    // expire — otherwise someone who fumbled twice would carry it for the rest of
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
   * That is the right direction, and for a concrete reason — the captcha itself
   * is still fully verified with the provider on every request. Losing Redis
   * degrades quota protection; it can never become a captcha bypass.
   */
  private async assertNotPenalised(ip: string): Promise<void> {
    const remaining = await this.cache.cooldownRemaining(KEYS.captcha.block(ip));
    if (remaining <= 0) return;

    this.logger.warn(
      { retryAfterSeconds: remaining },
      'refused a captcha attempt during a penalty',
    );
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
   * `rate_limited` — it genuinely did fail a captcha, and reporting a wait it has
   * not yet been asked to serve would be a less honest answer. The next attempt
   * is the one that meets `assertNotPenalised`.
   */
  private async recordFailure(ip: string): Promise<void> {
    const { limit, windowSeconds } = LIMITS.CAPTCHA_FAILURE_BY_IP;

    const failures = await this.cache.increment(KEYS.captcha.failures(ip), windowSeconds);
    if (failures < limit) return;

    // Which rung: first trip serves the first entry, and the ladder stops
    // climbing at the last one rather than running off the end.
    const strike = await this.cache.increment(
      KEYS.captcha.strikes(ip),
      CAPTCHA.STRIKE_TTL_SECONDS,
    );
    const rung = Math.min(Math.max(strike, 1), CAPTCHA.BLOCK_LADDER_SECONDS.length) - 1;
    const seconds = CAPTCHA.BLOCK_LADDER_SECONDS[rung] as number;

    // `allow`, and the ONLY `allow` among the five `cache.set` call sites. A
    // penalty we could not write costs enforcement, never correctness: the real
    // defence is the provider's own verdict, which still runs with Redis down. The
    // rest of this file is fail-open for the same reason — `increment` returns 0 on
    // failure, which reads as "no failures recorded", so a cache we cannot write
    // must not be able to penalise anyone either.
    await this.cache.set(KEYS.captcha.block(ip), '1', seconds, 'allow');
    // The window that produced this penalty is spent. Left in place it would
    // still be over the limit when the block lifts, so the very next failure
    // would trip the next rung immediately.
    await this.cache.clear(KEYS.captcha.failures(ip));

    this.logger.warn(
      { failures, strike, blockedForSeconds: seconds },
      'captcha failures tripped the limit; penalty applied',
    );
  }

  /** `provider` is passed separately because `input.provider` is nullable and the
   *  caller has already narrowed it — TypeScript cannot carry that through. */
  private async siteVerify(
    provider: CaptchaProvider,
    input: CaptchaVerification,
    secret: string,
  ): Promise<ProviderResponse> {
    const form = new URLSearchParams({
      secret,
      response: input.token,
      remoteip: input.ip,
    });

    let response: FormPostResult;
    try {
      response = await this.postForm(
        verifyUrlFor(provider),
        form,
        AbortSignal.timeout(config.CAPTCHA_TIMEOUT_MS),
      );
    } catch (err) {
      this.logger.error(
        { provider, err },
        'captcha verification request failed',
      );
      throw new ProblemException({ type: ERR.CAPTCHA_PROVIDER_UNAVAILABLE });
    }

    if (!response.ok) {
      this.logger.error(
        { provider, status: response.status },
        'captcha verification provider returned an HTTP error',
      );
      throw new ProblemException({ type: ERR.CAPTCHA_PROVIDER_UNAVAILABLE });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.body) as unknown;
    } catch (err) {
      this.logger.error(
        { provider, err },
        'captcha provider returned invalid JSON',
      );
      throw new ProblemException({ type: ERR.CAPTCHA_PROVIDER_UNAVAILABLE });
    }

    return parseProviderResponse(payload);
  }

  /**
   * One form POST over the pooled agent.
   *
   * Replaces a bare `fetch()` and is deliberately the same shape: same method, same
   * `content-type`, same body, same abort signal, and no retry. `content-length` is
   * added because `https.request` will not derive it the way `fetch` does — without
   * it the request would be sent chunked, which some siteverify endpoints reject.
   *
   * ─── Two things here that are not decoration ───────────────────────────────
   *
   * The response is ALWAYS read to the end, including on a non-2xx status. A socket
   * whose body was never consumed cannot go back to the free pool, so bailing out
   * early on an HTTP error would leak exactly the connection this change exists to
   * reuse — and the caller would then pay the handshake again anyway.
   *
   * `req.destroy()` on abort or error, so a timed-out request does not leave a
   * half-read socket in the pool for the next caller to inherit.
   *
   * Rejects for every transport-level failure — DNS, connect, TLS, abort, socket
   * error. `siteVerify`'s catch turns all of them into
   * `captcha_provider_unavailable`, which is what `fetch` produced too.
   */
  private postForm(
    target: string,
    form: URLSearchParams,
    signal: AbortSignal,
  ): Promise<FormPostResult> {
    const url = new URL(target);
    const body = form.toString();

    return new Promise<FormPostResult>((resolve, reject) => {
      const req = https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          agent: this.agent,
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(body),
          },
          signal,
        },
        (res) => {
          res.setEncoding('utf8');
          let text = '';
          res.on('data', (chunk: string) => {
            text += chunk;
          });
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            // `fetch`'s own definition of `ok`, kept verbatim so the branch above
            // behaves identically.
            resolve({ ok: status >= 200 && status < 300, status, body: text });
          });
          res.on('error', (err) => {
            req.destroy();
            reject(err);
          });
        },
      );

      req.on('error', (err) => {
        req.destroy();
        reject(err);
      });

      req.end(body);
    });
  }

  private assertHostname(provider: CaptchaProvider, hostname: string | null): void {
    const normalised = hostname?.toLowerCase() ?? null;
    if (normalised !== null && config.captchaAllowedHostnames.includes(normalised)) return;

    this.logger.warn(
      {
        provider,
        hostname: normalised,
        allowedHostnames: config.captchaAllowedHostnames,
      },
      'captcha token has an untrusted hostname',
    );
    throw new ProblemException({ type: ERR.CAPTCHA_FAILED });
  }

  private assertRecaptchaV3(input: CaptchaVerification, verified: ProviderResponse): void {
    if (
      verified.action !== input.action ||
      verified.score === null ||
      verified.score < config.CAPTCHA_RECAPTCHA_V3_MIN_SCORE
    ) {
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
}

/**
 * The secret that verifies this provider's tokens.
 *
 * An exhaustive switch rather than a lookup keyed on a string, so adding a
 * provider to `CAPTCHA_PROVIDERS` without giving it a secret fails the build. The
 * failure mode of the alternative is silent and bad: a new provider that returns
 * `undefined` here would be indistinguishable from an unconfigured one.
 */
function secretFor(provider: CaptchaProvider): string {
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

function verifyUrlFor(provider: CaptchaProvider): string {
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
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
