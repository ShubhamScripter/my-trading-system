import type { ValidationIssue } from '../http';
import {
  type DisablePath,
  type DisableProofs,
  type ProofField,
  PATH_BY_PROOF_FIELD,
  emailCodeRequiredForPath,
} from './settings.types';

/**
 * Pure helpers for the settings module.
 *
 * Pure functions rather than a service, and for the same reason `src/2fa/attempt.ts`
 * is: the disable policy is a decision table, its interesting behaviour is the
 * combinations it REFUSES, and a table-driven test of every combination should not
 * have to stand up a DI container to run. Nothing here does I/O.
 */

export type PathResolution =
  | { readonly ok: true; readonly path: DisablePath }
  | { readonly ok: false; readonly problems: readonly ValidationIssue[] };

/** The proof fields, in the order errors should mention them. */
const PROOF_FIELDS = Object.keys(PATH_BY_PROOF_FIELD) as readonly ProofField[];

/**
 * Which single path is this request naming?
 *
 * ─── Why ambiguity is an error and not a preference ─────────────────────────
 *
 * The obvious implementation checks the proofs in some order and uses the first that
 * verifies. `TwoFactorService.proveEnrolledFactor` does exactly that, and it is
 * right for what it does — but here it would mean a request carrying a TOTP code and
 * a passkey assertion silently exercises whichever branch happens to come first.
 * That has two costs: the caller cannot tell which credential was actually spent,
 * and a client that believed it was on one path would be told nothing when it was
 * put on another. Worse, "send everything and let the server sort it out" turns four
 * separate paths into a single OR, so the weakest one is the only one that matters.
 *
 * So: exactly one proof field, or a refusal naming the ones that conflict.
 *
 * ─── Why this runs in the DTO and again in the service ──────────────────────
 *
 * The schema calls it so a client that forgets `emailCode` gets a validation error
 * naming the field rather than a wrong-code error that costs it an attempt — the
 * same argument `twoFactorVerifySchema` makes. The service calls it because the
 * service is also reachable from tests and from any future caller, and a policy that
 * only holds when the HTTP layer is in front of it is not the policy.
 */
export function resolveDisablePath(proofs: DisableProofs): PathResolution {
  const present = PROOF_FIELDS.filter((field) => proofs[field] !== undefined);

  if (present.length === 0) {
    return {
      ok: false,
      problems: [
        {
          path: '',
          message:
            'Send exactly one proof: passkey, totpCode, backupCode or kyc. ' +
            'All but backupCode also need emailCode.',
        },
      ],
    };
  }

  if (present.length > 1) {
    // Every conflicting field is named, not just the extras, because the caller's
    // mistake is the combination and there is no basis for calling one of them the
    // intended one.
    return {
      ok: false,
      problems: present.map((field) => ({
        path: field,
        message: `Names the "${PATH_BY_PROOF_FIELD[field]}" path, which conflicts with: ${present
          .filter((other) => other !== field)
          .join(', ')}. Send exactly one proof.`,
      })),
    };
  }

  const path = PATH_BY_PROOF_FIELD[present[0] as ProofField];

  if (emailCodeRequiredForPath(path) && proofs.emailCode === undefined) {
    return {
      ok: false,
      problems: [
        {
          path: 'emailCode',
          message: `Required for the "${path}" path. Request one with POST /auth/2fa {"action":"credential-otp"}.`,
        },
      ],
    };
  }

  if (!emailCodeRequiredForPath(path) && proofs.emailCode !== undefined) {
    // Not merely tidiness: accepting it would let a caller burn a live emailed code
    // on a request that never checks it, which is a way to invalidate a code the
    // user is part-way through using elsewhere.
    return {
      ok: false,
      problems: [
        { path: 'emailCode', message: `Not permitted for the "${path}" path.` },
      ],
    };
  }

  return { ok: true, path };
}
