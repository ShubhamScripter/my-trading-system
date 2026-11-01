import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LoginAttempt, OauthProvider, Registration } from '@prisma/client';
import { chargeOtpMail, refundOtpMail } from './otp-mail.charge';
import { createHash, randomBytes } from 'node:crypto';
import { ERR } from '../../src/contracts';
import { GEO_RESOLVER, type GeoResolver } from '../../src/geo/geo.types';
import { isUniqueViolation } from '../../db/client';
import { ProblemException } from '../../src/http';
import { CacheService, KEYS, QuotaService } from '../../redis';
import { secondsFromNow } from '../../src/utils/public.utils';
import { OAUTH, OTP, REGISTRATION } from '../auth.constants';
import { policy } from '../limits';
import type {
  ClientContext,
  OauthCallbackOutcome,
  OauthIdentity,
  OauthRegisterOutcome,
} from '../auth.types';
import {
  generateContinuationSecret,
  generateOtp,
  normaliseEmail,
  pepperedHash,
} from '../auth.utility';
import { MailService } from '../../src/mail/mail.service';
import { MfaService } from '../../src/2fa/mfa.service';
import { TwoFactorDbOperation } from '../../src/2fa/2fa.dboperation';
import { RegistrationDbOperation } from '../persistence/registration.dboperation';
import { BlocklistService } from './blocklist.service';
import { SessionService } from './session.service';
import { UserDbOperation } from '../persistence/user.dboperation';
import { OauthProviderRegistry } from '../oauth/registry';
import type { OauthFlow, OauthProviderAdapter } from '../oauth/provider.port';
import type { LoginOauthCallbackRequest, LoginOauthStartRequest } from '../dto/login.dto';

/**
 * What `oauth:state:<state>` holds between `start` and `callback`.
 *
 * `codeVerifier` and `nonce` are optional in the TYPE and not merely per-provider:
 * an adapter whose capabilities say it supports neither writes neither, AND an entry
 * written by the deploy before this one has neither. A required field would make
 * `JSON.parse` produce an object that lies about itself. The tolerance is bounded by
 * `OAUTH.STATE_TTL_SECONDS`.
 *
 * `provider` was added with the adapter layer and is not optional-by-accident — see
 * `assertSameProvider`. It is read on every callback, so an entry that predates it
 * is refused rather than tolerated.
 */
interface OauthStateStash {
  readonly provider?: OauthProvider;
  readonly redirectUri: string;
  readonly ipClass: string;
  readonly deviceKey: string;
  readonly codeVerifier?: string;
  readonly nonce?: string;
  /**
   * The login flow this authorization belongs to.
   *
   * `state` already binds the callback to the request that started it, and
   * `ipClass`/`deviceKey` already bind it to the browser. This binds it to the
   * FLOW, which those do not: two tabs on one machine share a device key and an
   * IP class, so without it a callback minted by one tab's `oauth-start` could be
   * redeemed against the other tab's `loginId` and the resulting session would be
   * attributed to a flow that never authorised it.
   *
   * Optional for the same reason `provider` is: a state parked by the deploy
   * before this one has no such field, and a required field would make
   * `JSON.parse` produce an object that lies about itself. The tolerance is
   * bounded by `OAUTH.STATE_TTL_SECONDS` — ten minutes after deploy, every live
   * state carries it.
   */
  readonly loginAttemptId?: string;
}

/**
 * What `oauth:link-state:<state>` holds between `startLink` and `completeLink`.
 *
 * ─── Why this is a second type and not two more optional fields above ───────
 *
 * Because the two entries mean different things and are read by code with opposite
 * obligations. A login state resolves to a SESSION; a link state must never produce
 * one. Separate types alongside separate key namespaces (see `KEYS.oauth.linkState`)
 * is what makes "redeem a link state at the login callback" unrepresentable rather
 * than merely refused.
 *
 * ─── Why NOTHING here is optional ──────────────────────────────────────────
 *
 * `OauthStateStash` above marks almost every field optional as a rolling-deploy
 * tolerance — an entry written by the previous version genuinely has no `provider`,
 * and refusing it would fail every sign-in in flight at deploy time. That argument
 * does not transfer. There are no link states written by a previous deploy, because
 * this is the first one; and `linkUserId` is not a hint but the whole authorisation
 * check, so an entry lacking it must be refused rather than waved past. Required
 * here, and `parseLinkState` re-checks at runtime because `JSON.parse` believes
 * whatever it is handed.
 */
interface OauthLinkStateStash {
  readonly provider: OauthProvider;
  readonly redirectUri: string;
  readonly ipClass: string;
  readonly codeVerifier?: string;
  readonly nonce?: string;
  /** The account the finished link must attach to, and nobody else. */
  readonly linkUserId: string;
  /**
   * The session FAMILY that started the ceremony.
   *
   * The family rather than `Principal.sessionId`, and the distinction is not
   * pedantic: under the BFF the backend rotates the access token on its own
   * schedule, so the generation id a request carries changes silently partway
   * through a flow. Binding to it would refuse a legitimate user whose token
   * happened to rotate while they were at the provider. The family is the id of the
   * first generation and survives every rotation — the same reasoning `MePayload`
   * gives for reporting `familyId` rather than the generation.
   */
  readonly linkFamilyId: string;
  /** Recorded for the audit line only. Never compared — see `linkFamilyId`. */
  readonly linkSessionId: string;
}

/**
 * What a link ceremony needs from the request.
 *
 * ─── Why this is not `ClientContext`, and why there is no device binding ───
 *
 * `ClientContext` carries a `deviceKey` derived from the `orebit_device` cookie, and
 * the login OAuth flow binds its state to it. That binding is not merely unhelpful
 * on this path — it is unsatisfiable. `DEVICE.COOKIE_PATH` is `/auth`, so the browser
 * never sends the cookie to `/settings/*`, and building a full `ClientContext` there
 * means `deviceCookie()` MINTS A NEW ONE on every request: `start` would record one
 * device and `callback` would present a different one, so no link could ever
 * complete. (Found by curl. Every layer was individually behaving as designed.)
 *
 * So the ceremony binds to the SESSION FAMILY instead, which is strictly stronger
 * for what this needs to prove. A device cookie says "the same browser"; a family
 * says "the same login in the same browser", and it is the account binding that
 * matters when the thing being written is a credential for one account. The network
 * class is kept, unchanged, from the login flow.
 *
 * The narrower type is also what lets the Settings routes take no `FastifyReply` at
 * all — nothing on that path can set a cookie, which is the property the whole
 * module is built around.
 */
export interface LinkClientContext {
  readonly ip: string;
  readonly ipClass: string;
}

/** A pending identity is usable only for the choice produced by its callback. */
interface OauthPendingStash {
  readonly identity: OauthIdentity;
  readonly ipClass: string;
  readonly deviceKey: string;
  readonly purpose: 'oauth-choice';
}

