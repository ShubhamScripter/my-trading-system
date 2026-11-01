import {
  LINK_ACCOUNTS_UNAVAILABLE,
  type LinkProofMethod,
  type LinkProofs,
} from './link-accounts.types';

/**
 * Pure helpers for Settings → Social accounts.
 *
 * Pure functions rather than a service, for the reason `settings.utility.ts` gives:
 * the proof policy is a decision table, its interesting behaviour is the
 * combinations it REFUSES, and a table-driven test of every combination should not
 * have to stand up a DI container to run. Nothing here does I/O.
 */

/** What the account actually holds, as the resolver needs to see it. */
export interface EnrolledFactors {
  readonly hasTotp: boolean;
  readonly hasPasskey: boolean;
}

export type LinkProofResolution =
  | { readonly ok: true; readonly method: LinkProofMethod }
  | { readonly ok: false; readonly message: string };

/**
 * Which factor is this request presenting, and may it?
 *
 * ═══ THE FOUR CASES THIS TABLE EXISTS TO STATE ═════════════════════════════
 *
 *   authenticator only  →  `totpCode` required
 *   passkey only        →  `passkey` required
 *   both                →  exactly one of them, the caller's choice
 *   neither             →  neither, and sending one is an error
 *
 * ─── Why "neither" is not simply "anything goes" ───────────────────────────
 *
 * An account with nothing enrolled owes no factor, so the tempting implementation
 * ignores whatever was sent. That would accept a TOTP code against an account with
 * no authenticator and answer 201, which tells a client its proof was checked when
 * nothing checked it. A caller naming a factor the account does not hold has made a
 * mistake worth reporting.
 *
 * ─── Why ambiguity is an error rather than a preference ────────────────────
 *
 * `TwoFactorService.proveEnrolledFactor` tries the passkey and falls back to TOTP,
 * which is right for what it does — a ticket only has to establish that the person
 * still holds the account. Here the same permissiveness would mean a body carrying
 * both silently exercises whichever branch comes first, so the caller cannot tell
 * which credential was spent. `resolveDisablePath` next door draws the same line for
 * the same reason.
 *
 * ─── What this deliberately does NOT decide ────────────────────────────────
 *
 * The emailed code. It is required on every path here, so there is no decision to
 * make: `linkVerifyRequestSchema` marks it required and the service spends it before
 * any factor is compared. A boolean that is always true does not belong in a table.
 */
export function resolveLinkProof(
  proofs: LinkProofs,
  enrolled: EnrolledFactors,
): LinkProofResolution {
  const sentTotp = proofs.totpCode !== undefined;
  const sentPasskey = proofs.passkey !== undefined;

  if (sentTotp && sentPasskey) {
    return { ok: false, message: LINK_ACCOUNTS_UNAVAILABLE.TOO_MANY_PROOFS };
  }

  // Checked before the "is anything owed" branch, so a caller naming an absent
  // factor is told which one is missing rather than being told to send a factor
  // they just sent.
  if (sentTotp && !enrolled.hasTotp) {
    return { ok: false, message: LINK_ACCOUNTS_UNAVAILABLE.TOTP_NOT_ENROLLED };
  }
  if (sentPasskey && !enrolled.hasPasskey) {
    return { ok: false, message: LINK_ACCOUNTS_UNAVAILABLE.PASSKEY_NOT_ENROLLED };
  }

  if (!enrolled.hasTotp && !enrolled.hasPasskey) {
    // Nothing enrolled and nothing sent: the emailed code is the whole ceremony.
    return { ok: true, method: 'none' };
  }

  if (!sentTotp && !sentPasskey) {
    return { ok: false, message: LINK_ACCOUNTS_UNAVAILABLE.NO_PROOF };
  }

  return { ok: true, method: sentPasskey ? 'passkey' : 'totp' };
}
