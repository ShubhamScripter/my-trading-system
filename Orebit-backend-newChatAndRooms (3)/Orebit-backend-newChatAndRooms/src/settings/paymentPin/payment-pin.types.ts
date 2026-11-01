import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

/**
 * Domain types for the Payment PIN.
 *
 * ─── What this sub-module is, and why it sits under src/settings/ ───────────
 *
 * A Payment PIN is a six-digit secret that authorises a PAYMENT on a session that is
 * already established. It is product policy layered over mechanisms that already
 * exist — the emailed code, the authenticator, the passkey — and it owns none of
 * them. That is the same relationship `settings.types.ts` describes for the two
 * factor surfaces, which is why this lives beside them rather than in `src/2fa/`.
 *
 * ─── Why it is NOT a second factor, stated plainly ──────────────────────────
 *
 * `src/2fa/` answers "may this person sign in". The PIN never does. Nothing here
 * appears in `SignInMethod`, nothing mints recovery codes, and — the consequence that
 * matters — changing or removing a PIN does not sweep the account's other sessions.
 * Disabling a passkey does, because the passkey may have been how a session was
 * established; no session was ever established with a PIN, so there is nothing for a
 * sweep to invalidate. See `PaymentPinService.disable`.
 *
 * ─── Why this is a folder rather than more files in src/settings/ ───────────
 *
 * The two factor surfaces share one policy table because they have one policy — four
 * alternative disable paths, the same effects. This has a different one: three
 * methods rather than four paths, a two-step verify-then-act shape rather than one
 * atomic request, an update operation the factors do not have, and an account-scoped
 * change budget. Folding it into `DisablePath` would mean a fifth path that is legal
 * on one surface and meaningless on the other two.
 */

// ─── the operations a challenge can authorise ───────────────────────────────

/**
 * The two operations that need a verified challenge.
 *
 * `enable` is deliberately absent. It is authorised by an emailed code plus the mere
 * EXISTENCE of a factor — there is nothing for the user to prove interactively, so
 * there is nothing for a challenge to record. Adding it to this union would create a
 * challenge that could be minted without proving anything, which is the one shape
 * this mechanism must not have.
 */
export type PaymentPinOperation = 'update' | 'disable';

export const PAYMENT_PIN_OPERATIONS = [
  'update',
  'disable',
] as const satisfies readonly PaymentPinOperation[];

export function isPaymentPinOperation(value: string): value is PaymentPinOperation {
  return (PAYMENT_PIN_OPERATIONS as readonly string[]).includes(value);
}

// ─── the three verification methods ─────────────────────────────────────────

/**
 * ═══ THE POLICY TABLE FOR AUTHORISING AN UPDATE OR A DISABLE ════════════════
 *
 * Any ONE of these, plus the emailed code, authorises either operation. They are
 * alternatives, not steps.
 *
 *  - `pin`           — the current PIN. The ordinary path: a user changing their PIN
 *                      usually still knows it, and proving they hold it is the
 *                      cheapest honest authorisation.
 *  - `authenticator` — a TOTP code. Available when an authenticator is enrolled.
 *  - `passkey`       — a WebAuthn assertion. Available when a passkey is enrolled.
 *
 * ─── Why 'authenticator' and 'passkey' rather than one '2fa' ────────────────
 *
 * Because they are separate mechanisms with separate enrollment state, and a client
 * told "2fa is available" cannot render the right prompt: one needs six digits typed
 * from a phone, the other needs `navigator.credentials.get()`. A combined name would
 * also make the availability answer wrong on the common account that has exactly one
 * of the two.
 *
 * ─── Why the emailed code is on every path, unlike `backup-code` next door ──
 *
 * `DisablePath` exempts `backup-code` because that path exists for someone whose
 * FACTOR IS GONE, and demanding a mailbox round trip would re-close the escape hatch.
 * No path here is an escape hatch: all three require something the user currently
 * holds, so none of them is the last way out and none earns the exemption.
 *
 * Note what is deliberately NOT offered: a backup code, and a KYC reverification. Both
 * exist to recover an account that has lost its factors, and neither should be able to
 * move money's last guard. A user who has lost every credential AND forgotten their
 * PIN reaches support, not a self-service path.
 */
