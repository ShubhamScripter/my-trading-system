import { Injectable, Logger } from '@nestjs/common';
import type { OauthProvider } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { config } from '../../src/config';
import type { OauthIdentity } from '../auth.types';
import { getJson, optionalString, postForm, requireString } from './http';
import type {
  AuthorizationRequest,
  OauthProviderAdapter,
  ProviderCapabilities,
  VerificationRequest,
} from './provider.port';

/**
 * Pinned, not floating.
 *
 * Graph API versions are deprecated on a published schedule — roughly two years —
 * and an unversioned call silently resolves to whatever is current, so the shape of
 * a response can change under a deployment that did not change. Pinning makes the
 * upgrade a commit with a date on it. When this expires, calls start failing with a
 * clear version error rather than returning subtly different fields.
 */
const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const FACEBOOK_AUTHORIZE_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

/**
 * Facebook — OAuth 2.0 with a userinfo call, and no ID token anywhere.
 *
 * ─── What the absence of an ID token costs ──────────────────────────────────
 *
 * There is no signed assertion about the user. The identity comes from spending an
 * access token on `/me`, which means:
 *
 *  - No `nonce` to bind. `state` and the IP class are the only things tying this
 *    callback to the request that started it. Declared as `supportsNonce: false`
 *    rather than quietly not checked.
 *  - The subject is whatever `/me` returns for the token WE obtained, using OUR
 *    client secret, over TLS to Facebook. That chain is what makes it trustworthy —
 *    not a signature. It is why the code exchange must never be delegated to the
 *    client: a token minted for a different app, handed to us, would produce a
 *    perfectly well-formed identity belonging to somebody else's user base.
 *
 * There is deliberately no `debug_token` call to check the token's audience. We
 * performed the exchange ourselves with our own credentials, so the token cannot be
 * another app's — the check would be verifying something we already know, at the
 * cost of a second round trip on every sign-in.
 *
 * ─── The app-scoped id, which is the thing to understand before shipping ─────
 *
 * `id` from `/me` is scoped to the app. The same human logging into a different app
 * of ours gets a different id, and there is no way to correlate them without
 * Business Manager. So `OauthLink.subject` here is stable for this app and this app
 * only — which is all this service needs, but it means a future second product
 * cannot recognise the same user by it.
 */
@Injectable()
export class FacebookAdapter implements OauthProviderAdapter {
  readonly provider: OauthProvider = 'FACEBOOK';

  readonly capabilities: ProviderCapabilities = {
    flow: 'oauth2-code',
    // The `email` permission is requested, and the user can decline it in the
    // consent dialog while still completing the login. An account with no email on
    // file at Facebook also yields nothing. Both arrive as a valid identity with a
    // null address, which is the link-only path.
    providesEmail: 'sometimes',
    supportsPkce: true,
    supportsNonce: false,
    /**
     * ═══ FALSE, BECAUSE THE GRAPH API DOES NOT ASSERT IT ═══════════════════════
     *
     * This said `true`, on the reasoning that "Facebook only discloses an address it
     * has confirmed, so when one is present it is verified". That is a belief about
     * Facebook's behaviour, not a claim Facebook makes — and this field's own contract
     * in `provider.port.ts` is that it must be the provider's assertion rather than a
     * default.
     *
     * The `/me` response this adapter reads carries `id`, `name`, `email` and
     * `picture`. There is no email-verification field on the Graph User node to
     * request: `email_verified` does not exist there (that is the OIDC claim Google
     * and Apple send, which is why those two may declare `true`), and the legacy
     * `verified` field means something else entirely — whether the PERSON confirmed
     * their Facebook account by mobile number or card — and was withdrawn from the API
     * years ago. No scope, field expansion or version of this endpoint returns one, so
     * there is nothing to read rather than something we forgot to ask for.
     *
     * So the honest answer is `false`. Facebook remains a perfectly good way to sign
     * in and to link an account; what it can no longer do is let a registration skip
     * our own OTP, because the address it hands over is one this service has never
     * confirmed and Facebook has never vouched for.
     */
    assertsEmailVerified: false,
  };

  private readonly logger = new Logger('FacebookAdapter');

  get configuredRedirectUri(): string {
    return config.FACEBOOK_REDIRECT_URI;
  }

  isConfigured(): boolean {
    return config.facebookEnabled;
  }

