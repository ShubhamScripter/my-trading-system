import { Injectable } from '@nestjs/common';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { ClientContext, Principal } from '../../auth/auth.types';
import type { LoginPayload } from '../../auth/auth.dto';
import { toSessionPayload } from '../../auth/auth.dto';
import { UserDbOperation } from '../../auth/persistence/user.dboperation';
import type { SessionCookie } from '../../auth/security/session.cookie';
import { BffSessionService } from '../../auth/security/bff.session';
import { SessionService } from '../../auth/services/session.service';
import { ERR } from '../contracts';
import { ok, parseDto, ProblemException, type SuccessEnvelope } from '../http';
import { ElevationService } from './elevation';
import { MfaService } from './mfa.service';
import { TwoFactorService } from './2fa.service';
import {
  twoFactorRequestSchema,
  twoFactorVerifySchema,
  type FactorListPayload,
  type FactorPayload,
  type TwoFactorPayload,
} from './2fa.dto';
import { TWO_FACTOR_REQUIRES } from './2fa.types';
import type { EnrolledFactor } from './2fa.types';

/**
 * Parse, delegate, serialise. No business logic — the same contract every
 * `*.controller.ts` in this codebase keeps.
 *
 * Two things live here that are not delegation, and both are here rather than in a
 * service on purpose:
 *
 *   the credential check for each action, because `TWO_FACTOR_REQUIRES` maps an
 *   action to what must be presented, and "was a ticket presented" is a question
 *   about the REQUEST rather than about factors; and
 *
 *   minting the session at the end of a ceremony, because `SessionService` is an
 *   `auth` service and `MfaService` deliberately cannot reach it. See
 *   2fa.core.module.ts for why the feature is two Nest modules.
 */
@Injectable()
export class TwoFactorController {
  constructor(
    private readonly twoFactor: TwoFactorService,
    private readonly mfa: MfaService,
    private readonly elevation: ElevationService,
    private readonly sessions: SessionService,
    private readonly users: UserDbOperation,
    private readonly bff: BffSessionService,
  ) {}

  // ─── GET /auth/2fa ────────────────────────────────────────────────────────

  async list(principal: Principal): Promise<SuccessEnvelope<FactorListPayload>> {
    const { factors, recoveryCodesRemaining } = await this.twoFactor.list(principal.userId);
    return ok({ factors: factors.map(toFactorPayload), recoveryCodesRemaining });
  }

  // ─── POST /auth/2fa/verify ────────────────────────────────────────────────

