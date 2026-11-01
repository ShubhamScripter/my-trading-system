import { Injectable, Logger } from '@nestjs/common';
import type { OauthProvider } from '@prisma/client';
import { createHash, createHmac } from 'node:crypto';
import { config } from '../../src/config';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { safeEqual } from '../../src/utils/public.utils';
import type { OauthIdentity } from '../auth.types';
import type {
  AuthorizationRequest,
  OauthProviderAdapter,
  ProviderCapabilities,
  VerificationRequest,
} from './provider.port';

/**
 * How stale a Telegram payload may be.
 *
 * Telegram signs `auth_date` into the payload and recommends checking it, and here
 * it is doing real work rather than hygiene: the signature never expires on its own,
 * so without this a payload captured from a URL or a log is valid forever. Fifteen
 * minutes covers a user who authorises, gets distracted, and finishes — and the
 * single-use `state` is the other half of the replay defence.
 */
const MAX_AUTH_AGE_SECONDS = 15 * 60;

/**
 * The fields Telegram signs. Anything else in the payload is ignored.
 *
 * An allowlist rather than "every key except `hash`", and that difference is the
 * whole security property. Telegram builds its data-check string from the fields IT
 * sent; if we instead hashed every key present, a caller could append a key of their
 * own — it would go into our check string, not Telegram's, and the two would simply
 * disagree. That fails closed, so it is not an exploit. But it turns "an extra query
 * parameter on the callback URL" into a login that mysteriously never works, and the
 * allowlist is what makes an unexpected field harmless instead.
 */
const SIGNED_FIELDS = [
  'auth_date',
  'first_name',
  'id',
  'last_name',
  'photo_url',
  'username',
] as const;

/**
 * Telegram — not OAuth, and the shape of the whole integration follows from that.
 *
 * ─── There is no authorization endpoint ─────────────────────────────────────
 *
 * Telegram has no `/authorize` to redirect to and no code to exchange. The client
 * embeds the Login Widget, the user approves in Telegram, and the widget hands back
 * a small object of profile fields signed with an HMAC derived from the bot token.
 * `authorizationUrl` therefore returns null — there is nothing to send the user to,
 * and inventing a URL would give a client something to redirect to that cannot work.
 *
 * ─── How the shared controls are kept anyway ────────────────────────────────
 *
 * This is the part worth reading before wiring the frontend. `POST /auth/login
 * {mode:'oauth-start', provider:'TELEGRAM'}` still runs, still mints a single-use
 * `state`, and still parks the caller's IP class with it. It returns `url: null` and
 * `flow: 'signed-payload'`, and the client must then render the widget with
 * `data-auth-url` pointing at its own callback page WITH THAT STATE in the query
 * string — Telegram appends its own parameters to whatever `auth_url` is given, so
 * the state survives the round trip.
 *
 * The callback is then an ordinary `oauth-callback` carrying that `state` and the
 * signed payload as `code`. Which means Telegram inherits, unchanged: single-use
 * state, IP-class binding, the rate limits, the blocklist, the linked/unlinked
 * decision and the second factor. Skipping `oauth-start` for it — the tempting
 * shortcut, since Telegram does not need a redirect — would have thrown all six
 * away.
 *
 * ─── No email, ever ────────────────────────────────────────────────────────
 *
 * Telegram accounts are phone numbers. There is no email in the payload and no
 * endpoint that would supply one, so like X this is a link-only provider: it can be
 * attached to an existing account and can sign it in, but it cannot create one.
 *
 * ─── Not the Mini App algorithm ────────────────────────────────────────────
 *
 * Telegram has a SECOND signing scheme, for Mini Apps (`initData`), where the secret
 * is `HMAC(bot_token, "WebAppData")` rather than `SHA256(bot_token)`. They are not
 * interchangeable and a payload from one will never verify under the other. This is
 * the Login Widget scheme. If a Mini App is ever added it needs its own adapter, not
 * a flag here.
 */
@Injectable()
export class TelegramAdapter implements OauthProviderAdapter {
  readonly provider: OauthProvider = 'TELEGRAM';

  readonly capabilities: ProviderCapabilities = {
    flow: 'signed-payload',
    providesEmail: 'never',
    // Neither applies: there is no authorization request to attach them to.
    supportsPkce: false,
    supportsNonce: false,
    assertsEmailVerified: false,
  };

  private readonly logger = new Logger('TelegramAdapter');

  /**
   * Empty, and it has to be.
   *
   * Telegram redirects to whatever `auth_url` the widget was given, and that URL is
   * configured in the bot's domain settings at Telegram rather than here. There is no
   * value for the service to compare a caller's `redirectUri` against, so a caller
   * must not send one — `resolveRedirectUri` refuses a mismatch, and every non-empty
   * value mismatches an empty string.
   */
  readonly configuredRedirectUri = '';

  isConfigured(): boolean {
    return config.telegramEnabled;
  }