/**
 * Third-party login — the provider-independent half.
 *
 * ─── What lives here, and what lives in an adapter ─────────────────────────
 *
 * Everything in this file is the same for every provider: the single-use `state`,
 * the PKCE verifier, the IP-class binding, the rate limits, the blocklist, the
 * linked/unlinked decision, the second factor, and the choice handed back when
 * nothing is linked yet. An adapter under `auth/oauth/` owns only the two things
 * that are irreducibly per-provider — where to send the user, and how to turn what
 * comes back into an identity worth believing.
 *
 * That split is the point. Each control below was added in response to a finding,
 * and a new provider inherits all of them because there is no other way to reach
 * this flow. See `auth/oauth/provider.port.ts`.
 *
 * ─── The callback resolves to an outcome, not a session ─────────────────────
 *
 * Arriving from a provider does not by itself say what should happen. Only one case
 * is unambiguous — the identity is already linked, so this is an ordinary login.
 * Everything else is a question for the user, and `choice_required` is how it gets
 * asked: create an account, or sign in to an existing one and attach the provider.
 *
 * The service used to answer that question itself, registering automatically when
 * the email was unknown and refusing outright when it was taken. The refusal told
 * the client to "sign in and link the provider instead", which was advice no code
 * path could act on. Both halves are fixed: the choice is surfaced, and
 * `attachPending` gives the link branch somewhere to land.
 *
 * ─── Providers that cannot supply an email ─────────────────────────────────
 *
 * X and Telegram never do, and Apple and Facebook sometimes do not. An account
 * cannot be registered without an address — it is the login identifier, the recovery
 * channel and the single factor behind every account here — so those identities are
 * LINK-ONLY: they sign in an account that has already linked them, and they can be
 * attached to an existing one, but they cannot create one. That is surfaced as an
 * ordinary `choice_required` with a null email and `canCreateNew: false`, rather
 * than as a failure, because nothing failed.
 */
@Injectable()
export class OauthService {
  private readonly logger = new Logger('OauthService');

  constructor(
    private readonly users: UserDbOperation,
    private readonly registrations: RegistrationDbOperation,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    private readonly cache: CacheService,
    private readonly quota: QuotaService,
    private readonly blocklist: BlocklistService,
    private readonly mfa: MfaService,
    // The login flow row. A provider sign-in is a sign-in, so it retires its flow
    // on exactly the terms the password path does — see `callback`.
    private readonly attempts: TwoFactorDbOperation,
    private readonly providers: OauthProviderRegistry,
    @Inject(GEO_RESOLVER) private readonly geo: GeoResolver,
  ) {}

  /**
   * Build the authorization URL and stash a single-use `state`.
   *
   * `state` is held server-side in Redis rather than signed into the value.
   * Server-side is what makes it genuinely single-use: the callback deletes it, so a
   * captured authorization code cannot be redeemed a second time. A signed stateless
   * token would verify on every replay.
   *
   * ─── Why the PKCE verifier and the nonce ride in the same entry ─────────────
   *
   * All three values answer "is this callback the other half of the request I
   * started", so they expire together and are spent together. Giving the verifier
   * its own key would mean two `take`s that can disagree — one succeeding and one
   * missing leaves the callback holding half a request and having to invent a rule
   * for it. One entry, one `take`, one answer.
   *
   * Note what does NOT go back to the client: only `url`, `state` and `flow`. The
   * verifier and the nonce are ours, and a client that could read them could defeat
   * both.
   *
   * ─── A null `url` is not a failure ─────────────────────────────────────────
   *
   * Telegram has no authorization endpoint. It still comes through here, and that is
   * deliberate rather than incidental: this call is what mints the state and parks
   * the IP class, so routing Telegram around it — the tempting shortcut, since there
   * is no redirect to build — would have cost it single-use state, the IP binding,
   * the rate limits and everything downstream of them. `flow` tells the client to
   * render the Login Widget instead of navigating. See `TelegramAdapter`.
   */
  async start(
    input: LoginOauthStartRequest,
    client: ClientContext,
    /**
     * Opens the login flow this authorization will belong to.
     *
     * Passed in rather than done here, and passed as a FUNCTION rather than a
     * ready-made row, for two reasons that pull the same way.
     *
     * The handle belongs to `LoginService`: its byte count, its hash domain and
     * the row's expiry are defined in one place there, and a second copy in this
     * file would be a second place for them to drift.
     *
     * And the ORDER matters. This method charges the provider quotas first, and a
     * caller that had already created the row before calling would leave one
     * behind every time those quotas refuse — which is precisely the unbounded
     * anonymous write the limiters exist to stop. Handing over the ability to
     * create it lets this method decide when, which is: after the quotas, before
     * the state is parked.
     */
    openFlow: () => Promise<{ loginId: string; attempt: LoginAttempt }>,
  ): Promise<{ loginId: string; url: string | null; state: string; flow: OauthFlow }> {
    const adapter = this.providers.require(input.provider);
    await this.quota.consumeAll(
      [
        { key: KEYS.rate.oauthStartByIp(client.ip), rule: policy().OAUTH.START_BY_IP },
        { key: KEYS.rate.oauthStartByDevice(client.deviceKey), rule: policy().OAUTH.START_BY_DEVICE },
      ],
      'burst',
      'deny',
    );

    const redirectUri = this.resolveRedirectUri(adapter, input.redirectUri);

    // Quotas are spent and the provider is known good, so the sign-in is real
    // enough to write a row for. Everything below binds to it.
    const { loginId, attempt: loginFlow } = await openFlow();

    const state = randomBytes(32).toString('base64url');

    // PKCE. The verifier stays here; only its SHA-256 goes to the provider. That is
    // what makes an intercepted authorization code useless — redeeming it requires
    // the preimage, and the preimage never left this process.
    //
    // Minted only when the provider will act on it. Sending a challenge to a
    // provider that ignores it would park a verifier that proves nothing, and
    // reading it back at the callback would look like a control that is not there.
    const codeVerifier = adapter.capabilities.supportsPkce
      ? randomBytes(OAUTH.PKCE_VERIFIER_BYTES).toString('base64url')
      : undefined;
    const codeChallenge =
      codeVerifier === undefined
        ? null
        : createHash('sha256').update(codeVerifier).digest('base64url');

    // Same rule: only providers that return an ID token can echo a nonce back.
    const nonce = adapter.capabilities.supportsNonce
      ? randomBytes(OAUTH.NONCE_BYTES).toString('base64url')
      : undefined;

    const stash: OauthStateStash = {
      provider: adapter.provider,
      redirectUri,
      ipClass: client.ipClass,
      deviceKey: client.deviceKey,
      codeVerifier,
      nonce,
      loginAttemptId: loginFlow.id,
    };
    await this.cache.set(KEYS.oauth.state(state), JSON.stringify(stash), policy().OAUTH.STATE_TTL_SECONDS);

    const url = adapter.authorizationUrl({
      redirectUri,
      state,
      codeChallenge,
      nonce: nonce ?? null,
    });

    return { loginId, url, state, flow: adapter.capabilities.flow };
  }

