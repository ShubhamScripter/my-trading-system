import { z } from 'zod';
import type { DeletionStatus, PendingWithdrawalsState } from './delete-account.types';

/**
 * Request schemas and response payloads for Settings → Delete account.
 *
 * Vocabulary schemas are private to this file, following the convention the other
 * settings DTOs keep: a change to one feature's validation is never silently a change
 * to another's.
 */

/**
 * The emailed code, as typed.
 *
 * Deliberately loose — `min(1).max(64)` rather than six digits — for the reason the
 * login schemas give: a format rule at the door tells a caller which guesses were
 * well-formed before any comparison ran. The real bound is the attempt counter on the
 * challenge row.
 */
const codeSchema = z.string().min(1).max(64);

/**
 * The WebAuthn assertion, passed through to `@simplewebauthn/server`.
 *
 * `passthrough` rather than a mirrored schema: the library owns this shape and every
 * field is verified cryptographically downstream.
 */
const passkeySchema = z.object({ id: z.string().min(1) }).passthrough();

/**
 * An email address, for the PUBLIC reactivation route only.
 *
 * Loose on purpose. A strict address grammar here would answer differently for a
 * well-formed address and a malformed one, which on an unauthenticated route is an
 * oracle: it tells a caller which of their guesses are worth sending again. Length
 * bounds only, and the route then answers identically whatever it was given — see
 * `reactivateRequestSchema`.
 */
const emailSchema = z.string().min(3).max(254);

// ─── POST /settings/security/delete-account/verify ──────────────────────────

/**
 * Ask what this account can prove.
 *
 * Takes nothing else: the proof is about the account, and there is only one thing it
 * can authorise here.
 */
const challengeSchema = z.object({ action: z.literal('challenge') }).strict();

/**
 * Prove it, and receive a ticket.
 *
 * `emailCode` is REQUIRED — on every path, for every account, whether or not a factor
 * is enrolled. Required in the schema rather than in the service so a client that
 * forgets it gets a validation error naming the field instead of a refusal that has
 * already charged an attempt.
 *
 * The two factor fields are optional because an account with nothing enrolled owes
 * neither. Which is acceptable is decided against what the account actually holds —
 * see `DeleteAccountService.verify`. Sending BOTH is refused there, because "exactly
 * one" is a statement about enrolment as much as about the body.
 *
 * There is no `intent` discriminant, unlike the social ceremony: this route earns a
 * ticket for exactly one action, so there is nothing to choose between.
 */
const verifySchema = z
  .object({
    action: z.literal('verify'),
    emailCode: codeSchema,
    totpCode: codeSchema.optional(),
    passkey: passkeySchema.optional(),
  })
  .strict();

export const deleteVerifyRequestSchema = z.discriminatedUnion('action', [
  challengeSchema,
  verifySchema,
]);

export type DeleteVerifyRequest = z.infer<typeof deleteVerifyRequestSchema>;
export type DeleteProveRequest = Extract<DeleteVerifyRequest, { action: 'verify' }>;

// ─── POST /settings/security/delete-account ─────────────────────────────────

/**
 * Delete the account.
 *
 * `.strict()`, and it is load-bearing rather than tidy: this route wears
 * `ElevationGuard`, which spends the single-use ticket BEFORE the body is parsed. A
 * silently dropped field would mean the ticket was spent on a write the caller did not
 * describe, and there is no second ticket to retry with.
 *
 * ─── `acknowledgeFundsForfeited`, and what it does not mean ─────────────────
 *
 * It records that the owner was shown a withdrawal prompt and chose to continue
 * anyway. It does not withdraw anything, forfeit anything, or assert anything about a
 * balance — there is no withdrawal subsystem in this repository to do either. It is
 * read only when a BOUND provider reports `pending`, which nothing does today.
 *
 * Defaulted to `false` so a client written before a withdrawal subsystem exists keeps
 * meaning exactly what it meant: "I did not acknowledge a prompt", which is the honest
 * default and the safe one — it is the value that causes a refusal rather than a
 * silent deletion, on the day a provider is finally bound.
 */
export const deleteAccountRequestSchema = z
  .object({ acknowledgeFundsForfeited: z.boolean().default(false) })
  .strict();

export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

// ─── POST /settings/security/delete-account/reactivate ──────────────────────

/**
 * Ask for a reactivation code, then spend it.
 *
 * Both branches name the address, because this route is PUBLIC and there is no
 * principal to read it from — a deleted account cannot authenticate, which is the
 * whole reason the route exists.
 *
 * `.strict()` here is doing something different from the delete route's: there is no
 * ticket to mis-spend, but an unrecognised field on an unauthenticated route is worth
 * refusing loudly rather than ignoring, because it is the shape a probe takes.
 */
