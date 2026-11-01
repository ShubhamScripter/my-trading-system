import type { USERNAME } from '../../../auth/auth.constants';

/**
 * Domain types and product policy for the username setting.
 *
 * Nothing here does I/O. The length bands, the retention windows and the allocation
 * limits live in `USERNAME` in auth/auth.constants.ts with the rest of the product
 * policy; what is here is the policy that has nowhere else to go — the price, the
 * reserved-word list, and the port through which Premium is asked about.
 */

// ─── the Premium entitlement ────────────────────────────────────────────────

/**
 * Whether an account is currently entitled to Premium, and until when.
 *
 * `expiresAt` is informational — the status screen renders it. Nothing decides
 * anything from it, because "is Premium active" is a question only the provider can
 * answer and a timestamp this service compares against its own clock would be a second
 * implementation of that answer.
 */
export interface PremiumStatus {
  readonly active: boolean;
  readonly expiresAt: Date | null;
}

/**
 * The seam between the username feature and an entitlement system that does not exist
 * yet.
 *
 * ─── Why a port and not a column ────────────────────────────────────────────
 *
 * There is no subscription, entitlement, plan or billing anything in this repository —
 * `src/wallet`, `src/ledger`, `src/earning` and `src/merchant` are empty files. So
 * Premium had to be represented somehow, and the repository already has an answer for
 * a capability that is specified but unbuilt: `KYC_PORT` with `NullKycProvider`, and
 * `NullGeoResolver` before it. A port costs one symbol and one stub, states plainly
 * that nothing is implemented, and is replaced by changing one line in
 * `settings.module.ts`.
 *
 * A `premiumUntil` column would have been the alternative, and it is worse in the exact
 * way that matters: it would look like working state. Something would have to write it,
 * nothing would, and the first person to read the schema would have to work out whether
 * Premium was broken or absent.
 *
 * ─── The two contracts, both load-bearing ───────────────────────────────────
 *
 * `statusFor` NEVER throws. A caller cannot distinguish "not Premium" from "the
 * entitlement service is down", and it must not try: the safe answer under uncertainty
 * is the restrictive one, because guessing `active: true` during an outage would hand
 * out two-character usernames that the account is not entitled to keep. An
 * implementation that cannot reach its backend returns `{ active: false }`.
 *
 * `listRecentlyExpired` is the ONLY input to the compliance sweeper. Returning nothing
 * is what makes the sweeper a no-op today, rather than something that has to be
 * disabled separately.
 */
export interface PremiumStatusPort {
  statusFor(userId: string): Promise<PremiumStatus>;
  /**
   * Accounts whose entitlement lapsed at or after `since`.
   *
   * May over-report freely — a duplicate or an account that has already been
   * reconciled costs one no-op, because `renameForCompliance` re-checks every
   * precondition under a row lock. It must not UNDER-report, because nothing else will
   * notice an account left with a username it is no longer entitled to.
   */
  listRecentlyExpired(since: Date): Promise<readonly string[]>;
}

export const PREMIUM_PORT = Symbol('PREMIUM_PORT');

// ─── the price ──────────────────────────────────────────────────────────────

/**
 * ═══ PRODUCT VALUES — PENDING FOUNDER CONFIRMATION ══════════════════════════
 *
 * The brief specifies "X times every Y days for free" and "$X per change" without
 * fixing X, Y or the price, and nothing in this repository defines them. These are
 * placeholders chosen to be defensible, not decisions, and they are gathered here so
 * that confirming them is one edit rather than a search:
 *
 *   FREE_CHANGES             2        matches `EMAIL_CHANGE.CHANGE_BY_ACCOUNT`, so the
 *                                     two identifier changes have one allowance shape
 *   FREE_CHANGE_WINDOW_DAYS  30       the same window, for the same reason
 *   amountMinor / currency   499 USD  minor units, integer — never a float, and never
 *                                     a `number` of dollars that rounds
 *
 * ─── Why the price is QUOTED and not CHARGED ────────────────────────────────
 *
 * There is no payment provider here and inventing one was explicitly out of scope. So
 * when the allowance is spent, `POST` refuses with `username_change_payment_required`
 * and reports this amount. It does not take money, and it does not pretend to have.
 *
 * The integration point is exactly one place: inside the transaction in
 * `UsernameReservationDbOperation.changeUsername`, between the allowance count and the
 * reservation insert, a confirmed payment reference would waive the refusal the same
 * way `protectedReclaim` waives it now. Everything else — the price, the currency, the
 * decision that a charge is due — is already computed on this side of the wire.
 *
 * The price is NEVER read from a request. The DTO is `.strict()`, so a client sending
 * `price` or `amountMinor` is rejected outright rather than having the field ignored.
 */
