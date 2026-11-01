/**
 * Queue and worker tuning.
 *
 * Here rather than in `auth/auth.constants.ts` because none of it is product policy —
 * nobody changes a reclaim threshold in response to a risk review. It is the same
 * reasoning that keeps the connection-pool numbers beside the transport.
 */
/**
 * Kinds whose content stops being useful on a deadline.
 *
 * These are the messages that carry a one-time code, and they get their own retry
 * schedule below. Anything not listed here is ordinary mail — a welcome, a
 * security notification — which is just as valuable delivered late.
 */
const PERISHABLE_KINDS: ReadonlySet<string> = new Set(['otp', 'password-reset']);

/**
 * ═══ WHICH KINDS PUT A SECRET IN THEIR SUBJECT ══════════════════════════════
 *
 * Kind → the code-free subject to persist for it. The second of three defences behind
 * `safeAuditSubject`; the reasoning for the whole arrangement is on that function.
 *
 * This exists because `MailBody.auditSubject` is a field a body either has or has not
 * got, and there are two ways for a secret-bearing message to arrive without one:
 *
 *   A message queued BEFORE `auditSubject` existed. Bodies are rendered once and
 *   replayed on every retry (see mail.types.ts), so the deploy that adds the field does
 *   not touch the perishable `otp` jobs already in Redis being retried.
 *
 *   A future edit that drops the field from a template. The subject would keep working
 *   perfectly — the email is unaffected — so nothing else would notice.
 *
 * Only the kinds that interpolate a secret into their subject belong here. The other
 * six do not, and listing them would mean replacing a perfectly good audit subject
 * with a duller one for no security gain.
 *
 * The values deliberately read as the real subject with the code lifted out, so a row
 * in `mail_deliveries` is still recognisable as the message it records.
 */
export const SECRET_SUBJECT_KINDS: ReadonlyMap<string, string> = new Map([
  ['otp', 'Your OREBiT verification code'],
  ['password-reset', 'Your OREBiT password reset code'],
]);

/**
 * ═══ WHICH MESSAGES CARRY THE ANTI-PHISHING CODE ════════════════════════════
 *
 * The one place this is decided. `MailService.enqueue` reads this set and nothing else,
 * so "does this email show the code" is answered by a list a reviewer can read rather
 * than by which of seventeen call sites remembered to pass a value.
 *
 * ─── Why nearly everything, rather than a chosen few ──────────────────────────
 *
 * The code is only useful if its ABSENCE is informative. A user who sees it on some
 * genuine Orebit mail and not on other genuine Orebit mail has learned nothing they can
 * act on — a forgery without a code looks exactly like the legitimate messages that
 * also lack one. So the default is "every message to an established account", and each
 * exclusion below needs a reason.
 *
 * ─── The exclusions, and why each one is out ─────────────────────────────────
 *
 * `welcome` — sent seconds after the account is created, when no code can exist yet.
 *   Listing it would put a permanently unstamped message in the set and teach exactly
 *   the "sometimes there is no code" lesson this feature cannot afford.
 *
 * `email-removed` — goes to an address a recovery just REMOVED from the account, which
 *   in the compromise case is the attacker's own mailbox (see the template's own note on
 *   why it says almost nothing). Stamping it would hand the code to precisely the party
 *   who would use it to forge mail the real owner will trust. This is the one exclusion
 *   that is a security decision rather than a practical one.
 *
 * `email-changed` is deliberately INCLUDED even though it also goes to an address the
 * account has left. The difference is which party holds that mailbox: on the release
 * path it is the owner, and this is the message carrying their recovery link — the one
 * email that most needs to be recognisable as genuine. The security freeze in
 * `AntiPhishingService.assertChangeAllowed` is what stops an attacker who has just moved
 * the address from also changing the code before it is sent.
 *
 * The registration and OAuth signup sends are not listed as exclusions because they are
 * not a `kind` distinction: they use `otp`, and pass `null` because no account exists
 * yet. `enqueue` omits the block for a null code, so those messages carry nothing
 * without needing a second rule.
 */
export const ANTI_PHISHING_KINDS: ReadonlySet<string> = new Set([
  'otp',
  'password-reset',
  'security-changed',
  'social-unlink-scheduled',
  'new-device-login',
  'email-changed',
  'email-added',
  // The deletion pair. Both go to an address the account owns and both are exactly the
  // message a forger would want to imitate — "your account was deleted, click here" is
  // the shape of the attack, so the code that proves the message is genuine belongs on
  // them more than on most.
  'account-deleted',
  'account-reactivated',
  // `account-reactivation` is deliberately ABSENT. It is sent in response to an
  // unauthenticated request naming only an address, so stamping it would print the
  // account's anti-phishing code for anyone who can type that address into the restore
  // form — handing a forger the one thing the code exists to prove they lack. Same
  // exclusion, same reason, as the pre-account sends.
]);

