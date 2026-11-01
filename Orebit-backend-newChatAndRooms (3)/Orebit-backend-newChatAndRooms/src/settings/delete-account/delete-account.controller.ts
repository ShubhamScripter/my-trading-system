import { Injectable } from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Principal } from '../../../auth/auth.types';
import { ok, parseDto, type SuccessEnvelope } from '../../http';
import {
  deleteAccountRequestSchema,
  deleteVerifyRequestSchema,
  reactivateRequestSchema,
  type AccountDeletedPayload,
  type AccountReactivatedPayload,
  type DeleteAccountStatusPayload,
  type DeleteChallengePayload,
  type DeleteElevatedPayload,
  type ReactivationRequestedPayload,
} from './delete-account.dto';
import { DeleteAccountService } from './delete-account.service';

/**
 * Parse, delegate, serialise. No policy lives here.
 *
 * Every authenticated handler takes the acting account from the `Principal` and never
 * from the body, so a caller can only ever delete their own account — the property
 * `LinkAccountsController` relies on, and the reason no action carries a user id.
 *
 * `reactivate` is the exception and has to be: it is reachable without a session, so
 * the account is named by the address in the body. What stands in for the principal
 * there is the emailed code, which proves control of the mailbox — a stronger claim
 * about that address than a bearer token is. Nothing on that path reads a principal
 * even when one happens to be present.
 */
@Injectable()
export class DeleteAccountController {
  constructor(private readonly deletion: DeleteAccountService) {}

  // ─── GET /settings/security/delete-account ────────────────────────────────

  async status(principal: Principal): Promise<SuccessEnvelope<DeleteAccountStatusPayload>> {
    const state = await this.deletion.status(principal);
    const purgeAt = state.purgeAt?.toISOString() ?? null;

    return ok({
      outcome: 'delete_account_status',
      status: state.status,
      purgeAt,
      // The same instant under two names. `purgeAt` is what the server will do;
      // `reactivationAvailableUntil` is what the reader can still do about it, and a
      // screen renders the second. Derived here rather than in the service so there is
      // one value and no chance of the pair disagreeing.
      reactivationAvailableUntil: purgeAt,
      withdrawal: state.withdrawal,
      withdrawalPromptRequired: state.withdrawalPromptRequired,
      verification: { methods: state.methods, emailCodeRequired: true },
    });
  }

  // ─── POST /settings/security/delete-account/verify ────────────────────────

  /**
   * The two halves of the security check, on one action field.
   *
   * One route rather than two because the client is doing one thing, and — unlike the
   * delete route next door — this one wears no guard, so nothing is spent before the
   * body is read and a discriminant is safe here.
   */
  async verify(
    body: unknown,
    principal: Principal,
  ): Promise<SuccessEnvelope<DeleteChallengePayload | DeleteElevatedPayload>> {
    const input = parseDto(deleteVerifyRequestSchema, body);

    switch (input.action) {
      case 'challenge': {
        const { methods, options } = await this.deletion.challenge(principal.userId);
        return ok({
          outcome: 'delete_account_challenge',
          methods,
          options,
          emailCodeRequired: true,
        });
      }

      case 'verify': {
        const elevated = await this.deletion.verify(principal, {
          emailCode: input.emailCode,
          totpCode: input.totpCode,
          passkey: input.passkey as AuthenticationResponseJSON | undefined,
        });
        return ok({ outcome: 'delete_account_elevated', ...elevated });
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  // ─── POST /settings/security/delete-account ───────────────────────────────

  /**
   * Delete the account.
   *
   * The response is the last thing this account's tokens will ever be answered with:
   * the service revoked every session before returning, so the token that authorised
   * this request is already dead by the time the client reads the envelope.
   */
  async remove(
    body: unknown,
    principal: Principal,
    ipClass: string,
  ): Promise<SuccessEnvelope<AccountDeletedPayload>> {
    const input = parseDto(deleteAccountRequestSchema, body);
    const { purgeAt } = await this.deletion.remove(
      principal,
      // `=== true` rather than passing the field through. The schema defaults it to
      // false, but `parseDto` erases that in the inferred type — the same thing
      // `link-accounts` works around by comparing `intent`. Written as an explicit
      // comparison so the one value that means "acknowledged" is stated here: absent,
      // null and false all fail closed, which is the direction this particular field
      // has to fail.
      input.acknowledgeFundsForfeited === true,
      ipClass,
    );
    const at = purgeAt.toISOString();

    return ok({ outcome: 'account_deleted', purgeAt: at, reactivationAvailableUntil: at });
  }

  // ─── POST /settings/security/delete-account/reactivate ────────────────────

  /**
   * Ask for a restore code, then spend it.
   *
   * ─── Why the challenge branch cannot vary its answer ────────────────────────
   *
   * `requestReactivation` returns void on every path and throws only for a rate limit,
   * so there is nothing here to branch on and nothing to leak. A live account, a
   * deleted one, a purged one and an address that never registered all reach this same
   * `ok(...)` with the same status. That is not a coincidence to be preserved by care —
   * the service's signature makes any other outcome unrepresentable.
   *
   * The verify branch does throw, because a caller holding a code needs to know it did
   * not work. It answers `otp_invalid` for a wrong code AND for an unknown address, so
   * the two remain indistinguishable.
   */
  async reactivate(
    body: unknown,
    ip: string,
    ipClass: string,
  ): Promise<SuccessEnvelope<ReactivationRequestedPayload | AccountReactivatedPayload>> {
    const input = parseDto(reactivateRequestSchema, body);

    switch (input.action) {
      case 'challenge': {
        await this.deletion.requestReactivation(input.email, ip);
        return ok({ outcome: 'account_reactivation_requested' });
      }

      case 'verify': {
        await this.deletion.reactivate(input.email, input.code, ip, ipClass);
        return ok({ outcome: 'account_reactivated' });
      }

      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }
}