  /**
   * Complete a sign-in that stopped at `mfa_required`.
   *
   * Public — by definition. The caller has no access token; the whole point of the
   * ceremony is that they are halfway to one. What stands in for a bearer is the
   * `loginId`, which names a server-side row that expires in ten minutes and
   * authorises nothing except this step.
   *
   * ─── Why the session is minted here ───────────────────────────────────────
   *
   * `MfaService.proveFactor` returns the verified attempt rather than a session,
   * because it lives in the module `auth` depends on and must not depend back. So
   * the last two steps — issue and set cookies — happen at this seam.
   *
   * ─── The session is minted from THIS request's context ────────────────────
   *
   * It used to be minted from the context captured on the attempt, substituting the
   * stored `deviceKey`, `ipClass` and `userAgent` into what `SessionService.issue`
   * received. The argument was that the finishing request might carry no device
   * cookie, and that using the live context would drop remember-me for every 2FA
   * sign-in.
   *
   * The argument does not hold, and the substitution was a security hole. `contextOf`
   * SETS a device cookie on the first half of the ceremony, so a browser arriving
   * here already has the same one — the two contexts match in the ordinary case, and
   * nothing needed substituting. What the substitution actually did was hand whoever
   * held the `loginId` a session stamped with the ORIGINAL browser's identity,
   * inheriting that browser's trusted-device window and suppressing its new-device
   * email.
   *
   * `MfaService.requireAttempt` now refuses a mismatch outright, so by the time this
   * line runs the current context has been proven to be the one that started the
   * ceremony. Minting from it is therefore both correct and no longer a choice.
   */
  async verify(
    body: unknown,
    client: ClientContext,
    sessionCookies: SessionCookie,
  ): Promise<SuccessEnvelope<LoginPayload | TwoFactorPayload>> {
    const input = parseDto(twoFactorVerifySchema, body);

    // The passkey branch's first call: no assertion yet, so answer with the
    // challenge rather than treating the absence as a failed proof.
    if (input.method === 'passkey' && input.passkey === undefined) {
      const options = await this.twoFactor.signInPasskeyChallenge(input.loginId, client);
      return ok({ outcome: 'passkey_challenge', options });
    }

    const proven =
      input.method === 'passkey'
        ? await this.twoFactor.signInPasskeyVerify(
            input.loginId,
            input.passkey as unknown as AuthenticationResponseJSON,
            client,
          )
        : await this.mfa.proveFactor({
            loginId: input.loginId,
            method: input.method,
            // `superRefine` on the schema guarantees this for every non-passkey
            // method, so the fallback is unreachable rather than a default.
            code: input.code ?? '',
            client,
          });

    const found = await this.users.findWithCredential(proven.attempt.userId);
    if (found === null) {
      // The account went away between the two halves of the ceremony. Rare, and the
      // honest answer is that the sign-in did not happen.
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }

    // `client` verbatim. `requireAttempt` has already refused any request whose
    // device or network differs from the one that started the ceremony, so this IS
    // the original browser — see the note above for why substituting the stored
    // values was both unnecessary and unsafe.
    const session = await this.sessions.issue(found.user, found.credential, client);
    await this.users.touchLastSeen(found.user.id);

    // The second session-minting site in the service, and it has to do exactly what
    // `AuthController.mintCookies` does: store the record, then set the cookie pair,
    // then serialise without a token in it. Written out rather than shared because a
    // controller importing another controller's private helper is worse than two call
    // sites — `bff.create` + `cookies.issue` + `toSessionPayload` is the whole of it,
    // and `tests/app.routes.spec.ts` is what holds the two in step.
    const handle = await this.bff.create(session);
    const csrfToken = sessionCookies.issue(handle);
    return ok({ outcome: 'session', session: toSessionPayload(session, csrfToken) });
  }

  // ─── POST /auth/2fa ───────────────────────────────────────────────────────

