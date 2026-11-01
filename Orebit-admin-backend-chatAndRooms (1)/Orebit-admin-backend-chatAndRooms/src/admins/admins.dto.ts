import { z } from 'zod';
import type { AdminPayload } from '../../auth/auth.dto';

/**
 * `POST /admins` — the administrative actions one admin may perform on another.
 *
 * One route with a discriminated-union body, matching `POST /auth/login` and
 * `POST /2fa`. The reasoning is the same and is written up in
 * `auth/auth.routes.ts`: a small surface whose invariants live in one place, at the
 * cost of having to be explicit about per-action guards instead of getting them from
 * the router.
 *
 * ═══ EVERY ACTION NAMES A TARGET ═══════════════════════════════════════════
 *
 * `adminId` is required on all of them, and this is the first route in the service
 * where that is true. `POST /2fa` states as an invariant that no action takes one —
 * so the factors being changed there are always the caller's own — and this route is
 * the deliberate exception. That is why it is a separate prefix rather than three
 * more actions on `/2fa`: the invariant stays true of that route, and the place
 * where it does not hold is somewhere a reviewer can find.
 */

/** UUIDv7, like every id in this schema. Validated for shape so a malformed value
 *  answers `validation_failed` rather than reaching a query. */
const adminIdSchema = z.string().uuid();

/**
 * Empty a target's second-factor set so their next sign-in enrolls a new one.
 *
 * ─── Why this is not an emailed self-service flow ──────────────────────────
 *
 * Because email is ALREADY the second factor. `POST /auth/login` sends a code to
 * the mailbox and that code is factor two, so a factor reset delivered to the same
 * mailbox would make the mailbox sufficient on its own — the same collapse that
 * finding B1 closed on the password-reset path. Recovery therefore has to come from
 * a different direction entirely: another human, already signed in, who has just
 * proved their own second factor.
 *
 * `reason` is required and is written to the log. This action makes an account
 * signable-into by whoever next completes enrollment on it, so "who asked for this,
 * and why" is the thing an audit will want and the thing nobody records unless the
 * API insists.
 */
const resetFactorsSchema = z
  .object({
    action: z.literal('reset-factors'),
    adminId: adminIdSchema,
    reason: z.string().min(8).max(280),
  })
  .strict();

/** Take an account out of service. `AdminStatus.DISABLED` was previously reachable
 *  only by a direct database write. */
const disableSchema = z
  .object({
    action: z.literal('disable'),
    adminId: adminIdSchema,
    reason: z.string().min(8).max(280),
  })
  .strict();

/** Put it back. No reason required: restoring access is the reversible direction,
 *  and the disable that preceded it is already in the log. */
const enableSchema = z
  .object({ action: z.literal('enable'), adminId: adminIdSchema })
  .strict();

/**
 * Decide a pending login review: put the account back in service, or leave it out.
 *
 * ─── Why `expectedVersion` is required rather than optional ────────────────
 *
 * Because the review queue is a SHARED work list. Two super admins can be looking at
 * the same pending row, and without a version the second write silently overwrites
 * the first — including in the direction that re-enables an account the first person
 * had just decided to keep disabled. The client sends the `reviewVersion` it read from
 * `GET /admins/login-reviews`; the update names it in its WHERE clause and refuses if
 * it has moved.
 *
 * Optional-with-a-default would be worse than absent: it would let a client skip the
 * check by omission, which is exactly the client that has not read the current state.
 *
 * ─── Why `reason` is longer here than elsewhere ────────────────────────────
 *
 * 500 rather than the 280 the other actions allow. This decision is the one a future
 * incident review actually reads — "why did we decide this account was a fumbling
 * admin rather than an attack" — and 280 characters is a tweet, not a rationale. It is
 * required for BOTH decisions, unlike `enable`, because keeping an account disabled is
 * as consequential as restoring it and neither is self-explanatory from the log.
 */
