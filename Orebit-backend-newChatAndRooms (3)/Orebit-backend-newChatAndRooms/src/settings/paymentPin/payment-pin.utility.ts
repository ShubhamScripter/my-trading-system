import type { ValidationIssue } from '../../http';
import {
  PAYMENT_PIN_METHODS,
  PAYMENT_PIN_PROOF_FIELDS,
  PAYMENT_PIN_UNAVAILABLE,
  PIN_LENGTH,
  PROOF_FIELD_BY_METHOD,
  isPaymentPinMethod,
  isPaymentPinOperation,
  type PaymentPinAccount,
  type PaymentPinGrant,
  type PaymentPinProofField,
  type PaymentPinVerificationMethod,
} from './payment-pin.types';

/**
 * Pure helpers for the Payment PIN.
 *
 * Pure functions rather than a service, for the reason `settings.utility.ts` gives:
 * the interesting behaviour here is the combinations these REFUSE, and a table-driven
 * test of every combination should not have to stand up a DI container to run.
 * Nothing in this file does I/O, reads the clock, or touches config.
 */

// ─── PIN strength ───────────────────────────────────────────────────────────

export type PinAssessment =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * PINs that are common enough to be worth naming individually.
 *
 * Everything with structure — all one digit, a run, a repeated pair — is caught by the
 * rules below rather than listed, so this holds only the ones no rule describes:
 * years people pick, keypad shapes, and the handful that top every leaked-PIN study.
 *
 * Deliberately short. A long list is a false sense of security over a keyspace of a
 * million: what actually bounds guessing is `PAYMENT_PIN.VERIFY_BY_ACCOUNT`, and this
 * exists to stop the PINs an attacker would try in their first five attempts — which
 * is exactly the budget that quota allows.
 */
const BLOCKED_PINS = new Set([
  '123456',
  '654321',
  '111111',
  '000000',
  '121212',
  '112233',
  '123123',
  '696969',
  '159753',
  '147258',
  '789456',
  '102030',
  '123321',
  '456789',
  '987654',
  '011235',
  '069420',
  '007007',
  '420420',
  '666666',
]);

/** Every character the same: `000000`, `777777`. */
function isSingleDigit(pin: string): boolean {
  return new Set(pin).size === 1;
}

/**
 * A run of consecutive digits in either direction: `123456`, `654321`, `456789`.
 *
 * Not modular — `890123` is not treated as a run, because a user who picks it is not
 * following the pattern an attacker enumerates, and refusing it would be a rule the
 * error message cannot explain.
 */
function isSequentialRun(pin: string): boolean {
  const digits = [...pin].map(Number);
  const step = (digits[1] as number) - (digits[0] as number);
  if (step !== 1 && step !== -1) return false;
  return digits.every(
    (digit, index) => index === 0 || digit - (digits[index - 1] as number) === step,
  );
}

/** A two- or three-digit motif repeated to fill the length: `121212`, `123123`. */
function isRepeatedMotif(pin: string): boolean {
  return [2, 3].some((size) => {
    const motif = pin.slice(0, size);
    return pin === motif.repeat(PIN_LENGTH / size);
  });
}

/** Digit pairs repeated in place: `112233`, `445566`. */
function isPairedRun(pin: string): boolean {
  const pairs = [pin.slice(0, 2), pin.slice(2, 4), pin.slice(4, 6)];
  return pairs.every((pair) => pair[0] === pair[1]);
}

/**
 * Is this PIN acceptable to store?
 *
 * ─── Why a strength rule exists at all for six digits ───────────────────────
 *
 * A million possibilities sounds like enough and is not, because the distribution is
 * nothing like uniform: published analyses of leaked PIN sets put `123456` and its
 * neighbours at a double-digit percentage of all four- and six-digit PINs in use. An
 * attacker with five attempts per fifteen minutes — which is what
 * `PAYMENT_PIN.VERIFY_BY_ACCOUNT` allows — spends them on exactly this list. Refusing
 * it converts the quota from "slows a guesser down" into "a guesser has to be lucky".
 *
 * The same argument `CredentialService.assertPolicy` makes for `COMMON_PASSWORDS`, and
 * it is sharper here because the keyspace is six orders of magnitude smaller.
 *
 * ─── Why the format check is repeated ───────────────────────────────────────
 *
 * The DTO's `^\d{6}$` already ran. This runs it again because this function is also
 * reachable from the service, from tests, and from any future caller, and a policy that
 * only holds when the HTTP layer is in front of it is not the policy — the argument
 * `resolveDisablePath` makes next door.
 *
 * Returns a reason rather than throwing, so the DTO can render it as a field error and
 * the service can render it as `payment_pin_weak`. Both need the same words.
 */