const reactivateChallengeSchema = z
  .object({ action: z.literal('challenge'), email: emailSchema })
  .strict();

const reactivateVerifySchema = z
  .object({ action: z.literal('verify'), email: emailSchema, code: codeSchema })
  .strict();

export const reactivateRequestSchema = z.discriminatedUnion('action', [
  reactivateChallengeSchema,
  reactivateVerifySchema,
]);

export type ReactivateRequest = z.infer<typeof reactivateRequestSchema>;

// ─── responses ──────────────────────────────────────────────────────────────

/**
 * What the delete-account screen renders.
 *
 * ─── Why `purgeAt` is here and `deletionRequestedAt` is not ─────────────────
 *
 * The deadline is the only date the user can act on, so it is the only one published.
 * `deletionRequestedAt` is an audit column — the same decision `unlinkRequestedAt`
 * made, and for the same reason.
 *
 * `purgeAt` is null for a live account. It is the single field a client needs to tell
 * the two states apart, so `status` and it always agree.
 */
export interface DeleteAccountStatusPayload {
  readonly outcome: 'delete_account_status';
  readonly status: DeletionStatus;
  /** When the account will be permanently purged. Null unless `status` is `deleted`. */
  readonly purgeAt: string | null;
  /** The last instant a reactivation will be accepted — the same value as `purgeAt`,
   *  named for what the user can do with it rather than for what the server does. */
  readonly reactivationAvailableUntil: string | null;
  /**
   * What a bound withdrawal subsystem says about this account's funds.
   *
   * `{ state: 'unavailable' }` for every account today and means NO SUBSYSTEM IS
   * BOUND — it is not a balance of zero and a client must not render it as one. See
   * `PendingWithdrawalsState`.
   */
  readonly withdrawal: PendingWithdrawalsState;
  /** Whether a withdrawal prompt should be shown before the delete button. True only
   *  when a real provider reported funds, so false for every account today. */
  readonly withdrawalPromptRequired: boolean;
  readonly verification: {
    readonly methods: readonly string[];
    readonly emailCodeRequired: true;
  };
}

/**
 * What this account can prove, plus the WebAuthn options when it holds a passkey.
 *
 * `methods` is empty for an account with nothing enrolled, which is the signal that
 * the emailed code alone will do. `recovery_code` never appears: a backup code cannot
 * delete an account.
 */
export interface DeleteChallengePayload {
  readonly outcome: 'delete_account_challenge';
  readonly methods: readonly string[];
  readonly options: Record<string, unknown> | null;
  readonly emailCodeRequired: true;
}

/** A single-use permit for ONE deletion. Present it in `x-elevation-ticket`. */
export interface DeleteElevatedPayload {
  readonly outcome: 'delete_account_elevated';
  readonly ticket: string;
  readonly expiresInSeconds: number;
  readonly action: string;
}

/**
 * The account is deleted and every session has ended.
 *
 * The caller's own session is gone by the time they read this, so it is the last
 * thing this account's tokens will ever be answered with. `purgeAt` is here because
 * it is the one fact the user needs to write down.
 *
 * Idempotent: asking again inside the window returns the ORIGINAL `purgeAt` rather
 * than pushing it out or refusing — though a caller who could ask twice would need a
 * second session and a second ticket, since the first request revoked everything.
 */
export interface AccountDeletedPayload {
  readonly outcome: 'account_deleted';
  readonly purgeAt: string;
  readonly reactivationAvailableUntil: string;
}

/**
 * A reactivation code was requested.
 *
 * ═══ THIS IS THE SAME ANSWER FOR EVERY ADDRESS ══════════════════════════════
 *
 * Live account, deleted account, purged account, address that never registered: all
 * four produce exactly this payload, with the same HTTP status. The route is
 * unauthenticated, so any difference between them — a slug, a status code, a field, a
 * rate-limit bucket that empties faster — tells a stranger whether an address has an
 * account here. There is nothing in this shape to vary.
 */
export interface ReactivationRequestedPayload {
  readonly outcome: 'account_reactivation_requested';
}

/** The account is live again. The owner still has to sign in — every session it had
 *  was revoked when it was deleted, and none of them came back. */
export interface AccountReactivatedPayload {
  readonly outcome: 'account_reactivated';
}

export type DeleteAccountPayload =
  | DeleteAccountStatusPayload
  | DeleteChallengePayload
  | DeleteElevatedPayload
  | AccountDeletedPayload
  | ReactivationRequestedPayload
  | AccountReactivatedPayload;