const resolveLoginReviewSchema = z
  .object({
    action: z.literal('resolve-login-review'),
    adminId: adminIdSchema,
    decision: z.enum(['ENABLE', 'KEEP_DISABLED']),
    reason: z.string().min(8).max(500),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const adminRequestSchema = z.discriminatedUnion('action', [
  resetFactorsSchema,
  disableSchema,
  enableSchema,
  resolveLoginReviewSchema,
]);

/**
 * `GET /admins/login-reviews` — the query string.
 *
 * A separate schema rather than a member of the union above, because it is a different
 * route and a different HTTP method. Query values arrive as strings, hence `coerce` on
 * the numeric one.
 *
 * `status` defaults to PENDING: the overwhelmingly common read is "what needs my
 * attention", and making the useful case the default keeps the client from having to
 * know the vocabulary to ask the obvious question. RESOLVED and REJECTED are queryable
 * because "what did we decide last time" is the second question a reviewer asks.
 */
export const loginReviewQuerySchema = z
  .object({
    status: z.enum(['PENDING', 'RESOLVED', 'REJECTED']).default('PENDING'),
    /** Keyset cursor from a previous page's `nextCursor`. Opaque to the client. */
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type LoginReviewQuery = z.infer<typeof loginReviewQuerySchema>;

export type AdminRequest = z.infer<typeof adminRequestSchema>;

/**
 * What an administrative action reports back.
 *
 * The target's public shape plus what actually changed. `retired` is included
 * because "reset the factors" on an account that had none is a different event from
 * one that cleared two, and a UI that cannot tell them apart will show the operator
 * a success for a no-op.
 */
export type AdminActionPayload =
  | {
      readonly outcome: 'factors_reset';
      readonly admin: AdminPayload;
      readonly retired: { readonly totp: number; readonly passkey: number };
    }
  | { readonly outcome: 'status_changed'; readonly admin: AdminPayload }
  | {
      readonly outcome: 'login_review_resolved';
      readonly admin: AdminPayload;
      readonly decision: 'ENABLE' | 'KEEP_DISABLED';
      /** The version AFTER the write, so a client holding the list can update its row
       *  without a re-read — and so a second resolve on stale state is refused. */
      readonly reviewVersion: number;
    };

/**
 * One row of the review queue.
 *
 * ═══ WHAT IS DELIBERATELY ABSENT ═══════════════════════════════════════════
 *
 * No `passwordHash`, no `codeHash`, no `stepUpSecretHash`, no raw event metadata, no
 * IP addresses. The summary carries COUNTS of distinct addresses and devices rather
 * than the values, and that is the line: a reviewer needs to know whether this was one
 * actor or forty, which a count answers, and does not need the addresses themselves —
 * which would turn the review queue into a way to read the audit trail.
 *
 * Built field by field in the service rather than by spreading a row, so a column
 * added to `Admin` later is absent from this response until somebody puts it here on
 * purpose. Same discipline as `toPublicAdmin`.
 */
export interface LoginReviewPayload {
  readonly admin: AdminPayload;
  readonly reviewStatus: 'PENDING' | 'RESOLVED' | 'REJECTED';
  readonly reviewVersion: number;
  readonly disabledAt: Date | null;
  readonly disabledReason: string | null;
  readonly reviewedAt: Date | null;
  readonly reviewReason: string | null;
  /**
   * What the audit trail says about how this account came to be here.
   *
   * The whole point of the route. `AdminCredential.failedAttempts` cannot answer any
   * of it — it resets to zero on every lock — so without these counts a super admin is
   * asked to rule on an account with no evidence but the fact that it was locked.
   */
  readonly failureSummary: {
    readonly accountFailures: number;
    readonly distinctIps: number;
    readonly distinctDevices: number;
    readonly lastFailureAt: Date | null;
  };
}

export interface LoginReviewListPayload {
  readonly reviews: readonly LoginReviewPayload[];
  /** Pass back as `cursor` for the next page. Null when this is the last one. */
  readonly nextCursor: string | null;
}