  /**
   * Exchange the code, verify the identity, and decide what happens next.
   */
  async callback(
    loginFlow: LoginAttempt,
    input: LoginOauthCallbackRequest,
    client: ClientContext,
  ): Promise<OauthCallbackOutcome> {
    const adapter = this.providers.require(input.provider);
    await this.quota.consumeAll(
      [
        { key: KEYS.rate.oauthCallbackByIp(client.ip), rule: policy().OAUTH.CALLBACK_BY_IP },
        { key: KEYS.rate.oauthCallbackByDevice(client.deviceKey), rule: policy().OAUTH.CALLBACK_BY_DEVICE },
      ],
      'burst',
      'deny',
    );

    const stashed = await this.cache.take(KEYS.oauth.state(input.state));
    if (stashed === null) {
      // Unknown, expired, or already redeemed. All three are the same refusal.
      throw new ProblemException({ type: ERR.OAUTH_STATE_INVALID });
    }

    const stash = JSON.parse(stashed) as OauthStateStash;

    // Both before the exchange, so a callback arriving from somewhere else costs no
    // provider quota and never turns an authorization code into a verified identity
    // we then have to decide what to do with.
    this.assertSameProvider(stash.provider, adapter.provider);
    this.assertSameNetwork(stash.ipClass, client, 'callback');
    // States minted before device binding was deployed remain usable only for their
    // short, ten-minute lifetime. Every newly minted state carries this binding.
    if (stash.deviceKey !== undefined && stash.deviceKey !== client.deviceKey) {
      throw new ProblemException({ type: ERR.OAUTH_STATE_INVALID });
    }
    // The authorization must come back to the flow that sent it out. Same
    // tolerance as the two checks above for states that predate the field, and the
    // same refusal once it is present: an `oauth-start` from one tab must not be
    // redeemable against another tab's `loginId`, which the device and network
    // checks cannot see because both tabs share them.
    if (stash.loginAttemptId !== undefined && stash.loginAttemptId !== loginFlow.id) {
      throw new ProblemException({ type: ERR.OAUTH_STATE_INVALID });
    }

    const identity = await adapter.verify({
      code: input.code,
      redirectUri: stash.redirectUri,
      codeVerifier: stash.codeVerifier,
      expectedNonce: stash.nonce,
    });

    // An adapter returning an identity labelled with someone else's provider would
    // write an `OauthLink` under the wrong `(provider, subject)` pair — and subjects
    // are only unique WITHIN a provider, so that is a genuine cross-provider
    // collision rather than a tidiness check. Cheap, and it makes the invariant the
    // rest of this method relies on explicit.
    if (identity.provider !== adapter.provider) {
      this.logger.error(
        { expected: adapter.provider, actual: identity.provider },
        'oauth adapter returned an identity for a different provider',
      );
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }

    // 1. Already linked — an ordinary login. Reachable for every provider,
    //    including the ones that cannot supply an email: the link already exists, so
    //    no address is needed to find the account.
    const link = await this.users.findOauthLink(identity.provider, identity.subject);
    if (link !== null) {
      if (link.user.status !== 'ACTIVE') {
        throw new ProblemException({ type: ERR.ACCOUNT_DISABLED });
      }
      // A linked provider identity is the shortest path to a session in the whole
      // service, which is exactly why the blocklist has to be on it. Blocking a
      // domain everywhere except here would leave "sign in with Google" as the
      // documented way around the block.
      await this.blocklist.assertNotBlocked(link.user.emailLower);
      await this.users.touchOauthLogin(link.id);
      const found = await this.users.findWithCredential(link.userId);
      if (found === null) throw new ProblemException({ type: ERR.UNAUTHENTICATED });

      // The second factor, on exactly the same terms the password path applies it.
      //
      // The comment above about the blocklist — that a linked provider identity is
      // the shortest path to a session in the whole service — is the argument for
      // this check too, and more sharply: a user who deliberately switched 2FA on
      // would have found "Continue with Google" turned it back off.
      //
      // `challengeFor` answers null for an account with nothing enrolled, so the
      // ordinary provider sign-in is unchanged down to the round trip.
      const challenge = await this.mfa.challengeFor(loginFlow, found.user.id, 'STARTED');
      if (challenge !== null) {
        return { kind: 'mfa_required', ...challenge };
      }

      // No factor owed, so this flow ends here. Attach the account and retire the
      // handle, on exactly the terms the password path uses — a provider sign-in
      // that skipped either would leave a flow row that outlived the session it
      // produced and could be replayed for another.
      if (
        !(await this.attempts.promoteAttempt({
          id: loginFlow.id,
          userId: found.user.id,
          from: 'STARTED',
          to: 'FACTOR_REQUIRED',
        }))
      ) {
        throw new ProblemException({ type: ERR.MFA_TOKEN_INVALID });
      }
      if (!(await this.attempts.completeAttempt(loginFlow.id))) {
        throw new ProblemException({ type: ERR.MFA_TOKEN_INVALID });
      }

      const session = await this.sessions.issue(found.user, found.credential, client);
      await this.users.touchLastSeen(found.user.id);
      return { kind: 'session', session };
    }

    // 2. Nothing linked, and no address to register with. Park the identity and
    //    offer the link branch alone.
    //
    //    Not an error, which is the change worth noting: this used to throw
    //    `oauth_exchange_failed`, a 502 blaming the provider for behaving exactly as
    //    documented. The sign-in succeeded and the identity is genuine — what is
    //    missing is a way to create an account from it, and the honest answer is the
    //    same choice as always with one branch closed.
    if (identity.email === null) {
      this.logger.log(
        { provider: identity.provider, availability: adapter.capabilities.providesEmail },
        'provider identity has no email; offering the link branch only',
      );
      return {
        kind: 'choice_required',
        linkToken: await this.parkPending(identity, client),
        email: null,
        canCreateNew: false,
        provider: identity.provider,
      };
    }

    const emailLower = normaliseEmail(identity.email);

    // Before the identity is parked, so a blocked address never receives a
    // `linkToken` at all. The provider having verified the address says it is real;
    // it says nothing about whether we accept it.
    await this.blocklist.assertNotBlocked(emailLower);

    // 3. Not linked, and we have an address. Park the verified identity and hand the
    //    decision back rather than registering on the user's behalf. `canCreateNew`
    //    reports whether the create branch is even open — registration needs an
    //    unused address, so an email that already belongs to someone leaves only the
    //    link branch.
    const linkToken = await this.parkPending(identity, client);
    const canCreateNew = !(await this.users.emailExists(emailLower));

    return {
      kind: 'choice_required',
      linkToken,
      email: identity.email,
      canCreateNew,
      provider: identity.provider,
    };
  }

