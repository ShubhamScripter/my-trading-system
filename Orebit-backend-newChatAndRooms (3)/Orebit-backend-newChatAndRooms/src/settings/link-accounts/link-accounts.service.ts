import { Injectable, Logger } from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { OauthLink, OauthProvider } from '@prisma/client';
import { SOCIAL_UNLINK } from '../../../auth/auth.constants';
import type { Principal } from '../../../auth/auth.types';
import { policy } from '../../../auth/limits';
import { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { OauthService, type LinkClientContext } from '../../../auth/services/oauth.service';
import { CacheService, KEYS } from '../../../redis';
import { ElevationService } from '../../2fa/elevation';
import { MfaService } from '../../2fa/mfa.service';
import { TwoFactorService } from '../../2fa/2fa.service';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import { MailService } from '../../mail/mail.service';
import { antiPhishingCodeOf } from '../antiPhishing/antiPhishing.utility';
import type { LinkStartedPayload } from './link-accounts.dto';
import {
  LINK_ELEVATION_ACTION,
  UNLINK_ELEVATION_ACTION,
  type LinkedSocialAccount,
  type LinkProofs,
  type SocialAccountsStatus,
} from './link-accounts.types';
import { resolveLinkProof } from './link-accounts.utility';

/**
 * Attaching a social provider to an account that already exists.
 *
 * ─── What this service adds over `POST /auth/link` ─────────────────────────
 *
 * `auth/` can already attach a provider identity to an account. What it cannot
 * express is the product policy for doing it from a settings screen, which differs
 * in three ways:
 *
 *  1. An emailed code is required on EVERY path. `POST /auth/link` requires none —
 *     see `TwoFactorService.emailCodeRequiredFor`, which excludes
 *     `account.oauth.link` deliberately.
 *  2. An account with no enrolled factor owes nothing beyond that code.
 *     `reauthVerify` would demand the account PASSWORD, which an account created
 *     through a provider does not have at all.
 *  3. The ceremony must never produce a session. `POST /auth/login`'s OAuth callback
 *     can and does, which is why this path has its own.
 *
 * ─── Why none of that is implemented here ──────────────────────────────────
 *
 * It is composed. `TwoFactorService` publishes the narrow provers for exactly this
 * case — its own comments say `provePasskeyAssertion` and `proveTotpCode` are public
 * because "`src/settings/` needs to prove ONE named factor rather than 'any factor
 * the account has'", and `consumeCredentialOtp` because "`src/settings/` owes the
 * same emailed code on three of its four disable paths". `SettingsService.disable`
 * already composes them this way. The OAuth half is `OauthService.startLink` /
 * `completeLink`.
 *
 * So this file holds no crypto, no Prisma, no WebAuthn import and no session port.
 * That last one is not incidental: `SessionService` and `BffSessionService` are
 * absent from the constructor, so no code path here can mint a session even by
 * mistake.
 *
 * ─── Ordering, and why the emailed code is NOT spent first ─────────────────
 *
 * Every other consumer in this service spends the emailed code before comparing a
 * factor, so a wrong code cannot be used to probe whether a TOTP guess was right.
 * That still holds here. What runs even earlier is proof AVAILABILITY — the same
 * exception `SettingsService` carves out for `assertPathAvailable`: telling a user
 * "you sent a TOTP code and have no authenticator" after burning their emailed code
 * would charge them for a mistake the server could have reported for free.
 *
 * So the order is: bound the attempt, decide which proof is owed, spend the code,
 * then compare the factor.
 */
@Injectable()
export class LinkAccountsService {
  private readonly logger = new Logger('LinkAccounts');

  constructor(
    private readonly twoFactor: TwoFactorService,
    private readonly mfa: MfaService,
    private readonly elevation: ElevationService,
    private readonly oauth: OauthService,
    private readonly users: UserDbOperation,
    private readonly cache: CacheService,
    private readonly mail: MailService,
  ) {}

  // ─── read ─────────────────────────────────────────────────────────────────

  /**
   * What the settings screen renders: what is linked, and what is left.
   *
   * Two filters on `availableProviders`, and both are needed. Configuration decides
   * which providers this deployment offers at all — a build can ship five adapters
   * and hold credentials for two — and the one-link-per-provider rule decides which
   * of those are still free. Offering a provider that fails either test would render
   * a button that cannot work.
   *
   * ─── A provider with a pending unlink is still HELD ────────────────────────
   *
   * So it stays in `accounts` and stays out of `availableProviders`, which is the
   * honest answer on both counts: the link works, and the slot is occupied until the
   * deadline passes. Putting it back in `availableProviders` was the tempting
   * alternative and is wrong — it would render a generic "link this provider" button
   * that succeeds for the same provider account and fails with `oauth_already_linked`
   * for a different one, after a full round trip to the provider.
   *
   * The way back from a mis-clicked unlink is therefore driven by `unlinkAt` on the
   * account row, which says both that a removal is pending and when.
   *
   * Nothing here leaks: every value describes the caller's own account.
   */
  async status(userId: string): Promise<SocialAccountsStatus> {
    const links = await this.users.listOauthLinks(userId);
    const held = new Set<OauthProvider>(links.map((link) => link.provider));

    return {
      accounts: links.map(toLinkedAccount),
      availableProviders: this.oauth
        .availableProviders()
        .filter((provider) => !held.has(provider)),
    };
  }

  // ─── security verification ────────────────────────────────────────────────

  /**
   * What this account can prove, and the WebAuthn options if it holds a passkey.
   *
   * Delegates wholesale to the re-authentication challenge, passing this feature's
   * own action so the advertised list matches what will actually be accepted —
   * `reauthMethods` withholds `recovery_code` for every intent except factor
   * removal, which is the answer we want: a printed sheet must not attach a
   * provider.
   *
   * An account with nothing enrolled gets `methods: []` and `options: null`, which
   * is how a client knows to render no factor prompt at all.
   */
  async challenge(
    userId: string,
  ): Promise<{ methods: readonly string[]; options: Record<string, unknown> | null }> {
    return this.twoFactor.reauthChallenge(userId, LINK_ELEVATION_ACTION);
  }

  /**
   * Spend the emailed code and one factor, and issue the ticket for ONE social write.
   *
   * See `resolveLinkProof` for the four cases. The ticket this returns is single-use,
   * bound to this session and to exactly one action — it cannot be spent on
   * `POST /auth/link`, nor on adding or removing a factor.
   *
   * ─── Why link and unlink share this route ──────────────────────────────────
   *
   * Because they owe the identical proof. Both demand an emailed code on every path
   * and one enrolled factor when the account has one, so a second `/verify` would have
   * been the same forty lines under a different URL, and the day the policy changed
   * the two copies would have disagreed.
   *
   * What they must NOT share is the resulting permit, and they do not: `intent`
   * selects the action stamped into the grant, and `ElevationService.spend` refuses a
   * grant whose action is not the one the route names. So proving here buys the
   * caller one of the two writes, never both, and never the other one.
   */
  async verify(
    principal: Principal,
    input: { emailCode: string; intent?: 'link' | 'unlink' } & LinkProofs,
  ): Promise<{ ticket: string; expiresInSeconds: number; action: string }> {
    // Keyed on the SESSION, and the same bucket `reauth-verify` charges. This route
    // is bearer-only and compares credentials, so something has to bound a stolen
    // access token grinding it; `deny` on a cache failure because there is no
    // durable backstop here the way `Credential.failedAttempts` is for passwords.
    await this.cache.consume(
      KEYS.rate.reauthBySession(principal.sessionId),
      policy().MFA.REAUTH_FAIL_BY_SESSION,
      'deny',
    );

    const methods = await this.mfa.availableMethods(principal.userId);
    const enrolled = {
      hasTotp: methods.includes('totp'),
      hasPasskey: methods.includes('passkey'),
    };

    // BEFORE anything is consumed — see the ordering note on the class.
    const resolved = resolveLinkProof(input, enrolled);
    if (!resolved.ok) {
      throw new ProblemException({
        type: ERR.MFA_METHOD_UNAVAILABLE,
        detail: resolved.message,
      });
    }

    // Spent whatever happens next, which is the point: an abandoned request must
    // still have cost the code, and a wrong code must not be usable to probe
    // whether the factor beside it was right.
    await this.twoFactor.consumeCredentialOtp(principal.userId, input.emailCode);

    if (resolved.method !== 'none') {
      const proven =
        resolved.method === 'passkey'
          ? await this.twoFactor.provePasskeyAssertion(
              principal.userId,
              input.passkey as AuthenticationResponseJSON,
            )
          : await this.twoFactor.proveTotpCode(principal.userId, input.totpCode as string);

      if (!proven) {
        throw new ProblemException({ type: ERR.MFA_CODE_INVALID });
      }
    }

    const action =
      input.intent === 'unlink' ? UNLINK_ELEVATION_ACTION : LINK_ELEVATION_ACTION;

    this.logger.log(
      { userId: principal.userId, method: resolved.method, action },
      'social account verification passed',
    );
    return this.elevation.issue(principal.sessionId, action);
  }

  // ─── the provider round trip ──────────────────────────────────────────────

  /**
   * Begin the ceremony. Reachable only through `ElevationGuard`, which has already
   * spent a ticket proved for this exact write — see the route.
   */
  async start(
    principal: Principal,
    input: { provider: OauthProvider; redirectUri?: string },
    client: LinkClientContext,
  ): Promise<Omit<LinkStartedPayload, 'outcome'>> {
    const started = await this.oauth.startLink(principal, input, client);
    return {
      provider: input.provider,
      url: started.url,
      state: started.state,
      flow: started.flow,
    };
  }

  /**
   * Finish it: verify the identity and attach it to the calling account.
   *
   * No elevation of its own, and that is deliberate rather than an omission. A
   * ticket lives sixty seconds and a trip to a provider does not fit in sixty
   * seconds, so demanding one here would mean either a longer-lived ticket —
   * weakening every other elevated write in the service — or a second factor prompt
   * after the user comes back, for one action they already authorised.
   *
   * What stands in its place is the link state, which `startLink` could not have
   * written without a ticket: it is server-side, single-use, ten minutes long, and
   * bound to the account, the login, the device and the network. Its existence is
   * the proof.
   *
   * Re-reads the row rather than building the answer from the identity in hand, so
   * the client is handed the same shape `status` returns, with the database's own
   * timestamps rather than this process's clock.
   */
  async complete(
    principal: Principal,
    input: { provider: OauthProvider; code: string; state: string },
    client: LinkClientContext,
  ): Promise<LinkedSocialAccount> {
    const identity = await this.oauth.completeLink(principal, input, client);

    const written = (await this.users.listOauthLinks(principal.userId)).find(
      (link) => link.provider === identity.provider && link.subject === identity.subject,
    );
    if (written === undefined) {
      // Unreachable: `completeLink` either wrote the row or threw. A refusal rather
      // than a fabricated payload, because answering 201 with invented timestamps
      // would report a link nobody can find.
      throw new ProblemException({ type: ERR.INTERNAL_ERROR });
    }

    return toLinkedAccount(written);
  }

  // ─── the delayed unlink ───────────────────────────────────────────────────

  /**
   * Schedule the removal of a linked provider. NOTHING IS REMOVED HERE.
   *
   * ─── Why this writes a deadline instead of a `deletedAt` ───────────────────
   *
   * A linked provider is a way into the account, and this request is reachable by
   * anyone holding a live session and the mailbox. Removing the link immediately would
   * let such a party quietly close the owner's route in while the owner learns about it
   * from an email they may not read for days. So the request announces itself and then
   * waits: the link stays live, provider sign-in keeps working, and
   * `SocialUnlinkSweeper` retires the row once the deadline passes.
   *
   * The email is therefore a warning with time attached rather than a receipt, which
   * is also why its delivery is not load-bearing — see the send below.
   *
   * ─── Scoping, and why another account's link is unreachable ────────────────
   *
   * The caller names a provider. Everything else comes from the principal, and the row
   * is found by scanning THIS user's own links, so there is no field on which to name
   * somebody else's link and no lookup that could resolve one.
   *
   * ─── Idempotent on purpose ─────────────────────────────────────────────────
   *
   * A second click returns the original deadline and writes nothing. Resetting the
   * countdown on every click would let anyone with the session hold the removal at
   * seven days away indefinitely; refusing outright would make a double-submit look
   * like a failure and cost another emailed code to retry. Returning the standing
   * answer is the only option that is both honest and safe.
   */
  async requestUnlink(
    principal: Principal,
    provider: OauthProvider,
    ipClass: string,
  ): Promise<{ provider: OauthProvider; unlinkAt: string }> {
    const link = (await this.users.listOauthLinks(principal.userId)).find(
      (held) => held.provider === provider,
    );

    // `listOauthLinks` filters soft-deleted rows, so "not found" covers both "never
    // linked" and "already retired". `NOT_FOUND` rather than a bespoke slug: the
    // caller named a thing this account does not have, which is what it means.
    if (link === undefined) throw new ProblemException({ type: ERR.NOT_FOUND });

    if (link.unlinkAt !== null) {
      return { provider, unlinkAt: link.unlinkAt.toISOString() };
    }

    const unlinkAt = new Date(Date.now() + SOCIAL_UNLINK.DELAY_DAYS * 24 * 60 * 60 * 1000);

    if (!(await this.users.scheduleOauthUnlink(link.id, unlinkAt))) {
      // Lost the compare-and-swap: a second tab scheduled between our read and our
      // write, or the sweep retired the row. Re-read and answer with whatever is
      // actually true now, rather than reporting a deadline we did not set.
      const current = (await this.users.listOauthLinks(principal.userId)).find(
        (held) => held.provider === provider,
      );
      if (current?.unlinkAt == null) throw new ProblemException({ type: ERR.NOT_FOUND });
      return { provider, unlinkAt: current.unlinkAt.toISOString() };
    }

    this.logger.warn(
      { userId: principal.userId, provider, unlinkAt },
      'social account unlink scheduled',
    );

    // After the write, and fire-and-forget by `MailService`'s own contract: the
    // deadline is already recorded, and a mail failure must not report the request as
    // failed. Unlike a disable, nothing has been removed that the user would try
    // again — the pending state is on the settings screen either way.
    //
    // Only on the path that actually scheduled something, so a double-submit sends
    // one email rather than two.
    const user = await this.users.findById(principal.userId);
    if (user !== null) {
      this.mail.sendSocialUnlinkScheduled(
        user.email,
        provider,
        unlinkAt,
        ipClass,
        antiPhishingCodeOf(user),
      );
    }

    return { provider, unlinkAt: unlinkAt.toISOString() };
  }
}

/**
 * One stored link, as the API shows it.
 *
 * ─── The two normalisations, and why they are here rather than in the column ──
 *
 * `emailAtLink` is written as `''` by both writers when the provider supplied no
 * address — `attachPending` has done that since it was written, and the settings
 * path matches it so one column does not carry two spellings of the same fact. The
 * API says `null`, because an empty string in a JSON field a client renders is a
 * blank line rather than an absence.
 *
 * `subject` is absent, and that is the point of having a mapper at all: the row
 * carries the provider's identifier for the person and no response ever should.
 */
function toLinkedAccount(link: OauthLink): LinkedSocialAccount {
  return {
    provider: link.provider,
    displayName: link.nameAtLink,
    email: link.emailAtLink === null || link.emailAtLink === '' ? null : link.emailAtLink,
    emailVerifiedByProvider: link.emailVerifiedByProvider,
    imageUrl: link.avatarUrlAtLink,
    linkedAt: link.linkedAt.toISOString(),
    lastLoginAt: link.lastLoginAt === null ? null : link.lastLoginAt.toISOString(),
    // `unlinkRequestedAt` is deliberately NOT exposed. It is an audit column; the
    // only date a screen can act on is the one the removal happens.
    unlinkAt: link.unlinkAt === null ? null : link.unlinkAt.toISOString(),
  };
}