export function assessPin(pin: string): PinAssessment {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
    return { ok: false, reason: `A Payment PIN must be exactly ${PIN_LENGTH} digits.` };
  }

  if (isSingleDigit(pin)) {
    return { ok: false, reason: 'A Payment PIN must not be the same digit repeated.' };
  }

  if (isSequentialRun(pin)) {
    return { ok: false, reason: 'A Payment PIN must not be a run of consecutive digits.' };
  }

  if (isRepeatedMotif(pin) || isPairedRun(pin)) {
    return { ok: false, reason: 'A Payment PIN must not be a repeating pattern.' };
  }

  if (BLOCKED_PINS.has(pin)) {
    return { ok: false, reason: 'This Payment PIN is too common. Choose something less predictable.' };
  }

  return { ok: true };
}

// ─── which method is this request naming ────────────────────────────────────

export type ProofResolution =
  | { readonly ok: true; readonly method: PaymentPinVerificationMethod }
  | { readonly ok: false; readonly problems: readonly ValidationIssue[] };

/**
 * The declared method plus whatever proofs came with it.
 *
 * Every proof is `unknown` rather than its real type, and deliberately: this function
 * decides which fields are PRESENT, never what they contain. Typing them properly
 * would force both callers to cast — the DTO holds Zod's `passthrough` inference of the
 * WebAuthn response rather than the library's type, and the service holds the parsed
 * union — and a cast at every call site is a worse guarantee than a signature that says
 * what is actually read.
 */
interface DeclaredProof {
  readonly method: string;
  readonly emailCode?: unknown;
  readonly currentPin?: unknown;
  readonly totpCode?: unknown;
  readonly passkey?: unknown;
}

/**
 * Does this request carry exactly the proof its declared method names?
 *
 * ─── Why the method is declared rather than inferred ────────────────────────
 *
 * `resolveDisablePath` next door infers the path from which proof field is present,
 * because that route has no discriminant — "the path IS the combination". This one
 * does have a discriminant, and it is better: the client states its intent, so the
 * server can refuse a mismatch instead of quietly running whichever branch the fields
 * happen to select. A client that believed it was proving a passkey is told so when it
 * sent a TOTP code, rather than being silently put on the other path.
 *
 * ─── Why a superfluous proof is an ERROR and not ignored ────────────────────
 *
 * `{method: 'pin', currentPin, totpCode}` is refused rather than run as the PIN path
 * with the TOTP code discarded. Two reasons. Ignoring extras is how "send everything
 * and let the server sort it out" becomes a habit, and a habit like that turns three
 * separate methods into a single OR the moment any future branch checks fields instead
 * of the discriminant — at which point the weakest method is the only one that matters.
 * And a caller sending both has a bug, which a silent success hides until it is a
 * security question rather than an integration one.
 *
 * ─── Why this runs in the DTO and again in the service ──────────────────────
 *
 * In the DTO so a client that forgets `emailCode` gets a validation error naming the
 * field rather than a wrong-code error that costs it an attempt. In the service because
 * the service is also reachable from tests and from any future caller. The identical
 * argument `resolveDisablePath` documents, and the identical construction, so the two
 * read as the same kind of rule.
 */
export function resolvePaymentPinProof(input: DeclaredProof): ProofResolution {
  const { method } = input;

  if (!isPaymentPinMethod(method)) {
    return {
      ok: false,
      problems: [
        {
          path: 'method',
          message: `Must be one of: ${PAYMENT_PIN_METHODS.join(', ')}.`,
        },
      ],
    };
  }

  const expected = PROOF_FIELD_BY_METHOD[method];
  const present = PAYMENT_PIN_PROOF_FIELDS.filter((field) => input[field] !== undefined);

  const extras = present.filter((field) => field !== expected);
  if (extras.length > 0) {
    // Every conflicting field is named, and the declared method is quoted back, so the
    // caller can see which half of the disagreement they meant.
    return {
      ok: false,
      problems: extras.map((field) => ({
        path: field,
        message:
          `Not permitted for the "${method}" method, which is proved with "${expected}". ` +
          'Send exactly one proof, matching the method you declared.',
      })),
    };
  }

  if (!present.includes(expected)) {
    return {
      ok: false,
      problems: [
        { path: expected, message: `Required for the "${method}" method.` },
      ],
    };
  }

  // Unlike the disable paths next door there is no exemption: every method here proves
  // something the user currently holds, so none of them is the last way out and none
  // earns a pass on the mailbox round trip.
  if (input.emailCode === undefined) {
    return {
      ok: false,
      problems: [
        {
          path: 'emailCode',
          message:
            'Required for every Payment PIN verification. ' +
            'Request one with POST /auth/2fa {"action":"credential-otp"}.',
        },
      ],
    };
  }

  return { ok: true, method };
}