export type PaymentPinVerificationMethod = 'pin' | 'authenticator' | 'passkey';

/**
 * Every method, in the order a screen should offer them.
 *
 * `pin` first because it is the ordinary case and should not be third in a list.
 * Unlike `disablePathsFor` next door this order does not vary — there is only one
 * subject, so the order is a property of the methods themselves.
 */
export const PAYMENT_PIN_METHODS = [
  'pin',
  'authenticator',
  'passkey',
] as const satisfies readonly PaymentPinVerificationMethod[];

export function isPaymentPinMethod(value: string): value is PaymentPinVerificationMethod {
  return (PAYMENT_PIN_METHODS as readonly string[]).includes(value);
}

// ─── the proofs a caller may present ────────────────────────────────────────

/**
 * The proof fields, one per method.
 *
 * Every one is optional in the shape because the DTO is a discriminated union and the
 * union member decides which is legal. `resolvePaymentPinProof` is what enforces the
 * correspondence a second time, in the service, where it holds for callers that are
 * not the HTTP layer.
 */
export interface PaymentPinProofs {
  /** Required on every method — see the note on the policy table above. */
  readonly emailCode?: string;
  readonly currentPin?: string;
  readonly totpCode?: string;
  /** A WebAuthn assertion against the challenge `reauthChallenge` minted. */
  readonly passkey?: AuthenticationResponseJSON;
}

/**
 * Which proof field each method names. The resolver reads this and nothing else, so
 * adding a method is one row here plus one row in the union above.
 */
export const PROOF_FIELD_BY_METHOD = {
  pin: 'currentPin',
  authenticator: 'totpCode',
  passkey: 'passkey',
} as const satisfies Readonly<Record<PaymentPinVerificationMethod, keyof PaymentPinProofs>>;

export type PaymentPinProofField = (typeof PROOF_FIELD_BY_METHOD)[PaymentPinVerificationMethod];

/** The proof fields, in the order errors should mention them. */
export const PAYMENT_PIN_PROOF_FIELDS = PAYMENT_PIN_METHODS.map(
  (method) => PROOF_FIELD_BY_METHOD[method],
) as readonly PaymentPinProofField[];

// ─── what a verified challenge grants ───────────────────────────────────────

/**
 * What a challenge grants: one account, one login, one operation, one method.
 *
 * ─── Why each field is here ────────────────────────────────────────────────
 *
 * `userId`, so a challenge obtained from a log, a proxy or a shared screen cannot be
 * spent against another account. Without it the id would be a bearer credential over
 * every account in the system.
 *
 * `familyId`, so it cannot be spent from an unrelated login on the same account. This
 * is `ElevationGrant.sessionId`'s job, moved one level up: `sessionId` changes on
 * every refresh, and this challenge lives five minutes rather than sixty seconds, so
 * binding the generation would refuse a legitimate user whose token rotated while they
 * were typing. `familyId` is constant across rotations and still names one login.
 *
 * `operation`, so a proof given to change a PIN cannot be spent to remove it. The
 * client names it when asking; the ACTION names it when spending, and the two have to
 * agree — the same construction `ElevationService.spend` uses, and the reason the
 * spend argument comes from the route rather than the body.
 *
 * `method`, which is recorded rather than checked. Nothing at spend time compares it,
 * because the action request has no method field for a caller to present — so a
 * challenge verified with a passkey is structurally incapable of being replayed "as"
 * a PIN. It is here so the audit line and the response can say which credential was
 * actually spent, which is the property that makes the log worth reading.
 *
 * JSON rather than a delimited string, for `ElevationGrant`'s reason: four values in
 * one cache entry, and a format that cannot be confused by a value containing the
 * delimiter is worth more than the bytes.
 */
