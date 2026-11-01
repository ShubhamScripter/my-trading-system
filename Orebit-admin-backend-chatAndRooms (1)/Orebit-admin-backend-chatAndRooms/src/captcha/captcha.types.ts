/**
 * The captcha port.
 *
 * Four providers are named and ANY NUMBER of them may be live at once — the same
 * contract the consumer backend uses. A client sends `captchaProvider` alongside
 * `captchaToken` on every captcha-bearing request, and the server verifies the
 * token with that provider's own siteverify endpoint using that provider's secret.
 *
 * ─── Why a client-named provider is safe here ───────────────────────────────
 *
 * Naming a provider is not choosing whether to be verified. The server holds one
 * secret per provider, and:
 *
 *  - a provider with no secret configured is `captcha_provider_unavailable`, a
 *    refusal — never a skip. An attacker cannot name an unconfigured provider to
 *    get waved through.
 *  - a token minted by provider A and presented as provider B fails B's
 *    siteverify, because B has never issued it.
 *
 * So the field selects WHICH verification runs, never WHETHER one runs. What it
 * buys is a request contract that is final before the provider mix changes:
 * enabling hCaptcha alongside Turnstile changes configuration, not a DTO.
 *
 * The login page still learns which providers are live from
 * `POST /auth/login {"step":"start"}` rather than hardcoding the list.
 *
 * This file imports nothing. `src/config.ts` reads `CAPTCHA_PROVIDERS` from here
 * to build its enum, so anything imported here would be pulled into config's
 * import cycle.
 */

export const CAPTCHA_PROVIDERS = ['TURNSTILE', 'RECAPTCHA_V2', 'RECAPTCHA_V3', 'HCAPTCHA'] as const;

export type CaptchaProvider = (typeof CAPTCHA_PROVIDERS)[number];

/** Server-owned operation names; reCAPTCHA v3 tokens must be issued for one. */
export const CAPTCHA_ACTIONS = {
  LOGIN_PASSWORD: 'login_password',
} as const;

export type CaptchaAction = (typeof CAPTCHA_ACTIONS)[keyof typeof CAPTCHA_ACTIONS];

export interface CaptchaVerification {
  /**
   * Which provider issued the token. Selects the secret and the siteverify URL.
   *
   * Null when the caller sent no captcha at all. Whether that is acceptable is
   * `CaptchaService.verify`'s decision — it is fine with no provider configured
   * and a refusal otherwise — which is why this is nullable rather than the call
   * site checking `captchaEnabled` for itself.
   */
  readonly provider: CaptchaProvider | null;
  readonly token: string;
  /** The client IP, which every provider's siteverify accepts as a cross-check. */
  readonly ip: string;
  /** Required to bind a reCAPTCHA v3 token to the auth operation that requested it. */
  readonly action: CaptchaAction;
}

/** One live provider and the key the browser widget needs. The site key is public
 *  by design — it ships to the browser either way. */
export interface CaptchaOption {
  readonly provider: CaptchaProvider;
  readonly siteKey: string;
}

/**
 * What the login page needs in order to render a challenge.
 *
 * `providers` lists every provider with a secret configured, so a page can render
 * the first, or offer a choice, without a second copy of the deployment's
 * configuration living in the frontend.
 *
 * Empty with `enabled: false` in development where no secret is set, so a local
 * login needs no provider account. Production cannot reach that state — config.ts
 * refuses to boot without at least one fully configured provider.
 */
export interface CaptchaDescriptor {
  readonly enabled: boolean;
  readonly providers: readonly CaptchaOption[];
}

/**
 * One provider, as an OPERATOR sees it — which is a different question from what a
 * login page sees.
 *
 * `CaptchaDescriptor` answers "what can I render", so it lists only live providers
 * and says nothing about the rest. This answers "why is this one not live", which
 * needs the two independent reasons kept apart:
 *
 *   configured  this service has a SECRET for it in env. Not settable from the
 *               database, and the reason the database can only ever subtract.
 *   disabled    an operator switched it off in `admin.admin_captcha_providers`.
 *
 * `live` is `configured && !disabled` and is therefore derived, not stored. It is
 * returned anyway so a screen never has to recompute the rule — a second
 * implementation of it is a second chance to get it wrong.
 */
export interface CaptchaProviderState {
  readonly provider: CaptchaProvider;
  readonly configured: boolean;
  readonly disabled: boolean;
  readonly live: boolean;
  /** The site key, or null when the provider is not configured. */
  readonly siteKey: string | null;
  /** Why it was switched off. Null when there is no row, or the row gave no reason. */
  readonly reason: string | null;
  /** Who wrote the row, when it was written through the API. Null for a psql write. */
  readonly updatedByAdminId: string | null;
  /** Null when no row exists — i.e. the provider has never been toggled. */
  readonly updatedAt: Date | null;
}

/**
 * Resolves or throws — there is no boolean return, on purpose. A verifier that
 * returns `false` invites a caller to forget to check it; one that throws
 * `captcha_failed` cannot be silently ignored.
 */
export interface CaptchaVerifier {
  verify(input: CaptchaVerification): Promise<void>;
  describe(): CaptchaDescriptor;
}

/** DI token — the interface cannot be one, since it does not exist at runtime. */
export const CAPTCHA_VERIFIER = Symbol('CAPTCHA_VERIFIER');

export function isCaptchaProvider(value: string): value is CaptchaProvider {
  return (CAPTCHA_PROVIDERS as readonly string[]).includes(value);
}
