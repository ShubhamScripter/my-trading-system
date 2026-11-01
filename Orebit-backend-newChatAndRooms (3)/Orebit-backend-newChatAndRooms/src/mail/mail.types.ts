/**
 * ═══ WHY THE UNDO IS DATA AND NOT A FUNCTION ════════════════════════════════
 *
 * `MailService` used to take an `OnUndelivered` callback — a closure the caller
 * handed over, run in the background if the message never left. That worked for as
 * long as "the background" meant "later in this process".
 *
 * It cannot survive a crash, and that is the whole reason this file exists. A closure
 * is not serialisable: there is no way to put one in Redis and have another process,
 * or the same process after a restart, run it. So the compensating action had to stop
 * being code and start being a DESCRIPTION of code.
 *
 * ─── Why the loss mattered more than the message ────────────────────────────
 *
 * Losing a queued OTP costs the user a resend. Losing the UNDO is worse: the caller
 * has already charged that user a send from their budget, so the refund never
 * running leaves them one attempt poorer for mail that never arrived. Five of those
 * and they are locked out of their own account for an hour, with no error shown at
 * any point — which is precisely the failure the callback was introduced to prevent.
 *
 * ─── The cost of the change ────────────────────────────────────────────────
 *
 * An undo can now only be something this union can express. That is a real
 * constraint and a deliberate one: a caller cannot smuggle arbitrary work into the
 * mail path any more, and adding a new kind of compensation means adding a member
 * here and a handler in the registry — visible in a diff, rather than a lambda
 * nobody outside the call site ever reads.
 */

import type { QuotaStore } from '../../redis';

/** A compensating action to run if a message never left. Must be serialisable. */
export type MailUndo =
  /**
   * Give back one charge against a rolling-window quota.
   *
   * Carries the charge TOKEN rather than just the keys, and that is what makes it
   * safe to run more than once: the refund is a `ZREM` of that exact member, so a
   * duplicated compensation removes nothing the second time. The `cache.refund`
   * below cannot offer that — it is a `DECR`, and running it twice hands back two
   * slots for one failed send, which is a way to mint quota by deliberately breaking
   * delivery.
   */
  | {
      readonly kind: 'quota.refund';
      readonly token: string;
      readonly keys: readonly string[];
      readonly store: QuotaStore;
    }
  /**
   * Drop a cooldown key outright, so the next attempt is free to succeed.
   *
   * Paired with `cache.refund` on the login path: the send budget and the resend
   * cooldown are two separate mechanisms on two separate keys, and a user whose code
   * never arrived is owed both back.
   */
  | { readonly kind: 'cache.clear'; readonly key: string }
  /** Give back one slot in a fixed-window counter — a DECR that will not resurrect
   *  an expired key. See `CacheService.refund`. */
  | { readonly kind: 'cache.refund'; readonly key: string }
  /**
   * Return one OTP send to a registration's own budget.
   *
   * The registration row counts sends itself rather than borrowing a Redis counter,
   * because a signup that loses its cooldown to a cache flush would be unresumable.
   * Handled by `auth`, not here — see `MailUndoRegistry`.
   */
  | { readonly kind: 'registration.refund-otp-send'; readonly registrationId: string };

export type MailUndoKind = MailUndo['kind'];

/**
 * Which compensations are safe to run more than once.
 *
 * This used to be prose in the comments above and nothing else, which was enough
 * while an undo ran exactly once — from memory, immediately after dead-lettering, with
 * no retry if it failed. It is not enough now: compensations are recorded durably and
 * retried until they settle, so "can this run twice" is a question the code has to be
 * able to answer.
 *
 * `true` here means the operation is naturally idempotent and may simply be retried:
 *
 *   `quota.refund`  `ZREM` of a named member — the second call removes nothing.
 *   `cache.clear`   `DEL` — the second call deletes nothing.
 *
 * `false` means running it twice gives back more than was taken, which for a mail
 * budget is a way to mint quota by deliberately breaking delivery. Those run under a
 * once-only claim in `MailUndoRegistry` instead:
 *
 *   `cache.refund`                  a `DECR`.
 *   `registration.refund-otp-send`  an UPDATE decrementing a column.
 */
export const UNDO_IS_IDEMPOTENT: Readonly<Record<MailUndoKind, boolean>> = {
  'quota.refund': true,
  'cache.clear': true,
  'cache.refund': false,
  'registration.refund-otp-send': false,
} as const;

/**
 * The rendered message. `to`, `subject`, `text` and `html` are what nodemailer is
 * handed, verbatim — see `MailSender.tryRelay`, which names those four fields and
 * nothing else.
 */