// ─── availability ───────────────────────────────────────────────────────────

/**
 * Which methods would work on this account right now, in offer order.
 *
 * Pure and synchronous given the snapshot, which is what lets the status screen and
 * the pre-consumption check share it — so a method the screen offered can never be one
 * the verification refuses, and vice versa. That symmetry is two hand-written copies of
 * three conditions in the shape this codebase has already watched drift apart once; see
 * the note on `pathStatus` in settings.service.ts.
 *
 * `pin` is available exactly when the setting is on, because it IS the setting — the
 * same relationship `DisableSubject.selfPath` has to its factor.
 */
export function methodsFor(account: PaymentPinAccount): readonly PaymentPinVerificationMethod[] {
  return PAYMENT_PIN_METHODS.filter((method) => methodAvailable(method, account));
}

/** Whether one method is set up on this account. The single condition per method. */
export function methodAvailable(
  method: PaymentPinVerificationMethod,
  account: PaymentPinAccount,
): boolean {
  switch (method) {
    case 'pin':
      return account.enabled;
    case 'authenticator':
      return account.totpEnrolled;
    case 'passkey':
      return account.passkeyEnabled;
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
}

/** Why a method is closed, for the one caller that has to say so. Never reached for an
 *  available method. */
export function methodUnavailableReason(method: PaymentPinVerificationMethod): string {
  switch (method) {
    case 'pin':
      return PAYMENT_PIN_UNAVAILABLE.NOT_ENABLED;
    case 'authenticator':
      return PAYMENT_PIN_UNAVAILABLE.NO_TOTP;
    case 'passkey':
      return PAYMENT_PIN_UNAVAILABLE.NO_PASSKEY;
    default: {
      const exhaustive: never = method;
      return exhaustive;
    }
  }
}

/**
 * Whether a first factor exists at all — the gate on enabling.
 *
 * The product rule is "Passkey OR Authenticator already enrolled", and the reason is
 * that the PIN must not become the account's only self-service credential: a user who
 * sets one with no factor behind it has no way to change or remove it if they forget
 * it, because two of the three verification methods would be permanently closed.
 */
export function hasEnrolledFactor(account: PaymentPinAccount): boolean {
  return account.passkeyEnabled || account.totpEnrolled;
}

// ─── the grant, on the wire to Redis and back ───────────────────────────────

export function serialiseGrant(grant: PaymentPinGrant): string {
  return JSON.stringify(grant);
}

/**
 * Read a grant back, or `null` for anything unreadable.
 *
 * Total, and deliberately so: every failure mode — not JSON, not an object, a missing
 * field, an operation or method this build does not know — collapses to `null`, which
 * the caller already treats as "this challenge is not valid". A parse that threw would
 * turn a format change, or a value written by a previous deploy, into a 500 on a path
 * whose honest answer is "verify again". Challenges live five minutes, so a format
 * change costs at most five minutes of one deploy.
 *
 * Same construction as `parseGrant` in src/2fa/elevation.ts.
 */
export function parseGrant(raw: string | null): PaymentPinGrant | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const { userId, familyId, operation, method } = parsed as Record<string, unknown>;

  if (typeof userId !== 'string' || userId === '') return null;
  if (typeof familyId !== 'string' || familyId === '') return null;
  if (typeof operation !== 'string' || !isPaymentPinOperation(operation)) return null;
  if (typeof method !== 'string' || !isPaymentPinMethod(method)) return null;

  return { userId, familyId, operation, method };
}

/** Re-exported so the DTO can name the field type without importing the types module
 *  twice. */
export type { PaymentPinProofField };
