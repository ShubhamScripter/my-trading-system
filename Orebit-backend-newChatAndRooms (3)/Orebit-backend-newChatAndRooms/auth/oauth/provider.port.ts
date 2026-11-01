import type { OauthProvider } from '@prisma/client';
import type { OauthIdentity } from '../auth.types';

/**
 * ═══ THE PROVIDER PORT ══════════════════════════════════════════════════════
 *
 * `OauthService` owns the parts of third-party login that are the same for every
 * provider — the single-use `state`, the PKCE verifier, the IP-class binding, the
 * blocklist, the linked/unlinked decision, the second factor. An adapter owns the
 * parts that are irreducibly per-provider: where to send the user, and how to turn
 * what comes back into an `OauthIdentity` we are willing to believe.
 *
 * That split is why this file exists rather than a `switch (provider)` inside the
 * service. Every security control the Google path grew — and it grew several,
 * because each one was a finding — lives on the shared side. A new provider
 * inherits all of them by being unable to reach the flow any other way.
 *
 * ─── Capabilities, and why they are data rather than instanceof checks ──────
 *
 * The four providers being added do NOT all support the same primitives, and the
 * differences are not cosmetic:
 *
 *   - X and Telegram cannot give us an email address at all.
 *   - Facebook has no ID token, so there is no `nonce` to bind.
 *   - Telegram has no authorization-code flow whatsoever.
 *
 * A `switch` on the provider name would scatter those three facts across every
 * call site that cares. `ProviderCapabilities` states them once, as data the
 * service reads, so the shared flow adapts by asking rather than by knowing which
 * providers exist. Adding a fifth provider then changes one file.
 */

/**
 * How a provider's round trip is actually shaped.
 *
 * `oidc-code`   — authorization code, exchanged for an ID token we verify against
 *                 the provider's published keys. Google and Apple.
 * `oauth2-code` — authorization code, exchanged for an access token we then spend
 *                 on a userinfo call. No ID token, so no nonce. Facebook and X.
 * `signed-payload` — no authorization endpoint and no exchange. The provider hands
 *                 the browser a signed blob directly. Telegram alone, and the
 *                 reason `authorizationUrl` is allowed to return null.
 */
export type OauthFlow = 'oidc-code' | 'oauth2-code' | 'signed-payload';

/**
 * Whether an identity from this provider will carry an email address.
 *
 * `never` is the load-bearing value. An account cannot be REGISTERED without an
 * address — it is the login identifier, the recovery channel and the single factor
 * behind every account in this service — so a provider that cannot supply one can
 * only ever be ATTACHED to an account that already exists. The service reads this
 * to decide whether to offer the create branch at all, instead of discovering the
 * problem when `identity.email` turns out to be null.
 *
 * `sometimes` is not a weaker `always`: it means a successful, fully-verified
 * authorization can still arrive with no address, because the user declined the
 * scope (Facebook) or the provider only discloses it on first consent (Apple).
 * Both must degrade to the link-only path at runtime rather than erroring.
 */
export type EmailAvailability = 'always' | 'sometimes' | 'never';

export interface ProviderCapabilities {
  readonly flow: OauthFlow;
  readonly providesEmail: EmailAvailability;
  /**
   * The authorization request accepts an S256 `code_challenge`.
   *
   * Always true for the code flows here — X *requires* PKCE even for confidential
   * clients — but declared rather than assumed, because a provider that ignored
   * the parameter would make the verifier a comfort rather than a control, and
   * that is worth being able to see.
   */
  readonly supportsPkce: boolean;
  /**
   * The provider returns an ID token whose `nonce` echoes what we sent.
   *
   * False for the `oauth2-code` providers, and the consequence is worth naming: a
   * Facebook or X callback is bound to its request by `state` and the IP class
   * alone. `state` is single-use and server-side, so that is not nothing — but it
   * is one control rather than two, and `nonce` is the one that catches a token
   * minted for somebody else's authorization.
   */
  readonly supportsNonce: boolean;
  /**
   * Whether the address, when present, is one the provider has verified.
   *
   * Read straight into `OauthIdentity.emailVerified`, which decides whether an
   * OAuth registration skips our own OTP. A provider that merely repeats what the
   * user typed must report false — accepting that claim would let anyone who can
   * create an account there claim any address here.
   */
  readonly assertsEmailVerified: boolean;
}

/** What the service has already minted for this authorization request. */
export interface AuthorizationRequest {
  /** Where the provider sends the user back. Already validated by the service. */
  readonly redirectUri: string;
  /** The single-use handle the service parked in Redis. */
  readonly state: string;
  /** S256 challenge, or null when `supportsPkce` is false. */
  readonly codeChallenge: string | null;
  /** OIDC nonce, or null when `supportsNonce` is false. */
  readonly nonce: string | null;
}

/** What came back, and what it has to agree with. */
export interface VerificationRequest {
  /**
   * The authorization code — or, for `signed-payload`, the provider's signed blob
   * verbatim. One field rather than two because the service treats it as opaque:
   * it arrives from the client, is never interpreted outside the adapter, and
   * naming it `code` keeps the wire contract in `login.dto.ts` unchanged.
   */
  readonly code: string;
  /** The same value sent at authorization; providers check it matches. */
  readonly redirectUri: string;
  /** The PKCE preimage. Undefined only for a pre-PKCE state entry. */
  readonly codeVerifier: string | undefined;
  /** What the ID token's nonce must equal. Undefined when unsupported. */
  readonly expectedNonce: string | undefined;
}

export interface OauthProviderAdapter {
  readonly provider: OauthProvider;
  readonly capabilities: ProviderCapabilities;

  /**
   * Are this provider's credentials present on this deployment?
   *
   * Per-adapter rather than a single flag, because "configured" differs: Google
   * needs two values, Apple needs four (team id, key id, private key, client id),
   * and Telegram needs one bot token. The service turns a false here into
   * `oauth_provider_unsupported`, which is why the DTO can accept all five
   * providers without every deployment having to implement them.
   */
  isConfigured(): boolean;

  /** The one redirect URI this deployment will honour. The service compares a
   *  caller-supplied value against it — anything else is an open redirect. */
  readonly configuredRedirectUri: string;

  /**
   * Where to send the user, or null when the provider has no authorization
   * endpoint.
   *
   * Null is Telegram, and the service turns it into a refusal that says so. The
   * alternative — inventing a URL for a flow that does not have one — would give a
   * client something to redirect to that cannot work.
   */
  authorizationUrl(request: AuthorizationRequest): string | null;

  /**
   * Turn the callback into an identity, or throw.
   *
   * The contract every adapter owes, and the reason this is the only method that
   * matters: an `OauthIdentity` returned from here is treated by everything
   * downstream as PROVEN. `subject` must come from a signature or a token exchange
   * the provider authenticated — never from a field the browser could have set —
   * and `emailVerified` must be the provider's own assertion, not a default.
   */
  verify(request: VerificationRequest): Promise<OauthIdentity>;
}

/** Injection token for the set of adapters this deployment was built with. */
export const OAUTH_ADAPTERS = Symbol('OAUTH_ADAPTERS');
