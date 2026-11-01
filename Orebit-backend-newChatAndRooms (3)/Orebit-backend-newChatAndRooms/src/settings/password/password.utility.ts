import {
  PASSWORD_FACTOR_METHODS,
  PASSWORD_PROOF_FIELDS,
  PASSWORD_UNAVAILABLE,
  PROOF_FIELD_BY_FACTOR,
  type PasswordAccount,
  type PasswordFactorMethod,
  type PasswordForgotStatus,
  type PasswordOperationStatus,
  type PasswordProofField,
  type PasswordStatus,
} from './password.types';

/**
 * ═══ THE POLICY, AS PURE FUNCTIONS ══════════════════════════════════════════
 *
 * Every decision this feature makes that does not need I/O lives here, so the DTO
 * and the service can each run the SAME function rather than each expressing the
 * rule in their own dialect. That is the arrangement `resolveDisablePath` and
 * `resolvePaymentPinProof` established next door, and the reason is the same: a
 * policy that holds only when the HTTP layer is in front of it is not the policy.
 *
 * Nothing here reads a database, so nothing here can decide whether a factor is
 * required — `factorRequirementFor` takes the account snapshot as an argument and the
 * service is the only thing that can produce one.
 */

// ─── which factors are open on this account ─────────────────────────────────

/**
 * The factors this account could present, in offer order.
 *
 * Derived from the snapshot rather than from the request, which is the whole
 * anti-bypass property: no field a client can send appears in this function's
 * arguments.
 */
export function factorMethodsFor(account: PasswordAccount): PasswordFactorMethod[] {
  return PASSWORD_FACTOR_METHODS.filter((method) =>
    method === 'passkey' ? account.passkeyEnabled : account.totpEnrolled,
  );
}

/** Is one named method actually set up here? Shared by the status render and the
 *  pre-consumption check, so a method the screen offered can never be one the
 *  service refuses. */
export function factorAvailable(
  method: PasswordFactorMethod,
  account: PasswordAccount,
): boolean {
  return method === 'passkey' ? account.passkeyEnabled : account.totpEnrolled;
}

export function factorUnavailableReason(method: PasswordFactorMethod): string {
  return method === 'passkey' ? PASSWORD_UNAVAILABLE.NO_PASSKEY : PASSWORD_UNAVAILABLE.NO_TOTP;
}

// ─── what `forgot` demands of this account ──────────────────────────────────

export interface FactorRequirement {
  readonly required: boolean;
  /** The factors that would satisfy it, in offer order. Empty when not required. */
  readonly methods: readonly PasswordFactorMethod[];
}

/**
 * ═══ THE ONE DECISION THE FRONTEND MUST NOT BE ABLE TO MAKE ═════════════════
 *
 * Whether `forgot` needs a second proof. A function of the ACCOUNT and of nothing
 * else — no request field reaches this, so a client sending `has2FA: false` is
 * sending a field that appears in no schema and is read by no code.
 *
 * `required` follows `hasEnabledFactor`, which is `MfaService.availableMethods`
 * filtered to CONFIRMED credentials. An abandoned TOTP enrollment therefore does not
 * demand a code the user cannot produce, and an enrolled-but-unconfirmed passkey
 * does not lock anyone out of their own password reset.
 */
export function factorRequirementFor(account: PasswordAccount): FactorRequirement {
  const methods = factorMethodsFor(account);
  return { required: methods.length > 0, methods };
}

// ─── the ambiguity rule on a `forgot` body ──────────────────────────────────

export interface ProofProblem {
  /** `''` means "the request as a whole" — which is what an empty path array means
   *  to Zod as well. */
  readonly path: string;
  readonly message: string;
}

export type FactorProofResolution =
  | { readonly ok: true; readonly method: PasswordFactorMethod | null }
  | { readonly ok: false; readonly problems: readonly ProofProblem[] };