  /**
   * The "create a new account" branch of the choice.
   *
   * Consumes the pending identity outright — a registration carries it onward in its
   * own row from here, so there is nothing left for a second call to do.
   */
  async chooseRegister(linkToken: string, client: ClientContext): Promise<OauthRegisterOutcome> {
    const identity = await this.takePending(linkToken, client, 'register');

    if (identity.email === null) {
      // The client ignored `canCreateNew` on a link-only identity. A distinct slug
      // rather than `oauth_exchange_failed`, because the remedy is specific and
      // actionable: sign up with an email, then link this provider.
      throw new ProblemException({
        type: ERR.OAUTH_EMAIL_UNAVAILABLE,
        extra: { provider: identity.provider },
      });
    }

    const emailLower = normaliseEmail(identity.email);

    // Checked again rather than trusted from the callback: a pending identity lives
    // for thirty minutes, so a rule added in between would otherwise be bypassed by
    // anyone already holding a token.
    await this.blocklist.assertNotBlocked(emailLower);

    if (await this.users.emailExists(emailLower)) {
      // The client ignored `canCreateNew`, or an account was created in the gap.
      throw new ProblemException({
        type: ERR.OAUTH_LINK_REQUIRED,
        extra: { email: identity.email },
      });
    }

    return this.beginRegistration(identity, emailLower, client);
  }

  /**
   * Meter attempts to attach a provider to one account.
   *
   * `deny` on cache failure. Unlike the login limiters — which allow through,
   * because `Credential.failedAttempts` keeps enforcing lockout in Postgres with
   * Redis down — there is no durable backstop here. Nothing else bounds a caller
   * grinding `linkToken` values, so a cache outage must refuse rather than remove
   * the only limit on a write that creates a permanent credential.
   */
  async rateLimitLink(userId: string): Promise<void> {
    await this.cache.consume(
      KEYS.rate.oauthLinkByAccount(userId),
      policy().OAUTH.LINK_BY_ACCOUNT,
      'deny',
    );
  }

  /** A rejected link confirmation is a separate abuse signal from a successful
   * link. Keep it account-scoped so a caller cannot grind opaque pending tokens. */
  private async recordLinkFailure(userId: string): Promise<void> {
    await this.cache.consume(
      KEYS.rate.oauthLinkFailByAccount(userId),
      policy().OAUTH.LINK_FAIL_BY_ACCOUNT,
      'deny',
    );
  }

  /**
   * What is waiting behind a `linkToken`, without spending it.
   *
   * So a client can show "attach ada@gmail.com to this account?" before asking for a
   * factor. Reading is safe to leave unspent — the identity grants nothing until
   * `attachPending` writes the link, and the caller already holds the token.
   */
  async previewPending(linkToken: string, client: ClientContext): Promise<OauthIdentity> {
    return this.readPending(linkToken, client, 'link-preview');
  }

  /**
   * Attach a verified provider identity to an existing account.
   *
   * ─── What guards this, and where ───────────────────────────────────────────
   *
   * Nothing in here. `POST /auth/link` wears `@UseGuards(ElevationGuard)` and
   * `@RequiresElevation('account.oauth.link')`, so by the time this runs the caller
   * has a live session AND has spent a single-use ticket proved for this exact
   * write. That is deliberate placement rather than an omission: the guard runs
   * before the handler, so an unelevated request never reaches this method at all,
   * and putting a second check here would only be a second thing to keep in sync.
   *
   * It used to be called from `LoginService.completeLogin` whenever a login carried
   * a `linkToken`, which made a permanent credential a side effect of one factor.
   *
   * This is also the ONLY way an X or Telegram identity ever reaches an account, so
   * it carries more weight than it did when every provider could also register. It
   * needs no email, which is exactly why those providers can get this far.
   *
   * Ordering is still the design. The token is read without being consumed so a
   * failure costs the user a retry rather than a second trip through the provider,
   * and it is only spent once the link is actually written.
   */
  async attachPending(userId: string, linkToken: string, client: ClientContext): Promise<void> {
    let identity: OauthIdentity;
    try {
      identity = await this.readPending(linkToken, client, 'link-confirm');
    } catch (error) {
      if (error instanceof ProblemException) await this.recordLinkFailure(userId);
      throw error;
    }

    // Only one live confirmation may attach a given provider to one account. The
    // marker is keyed by account and provider (not token), so two browser tabs
    // cannot race two distinct identities into the same permanent credential slot.
    const ceremonyKey = KEYS.rate.oauthLinkCeremony(userId, identity.provider);
    const acquired = await this.cache.setIfAbsent(
      ceremonyKey,
      linkToken,
      policy().OAUTH.PENDING_TTL_SECONDS,
    );
    if (!acquired) {
      await this.recordLinkFailure(userId);
      throw new ProblemException({ type: ERR.OAUTH_LINK_INVALID });
    }

    try {
      // Spend before the write. A link token is a one-action credential: retaining
      // it through an error makes retries and concurrent confirmations ambiguous.
      identity = await this.takePending(linkToken, client, 'link-confirm');
      await this.users.linkOauth(userId, {
        provider: identity.provider,
        subject: identity.subject,
        emailAtLink: identity.email ?? '',
        emailVerifiedByProvider: identity.emailVerified,
        avatarUrl: identity.avatarUrl,
      });
    } catch (err) {
      // The partial unique index on (provider, subject) is the authority. Losing to
      // it means someone linked this identity first — a race, or a replay of a token
      // whose deletion did not stick.
      if (isUniqueViolation(err)) {
        await this.recordLinkFailure(userId);
        throw new ProblemException({ type: ERR.OAUTH_ALREADY_LINKED });
      }
      throw err;
    } finally {
      await this.cache.clearIfValue(ceremonyKey, linkToken);
    }

    this.logger.log({ userId, provider: identity.provider }, 'oauth provider linked');
  }

  // ─── Settings → Social accounts ───────────────────────────────────────────
  //
  // ═══ WHY THIS IS A SECOND PAIR OF METHODS AND NOT A FLAG ON THE FIRST ═════
  //
  // `start`/`callback` above are a SIGN-IN. The callback's first branch resolves a
  // linked identity into a session, and `AuthController` sets the session cookie
  // from it. That is correct for a login and catastrophic for a settings screen: a
  // signed-in user attaching a provider that already belongs to somebody else would
  // be quietly signed in AS that somebody else, cookie and all.
  //
  // A `mode: 'link'` flag on those methods would have put that branch one boolean
  // away from a settings request, forever. These two methods cannot reach it,
  // because it is not in them. That is the whole argument for the duplication, and
  // the duplication is smaller than it looks — the provider round trip, the PKCE
  // verifier, the nonce, the redirect-URI check, the network binding and the link
  // write are all the SAME calls, reached from here instead of from there.
  //
  // The other half of the separation is the keyspace: link states live under
  // `KEYS.oauth.linkState`, so neither flow can redeem the other's state at all.
  // See the note there for why a shared namespace with a discriminator would have
  // been weaker rather than merely uglier.

  /**
   * Which providers this deployment can complete a sign-in with.
   *
   * A one-line delegation, and it exists to preserve a boundary rather than to do
   * work: `AuthModule` does not export `OauthProviderRegistry`, deliberately, so
   * that this service stays the only thing able to reach an adapter. Settings needs
   * the offered set to render "available to link", and this is how it gets it
   * without that boundary being widened.
   */
  availableProviders(): readonly OauthProvider[] {
    return this.providers.enabled();
  }