  /**
   * Everything a signed-in user does to their own factors.
   *
   * `assertCredential` runs first and for every action, driven by
   * `TWO_FACTOR_REQUIRES`. Doing it from one place rather than per branch is what
   * makes the table the authority: adding an action without an entry is a type
   * error, and adding one with the wrong entry is a one-line diff a reviewer can
   * see.
   *
   * No action takes a user id, so the factors being read or changed are always the
   * caller's own — one account cannot touch another's even by accident.
   */
  async mutate(
    body: unknown,
    principal: Principal,
    ticket: string | null,
    /** The requesting address, recorded on a credential-change challenge. */
    ip: string,
  ): Promise<SuccessEnvelope<TwoFactorPayload>> {
    const input = parseDto(twoFactorRequestSchema, body);
    await this.assertCredential(input.action, principal, ticket);

    switch (input.action) {
      case 'reauth-challenge': {
        // `intent` is forwarded so the advertised methods match what will actually be
        // accepted — a recovery code is offered for removal and withheld for
        // enrollment. Optional, and omitting it advertises the stricter set.
        const { methods, options } = await this.twoFactor.reauthChallenge(
          principal.userId,
          input.intent,
        );
        return ok({ outcome: 'reauth_challenge', methods, options });
      }

      case 'credential-otp': {
        // Sends to the account's own address, so the session is the whole
        // authorisation. `ok` regardless of anything the account happens to be — the
        // caller already proved who they are, and a varying answer would leak state
        // for no gain.
        await this.twoFactor.requestCredentialOtp(await this.requireUser(principal), ip);
        return ok({ outcome: 'ok' });
      }

      case 'reauth-verify': {
        const user = await this.requireUser(principal);
        const granted = await this.twoFactor.reauthVerify(user, principal.sessionId, input.intent, {
          totpCode: input.totpCode,
          password: input.password,
          passkey: input.passkey as unknown as AuthenticationResponseJSON | undefined,
          // Accepted only for `account.mfa.remove`; the service enforces that, not
          // this line. It is what lets a user who lost their authenticator remove it.
          recoveryCode: input.recoveryCode,
          // Required alongside the factor proof for the factor-changing intents.
          emailCode: input.emailCode,
        });
        return ok({ outcome: 'elevated', ...granted });
      }

      case 'totp-add': {
        const enrollment = await this.twoFactor.totpAdd(await this.requireUser(principal), input.label);
        return ok({ outcome: 'totp_enrollment', ...enrollment });
      }

      case 'totp-confirm': {
        const { recoveryCodes } = await this.twoFactor.totpConfirm(principal.userId, input.code);
        return ok({ outcome: 'recovery_codes', recoveryCodes });
      }

      case 'passkey-add-challenge': {
        const options = await this.twoFactor.passkeyAddChallenge(await this.requireUser(principal));
        return ok({ outcome: 'passkey_challenge', options });
      }

      case 'passkey-add-verify': {
        // Returns the recovery codes alongside the factor. Enrolling a FIRST passkey
        // mints them, and this response is the only place they will ever be visible —
        // the same one-shot contract `totp-confirm` has. They used to be dropped here.
        const { factor, recoveryCodes } = await this.twoFactor.passkeyAddVerify(
          principal.userId,
          input.passkey as unknown as RegistrationResponseJSON,
          input.label,
        );
        return ok({
          outcome: 'factor_with_recovery_codes',
          factor: toFactorPayload(factor),
          recoveryCodes,
        });
      }

      case 'recovery-regenerate': {
        const { recoveryCodes } = await this.twoFactor.regenerateRecoveryCodes(principal.userId);
        return ok({ outcome: 'recovery_codes', recoveryCodes });
      }

      case 'remove': {
        await this.twoFactor.remove(principal.userId, input.kind, input.id);
        return ok({ outcome: 'ok' });
      }

      case 'rename': {
        await this.twoFactor.rename(principal.userId, input.kind, input.id, input.label);
        return ok({ outcome: 'ok' });
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /**
   * Enforce `TWO_FACTOR_REQUIRES` for one action.
   *
   * `bearer` is already satisfied — a principal exists or the route would not have
   * reached here. `bearer+ticket` spends one, and spending is what makes it
   * single-use: `ElevationService.spend` reads with GETDEL, so a second call with
   * the same ticket finds nothing.
   */
  private async assertCredential(
    action: keyof typeof TWO_FACTOR_REQUIRES,
    principal: Principal,
    ticket: string | null,
  ): Promise<void> {
    if (TWO_FACTOR_REQUIRES[action] !== 'bearer+ticket') return;

    // The action the ROUTE is performing, never one from the body. A caller who
    // could name it at spend time could present whichever action their ticket
    // happens to carry — see the note on `RequiresElevation`.
    await this.elevation.spend(ticket, principal.sessionId, elevationActionFor(action));
  }

  private async requireUser(principal: Principal) {
    const found = await this.users.findWithCredential(principal.userId);
    if (found === null) {
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }
    return found.user;
  }
}

/**
 * Which elevation action each ticketed management action spends.
 *
 * Enrolling and removing are separated because they are different risks pointing in
 * opposite directions: a ticket proved in order to add a phone must not also
 * authorise deleting the one that is already there.
 */
function elevationActionFor(action: keyof typeof TWO_FACTOR_REQUIRES) {
  switch (action) {
    case 'totp-add':
    case 'passkey-add-challenge':
      return 'account.mfa.enroll' as const;
    default:
      return 'account.mfa.remove' as const;
  }
}

function toFactorPayload(factor: EnrolledFactor): FactorPayload {
  return {
    id: factor.id,
    kind: factor.kind,
    label: factor.label,
    createdAt: factor.createdAt.toISOString(),
    lastUsedAt: factor.lastUsedAt?.toISOString() ?? null,
  };
}
