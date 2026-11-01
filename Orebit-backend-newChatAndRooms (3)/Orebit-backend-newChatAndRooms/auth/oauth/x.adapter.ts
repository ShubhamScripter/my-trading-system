import { Injectable, Logger } from '@nestjs/common';
import type { OauthProvider } from '@prisma/client';
import { config } from '../../src/config';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import type { OauthIdentity } from '../auth.types';
import { getJson, optionalString, postForm, requireString } from './http';
import type {
  AuthorizationRequest,
  OauthProviderAdapter,
  ProviderCapabilities,
  VerificationRequest,
} from './provider.port';

const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const X_ME_URL = 'https://api.x.com/2/users/me?user.fields=profile_image_url,username';

/**
 * X — OAuth 2.0 with mandatory PKCE, and no email address at all.
 *
 * ─── The email, which is the fact that shapes everything else ───────────────
 *
 * X does not expose an email address through OAuth 2.0. Not behind a scope, not at
 * standard access, not from `/2/users/me`. The legacy 1.1
 * `account/verify_credentials` endpoint could, with an allowlisted app, and it is
 * not part of the v2 surface this uses.
 *
 * So `providesEmail: 'never'`, and the consequence is structural rather than a
 * limitation to work around: an X identity can be ATTACHED to an account that
 * already exists, and can sign that account in forever after, but it cannot CREATE
 * one. `OauthService` reads the capability and offers only the link branch. A user
 * whose first contact with the product is "Continue with X" gets told to sign up
 * with an email first — which is the honest answer, and better than collecting an
 * unverified address in a flow that looks like it verified something.
 *
 * ─── PKCE is not optional ───────────────────────────────────────────────────
 *
 * X requires `code_challenge` on the authorization request even for confidential
 * clients, and refuses the exchange without a matching verifier. The shared flow
 * always sends one, so this is satisfied — but it is why `supportsPkce` being
 * accurate matters: a provider registry that skipped the challenge for X would fail
 * every sign-in at the authorization step.
 *
 * ─── Confidential client, so Basic auth on the token endpoint ───────────────
 *
 * Credentials go in the `Authorization` header rather than the body. X accepts
 * `client_id` in the body only for public clients, and a confidential app that sends
 * it there is rejected with an unhelpful `invalid_request`.
 */
@Injectable()
export class XAdapter implements OauthProviderAdapter {
  readonly provider: OauthProvider = 'X';

  readonly capabilities: ProviderCapabilities = {
    flow: 'oauth2-code',
    providesEmail: 'never',
    supportsPkce: true,
    supportsNonce: false,
    // Moot while `providesEmail` is `never` — there is no address to describe. Set
    // false so that if X ever exposes one, the default is our own OTP rather than
    // trusting a claim nobody has checked.
    assertsEmailVerified: false,
  };

  private readonly logger = new Logger('XAdapter');

  get configuredRedirectUri(): string {
    return config.X_REDIRECT_URI;
  }

  isConfigured(): boolean {
    return config.xEnabled;
  }

  authorizationUrl(request: AuthorizationRequest): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.X_CLIENT_ID,
      redirect_uri: request.redirectUri,
      // The minimum that makes `/2/users/me` answer. `tweet.read` is required
      // alongside `users.read` by X's own scope model even though nothing here reads
      // a tweet — asking for less returns an authorization error, not a smaller
      // token. `offline.access` is deliberately absent: a refresh token would let
      // this service act for the user later, and it never needs to.
      scope: 'users.read tweet.read',
      state: request.state,
    });
    if (request.codeChallenge !== null) {
      params.set('code_challenge', request.codeChallenge);
      params.set('code_challenge_method', 'S256');
    }

    return `${X_AUTHORIZE_URL}?${params.toString()}`;
  }

  async verify(request: VerificationRequest): Promise<OauthIdentity> {
    if (request.codeVerifier === undefined) {
      // X cannot complete an exchange without one, so failing here names the reason
      // rather than forwarding a request we know will be refused. Only reachable
      // from a pre-PKCE state entry, which no longer exists after one TTL.
      this.logger.warn('x exchange attempted without a pkce verifier');
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }

    const basic = Buffer.from(`${config.X_CLIENT_ID}:${config.X_CLIENT_SECRET}`).toString('base64');

    const token = await postForm(
      X_TOKEN_URL,
      {
        code: request.code,
        grant_type: 'authorization_code',
        redirect_uri: request.redirectUri,
        code_verifier: request.codeVerifier,
      },
      { authorization: `Basic ${basic}` },
    );

    const accessToken = requireString(token, 'access_token', 'x token exchange');

    const me = await getJson(X_ME_URL, { authorization: `Bearer ${accessToken}` });

    // Every v2 response wraps its payload in `data`. Reaching for `id` at the top
    // level would find nothing and produce an empty subject.
    const data = (me as Record<string, unknown> | null)?.['data'];
    if (data === undefined || data === null) {
      this.logger.warn('x /2/users/me returned no data object');
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }

    return {
      provider: 'X',
      subject: requireString(data, 'id', 'x /2/users/me'),
      email: null,
      emailVerified: false,
      // The display name, falling back to the handle. Only a seed for username
      // generation, so either is fine and neither is authoritative.
      name: optionalString(data, 'name') ?? optionalString(data, 'username'),
      avatarUrl: normaliseAvatar(optionalString(data, 'profile_image_url')),
    };
  }
}

/**
 * Ask for the full-size avatar rather than the 48px one.
 *
 * X returns a `_normal` variant by default, which is 48×48 and looks wrong anywhere
 * the product shows an avatar larger than a list row. Dropping the suffix is the
 * documented way to get the original. Guarded rather than assumed: if the shape ever
 * changes, the URL is returned untouched instead of being mangled into a 404.
 */
function normaliseAvatar(url: string | null): string | null {
  if (url === null) return null;
  return url.replace(/_normal(\.[a-z]{3,4})$/i, '$1');
}