/**
 * Backoff before each retry, in milliseconds, indexed by attempts already made.
 *
 * Explicit lists rather than a formula. A formula hides the shape, and the shape is
 * the decision.
 *
 * ─── Why perishable mail needs its own schedule ─────────────────────────────
 *
 * The standard ladder ends with a fifteen-minute wait, which puts the fifth attempt
 * at roughly seventeen and a half minutes after the first. For a welcome email that
 * is exactly right: an outage that lasts a quarter of an hour should not cost the
 * message.
 *
 * For a one-time code with a ten-minute life it is worse than useless. Attempts four
 * and five are delivering a code that has already expired, so the recipient gets mail
 * they cannot use — twice — for a sign-in they long ago abandoned. The previous
 * version of this file defended that fifth attempt as covering "a relay that comes
 * back just as the code dies". That was wrong on the arithmetic: at 17m35s the code
 * had been dead for seven and a half minutes.
 *
 * The perishable ladder fits entirely inside the code's life — 5s, then 30s and 90s,
 * so the last of its four attempts lands at about two minutes. If a relay is still
 * refusing by then, the honest outcome is to give up and refund, which is what the
 * worker does. `MailSender` enforces the deadline independently, so a stale message
 * cannot reach a relay even if a schedule is later edited badly.
 *
 * ─── Why there is no longer a leading zero ──────────────────────────────────
 *
 * The list began `[0, 5_000, ...]`, which bought nothing and cost something. A zero
 * rung is an immediate retry: the same message goes back to the same relay in the
 * same instant it just refused, so the one thing it cannot do is give the condition
 * time to clear. Against a relay that is down it is a wasted attempt; against one
 * that is rate-limiting or throttling, it is the worst possible response.
 *
 * With `maxAttemptsFor` deriving the count from the ladder, that rung was also a
 * FIFTH attempt on a schedule the comment above describes as four — initial, then
 * immediate, 5s, 30s, 90s. Dropping it makes the code match the prose, and the total
 * elapsed time is unchanged at ~125s.
 */
const PERISHABLE_BACKOFF_MS: readonly number[] = [5_000, 30_000, 90_000];
const STANDARD_BACKOFF_MS: readonly number[] = [5_000, 30_000, 2 * 60_000, 15 * 60_000];

export const MAIL_QUEUE = {
  /** The retry ladder for a message of this kind. */
  backoffFor(kind: string): readonly number[] {
    return PERISHABLE_KINDS.has(kind) ? PERISHABLE_BACKOFF_MS : STANDARD_BACKOFF_MS;
  },

  /**
   * Delivery attempts before a message is dead-lettered.
   *
   * Derived from the ladder rather than declared beside it. The two used to be
   * independent constants, which meant an edit to one silently changed the meaning of
   * the other: shortening the backoff list left `MAX_ATTEMPTS` retrying past its end,
   * and lengthening it left the tail unreachable. One attempt per rung, plus the
   * first — so the count cannot disagree with the schedule.
   */
  maxAttemptsFor(kind: string): number {
    return this.backoffFor(kind).length + 1;
  },

  /** The wait after `attempts` failures, or 0 past the end of the ladder. */
  backoffAfter(kind: string, attempts: number): number {
    return this.backoffFor(kind)[attempts - 1] ?? 0;
  },

  /**
   * How long a claimed message may sit unacked before another worker may take it.
   *
   * MUST exceed the transport's own timeouts. `socketTimeout` is 20s and a message
   * can wait behind others for a pooled connection, so a threshold below that would
   * let a healthy-but-slow worker have its message stolen — and the message would then
   * be sent twice for no reason. Two minutes is comfortably clear of the worst
   * legitimate case while still recovering a killed process within one cycle.
   */
  RECLAIM_AFTER_MS: 2 * 60_000,

  /** Messages claimed per cycle. Small, because each one is an SMTP conversation and
   *  the pool only holds five connections — claiming more would just queue them
   *  inside nodemailer, where the queue is NOT durable. */
  BATCH_SIZE: 5,

  /**
   * How long `XREADGROUP` blocks waiting for work.
   *
   * Long enough that an idle service is not polling, short enough that the loop comes
   * round to promote due retries and reclaim stalled messages at a sensible cadence.
   */
  BLOCK_MS: 5_000,

  /** Dead-letter entries retained. An audit log, so approximate trimming is fine. */
  DLQ_MAX_LEN: 10_000,

  /** How long shutdown waits for the current batch to finish before abandoning it.
   *  Abandoning is safe — an unacked message is reclaimed, not lost. */
  DRAIN_TIMEOUT_MS: 10_000,
} as const;
