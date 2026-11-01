import { z } from 'zod';
import type { OauthFlow } from '../../../auth/oauth/provider.port';
import type { LinkedSocialAccount, SocialAccountsStatus } from './link-accounts.types';

/**
 * The wire shapes for Settings → Social accounts.
 *
 * Four operations across three routes, and the split is not stylistic:
 *
 *   `GET  …/social-accounts`           what is linked, and what is left to link
 *   `POST …/social-accounts/verify`    prove the mailbox and a factor, earn a ticket
 *   `POST …/social-accounts/start`     spend the ticket, get the authorization URL
 *   `POST …/social-accounts/callback`  finish, and write the link
 *
 * ─── Why `start` and `callback` are two ROUTES, not one `action` union ──────
 *
 * A Nest guard runs BEFORE the body is parsed. `start` wears `ElevationGuard`, which
 * reads the ticket with GETDEL — so on a shared handler the guard would spend the
 * single-use ticket without knowing which action had been asked for, and a
 * `callback` request would destroy the ticket a `start` was about to need.
 *
 * This is not hypothetical. `POST /auth/link` and `POST /auth/link/preview` were one
 * route with an `action` discriminator and had exactly this bug: `preview` really did
 * consume the ticket, and the `confirm` that followed failed with `reauth_required`.
 * Splitting them is what lets the ROUTE define the action, which is the property that
 * matters — the handler beneath `@RequiresElevation` can only perform the write it
 * names. See the header of auth/dto/link.dto.ts.
 *
 * `verify` keeps a discriminant precisely because it wears no guard: nothing is spent
 * before the body is read, so the two halves of one ceremony can share a path the way
 * every other settings surface's enable flow does.
 */

/**
 * The five providers that EXIST. Configuration decides which are OFFERED — see
 * `OauthProviderRegistry.require`, which refuses an unconfigured one with
 * `oauth_provider_unsupported`.
 *
 * Repeated here rather than imported from auth/dto/login.dto.ts, which does not
 * export it. That is the convention this module follows rather than works around:
 * settings DTOs keep their vocabulary schemas private, so a change to one route's
 * validation is never silently a change to another's.
 *
 * UPPERCASE, matching the Prisma enum and every existing OAuth request and response
 * on this service. A settings screen that spelled providers in lower case would be
 * the only surface that did.
 */
const providerSchema = z.enum(['GOOGLE', 'X', 'TELEGRAM', 'APPLE', 'FACEBOOK']);

/**
 * The emailed code, as typed.
 *
 * Deliberately loose — `min(1).max(64)` rather than six digits — for the reason the
 * login schemas give: a format rule at the door tells a caller which guesses were
 * well-formed before any comparison ran, and it would reject a code the moment its
 * format changed. The real bound is the attempt counter on the challenge row.
 */
const codeSchema = z.string().min(1).max(64);

/**
 * The WebAuthn assertion, passed through to `@simplewebauthn/server`.
 *
 * `passthrough` rather than a mirrored schema: the library owns this shape, it
 * changes with the spec, and every field is verified cryptographically downstream. A
 * second copy here would only be a place for the two to disagree. Same decision as
 * `webauthnResponseSchema` in 2fa.dto.ts.
 */
const passkeySchema = z.object({ id: z.string().min(1) }).passthrough();

// ─── POST /settings/security/social-accounts/verify ─────────────────────────

/**
 * Ask what this account can prove.
 *
 * Takes no provider: the proof is about the ACCOUNT, and a per-provider challenge
 * would mean a user who changed their mind between Google and Apple had to prove
 * themselves twice for one decision.
 */
const challengeSchema = z.object({ action: z.literal('challenge') }).strict();

/**
 * Prove it, and receive a ticket.
 *
 * `emailCode` is REQUIRED — on every path, for every account, whether or not a factor
 * is enrolled. That is the one thing this ceremony always costs, and making it
 * required in the schema rather than in the service means a client that forgets it
 * gets a validation error naming the field instead of a refusal that has already
 * charged an attempt.
 *
 * The two factor fields are optional because an account with nothing enrolled owes
 * neither. Which of them is acceptable is decided by the service against what the
 * account actually holds — see `LinkAccountsService.verify`. Sending BOTH is refused
 * there rather than here, because "exactly one" is a statement about the account's
 * enrolment as much as about the body.
 */
const verifySchema = z
  .object({
    action: z.literal('verify'),
    emailCode: codeSchema,
    totpCode: codeSchema.optional(),
    passkey: passkeySchema.optional(),
    /**
     * Which write the resulting ticket may be spent on.
     *
     * Link and unlink owe the SAME proof — an emailed code plus one enrolled factor —
     * so they share this route rather than each growing a `/verify` of their own. What
     * they must not share is the ticket: a permit for attaching a provider is not a
     * permit for removing one. The two are told apart by the action named here, and
     * `ElevationService.spend` refuses a ticket presented to the wrong route.
     *
     * Defaulted rather than required, so every client and every stored request written
     * before unlink existed keeps meaning exactly what it meant.
     */
    intent: z.enum(['link', 'unlink']).default('link'),
  })
  .strict();

export const linkVerifyRequestSchema = z.discriminatedUnion('action', [
  challengeSchema,
  verifySchema,
]);

export type LinkVerifyRequest = z.infer<typeof linkVerifyRequestSchema>;
export type LinkChallengeRequest = Extract<LinkVerifyRequest, { action: 'challenge' }>;
export type LinkProveRequest = Extract<LinkVerifyRequest, { action: 'verify' }>;

