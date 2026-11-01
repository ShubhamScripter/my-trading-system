import { z } from 'zod';
import { USERNAME } from '../../../auth/auth.constants';
import type { UnavailableReason, UsernameIssue, UsernameRules } from './username.types';

/**
 * Request and response shapes for the username setting.
 *
 * ─── Why neither schema enforces the length band ────────────────────────────
 *
 * Because the band depends on whether the account holds Premium, and a DTO cannot know
 * that. It has two ways to get it wrong and no way to get it right: assume the free
 * floor and a Premium user is refused their two-character name before the service ever
 * runs, or read a tier from the request body and the client decides what it is owed.
 *
 * So these validate SHAPE — a string, of a sane size, present — and `UsernameService`
 * enforces the rules against the entitlement it resolved itself. The same division as
 * `resolvePaymentPinProof`, which the payment-PIN DTO and service both call: the DTO
 * refuses what is cheap to refuse, and the service holds the policy.
 */

/**
 * The upper bound here is NOT `USERNAME.MAX_LENGTH`, and that is deliberate.
 *
 * This bounds what the parser will look at; the product rule is a separate judgement
 * reported as `too_long` with the actual maximum in it. If this were 30, a user pasting
 * a 40-character string would get a generic `validation_failed` with no idea which rule
 * they broke — and on the availability endpoint, which is called while they type, they
 * would get a 400 mid-word.
 *
 * 64 is simply the point past which the input cannot plausibly be a username being
 * typed, so parsing it is wasted work.
 */
const RAW_MAX = 64;

const rawUsernameSchema = z.string().min(1).max(RAW_MAX);

/**
 * `GET /settings/profile/username/check?username=…`
 *
 * `.strict()` like every other schema in `src/settings/`. An unknown query parameter is
 * refused rather than stripped — the control that stops a client believing it sent
 * something meaningful.
 */
export const usernameCheckQuerySchema = z
  .object({ username: rawUsernameSchema })
  .strict();

export type UsernameCheckQuery = z.infer<typeof usernameCheckQuerySchema>;

/**
 * `POST /settings/profile/username`
 *
 * One field, and `.strict()` is what keeps it to one. A client sending
 * `{ username, isPremium: true }` or `{ username, price: 0 }` is REFUSED, not silently
 * ignored — the difference matters, because a stripped field leaves the caller
 * believing it was honoured and the next version of that client will be built on the
 * assumption that it was.
 */
export const usernameUpdateSchema = z.object({ username: rawUsernameSchema }).strict();

export type UsernameUpdateRequest = z.infer<typeof usernameUpdateSchema>;

// ─── responses ──────────────────────────────────────────────────────────────

/** How many free changes are left, and when the window turns over. */
export interface UsernameQuotaPayload {
  readonly freeChangesRemaining: number;
  readonly freeChangesTotal: number;
  readonly periodDays: number;
  /**
   * When the oldest change in the window ages out, i.e. when a free change next becomes
   * available. Null when one is available now.
   *
   * Computed here so the client never subtracts dates. A client doing that arithmetic
   * is a second copy of the allowance policy, and it drifts.
   */
  readonly nextFreeChangeAt: string | null;
}

/** What the next change would cost. Priced by the server, always. */
export interface UsernameNextChangePayload {
  readonly requiresPayment: boolean;
  /** Minor units — cents — as an integer. Null when the next change is free. */
  readonly amountMinor: number | null;
  readonly currency: string | null;
}

/** A previous username still held for this account. */
export interface UsernameReservationPayload {
  readonly username: string;
  readonly expiresAt: string;
  /** Whether reclaiming it is free even with the allowance spent — the long,
   *  identity-protecting reservation rather than a few-minute churn release. */
  readonly reclaimFree: boolean;
}

export interface UsernameStatusPayload {
  readonly outcome: 'username_status';
  readonly username: string;
  readonly rules: UsernameRules;
  readonly premium: { readonly active: boolean; readonly expiresAt: string | null };
  readonly quota: UsernameQuotaPayload;
  readonly nextChange: UsernameNextChangePayload;
  /** Newest deadline first. Empty for an account that has never changed its username. */
  readonly reservations: readonly UsernameReservationPayload[];
}

export interface UsernameAvailabilityPayload {
  readonly outcome: 'username_availability';
  /** The NORMALISED form. Echoed so a client can discard a response that arrived after
   *  the user typed on — the whole reason a debounced field needs it back. */
  readonly username: string;
  readonly available: boolean;
  /** Absent when available. */
  readonly reason?: UnavailableReason;
  /** Present only for `reason: 'invalid'`. */
  readonly issues?: readonly UsernameIssue[];
  /** Present only when unavailable and alternatives were found. */
  readonly suggestions?: readonly string[];
}

export interface UsernameUpdatedPayload {
  readonly outcome: 'username_updated';
  readonly username: string;
  readonly previous: { readonly username: string; readonly reservedUntil: string };
  readonly quota: UsernameQuotaPayload;
}

export type UsernamePayload =
  | UsernameStatusPayload
  | UsernameAvailabilityPayload
  | UsernameUpdatedPayload;

/** The published rule set. One place, so the client hint and the server refusal cannot
 *  describe different rules. */
export const USERNAME_MAX_LENGTH = USERNAME.MAX_LENGTH;