  /**
   * Begin a link ceremony for an already-authenticated user.
   *
   * ─── What has already happened by the time this runs ───────────────────────
   *
   * `POST /settings/security/social-accounts/start` wears `ElevationGuard` and
   * `@RequiresElevation('account.social.link')`, so the caller has spent a
   * single-use ticket proved for this exact write — which cost them the emailed
   * code and, on an account that has one, an enrolled factor.
   *
   * ─── How that proof survives the redirect, which is the whole problem ──────
   *
   * It does not travel. A ticket lives sixty seconds and a trip to Google does not
   * fit in sixty seconds, so carrying one across would have meant either a longer
   * ticket — weakening every other elevated write — or a second proof after the
   * user comes back, which is a second 2FA prompt for one action.
   *
   * Instead the ticket is spent HERE, at departure, and the state entry this writes
   * is what the callback trusts. That entry is server-side, single-use, ten minutes
   * long, and bound to the account, the session family, the device and the network.
   * It cannot be minted without a ticket, because this method is only reachable
   * through the guard — so its existence IS the proof, and the callback needs no
   * credential of its own beyond the session it already requires.
   *
   * No `LoginAttempt` row is opened, unlike `start`. There is no sign-in here to
   * attribute one to, and a flow row would be a second thing to retire.
   */
  async startLink(
    principal: { userId: string; sessionId: string; familyId: string },
    input: { provider: OauthProvider; redirectUri?: string },
    client: LinkClientContext,
  ): Promise<{ url: string | null; state: string; flow: OauthFlow }> {
    const adapter = this.providers.require(input.provider);

    // The per-IP bucket `start` charges, shared deliberately: both spend a trip to
    // the provider, and a per-surface bucket would let one caller have two.
    //
    // NOT the per-device bucket. There is no device key on this path (see
    // `LinkClientContext`), and the account ceiling charged below is the better
    // bound anyway — this route is authenticated, so the account is a verified fact
    // rather than a cookie the caller controls.
    await this.quota.consumeAll(
      [{ key: KEYS.rate.oauthStartByIp(client.ip), rule: policy().OAUTH.START_BY_IP }],
      'burst',
      'deny',
    );
    // And the per-account ceiling on link ceremonies, which `POST /auth/link`
    // charges at confirm time. Charged at START here because this is the request
    // that costs a provider round trip, and because a caller who never comes back
    // should still have spent something.
    await this.rateLimitLink(principal.userId);

    const redirectUri = this.resolveRedirectUri(adapter, input.redirectUri);

    const state = randomBytes(32).toString('base64url');
    const codeVerifier = adapter.capabilities.supportsPkce
      ? randomBytes(OAUTH.PKCE_VERIFIER_BYTES).toString('base64url')
      : undefined;
    const codeChallenge =
      codeVerifier === undefined
        ? null
        : createHash('sha256').update(codeVerifier).digest('base64url');
    const nonce = adapter.capabilities.supportsNonce
      ? randomBytes(OAUTH.NONCE_BYTES).toString('base64url')
      : undefined;

    const stash: OauthLinkStateStash = {
      provider: adapter.provider,
      redirectUri,
      ipClass: client.ipClass,
      codeVerifier,
      nonce,
      linkUserId: principal.userId,
      linkFamilyId: principal.familyId,
      linkSessionId: principal.sessionId,
    };
    await this.cache.set(
      KEYS.oauth.linkState(state),
      JSON.stringify(stash),
      policy().OAUTH.STATE_TTL_SECONDS,
    );

    // Null for Telegram, which has no authorization endpoint — the client renders
    // the Login Widget instead of navigating, and `flow` is what tells it to. Same
    // contract as `start`, so a client that implements one implements both.
    const url = adapter.authorizationUrl({
      redirectUri,
      state,
      codeChallenge,
      nonce: nonce ?? null,
    });

    this.logger.log(
      { userId: principal.userId, provider: adapter.provider },
      'oauth link ceremony started',
    );
    return { url, state, flow: adapter.capabilities.flow };
  }

  /**
   * Finish a link ceremony: verify the identity, and attach it to the caller.
   *
   * ═══ THIS METHOD NEVER MINTS A SESSION ═══════════════════════════════════
   *
   * It holds no `SessionService` call, no `BffSessionService` call and no cookie
   * port, and the route above it takes no `FastifyReply`. A provider identity that
   * turns out to belong to another account is a REFUSAL here — `oauth_already_linked`
   * — where the login callback would have signed the caller in. That difference is
   * the reason this method exists.
   *
   * ─── The order of the checks ──────────────────────────────────────────────
   *
   * Everything cheap and everything binding runs before `adapter.verify`, so a
   * callback that does not belong to this ceremony never costs a provider token
   * exchange and never produces a verified identity we would then have to decide
   * what to do with. Same discipline as `callback`.
   */
  async completeLink(
    principal: { userId: string; sessionId: string; familyId: string },
    input: { provider: OauthProvider; code: string; state: string },
    client: LinkClientContext,
  ): Promise<OauthIdentity> {
    const adapter = this.providers.require(input.provider);
    // Per-IP only, for the reason `startLink` gives — and the account is bounded by
    // `recordLinkFailure` on every refusal below.
    await this.quota.consumeAll(
      [{ key: KEYS.rate.oauthCallbackByIp(client.ip), rule: policy().OAUTH.CALLBACK_BY_IP }],
      'burst',
      'deny',
    );

    // Single-use, like every state in this file. Unknown, expired and already
    // redeemed are one refusal.
    const stashed = await this.cache.take(KEYS.oauth.linkState(input.state));
    if (stashed === null) {
      throw new ProblemException({ type: ERR.OAUTH_STATE_INVALID });
    }
    const stash = this.parseLinkState(stashed);

    this.assertSameProvider(stash.provider, adapter.provider);
    this.assertSameNetwork(stash.ipClass, client, 'link-callback');

    // ═══ THE BINDING THAT MAKES THIS A LINK AND NOT A LOGIN ════════════════
    //
    // The account is the one that STARTED the ceremony, and it has to equal the one
    // asking now. Without this, a state minted by user A and leaked — a shared
    // machine, a copied URL, a `Referer` — could be redeemed by user B, and B would
    // have attached A's provider identity to B's account.
    //
    // Note the answer is `oauth_state_invalid` rather than something that says
    // "this belongs to someone else": a caller holding a state they were not given
    // learns nothing, and the legitimate remedy is identical.
    if (stash.linkUserId !== principal.userId || stash.linkFamilyId !== principal.familyId) {
      this.logger.warn(
        {
          expectedUser: stash.linkUserId,
          actualUser: principal.userId,
          startedBySession: stash.linkSessionId,
        },
        'oauth link state redeemed by a different account or login',
      );
      await this.recordLinkFailure(principal.userId);
      throw new ProblemException({ type: ERR.OAUTH_STATE_INVALID });
    }

    const identity = await adapter.verify({
      code: input.code,
      redirectUri: stash.redirectUri,
      codeVerifier: stash.codeVerifier,
      expectedNonce: stash.nonce,
    });

    // Same cross-check `callback` makes: subjects are unique only WITHIN a provider,
    // so an adapter answering with somebody else's provider label would write the
    // link under the wrong pair.
    if (identity.provider !== adapter.provider) {
      this.logger.error(
        { expected: adapter.provider, actual: identity.provider },
        'oauth adapter returned an identity for a different provider',
      );
      throw new ProblemException({ type: ERR.OAUTH_EXCHANGE_FAILED });
    }

    await this.attachToAccount(principal.userId, identity);
    return identity;
  }