export const USERNAME_PAID_CHANGE = {
  FREE_CHANGES: 2,
  FREE_CHANGE_WINDOW_DAYS: 30,
  amountMinor: 499,
  currency: 'USD',
} as const;

// ─── reserved words ─────────────────────────────────────────────────────────

/**
 * Usernames nobody may claim.
 *
 * New in this feature, because until now no username was ever chosen by a user — they
 * were generated from an email local part, and nobody's mailbox is called `support`.
 * The moment usernames become user-chosen, `@support` and `@security` become things
 * somebody will try to register in order to be mistaken for us.
 *
 * Deliberately SMALL and deliberately not a profanity filter. This list exists to stop
 * impersonation of the product and its staff, which is a closed set we can enumerate.
 * Content moderation is a different problem with a different failure mode — a word list
 * that blocks real names — and it is not solved by adding rows here.
 *
 * Matched against the NORMALISED username, so casing and the `Support` variant are
 * covered by the one entry. Substrings are deliberately not matched: `supporter` is a
 * perfectly ordinary name and refusing it would be the kind of rule that generates
 * support tickets about the word support.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'orebit',
  'admin',
  'administrator',
  'root',
  'system',
  'support',
  'help',
  'security',
  'billing',
  'payments',
  'official',
  'staff',
  'moderator',
  'api',
  'www',
]);

// ─── what a username is refused for ─────────────────────────────────────────

/**
 * Why a username cannot be used, as the availability endpoint reports it.
 *
 * `taken` and `reserved` are distinguished HERE and folded into one slug on the
 * mutation, which is not an inconsistency. This endpoint exists to explain why a name
 * is unusable and reveals nothing about whose it was; the mutation's refusal is a
 * committed attempt on a specific name, where distinguishing them would let a caller
 * walk a dictionary and learn which usernames were recently changed away from.
 */
export type UnavailableReason = 'taken' | 'reserved' | 'invalid' | 'current';

/** One thing wrong with a proposed username. Rendered by the client next to the field. */
export interface UsernameIssue {
  /** Stable, switchable — the client picks its own wording for its own locale. */
  readonly code: 'charset' | 'too_short' | 'too_long' | 'edge_underscore' | 'reserved';
  /** A complete sentence, so a client that does not switch on `code` still has copy. */
  readonly message: string;
}

/** The verdict of the pure rule check. Never thrown — both the DTO and the service
 *  render it, and a thrown value cannot be rendered twice. */
export type UsernameAssessment =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly UsernameIssue[] };

/** The length band that applies to one caller, resolved from their entitlement. */
export interface UsernameLengthBand {
  readonly minLength: number;
  readonly maxLength: number;
}

/** The rules, as the settings screen renders them. Both floors are sent, so the client
 *  can show what Premium would buy without a second endpoint. */
export interface UsernameRules {
  readonly minLength: number;
  readonly defaultMinLength: typeof USERNAME.DEFAULT_MIN_LENGTH;
  readonly premiumMinLength: typeof USERNAME.PREMIUM_MIN_LENGTH;
  readonly maxLength: typeof USERNAME.MAX_LENGTH;
  readonly pattern: string;
}
