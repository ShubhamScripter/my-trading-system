import { Injectable, Logger } from '@nestjs/common';
import type { OauthProvider } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import type { OauthIdentity } from '../auth.types';
import { postForm, requireString } from './http';
import { assertNonce, verifyIdToken } from './jwks';
import type {
  AuthorizationRequest,
  OauthProviderAdapter,
  ProviderCapabilities,
  VerificationRequest,
} from './provider.port';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_AUTHORIZE_URL = `${APPLE_ISSUER}/auth/authorize`;
const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`;
const APPLE_JWKS_URL = `${APPLE_ISSUER}/auth/keys`;

/**
 * How long a generated `client_secret` is valid.
 *
 * Apple allows up to six months and most integrations mint one that long, check it
 * into config, and are surprised twice a year. This mints one per exchange instead:
 * it is a local ES256 signature over four claims, so it costs microseconds, and a
 * five-minute lifetime means a leaked secret is worthless before it can be used.
 *
 * The trade is that the signing key must be present at runtime rather than only at
 * setup — which it has to be anyway, since there is nowhere else to keep it.
 */
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;

/**
 * Apple — OIDC, with three things that are genuinely different from Google.
 *
 * ─── 1. The client secret is a JWT we sign ──────────────────────────────────
 *
 * There is no static client secret to configure. Apple issues a `.p8` EC private
 * key and expects a short-lived ES256 assertion built from it, keyed by team id and
 * key id. `clientSecret` below is that. Getting any of the four values wrong
 * produces `invalid_client` from the token endpoint and nothing more specific, which
 * is why the log line on failure names which of them are present.
 *
 * ─── 2. `response_mode=form_post` is mandatory, and changes the callback ─────
 *
 * Requesting the `name` or `email` scope obliges the authorization request to use
 * `response_mode=form_post`. Apple then POSTs a form body to the redirect URI
 * instead of redirecting with a query string. The client must handle that and hand
 * us `code` and `state` — the shape this service already accepts — so nothing here
 * changes, but a client written against the Google flow will silently receive
 * nothing until it does.
 *
 * ─── 3. The email is often not the user's real address ──────────────────────
 *
 * "Hide My Email" gives a `@privaterelay.appleid.com` forwarding address, and the
 * `is_private_email` claim says so. We store it exactly as issued and treat it as
 * verified, because it is: Apple controls the relay and delivers to it. What it
 * means in practice is that a user who later revokes the relay loses that channel,
 * and the account's email is then undeliverable while still being the login
 * identifier. That is a product consequence worth knowing about before this ships —
 * it is not something this adapter can fix.
 *
 * Also: `name` arrives ONLY on first authorization, in a separate `user` form field
 * that is not part of the ID token, and never again. This adapter therefore reports
 * `name: null` always rather than pretending. Username generation on the social path
 * falls back to deriving one from the email, which it already does for any provider
 * that gives no name.
 */
@Injectable()
export class AppleAdapter implements OauthProviderAdapter {
  readonly provider: OauthProvider = 'APPLE';

  readonly capabilities: ProviderCapabilities = {
    flow: 'oidc-code',
    // `sometimes`, not `always`: Apple returns `email` on the FIRST authorization
    // for a given client and may omit it on subsequent ones, so a returning user
    // whose link was deleted can arrive with a valid identity and no address.
    providesEmail: 'sometimes',
    supportsPkce: true,
    supportsNonce: true,
    assertsEmailVerified: true,
  };

  private readonly logger = new Logger('AppleAdapter');

  get configuredRedirectUri(): string {
    return config.APPLE_REDIRECT_URI;
  }

  isConfigured(): boolean {
    return config.appleEnabled;
  }

  authorizationUrl(request: AuthorizationRequest): string {
    const params = new URLSearchParams({
      client_id: config.APPLE_CLIENT_ID,
      redirect_uri: request.redirectUri,
      response_type: 'code',
      // Requesting these is what obliges `form_post` — see the class comment.
      scope: 'name email',
      response_mode: 'form_post',
      state: request.state,
    });
    if (request.nonce !== null) params.set('nonce', request.nonce);
    if (request.codeChallenge !== null) {
      params.set('code_challenge', request.codeChallenge);
      params.set('code_challenge_method', 'S256');
    }

    return `${APPLE_AUTHORIZE_URL}?${params.toString()}`;
  }

  async verify(request: VerificationRequest): Promise<OauthIdentity> {
    const body = await postForm(APPLE_TOKEN_URL, {
      client_id: config.APPLE_CLIENT_ID,
      client_secret: this.clientSecret(),
      code: request.code,
      grant_type: 'authorization_code',
      redirect_uri: request.redirectUri,
      // Apple rejects the exchange when this does not hash to the challenge sent at
      // authorization, so PKCE is enforced by the provider rather than by us.
      ...(request.codeVerifier === undefined ? {} : { code_verifier: request.codeVerifier }),
    });

    const idToken = requireString(body, 'id_token', 'apple token exchange');

    const claims = await verifyIdToken(idToken, {
      jwksUri: APPLE_JWKS_URL,
      issuer: APPLE_ISSUER,
      audience: config.APPLE_CLIENT_ID,
      // RS256 only. Apple signs ID tokens with RSA; the ES256 above is OUR
      // signature on the client secret, in the other direction.
      algorithms: ['RS256'],
      provider: 'APPLE',
    });

    assertNonce(claims['nonce'], request.expectedNonce, 'APPLE');

    if (typeof claims.sub !== 'string' || claims.sub === '') {
      this.logger.warn('apple id token carried no sub');
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }

    const email = typeof claims['email'] === 'string' ? claims['email'] : null;

    return {
      provider: 'APPLE',
      subject: claims.sub,
      email,
      // Apple sends this as the STRING "true" rather than a boolean, and has sent
      // both over the years. `isTrue` accepts either; a bare `=== true` would treat
      // every Apple address as unverified and put every Apple signup through our own
      // OTP, which works but is a round trip nobody needs.
      emailVerified: email !== null && isTrue(claims['email_verified']),
      // Never available in the ID token — see the class comment.
      name: null,
      // Apple publishes no avatar. Not a gap to fill later: there is no endpoint.
      avatarUrl: null,
    };
  }

  /**
   * The ES256 assertion Apple wants in place of a client secret.
   *
   * `sub` is the client id and `iss` is the team id, which reads backwards until you
   * notice the token is Apple's developer account asserting "this client is mine".
   * Mixing the two is the most common misconfiguration and produces a bare
   * `invalid_client`.
   */
  private clientSecret(): string {
    const now = Math.floor(Date.now() / 1000);

    try {
      return jwt.sign(
        {
          iss: config.APPLE_TEAM_ID,
          iat: now,
          exp: now + CLIENT_SECRET_TTL_SECONDS,
          aud: APPLE_ISSUER,
          sub: config.APPLE_CLIENT_ID,
        },
        config.applePrivateKey,
        { algorithm: 'ES256', keyid: config.APPLE_KEY_ID },
      );
    } catch (err) {
      // A malformed `.p8` fails here rather than at the token endpoint. Logged with
      // which values are present, because Apple's own answer to a bad assertion is
      // `invalid_client` and says nothing about which of the four is wrong.
      this.logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          hasTeamId: config.APPLE_TEAM_ID !== '',
          hasKeyId: config.APPLE_KEY_ID !== '',
          hasClientId: config.APPLE_CLIENT_ID !== '',
          privateKeyBytes: config.applePrivateKey.length,
        },
        'could not sign the apple client secret — check APPLE_PRIVATE_KEY is the base64 of the .p8 file',
      );
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }
  }
}

/** Accept a boolean or its string spelling. Providers are inconsistent about both. */
function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}
