import { DELETE_ACCOUNT_UNAVAILABLE } from './delete-account.types';
import type { PendingWithdrawalsState } from './delete-account.types';

/**
 * Pure helpers for Settings → Delete account.
 *
 * Pure functions rather than a service, for the reason `link-accounts.utility.ts`
 * gives: these are decision tables whose interesting behaviour is what they REFUSE,
 * and a table-driven test of every combination should not have to stand up a DI
 * container. Nothing here does I/O.
 */

/** What the account actually holds, as the resolver needs to see it. */
export interface EnrolledFactors {
  readonly hasTotp: boolean;
  readonly hasPasskey: boolean;
}

/** What the request is presenting. */
export interface DeleteProofs {
  readonly totpCode?: string;
  readonly passkey?: unknown;
}

export type DeleteProofMethod = 'totp' | 'passkey' | 'none';

export type DeleteProofResolution =
  | { readonly ok: true; readonly method: DeleteProofMethod }
  | { readonly ok: false; readonly message: string };

/**
 * Which factor is this request presenting, and may it?
 *
 * ═══ THE FOUR CASES ════════════════════════════════════════════════════════
 *
 *   authenticator only  →  `totpCode` required
 *   passkey only        →  `passkey` required
 *   both                →  exactly one of them, the caller's choice
 *   neither             →  neither, and sending one is an error
 *
 * The same table `resolveLinkProof` states, and deliberately a separate copy rather
 * than a shared helper. The two features have identical policies TODAY and no reason
 * to be bound to each other tomorrow: a change to what deleting an account costs must
 * not silently become a change to what linking a provider costs. Sharing would make
 * that coupling invisible, and the function is twenty lines.
 *
 * ─── What this deliberately does NOT decide ────────────────────────────────
 *
 * The emailed code, which is owed on every path here — `deleteVerifyRequestSchema`
 * marks it required and the service spends it before any factor is compared. A
 * boolean that is always true does not belong in a table.
 *
 * And the account password, which this ceremony never accepts. That is not an
 * omission: a password is the credential most likely to be already compromised in
 * exactly the scenario this ceremony exists to stop, and there is no combination of
 * inputs to this function that can return a resolution naming one.
 */
export function resolveDeleteProof(
  proofs: DeleteProofs,
  enrolled: EnrolledFactors,
): DeleteProofResolution {
  const sentTotp = proofs.totpCode !== undefined;
  const sentPasskey = proofs.passkey !== undefined;

  if (sentTotp && sentPasskey) {
    return { ok: false, message: DELETE_ACCOUNT_UNAVAILABLE.TOO_MANY_PROOFS };
  }

  // Checked before the "is anything owed" branch, so a caller naming an absent factor
  // is told which one is missing rather than told to send a factor they just sent.
  if (sentTotp && !enrolled.hasTotp) {
    return { ok: false, message: DELETE_ACCOUNT_UNAVAILABLE.TOTP_NOT_ENROLLED };
  }
  if (sentPasskey && !enrolled.hasPasskey) {
    return { ok: false, message: DELETE_ACCOUNT_UNAVAILABLE.PASSKEY_NOT_ENROLLED };
  }

  if (!enrolled.hasTotp && !enrolled.hasPasskey) {
    // Nothing enrolled and nothing sent: the emailed code is the whole ceremony.
    return { ok: true, method: 'none' };
  }

  if (!sentTotp && !sentPasskey) {
    return { ok: false, message: DELETE_ACCOUNT_UNAVAILABLE.NO_PROOF };
  }

  return { ok: true, method: sentPasskey ? 'passkey' : 'totp' };
}

/**
 * Should the screen prompt the owner to withdraw before deleting?
 *
 * ═══ ONLY `pending` IS A YES, AND ONLY `none` IS A NO ═══════════════════════
 *
 * The third state is neither, and this function exists mainly to stop it being
 * quietly treated as one. `unavailable` means no withdrawal subsystem is bound, so
 * there is nothing to prompt ABOUT — a prompt offering to withdraw funds through an
 * API that does not exist would be worse than no prompt. It returns false.
 *
 * But false here is "do not render a prompt", NOT "this account has no funds", and
 * the distinction is why the raw state travels to the client alongside this boolean
 * rather than being collapsed into it. A client that wants to say something careful
 * on an unbound deployment has the state to say it with.
 */
export function shouldPromptWithdrawal(withdrawal: PendingWithdrawalsState): boolean {
  return withdrawal.state === 'pending';
}

/**
 * May the deletion proceed, given what the withdrawal subsystem said?
 *
 * `unavailable` proceeds. An unbuilt subsystem must not make the feature unusable,
 * and in this repository there is demonstrably nothing to withdraw — `src/wallet/` and
 * `src/ledger/` are empty files. Refusing here would mean no account could ever be
 * deleted until a wallet shipped.
 *
 * `pending` requires the acknowledgement, which is the whole point of the prompt: the
 * owner is told there are funds and chooses to continue anyway. Unreachable today.
 *
 * `none` proceeds unconditionally — a real provider looked and there is nothing there.
 */
export function mayDeleteWithFunds(
  withdrawal: PendingWithdrawalsState,
  acknowledged: boolean,
): boolean {
  return withdrawal.state !== 'pending' || acknowledged;
}
