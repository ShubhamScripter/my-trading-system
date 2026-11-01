import { Injectable, Logger } from '@nestjs/common';
import type { OauthProvider } from '@prisma/client';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { config } from '../../src/config';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import type { OauthIdentity } from '../auth.types';
import { assertNonce } from './jwks';
import type {
  AuthorizationRequest,
  OauthProviderAdapter,
  ProviderCapabilities,
  VerificationRequest,
} from './provider.port';

/**
 * Google — the reference adapter, and the only one verified against live
 * credentials.
 *
 * Lifted from `OauthService` unchanged when the port was introduced. Nothing about
 * the flow was altered in the move, deliberately: this path is in production, so
 * the refactor had to be provably behaviour-preserving, and the tests that cover it
 * exercise this adapter rather than the service's old private method.
 *
 * `google-auth-library` does the parts that would otherwise live in `jwks.ts` — it
 * fetches and caches Google's signing keys and checks `aud` and `iss` itself. That
 * is why this adapter is the short one: the library is the reason, not a difference
 * in how carefully the provider is treated.
 */
@Injectable()
export class GoogleAdapter implements OauthProviderAdapter {
  readonly provider: OauthProvider = 'GOOGLE';

  readonly capabilities: ProviderCapabilities = {
    flow: 'oidc-code',
    // Guaranteed by the `email` scope, which we always request. `verify` still
    // handles a missing address rather than asserting — a capability is a statement
    // about the provider's contract, not a licence to skip a null check.
    providesEmail: 'always',
    supportsPkce: true,
    supportsNonce: true,
    assertsEmailVerified: true,
  };

  private readonly logger = new Logger('GoogleAdapter');
  private readonly client: OAuth2Client;

  constructor() {
    this.client = new OAuth2Client({
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      redirectUri: config.GOOGLE_REDIRECT_URI,
    });
  }

  get configuredRedirectUri(): string {
    return config.GOOGLE_REDIRECT_URI;
  }

  isConfigured(): boolean {
    return config.googleEnabled;
  }

  authorizationUrl(request: AuthorizationRequest): string {
    return this.client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      redirect_uri: request.redirectUri,
      state: request.state,
      // Force the account chooser. Without it, a user with a live Google session is
      // signed straight back into the same account, which makes "wrong account"
      // unrecoverable from our side.
      prompt: 'select_account',
      code_challenge_method: CodeChallengeMethod.S256,
      ...(request.codeChallenge === null ? {} : { code_challenge: request.codeChallenge }),
      // Not a named field on `GenerateAuthUrlOpts` — it rides the index signature,
      // which serialises it into the query string verbatim. That is the documented
      // way this library passes OIDC parameters it has no first-class support for,
      // and `verifyIdToken` correspondingly has no nonce option: the comparison is
      // ours to make, in `verify` below.
      ...(request.nonce === null ? {} : { nonce: request.nonce }),
    });
  }

  /**
   * Exchange the authorization code and verify the returned ID token.
   *
   * `verifyIdToken` is what does most of the real work: it checks the signature
   * against Google's published keys (cached by the library), and checks `aud`
   * against our client id and `iss` against Google. Decoding the token without that
   * check would accept any well-formed JWT anyone cared to send.
   *
   * Two things it does NOT do, which is why they are here:
   *
   *  - PKCE. `codeVerifier` goes to the token endpoint, and Google refuses the
   *    exchange if it does not hash to the `code_challenge` sent at authorization.
   *    So a failure surfaces as a rejected exchange rather than as a check of ours.
   *  - `nonce`. `VerifyIdTokenOptions` has no field for it, so the comparison is
   *    `assertNonce`. A token can be perfectly signed, correctly addressed to us,
   *    and still be one an attacker obtained for their own authorization request
   *    and injected into someone else's callback.
   */
  async verify(request: VerificationRequest): Promise<OauthIdentity> {
    let idToken: string | undefined;
    try {
      const { tokens } = await this.client.getToken({
        code: request.code,
        redirect_uri: request.redirectUri,
        codeVerifier: request.codeVerifier,
      });
      idToken = tokens.id_token ?? undefined;
    } catch (err) {
      this.logger.warn({ err }, 'google token exchange failed');
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }

    if (idToken === undefined) {
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }

    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: config.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      if (payload === undefined || !payload.sub) {
        throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
      }

      assertNonce(payload.nonce, request.expectedNonce, 'GOOGLE');

      return {
        provider: 'GOOGLE',
        subject: payload.sub,
        email: payload.email ?? null,
        emailVerified: payload.email_verified === true,
        name: payload.given_name ?? payload.name ?? null,
        avatarUrl: payload.picture ?? null,
      };
    } catch (err) {
      if (err instanceof ProblemException) throw err;
      this.logger.warn({ err }, 'google id token verification failed');
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }
  }
}