  /** Null — see the class comment. The service turns this into a refusal that
   *  explains the widget, rather than a redirect that would go nowhere. */
  authorizationUrl(_request: AuthorizationRequest): string | null {
    return null;
  }

  async verify(request: VerificationRequest): Promise<OauthIdentity> {
    // Nothing here is asynchronous — no exchange, no key fetch, one HMAC. The
    // signature is `Promise`-returning because the port is, and an adapter that
    // could not be swapped for a networked one would be the wrong abstraction.
    const payload = parsePayload(request.code);

    const hash = payload.get('hash');
    if (hash === null || hash === '') {
      this.logger.warn('telegram payload carried no hash');
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }

    this.assertSignature(payload, hash);
    this.assertFresh(payload.get('auth_date'));

    const id = payload.get('id');
    if (id === null || id === '') {
      this.logger.warn('telegram payload carried no id');
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }

    // The display name is a seed for username generation and nothing more, so any
    // of the three is acceptable and none is authoritative. Telegram guarantees only
    // `first_name`; `username` is optional and `last_name` frequently absent.
    const fullName = [payload.get('first_name'), payload.get('last_name')]
      .filter((part): part is string => part !== null && part !== '')
      .join(' ');

    return {
      provider: 'TELEGRAM',
      subject: id,
      email: null,
      emailVerified: false,
      name: fullName === '' ? payload.get('username') : fullName,
      avatarUrl: payload.get('photo_url'),
    };
  }

  /**
   * The HMAC check. This is the entire authentication of a Telegram login.
   *
   * `secret = SHA256(bot_token)` and the message is the signed fields as `key=value`
   * lines, sorted by key and joined with newlines. Both details are Telegram's and
   * neither is negotiable: a different sort order or a different separator produces a
   * different digest, which is why the field list above is sorted at rest rather than
   * at runtime where a refactor could reorder it.
   *
   * `safeEqual` on the comparison, matching every other secret comparison in the
   * service. Absent fields are omitted from the check string entirely rather than
   * included as empty — Telegram does not send `last_name` for a user who has none,
   * and signing `last_name=` would not match what it signed.
   */
  private assertSignature(payload: URLSearchParams, hash: string): void {
    const checkString = SIGNED_FIELDS.filter((field) => payload.get(field) !== null)
      .map((field) => `${field}=${payload.get(field) ?? ''}`)
      .join('\n');

    const secret = createHash('sha256').update(config.TELEGRAM_BOT_TOKEN).digest();
    const expected = createHmac('sha256', secret).update(checkString).digest('hex');

    if (!safeEqual(hash, expected)) {
      // The check string is logged because a mismatch is almost always a field the
      // client re-serialised — `id` arriving as a JSON number then written back with
      // different formatting is the classic one — and there is no way to see that
      // without the exact bytes that were hashed. It contains no secret: every field
      // in it came from the request.
      this.logger.warn({ checkString }, 'telegram payload signature did not verify');
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }
  }

  /**
   * Refuse a payload older than the window.
   *
   * Checked AFTER the signature, deliberately: `auth_date` is only meaningful once
   * we know Telegram signed it, and reading it first would be acting on a number the
   * caller could have chosen.
   */
  private assertFresh(authDate: string | null): void {
    const seconds = Number(authDate);
    if (!Number.isFinite(seconds)) {
      this.logger.warn({ authDate }, 'telegram payload had no usable auth_date');
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }

    const age = Math.floor(Date.now() / 1000) - seconds;
    // A negative age is a payload dated in the future — clock skew at Telegram or a
    // fabricated value that happened to verify, which cannot occur, but the bound is
    // free and an unbounded future date would never expire.
    if (age > MAX_AUTH_AGE_SECONDS || age < -MAX_AUTH_AGE_SECONDS) {
      this.logger.warn({ age }, 'telegram payload outside the freshness window');
      throw new ProblemException({ type: ERR.OAUTH_STATE_INVALID });
    }
  }
}

/**
 * Accept the payload in either form the widget produces.
 *
 * The redirect mode gives a query string; the JS-callback mode gives an object the
 * client has to serialise itself. Both are supported because forcing one would make
 * the frontend transform the other, and every transformation of a signed payload is
 * a chance to change a byte that was signed.
 *
 * JSON numbers are stringified with `String`, which is exactly what the check string
 * needs — Telegram signs the decimal digits. A client that formats `id` any other way
 * (padding, exponent notation, a float) breaks the signature, and `assertSignature`
 * logs the check string precisely so that is visible rather than mysterious.
 */
function parsePayload(raw: string): URLSearchParams {
  const trimmed = raw.trim();

  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      // Objects and arrays are dropped rather than stringified: Telegram sends only
      // scalars, and `[object Object]` in a check string is never what was signed.
      if (typeof value === 'object') continue;
      params.set(key, String(value));
    }
    return params;
  }

  // A leading `?` is what a client gets from `window.location.search`, and passing it
  // through verbatim is the likeliest way this arrives.
  return new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
}