  /**
   * Write the link, or say why not.
   *
   * Three refusals, one slug. `oauth_already_linked` covers "this provider identity
   * belongs to another account", "you have already linked this very identity" and
   * "you already have a different account of this provider attached" — because from
   * the caller's side they are one fact, the screen says the same sentence for all
   * three, and distinguishing the first would report whether a given provider
   * identity exists on this service.
   *
   * ─── Why the reads are not the authority ──────────────────────────────────
   *
   * Both checks below are races: a second tab, or a second device, can commit
   * between the read and the insert. They exist so the ordinary case gets a clean
   * refusal without a failed write, and the two partial unique indexes in
   * db/sql/identity.sql are what actually decide — the insert raises 23505 and the
   * catch turns it into the same slug. That is the same insert-and-catch pattern
   * username allocation uses, for the same reason.
   */
  private async attachToAccount(userId: string, identity: OauthIdentity): Promise<void> {
    const existing = await this.users.findOauthLink(identity.provider, identity.subject);
    if (existing !== null) {
      // ─── Re-linking an identity that is counting down TAKES THE UNLINK BACK ──
      //
      // There is no cancel endpoint, and this is why one is not needed. The caller
      // has completed the full ceremony — an elevation ticket proved for the link,
      // a provider round trip, and a link state bound to this account, login, device
      // and network — and arrived back holding the very identity that is scheduled
      // to go. The outcome they are asking for is "leave this exactly as it was".
      //
      // Safe to allow where a SWAP is not, and the asymmetry is the whole design:
      // letting a different account of the same provider take the slot early would
      // let anyone holding a session and the mailbox replace the social login in one
      // ceremony, which is precisely what the seven days exist to prevent. Restoring
      // the status quo grants nobody anything — there is no state an attacker
      // reaches by cancelling somebody else's unlink.
      //
      // No email. The scheduling notice already told the owner what was pending and
      // named this as the way back, and a message saying "nothing changed after all"
      // would be noise on the one path that needs none.
      //
      // Nullish rather than `!== null`: "there is a pending unlink" is the question,
      // and a row that answers it with `undefined` — an older client, a projection
      // that did not select the column — must take the ordinary refusal rather than
      // the cancel path.
      if (existing.userId === userId && existing.unlinkAt != null) {
        if (await this.users.cancelOauthUnlink(existing.id)) {
          this.logger.log(
            { userId, provider: identity.provider },
            'pending social unlink cancelled by re-link',
          );
          // Not `recordLinkFailure`: this is a completed ceremony, not a refusal.
          return;
        }
        // The swap failed, so the row changed under us — the sweep retired it on the
        // deadline. Fall through: the refusal below is the honest answer, and the
        // caller's retry links fresh against a now-absent row.
      }

      await this.recordLinkFailure(userId);
      throw new ProblemException({
        type: ERR.OAUTH_ALREADY_LINKED,
        detail:
          existing.userId === userId
            ? 'That account is already linked to this Orebit account.'
            : 'That account is already linked to a different Orebit account.',
      });
    }

    // One live link per provider per account, checked here and enforced by
    // `ix_oauth_links_user_provider_active`.
    //
    // A link with a pending unlink is still LIVE and so still occupies the slot. That
    // is deliberate — see the branch above for why a different account of the same
    // provider must wait out the deadline rather than take the slot early — but the
    // refusal has to say so, because "already linked" reads as a contradiction to
    // somebody who asked to unlink it an hour ago.
    const held = await this.users.listOauthLinks(userId);
    const occupant = held.find((link) => link.provider === identity.provider);
    if (occupant !== undefined) {
      await this.recordLinkFailure(userId);
      throw new ProblemException({
        type: ERR.OAUTH_ALREADY_LINKED,
        // Nullish-guarded for the reason above, and here it also keeps a missing
        // column from turning a refusal into a TypeError.
        detail:
          occupant.unlinkAt == null
            ? `A ${identity.provider} account is already linked to this Orebit account.`
            : `A ${identity.provider} account is already linked to this Orebit account and ` +
              `is scheduled to be removed on ${occupant.unlinkAt.toISOString()}. ` +
              `You can link a different ${identity.provider} account after that.`,
      });
    }

    // The same marker `attachPending` takes, keyed by account and provider, so two
    // tabs cannot race two distinct identities into one permanent credential slot.
    const ceremonyKey = KEYS.rate.oauthLinkCeremony(userId, identity.provider);
    const acquired = await this.cache.setIfAbsent(
      ceremonyKey,
      identity.subject,
      policy().OAUTH.PENDING_TTL_SECONDS,
    );
    if (!acquired) {
      await this.recordLinkFailure(userId);
      throw new ProblemException({ type: ERR.OAUTH_LINK_INVALID });
    }

    try {
      await this.users.linkOauth(userId, {
        provider: identity.provider,
        subject: identity.subject,
        // `?? ''` rather than null, matching `attachPending`, so one column does not
        // carry two spellings of "the provider gave us no address". The settings
        // read normalises it back to null.
        emailAtLink: identity.email ?? '',
        emailVerifiedByProvider: identity.emailVerified,
        avatarUrl: identity.avatarUrl,
        nameAtLink: identity.name,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        await this.recordLinkFailure(userId);
        throw new ProblemException({ type: ERR.OAUTH_ALREADY_LINKED });
      }
      throw err;
    } finally {
      await this.cache.clearIfValue(ceremonyKey, identity.subject);
    }

    this.logger.log(
      { userId, provider: identity.provider },
      'oauth provider linked from settings',
    );
  }

  /**
   * Read a link state back, refusing anything that is not one.
   *
   * `JSON.parse` will happily produce an object with no `linkUserId`, and that
   * object would authorise a link to whoever happened to be asking. So every field
   * the checks depend on is verified to be a non-empty string here, and the whole
   * entry is refused otherwise.
   *
   * Deliberately NOT the rolling-deploy tolerance `callback` grants missing fields.
   * That tolerance is safe there because an attacker cannot MANUFACTURE a
   * field-less entry — the only ones in existence are legitimate flows already in
   * flight. There are no legitimate link states missing `linkUserId`, in flight or
   * otherwise, because none has ever been written without one.
   */
  private parseLinkState(stashed: string): OauthLinkStateStash {
    let parsed: Partial<OauthLinkStateStash>;
    try {
      parsed = JSON.parse(stashed) as Partial<OauthLinkStateStash>;
    } catch {
      throw new ProblemException({ type: ERR.OAUTH_STATE_INVALID });
    }

    const present = (value: unknown): value is string =>
      typeof value === 'string' && value !== '';

    if (
      !present(parsed.provider) ||
      !present(parsed.ipClass) ||
      !present(parsed.linkUserId) ||
      !present(parsed.linkFamilyId) ||
      typeof parsed.redirectUri !== 'string'
    ) {
      throw new ProblemException({ type: ERR.OAUTH_STATE_INVALID });
    }

    return parsed as OauthLinkStateStash;
  }

  /** Park a verified identity behind a fresh `linkToken` and return it. */
  private async parkPending(identity: OauthIdentity, client: ClientContext): Promise<string> {
    const linkToken = generateContinuationSecret();
    await this.cache.set(
      KEYS.oauth.pending(linkToken),
      JSON.stringify({
        identity,
        ipClass: client.ipClass,
        deviceKey: client.deviceKey,
        purpose: 'oauth-choice',
      } satisfies OauthPendingStash),
      policy().OAUTH.PENDING_TTL_SECONDS,
    );
    return linkToken;
  }

  /**
   * Read the parked identity, leaving it in place, and check the network.
   *
   * Both readers take a `ClientContext` rather than only the token, because the
   * recorded `ipClass` is useless if a caller can reach the identity without
   * presenting one. Making it a required parameter is what stops a future call site
   * quietly skipping the check.
   */
  private async readPending(
    linkToken: string,
    client: ClientContext,
    stage: string,
  ): Promise<OauthIdentity> {
    return this.parsePending(await this.cache.get(KEYS.oauth.pending(linkToken)), client, stage);
  }

  /** Read the parked identity and spend it in the same step. */
  private async takePending(
    linkToken: string,
    client: ClientContext,
    stage: string,
  ): Promise<OauthIdentity> {
    return this.parsePending(await this.cache.take(KEYS.oauth.pending(linkToken)), client, stage);
  }

  private parsePending(
    stashed: string | null,
    client: ClientContext,
    stage: string,
  ): OauthIdentity {
    // Unknown, expired, and already spent are one refusal: none of them tell the
    // caller anything except "start again at the provider".
    if (stashed === null) {
      throw new ProblemException({ type: ERR.OAUTH_LINK_INVALID });
    }
    const parsed = JSON.parse(stashed) as Partial<OauthPendingStash>;
    if (
      parsed.purpose !== 'oauth-choice' ||
      typeof parsed.deviceKey !== 'string' ||
      parsed.deviceKey !== client.deviceKey ||
      parsed.identity === undefined
    ) {
      throw new ProblemException({ type: ERR.OAUTH_LINK_INVALID });
    }
    this.assertSameNetwork(parsed.ipClass, client, stage);
    return parsed.identity;
  }

  /**
   * Create (or resume) an OAuth-initiated registration.
   *
   * The email is treated as verified ONLY when the provider asserts it. Otherwise
   * the attempt runs through our own OTP exactly as a direct signup would — a
   * provider's unverified email is a claim, not evidence, and accepting it would let
   * anyone who can create a provider account with someone else's address claim that
   * address here.
   *
   * ─── Why a trusted attempt starts at CREDENTIALS_SET ──────────────────────
   *
   * The direct path needs `credentials` because the user has a decision to make: set
   * a password, or skip. Someone arriving from a provider has already made it — the
   * provider IS the credential — so the step could only ever be called with
   * `skip: true`, and its sole effect would be to advance the state. A no-op the
   * client is obliged to perform is not a step, it is a round trip, and it puts the
   * "Continue with…" flow one screen away from where it should land.
   *
   * Starting at `CREDENTIALS_SET` deletes that call: `country` is legal the moment
   * the client comes back from `oauth-register`. The account is created with
   * `pendingPasswordHash: null`, which is exactly what `skip: true` would have
   * stored, so the resulting user is byte-for-byte the same one the old two-call
   * sequence produced — no password, reachable through the provider or, since it has
   * no credential row, through email OTP.
   *
   * This is a state assignment, not a relaxed guard: `STEP_REQUIRES.country` still
   * insists on `CREDENTIALS_SET` and no client can talk its way into it.
   *
   * An untrusted email still starts at `OTP_SENT`, because that attempt has not
   * proven the address yet — but it skips `credentials` too, one step later:
   * `verifyEmail` lands an OAuth-initiated row on `CREDENTIALS_SET` directly. The
   * rule is the same either way, and belongs to the registration rather than to the
   * door it came through — an OAuth registration never owes a credential decision.
   * What the provider's `email_verified` claim changes is only whether we send a
   * code first.
   */
  private async beginRegistration(
    identity: OauthIdentity,
    emailLower: string,
    client: ClientContext,
  ): Promise<OauthRegisterOutcome> {
    // A resumed attempt gets a FRESH secret rather than the old one, which we could
    // not return anyway — only its hash was ever stored. Re-issuing also invalidates
    // whatever cookie the previous attempt left behind.
    const continuationSecret = generateContinuationSecret();

    const existing = await this.registrations.findResumableByOauth(
      identity.provider,
      identity.subject,
    );
    if (existing !== null) {
      await this.registrations.setContinuationSecret(
        existing.id,
        pepperedHash(continuationSecret, 'continuation'),
      );
      return {
        kind: 'registration_required',
        continuationSecret,
        email: existing.email,
        emailVerified: existing.emailVerifiedAt !== null,
      };
    }

    const trusted = identity.emailVerified;
    const code = trusted ? null : generateOtp();
    // Shared between the row and the message, so both enforce the same instant.
    const otpExpiresAt = code === null ? null : secondsFromNow(OTP.TTL_SECONDS);

    // ─── The recipient's mail budget, charged HERE too ───────────────────────
    //
    // This path used to send a registration OTP without touching
    // `REGISTRATION.OTP_MAIL_BY_RECIPIENT` at all. The budget is keyed on the ADDRESS
    // precisely so it cannot be reset by restarting a signup — but it was only ever
    // charged by `RegistrationService`, so the same signup started through a provider
    // spent nothing. Anyone wanting unmetered mail to an address simply used the OAuth
    // entrance to the identical flow.
    //
    // Charged before the row is created, so a caller who is over budget has not left a
    // registration behind for a code that was never sent — the same ordering the direct
    // path uses.
    //
    // Only when a code is actually owed: a provider-verified email sends nothing, and
    // charging for it would take a slot from a budget that measures messages.
    const mailCharge =
      code === null ? null : await chargeOtpMail(this.quota, emailLower);

    let registration: Registration | null = null;

    try {
      // The country step is the next thing a trusted attempt sees, so it needs the
      // same preselect the direct path has always had. `resolve` never throws and
      // answers `null` when it cannot tell, which costs the user one dropdown
      // interaction and nothing else.
      const geo = await this.geo.resolve(client.ip);

      registration = await this.registrations.create({
        email: identity.email ?? emailLower,
        emailLower,
        ipAddress: client.ip,
        countrySuggested: geo.country,
        otpHash: code === null ? null : pepperedHash(code, 'otp'),
        otpExpiresAt,
        expiresAt: secondsFromNow(REGISTRATION.TTL_SECONDS),
        continuationSecretHash: pepperedHash(continuationSecret, 'continuation'),
        state: trusted ? 'CREDENTIALS_SET' : 'OTP_SENT',
        emailVerified: trusted,
        oauth: {
          provider: identity.provider,
          subject: identity.subject,
          emailVerified: identity.emailVerified,
          avatarUrl: identity.avatarUrl,
        },
      });

      if (code !== null && otpExpiresAt !== null && mailCharge !== null) {
        // AWAITED, unlike before. The old comment justified firing this off "because
        // the registration is returned to the caller without waiting on SMTP" — but
        // `sendOtp` does not wait on SMTP; it is one `XADD` onto the queue, and the
        // worker does the waiting. What not awaiting actually bought was an unhandled
        // promise rejection whenever Redis refused the job, plus a registration row in
        // state OTP_SENT holding a live hash for a code that was never queued and
        // never would be: the user is told to check their email, finds nothing, and
        // cannot proceed.
        //
        // The row is created with one send already charged, so the undo hands back
        // BOTH that and the address's budget — otherwise this user starts one short
        // for an email they never got.
        await this.mail.sendOtp(
          registration.email,
          code,
          otpExpiresAt,
          [
            { kind: 'registration.refund-otp-send', registrationId: registration.id },
            refundOtpMail(mailCharge),
          ],
          // A provider-initiated REGISTRATION: no account yet, so no code to show.
          null,
        );
      }
    } catch (error) {
      const row = registration;
      try {
        if (row !== null && code !== null) {
          await this.registrations.invalidateOtp(row.id, pepperedHash(code, 'otp'));
          await this.registrations.refundOtpSend(row.id);
        }
        if (mailCharge !== null) await this.quota.refund(mailCharge, 'durable');
      } catch (err) {
        // Never let the compensation replace the failure that caused it.
        this.logger.error({ err }, 'compensation after a failed OAuth registration send failed');
      }
      throw error;
    }

    return {
      kind: 'registration_required',
      continuationSecret,
      email: registration.email,
      emailVerified: trusted,
    };
  }

  /**
   * The callback must name the same provider the flow started with.
   *
   * Without this, a `state` minted for one provider could be redeemed against
   * another's adapter. The exchange itself would almost certainly fail — a Google
   * code is not a Facebook code — but "almost certainly" is not a security property,
   * and the failure would be a 502 rather than a refusal that says what happened.
   *
   * There is a sharper case than a failed exchange. Telegram's verification needs no
   * round trip at all: it is an HMAC over a payload the caller supplies. Handing a
   * Telegram payload to a callback whose state was minted for Google must not be a
   * question of which adapter happens to be selected, and this is what settles it.
   *
   * `stashed === undefined` is the rolling-deploy tolerance, same as PKCE's and the
   * IP class's — and it is safe for a reason worth stating, because "tolerate a
   * missing security field" usually is not. After this deploy every entry `start`
   * writes carries a provider, so an attacker cannot MANUFACTURE one that lacks it.
   * The only provider-less entries in existence are legitimate flows that were
   * already in flight, and they drain within `OAUTH.STATE_TTL_SECONDS`. Refusing
   * them instead would fail every sign-in mid-flight at deploy time to close a
   * window nobody can reach.
   */
  private assertSameProvider(stashed: OauthProvider | undefined, actual: OauthProvider): void {
    if (stashed === undefined || stashed === actual) return;

    this.logger.warn(
      { expected: stashed, actual },
      'oauth callback named a different provider than the authorization request',
    );
    throw new ProblemException({ type: ERR.OAUTH_STATE_INVALID });
  }

  /**
   * The request finishing an OAuth flow must come from the network that started it.
   *
   * ─── Why every parked handle carries an ipClass ────────────────────────────
   *
   * Both `oauth:state` and `oauth:pending` have recorded one since they were
   * written. Each is an opaque handle that travels through a browser — through a
   * redirect, a URL, a `Referer`, shared history — and the recorded prefix is what
   * binds the half of the flow that comes back to the half that went out.
   *
   * ─── /24 rather than the address, and what that means here ────────────────
   *
   * `ipClassOf` picks a prefix precisely because it is compared across requests: a
   * mobile client's exact address changes constantly inside one carrier block, so
   * comparing full addresses would refuse every legitimate flow and catch none of
   * the real relocations. The prefix survives movement WITHIN a network and still
   * changes when someone moves between one.
   *
   * Which means the honest description of the false positive: a phone dropping from
   * wi-fi to mobile data mid-flow is refused. It is recoverable — start again — and
   * `OAUTH_CONTEXT_MISMATCH` exists so a client can say which of the two things
   * happened rather than showing a generic failure.
   *
   * `stashed === undefined` is the rolling-deploy tolerance, same as PKCE's: an
   * entry written by the previous version has no prefix to compare.
   */
  private assertSameNetwork(
    stashed: string | undefined,
    // Widened from `ClientContext` to the one field it reads, so the Settings link
    // ceremony can share it. That flow has no device cookie to build a full context
    // from — see `LinkClientContext` — and every existing caller still satisfies
    // this, because `ClientContext` has an `ipClass`.
    client: { readonly ipClass: string },
    stage: string,
  ): void {
    if (stashed === undefined || stashed === client.ipClass) return;

    // Logged whether or not it is enforced, so turning the policy off leaves the
    // signal intact rather than blinding the thing that would tell you to turn it
    // back on.
    this.logger.warn(
      { stage, enforced: OAUTH.ENFORCE_IP_CLASS, expected: stashed, actual: client.ipClass },
      'oauth flow continued from a different network',
    );

    if (!OAUTH.ENFORCE_IP_CLASS) return;
    throw new ProblemException({ type: ERR.OAUTH_CONTEXT_MISMATCH });
  }

  /**
   * A caller-supplied redirect URI is honoured only if it matches the one this
   * provider is configured with. Anything else is an open redirect: the
   * authorization code arrives at whatever address is named, so accepting an
   * arbitrary value hands the code — and with it the account — to whoever asked.
   *
   * Per-adapter rather than one constant, because each provider registers its own
   * callback URL. Telegram's is deliberately the empty string — its callback is
   * configured in the bot's domain settings rather than here — so every non-empty
   * value a caller could send mismatches, which is the correct answer.
   */
  private resolveRedirectUri(
    adapter: OauthProviderAdapter,
    requested: string | undefined,
  ): string {
    const configured = adapter.configuredRedirectUri;
    if (requested === undefined) return configured;
    if (requested !== configured) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [{ path: 'redirectUri', message: 'Does not match the configured redirect URI' }],
      });
    }
    return requested;
  }
}