// ─── POST /settings/security/social-accounts/start ──────────────────────────

/**
 * Begin the provider round trip.
 *
 * `.strict()` on all three bodies below, and it is load-bearing rather than tidy: a
 * client that sent `action: 'callback'` to this route would otherwise have the field
 * silently dropped and get a START — spending its elevation ticket on the wrong half
 * of the ceremony. A loud validation error is the only honest answer to a field this
 * route does not read.
 */
export const linkStartRequestSchema = z
  .object({
    provider: providerSchema,
    /**
     * Where the provider sends the user back.
     *
     * Optional, and checked against this deployment's configured URI for that
     * provider — accepting an arbitrary value would be an open redirect that hands
     * the authorization code to whoever asked. See `OauthService.resolveRedirectUri`,
     * which is the one place that decides.
     */
    redirectUri: z.string().url().max(2048).optional(),
  })
  .strict();

export type LinkStartRequest = z.infer<typeof linkStartRequestSchema>;

// ─── POST /settings/security/social-accounts/callback ───────────────────────

export const linkCallbackRequestSchema = z
  .object({
    provider: providerSchema,
    /**
     * The authorization code — or, for Telegram, the provider's signed payload
     * verbatim. One field rather than two because the service treats it as opaque
     * and only the adapter interprets it, which is also what keeps this contract
     * identical to `oauth-callback`'s.
     */
    code: z.string().min(1).max(2048),
    state: z.string().min(1).max(512),
  })
  .strict();

export type LinkCallbackRequest = z.infer<typeof linkCallbackRequestSchema>;

// ─── POST /settings/security/social-accounts/unlink ─────────────────────────

/**
 * The provider, and deliberately nothing else.
 *
 * No link id, no user id, no provider subject, no token. The row is resolved from the
 * authenticated principal plus this one value, which is what makes unlinking somebody
 * else's account unreachable through the API rather than merely checked for — there is
 * no field on which to name another account's link.
 *
 * `.strict()` for `linkStartRequestSchema`'s reason: a body carrying an extra field is
 * a client that believes something this route does not do, and silently dropping it
 * would spend the elevation ticket on a write the caller did not mean.
 */
export const linkUnlinkRequestSchema = z.object({ provider: providerSchema }).strict();

export type LinkUnlinkRequest = z.infer<typeof linkUnlinkRequestSchema>;

// ─── responses ──────────────────────────────────────────────────────────────

export interface SocialAccountsStatusPayload extends SocialAccountsStatus {
  readonly outcome: 'social_accounts_status';
}

/**
 * What this account can prove, plus the WebAuthn options when it holds a passkey.
 *
 * `methods` is empty for an account with nothing enrolled, and that is the signal a
 * client needs: it means the emailed code alone will do, so no factor prompt should
 * be rendered. `options` is null whenever there is no passkey to assert.
 *
 * `recovery_code` never appears here. A backup code cannot attach a provider.
 */
export interface LinkChallengePayload {
  readonly outcome: 'social_link_challenge';
  readonly methods: readonly string[];
  readonly options: Record<string, unknown> | null;
  /** Whether an emailed code is owed. Always true — stated rather than left to be
   *  inferred, so a client never has to guess whether this ceremony is the cheap one. */
  readonly emailCodeRequired: true;
}

/** A single-use permit for ONE link start. Present it in `x-elevation-ticket`. */
export interface LinkElevatedPayload {
  readonly outcome: 'social_link_elevated';
  readonly ticket: string;
  readonly expiresInSeconds: number;
  readonly action: string;
}

/**
 * Where to send the user.
 *
 * `url` is null for Telegram, which has no authorization endpoint — `flow` is
 * `signed-payload` and the client renders the Login Widget instead of navigating.
 * That is the same contract `POST /auth/login {step:'oauth-start'}` returns, so a
 * client that has implemented one has implemented both.
 *
 * `state` is echoed so the client can carry it to the callback. It is not a secret
 * and it authorises nothing: the entry behind it is bound to this account, this
 * login, this device and this network.
 */
export interface LinkStartedPayload {
  readonly outcome: 'social_account_link_started';
  readonly provider: string;
  readonly url: string | null;
  readonly state: string;
  readonly flow: OauthFlow;
}

/** The link was written. Carries the same fields the status screen renders, so a
 *  client can insert the row without a second round trip.
 *
 *  Also the answer when a re-link CANCELLED a pending removal: nothing new was
 *  written, and the `unlinkAt: null` it carries is how the client sees that. */
export interface SocialAccountLinkedPayload extends LinkedSocialAccount {
  readonly outcome: 'social_account_linked';
}

/**
 * The removal was SCHEDULED. Nothing has been unlinked.
 *
 * The outcome says `scheduled` rather than `unlinked` because the account is still
 * linked when this is returned and stays that way until `unlinkAt` — a client that
 * removed the row from its list on seeing this would be showing the user something
 * untrue for a week. `GET …/social-accounts` keeps listing the provider, now with the
 * same `unlinkAt`.
 *
 * Idempotent: asking again before the deadline returns the ORIGINAL `unlinkAt`
 * unchanged rather than pushing it out or refusing.
 */
export interface SocialAccountUnlinkScheduledPayload {
  readonly outcome: 'social_account_unlink_scheduled';
  readonly provider: string;
  readonly unlinkAt: string;
}

export type LinkAccountsPayload =
  | SocialAccountsStatusPayload
  | LinkChallengePayload
  | LinkElevatedPayload
  | LinkStartedPayload
  | SocialAccountLinkedPayload
  | SocialAccountUnlinkScheduledPayload;