/**
 * The structural minimum `resolveFactorProof` needs, with both proofs as `unknown`.
 *
 * Mirrors `DeclaredProof` in `paymentPin/payment-pin.utility.ts`, and for its reason:
 * the resolver only ever asks whether a field is PRESENT, so typing `passkey` as
 * `AuthenticationResponseJSON` here would buy nothing and would force a cast at both
 * call sites — the DTO's inferred type is a `passthrough` object, not the library's
 * shape, because the library is what verifies that shape cryptographically.
 *
 * `PasswordFactorProofs` in password.types.ts stays the documented domain type. This
 * is the resolver's parameter and nothing else.
 */
interface DeclaredProofs {
  readonly totpCode?: unknown;
  readonly passkey?: unknown;
}

/**
 * Which factor a `forgot` body names, or `null` for none.
 *
 * ─── What this DOES decide: at most one ─────────────────────────────────────
 *
 * Two proofs in one body is refused rather than resolved, for `resolveDisablePath`'s
 * reason: "send everything and let the server sort it out" turns two separate
 * mechanisms into a single OR, so the weaker becomes the only one that matters and
 * the caller cannot tell which credential was actually spent. Refused BEFORE any
 * comparison runs, so a caller sending both learns nothing about which would have
 * verified.
 *
 * Every conflicting field is named, not just the extra one, because the mistake is
 * the combination and there is no basis for calling one of them the intended one.
 *
 * ─── What this does NOT decide: at least one ────────────────────────────────
 *
 * `{ ok: true, method: null }` means "this body names no factor", which is a
 * perfectly valid request on an account that has none. Whether it is valid on THIS
 * account is `factorRequirementFor`'s answer, and it needs I/O — so the DTO cannot
 * make it and does not try. A body with no proof therefore parses, and is refused by
 * the service with `password_factor_required` naming the methods that would work.
 */
export function resolveFactorProof(proofs: DeclaredProofs): FactorProofResolution {
  const present = PASSWORD_PROOF_FIELDS.filter((field) => proofs[field] !== undefined);

  if (present.length === 0) {
    return { ok: true, method: null };
  }

  if (present.length > 1) {
    return {
      ok: false,
      problems: present.map((field) => ({
        path: field,
        message:
          `Names the "${factorForField(field)}" verification, which conflicts with: ` +
          `${present.filter((other) => other !== field).join(', ')}. Send exactly one.`,
      })),
    };
  }

  return { ok: true, method: factorForField(present[0] as PasswordProofField) };
}

/** The reverse of `PROOF_FIELD_BY_FACTOR`, derived rather than written out so the two
 *  cannot drift. */
function factorForField(field: PasswordProofField): PasswordFactorMethod {
  const method = PASSWORD_FACTOR_METHODS.find(
    (candidate) => PROOF_FIELD_BY_FACTOR[candidate] === field,
  );
  if (method === undefined) {
    // Unreachable: `field` is typed as one of the mapped values. Throwing beats
    // returning a plausible wrong method, which would run the wrong proof.
    throw new Error(`no password factor names the proof field "${field}"`);
  }
  return method;
}

// ─── the status render ──────────────────────────────────────────────────────

/**
 * The whole setting screen, from one snapshot.
 *
 * Shares `factorRequirementFor` with the service rather than re-deriving it, so what
 * the screen promises and what the service demands are the same computation. The
 * three operations are mutually exclusive by construction — `set` is open exactly
 * when `reset` and `forgot` are closed — and that is stated as three independent
 * booleans rather than one enum because a client renders three controls and needs a
 * reason for each disabled one.
 */
export function statusFor(account: PasswordAccount): PasswordStatus {
  const requirement = factorRequirementFor(account);

  const set: PasswordOperationStatus = account.passwordSet
    ? { available: false, reason: PASSWORD_UNAVAILABLE.ALREADY_SET }
    : { available: true };

  const knowsCurrent: PasswordOperationStatus = account.passwordSet
    ? { available: true }
    : { available: false, reason: PASSWORD_UNAVAILABLE.NOT_SET };

  const forgot: PasswordForgotStatus = {
    ...knowsCurrent,
    factorRequired: account.passwordSet && requirement.required,
    // Empty unless the requirement actually applies, so a client cannot render a
    // passkey prompt for an operation that will not check one.
    methods: account.passwordSet && requirement.required ? requirement.methods : [],
  };

  return { passwordSet: account.passwordSet, set, reset: knowsCurrent, forgot };
}