export interface PaymentPinGrant {
  readonly userId: string;
  readonly familyId: string;
  readonly operation: PaymentPinOperation;
  readonly method: PaymentPinVerificationMethod;
}

// ─── what the setting screen is told ────────────────────────────────────────

/**
 * One operation's availability, as the client renders it.
 *
 * `available: false` carries a `reason` for `DisablePathStatus`'s reason: a greyed-out
 * control with no explanation is the thing a support ticket is about. Every reason
 * describes the caller's own account and leaks nothing.
 */
export interface PaymentPinOperationStatus {
  readonly available: boolean;
  /** Present only when unavailable. A short, user-facing sentence from
   *  `PAYMENT_PIN_UNAVAILABLE`. */
  readonly reason?: string;
  /** The methods that would work right now, in offer order. Empty when unavailable. */
  readonly methods: readonly PaymentPinVerificationMethod[];
}

/**
 * The update operation additionally reports what is left of the change budget.
 *
 * Its own shape rather than an optional field on `PaymentPinOperationStatus`, because
 * `remaining` is meaningful for exactly one operation and an optional number that is
 * always absent on the other would invite a client to render "0 remaining" on a
 * disable screen.
 */
export interface PaymentPinUpdateStatus extends PaymentPinOperationStatus {
  /**
   * Changes left in the current window. Advisory: it is read without charging, so it
   * can be stale by the time the client acts on it, and the authoritative answer is
   * the `rate_limited` refusal. A quota read never throws — it reports 0 used on a
   * cache failure — so this can also read high during an outage.
   */
  readonly remaining: number;
}

/**
 * What the Payment PIN setting screen renders.
 *
 * The whole point of this shape is that a client asks ONE question. It never has to
 * work out whether the account has TOTP, whether a passkey exists, whether the PIN is
 * set, or which combination makes an operation legal — every one of those is a policy
 * decision made here and delivered as a boolean plus a list.
 */
export interface PaymentPinStatus {
  /** Whether a PIN is set. A row exists; there is no separate flag to disagree. */
  readonly enabled: boolean;
  /** Whether `action: 'enable'` would be accepted right now. */
  readonly canEnable: boolean;
  /** Present only when `canEnable` is false, for the same reason `reason` is on the
   *  operation statuses. */
  readonly canEnableReason?: string;
  readonly update: PaymentPinUpdateStatus;
  readonly disable: PaymentPinOperationStatus;
}

/**
 * The account facts every Payment PIN policy question is a pure function of.
 *
 * A snapshot rather than repeated awaits inside the availability engine — the same
 * arrangement, and the same reason, as `AccountFactors` in settings.types.ts: it keeps
 * the engine synchronous and testable, and stops one status render from asking the
 * same question twice.
 */
export interface PaymentPinAccount {
  readonly enabled: boolean;
  readonly passkeyEnabled: boolean;
  readonly totpEnrolled: boolean;
}

/**
 * Why an operation is closed on this account, as one sentence per cause.
 *
 * Hoisted to constants because two callers need the identical answer — the status
 * screen renders it and the pre-consumption check returns it as a refusal — and a user
 * shown two different phrasings of one fact is being shown a seam. The same drift
 * `UNAVAILABLE` in settings.types.ts was written to stop.
 */
export const PAYMENT_PIN_UNAVAILABLE = {
  NOT_ENABLED: 'No Payment PIN is set on this account.',
  ALREADY_ENABLED: 'A Payment PIN is already set on this account.',
  NO_FACTOR:
    'Set up biometric sign-in or an authenticator app before creating a Payment PIN.',
  NO_TOTP: 'No authenticator app is set up on this account.',
  NO_PASSKEY: 'Biometric sign-in is not enabled on this account.',
} as const;

/** Exactly six digits, and the one place that number is written down. */
export const PIN_LENGTH = 6;