  authorizationUrl(request: AuthorizationRequest): string {
    const params = new URLSearchParams({
      client_id: config.FACEBOOK_APP_ID,
      redirect_uri: request.redirectUri,
      state: request.state,
      response_type: 'code',
      scope: 'email,public_profile',
    });
    if (request.codeChallenge !== null) {
      params.set('code_challenge', request.codeChallenge);
      params.set('code_challenge_method', 'S256');
    }

    return `${FACEBOOK_AUTHORIZE_URL}?${params.toString()}`;
  }

  async verify(request: VerificationRequest): Promise<OauthIdentity> {
    // POST, although Facebook documents this endpoint as a GET. A GET would put
    // `client_secret` in a URL, and URLs are the one part of a request that gets
    // written to access logs, proxy logs and error trackers by default.
    const token = await postForm(`${GRAPH_BASE}/oauth/access_token`, {
      client_id: config.FACEBOOK_APP_ID,
      client_secret: config.FACEBOOK_APP_SECRET,
      redirect_uri: request.redirectUri,
      code: request.code,
      ...(request.codeVerifier === undefined ? {} : { code_verifier: request.codeVerifier }),
    });

    const accessToken = requireString(token, 'access_token', 'facebook token exchange');

    // `appsecret_proof` proves the caller holds the app secret, not just a token.
    // Facebook can be configured to require it, and it is free to send always — an
    // exfiltrated access token is then not enough to read the profile.
    const proof = createHmac('sha256', config.FACEBOOK_APP_SECRET)
      .update(accessToken)
      .digest('hex');

    const params = new URLSearchParams({
      fields: 'id,name,email,picture.type(large)',
      access_token: accessToken,
      appsecret_proof: proof,
    });

    const me = await getJson(`${GRAPH_BASE}/me?${params.toString()}`);

    const subject = requireString(me, 'id', 'facebook /me');
    const email = optionalString(me, 'email');

    if (email === null) {
      // Not an error — the link-only path handles it — but worth a line, because
      // "sign in with Facebook does not create accounts" will otherwise be reported
      // as a bug with nothing in the log to explain it.
      this.logger.log({ subject }, 'facebook returned no email; identity is link-only');
    }

    return {
      provider: 'FACEBOOK',
      subject,
      email,
      /**
       * ═══ NEVER INFERRED FROM THE PRESENCE OF AN ADDRESS ═══════════════════════
       *
       * This was `email !== null`, which made "Facebook told us an address" mean
       * "Facebook confirmed that address". Those are different statements, and the
       * second one is not on the wire: see `assertsEmailVerified` above for why the
       * Graph User node has no verification field to read.
       *
       * The consequence of the old form was not cosmetic. `OauthService` reads this as
       * `trusted`, and a trusted identity registers with `state: 'CREDENTIALS_SET'`
       * and `emailVerified: true` WITHOUT sending our own OTP — so an address Facebook
       * merely reported arrived in this service already marked confirmed, having been
       * proven to nobody.
       *
       * A literal `false` rather than a field lookup, deliberately: a lookup would
       * imply there is a claim here that might one day be populated, and the next
       * reader would go looking for the key. If Facebook ever does assert this, the
       * change is to read that claim AND flip the capability above, together.
       *
       * The address itself is still returned and still used — for matching and for
       * linking. It is only the verification signal that is withheld, so a Facebook
       * registration now takes the same OTP path as any other unverified address.
       */
      emailVerified: false,
      name: optionalString(me, 'name'),
      avatarUrl: readPictureUrl(me),
    };
  }
}

/**
 * Dig the avatar out of `picture.type(large)`.
 *
 * Nested two levels and wrapped in a `data` object, unlike every other field. The
 * `is_silhouette` flag is honoured: Facebook returns a generic grey outline for a
 * user with no photo, and storing that as an avatar would show every such user a
 * placeholder that looks like a broken upload rather than the initials fallback the
 * product already has.
 */
function readPictureUrl(me: unknown): string | null {
  const picture = (me as Record<string, unknown> | null)?.['picture'];
  const data = (picture as Record<string, unknown> | null)?.['data'];
  if (data === undefined || data === null) return null;

  const fields = data as Record<string, unknown>;
  if (fields['is_silhouette'] === true) return null;

  const url = fields['url'];
  return typeof url === 'string' && url !== '' ? url : null;
}
