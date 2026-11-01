/**
 * The captcha port.
 *
 * Four providers are named because the product switches between them from the
 * admin surface, and the *request contract* has to be final before that surface
 * exists — a client sends `captchaProvider` with every captcha-bearing request
 * from day one, so turning verification on later changes no DTO, no route, and
 * no caller.
 *
 * `CaptchaService` verifies every token server-side with its issuing provider.
 *
 * This file imports nothing. `src/config.ts` reads `CAPTCHA_PROVIDERS` from here to
 * build its provider list, so anything imported here would be pulled into config's
 * import cycle.
 */

export const CAPTCHA_PROVIDERS = ['TURNSTILE', 'RECAPTCHA_V2', 'RECAPTCHA_V3', 'HCAPTCHA'] as const;

export type CaptchaProvider = (typeof CAPTCHA_PROVIDERS)[number];

/** Server-owned operation names; reCAPTCHA v3 tokens must be issued for one. */
export const CAPTCHA_ACTIONS = {
  REGISTER_START: 'register_start',
  LOGIN_PASSWORD: 'login_password',
  LOGIN_OTP_REQUEST: 'login_otp_request',
  PASSWORD_FORGOT: 'password_forgot',
} as const;

export type CaptchaAction = (typeof CAPTCHA_ACTIONS)[keyof typeof CAPTCHA_ACTIONS];

export interface CaptchaVerification {
  readonly provider: CaptchaProvider;
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
 * What the login and registration pages need in order to render a challenge.
 *
 * `providers` is the env set minus whatever an operator has disabled in
 * `admin.admin_captcha_providers`, so a page can render the first, or offer a
 * choice, without a second copy of the deployment's configuration in the frontend.
 *
 * ─── `enabled` MEANS SOMETHING DIFFERENT HERE THAN IN THE ADMIN BACKEND ─────
 *
 * The shape is deliberately identical so one frontend type serves both surfaces,
 * but the two fields are not computed the same way and must not be.
 *
 * In the admin service `enabled` is `config.captchaEnabled`, and it gates a real
 * "skip verification entirely" branch that exists so a developer can sign in with
 * no provider account. Deriving it from `providers.length` there would let a bad
 * database row turn captcha OFF on a public login route.
 *
 * This service has no such branch — `verify` always runs, whatever this says — so
 * here `enabled` is purely what the page should render, and `providers.length > 0`
 * is both safe and the honest answer. A development deployment with no secrets
 * configured reports `false`, which is exactly right: there is nothing to mount.
 */
export interface CaptchaDescriptor {
  readonly enabled: boolean;
  readonly providers: readonly CaptchaOption[];
}

/**
 * Resolves or throws — there is no boolean return, on purpose. A verifier that
 * returns `false` invites a caller to forget to check it; one that throws
 * `captcha_failed` cannot be silently ignored.
 */
export interface CaptchaVerifier {
  verify(input: CaptchaVerification): Promise<void>;
  /** Every live provider and its site key. Read by `GET /auth/captcha`. */
  describe(): CaptchaDescriptor;
}

/** DI token — the interface cannot be one, since it does not exist at runtime. */
export const CAPTCHA_VERIFIER = Symbol('CAPTCHA_VERIFIER');

/**
 * Here rather than in captcha.service.ts, where it used to live.
 *
 * `captcha.settings.ts` needs it too, and importing it from the service would make
 * a cycle — the service depends on the settings snapshot.
 */
export function isCaptchaProvider(value: string): value is CaptchaProvider {
  return (CAPTCHA_PROVIDERS as readonly string[]).includes(value);
}