export interface MailBody {
  readonly to: string;
  readonly subject: string;
  /**
   * ═══ THE SUBJECT THAT IS SAFE TO KEEP ═══════════════════════════════════════
   *
   * The subject to PERSIST, when the real one carries a secret. Never sent to anybody:
   * `tryRelay` hands the relay `subject`, so setting this cannot change the email a
   * user receives.
   *
   * ─── Why the audit trail needs its own subject at all ───────────────────────
   *
   * `mail_deliveries.subject` is durable storage with no retention or TTL, indexed by
   * `(recipient, created_at)`. The one-time-code templates lead their subject with the
   * code — that is deliberate, because a reader scanning an inbox should be able to see
   * the digits without opening the message. Persisting that subject turns a
   * delivery-diagnostics table into a permanent archive of plaintext credentials, and
   * a row written in the last ten minutes holds a code that still works. Database
   * access, a replica, a backup, or a support tool reading the audit trail then reads
   * live credentials.
   *
   * So the two uses of "the subject" stopped being one string. The message keeps the
   * subject it always had; the audit row gets this one.
   *
   * ─── Why OPTIONAL, and what happens when it is absent ──────────────────────
   *
   * Absent means "the real subject is already safe to keep", which is true of six of
   * the eight kinds — they interpolate no secret. It is also what every message queued
   * before this field existed looks like, and those are still in Redis being retried
   * across the deploy that adds it.
   *
   * Absence is therefore NOT trusted as a promise. `safeAuditSubject` at the
   * persistence boundary makes the final decision and has two further defences for a
   * body that never set this — see `mail.dboperation.ts`. A template that forgets it
   * cannot leak; this field is how a template gets a *legible* audit subject rather
   * than the boundary's fallback.
   */
  readonly auditSubject?: string;
  readonly text: string;
  readonly html: string;
}

/**
 * One queued message, as it exists in Redis.
 *
 * ─── Why the RENDERED body is stored, not the template and its arguments ────
 *
 * Storing `{ template: 'otp', code, minutes }` would be smaller and would let a
 * template change apply to already-queued mail. Both are the wrong trade here.
 *
 * The body is rendered at enqueue time because the message is a promise already made
 * to a user: they were told a code was sent, and the code they were told about is the
 * one that must arrive. Re-rendering at delivery time means a deploy between enqueue
 * and send could change the wording, the expiry, or — with a template argument
 * renamed — produce a message with a hole in it. It also means the worker needs every
 * template's argument shape, which puts template evolution on the critical path of
 * draining a backlog after an outage.
 *
 * The cost is size: a few kilobytes of HTML per queued message rather than a few
 * dozen bytes. At the volumes this service sends, that is not a consideration.
 */
export interface MailJob {
  /**
   * Our own id, distinct from the Redis stream entry id.
   *
   * The stream id changes when a message is retried — a retry is a new `XADD` — so it
   * cannot be what correlates the attempts of one message. This can, and it is what
   * `MailDelivery.jobId` records, which is how "show me every attempt at the code
   * this user says never arrived" becomes one query.
   */
  readonly id: string;
  /** Which template produced it: `otp`, `password-reset`, `welcome`, … */
  readonly kind: string;
  readonly body: MailBody;
  /**
   * The instant after which this message is worthless, ISO 8601. Absent for mail
   * that does not go stale.
   *
   * ─── Why the queue has to know ──────────────────────────────────────────────
   *
   * Because the body is rendered once and replayed on every retry, and for a
   * one-time code that body is a promise with a deadline attached. The queue knew
   * about the promise and not about the deadline, so a relay that was down for
   * twenty minutes produced this: five delivery attempts spread over seventeen
   * minutes, every one of them carrying the SAME six digits, the last two arriving
   * after the code had already expired. From the recipient's side that is one code
   * being sent again and again, the last times uselessly — which is exactly how it
   * was reported.
   *
   * Storing an absolute instant rather than a duration is the point. A duration
   * would have to be measured from something, and every candidate is wrong: from
   * the attempt (each retry renews the code's life), from the enqueue (correct, but
   * then every reader has to recompute it and one of them will forget). An absolute
   * timestamp cannot be misread — it is the same instant to the producer, to the
   * worker, and to a human reading the DLQ.
   */
  readonly validUntil?: string;
  /** Compensations to run if this message is finally undeliverable. */
  readonly undo: readonly MailUndo[];
  /** Delivery attempts already made. Zero on first enqueue. */
  readonly attempts: number;
  /** When it first entered the queue, ISO 8601. Retries preserve it, so the age of a
   *  message is the age of the promise rather than of its latest attempt. */
  readonly queuedAt: string;
  /** The last failure, for the DLQ entry and the log. */
  readonly lastError?: string;
}
