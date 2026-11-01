import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ANTI_PHISHING_KINDS } from './mail.constants';
import { MailQueue } from './mail.queue';
import { MailUndoRegistry } from './mail.undo';
import type { MailBody, MailJob, MailUndo } from './mail.types';
import {
  accountDeletedEmail,
  accountReactivatedEmail,
  accountReactivationEmail,
  emailAddedEmail,
  emailChangedEmail,
  emailRemovedEmail,
  newDeviceLoginEmail,
  otpEmail,
  passwordResetEmail,
  securityChangedEmail,
  socialUnlinkScheduledEmail,
  welcomeEmail,
  withAntiPhishingCode,
} from './mail.templates';

export type { MailBody as Mail } from './mail.types';
export type { MailUndo } from './mail.types';

/**
 * How long the template should tell the reader they have.
 *
 * Derived from the deadline rather than passed alongside it, so the sentence in the
 * email and the instant the worker enforces cannot disagree. They used to be two
 * arguments — a `minutesValid` for the body and nothing at all for the queue — which
 * is how a message could say "expires in 10 minutes" and then be delivered
 * seventeen minutes later.
 *
 * Rounded up: telling someone they have nine minutes when they have nine and a half
 * is a worse answer than telling them ten.
 */
function minutesUntil(expiresAt: Date): number {
  return Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 60_000));
}

/**
 * ═══ OUTBOUND EMAIL — THE PRODUCER ══════════════════════════════════════════
 *
 * Render a message and put it on the durable queue. That is all this class does now;
 * the SMTP conversation is `MailSender`, driven by `MailWorker`.
 *
 * ─── What changed, and why it was not enough before ─────────────────────────
 *
 * Dispatch was already off the request path: `dispatch` returned void and the send
 * ran in the background. What it was NOT was durable. The pending sends lived in an
 * in-memory `Set`, so a crash or a deploy between "we told the user a code was sent"
 * and "the relay accepted it" lost the message — and the process's own shutdown log
 * said `messages dropped` when its five-second drain elapsed.
 *
 * Worse than the message was the accounting. A caller that charged a user a send from
 * their budget handed over an `OnUndelivered` closure to give it back. A closure
 * cannot be written to Redis, so that refund died with the process: the user was left
 * one attempt poorer for mail that never arrived, and five of those locks them out of
 * their own account for an hour with no error shown at any point.
 *
 * So the compensation stopped being a callback and became DATA — see `MailUndo`. A
 * message is now safe the moment `XADD` returns, and so is the promise to undo its
 * accounting if it never lands.
 *
 * ─── The API is unchanged where it matters ──────────────────────────────────
 *
 * Still fire-and-forget: none of these methods is `async`, and that is the contract
 * rather than an accident — a caller cannot reintroduce blocking by putting `await`
 * in front of one. A failure still cannot fail the request that triggered it. What a
 * caller passes instead of a closure is a list of `MailUndo` descriptors.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');

  constructor(
    private readonly queue: MailQueue,
    /** Only reached when the ENQUEUE itself fails — see the note on `enqueue`. The
     *  delivered-path compensation is the worker's. */
    private readonly undo: MailUndoRegistry,
  ) {}

  /**
   * ═══ THE ANTI-PHISHING PARAMETER, ON EVERY SEND ═════════════════════════════
   *
   * Every method below takes `antiPhishingCode: string | null`, and it is REQUIRED
   * rather than optional for exactly the reason `undo` is: a caller who forgot it would
   * silently ship a message that omits a code the user has been told to check for, and
   * the compiler is a better place to catch that than a support ticket.
   *
   * `null` is the explicit way to say "this account has no code, or has no account
   * yet" — the registration and OAuth signup sends pass it because no user row exists,
   * and `sendEmailRemoved` passes it because that message must not carry one. Every
   * caller therefore states its position rather than inheriting a default.
   *
   * The value is resolved BY THE CALLER, from a `User` row it already holds. That is
   * what keeps `MailService` free of a database dependency and keeps the
   * fire-and-forget contract intact — see `antiPhishingCodeOf`, and the note on
   * `enqueue` for where the stamping happens.
   */

  /**
   * One-time code, for registration email verification and login.
   *
   * `undo` is what the caller wants reversed if the message is finally undeliverable.
   * Required rather than optional: a path that charged a user's budget and passed
   * nothing here would silently keep the charge, and the compiler is a better place
   * to catch that than a support ticket. Pass an empty array to mean "nothing was
   * charged" — `sendWelcome` and `sendNewDeviceLogin` do exactly that.
   */
  async sendOtp(
    to: string,
    code: string,
    expiresAt: Date,
    undo: readonly MailUndo[],
    antiPhishingCode: string | null,
  ): Promise<void> {
    await this.enqueue(
      otpEmail(to, code, minutesUntil(expiresAt)),
      'otp',
      undo,
      antiPhishingCode,
      expiresAt,
    );
  }

  sendPasswordReset(
    to: string,
    code: string,
    expiresAt: Date,
    undo: readonly MailUndo[],
    antiPhishingCode: string | null,
  ): Promise<void> {
    return this.enqueue(
      passwordResetEmail(to, code, minutesUntil(expiresAt)),
      'password-reset',
      undo,
      antiPhishingCode,
      expiresAt,
    );
  }

  /**
   * ═══ THE THREE FIRE-AND-FORGET NOTIFICATIONS ════════════════════════════════
   *
   * These three return `void` on purpose: nothing was charged for them, no ceremony
   * depends on them, and a caller must not be able to put a Redis round trip on the
   * critical path of a sign-in by awaiting one.
   *
   * They must still handle their own failure. `enqueue` is `async` and RETHROWS when
   * Redis will not take the job (see the note on it below), so calling it without
   * `await` or `.catch` produced an unhandled promise rejection — which in Node
   * terminates the process by default. A welcome email that cannot be queued would
   * have taken the API down with it.
   *
   * `swallow` is where that stops. The message is lost, which for a notification is
   * the correct outcome and is already logged inside `enqueue`.
   */
  sendNewDeviceLogin(
    to: string,
    device: string,
    ipClass: string,
    antiPhishingCode: string | null,
  ): void {
    this.swallow(
      this.enqueue(
        newDeviceLoginEmail(to, device, ipClass),
        'new-device-login',
        [],
        antiPhishingCode,
      ),
    );
  }

  /** Gap M3 — the notification that makes a credential change auditable by its owner. */
  sendSecurityChanged(
    to: string,
    what: string,
    ipClass: string,
    antiPhishingCode: string | null,
  ): void {
    this.swallow(
      this.enqueue(securityChangedEmail(to, what, ipClass), 'security-changed', [], antiPhishingCode),
    );
  }

  /**
   * A social login is scheduled for removal, seven days out.
   *
   * Fire-and-forget like the notifications above, and the delay is what makes that
   * comfortable rather than merely conventional: the message is the reader's warning,
   * but it is not the only thing standing between them and the change. Even if it is
   * never delivered the link keeps working for a week, and the pending state is
   * visible on the settings screen the whole time.
   *
   * `expiresAt` is deliberately NOT passed. The queue's expiry exists for perishable
   * content — a code that is worthless once it has lapsed — and this message stays
   * worth reading right up to the deadline and after it. Handing it `unlinkAt` would
   * make a delivery retried past the boundary get dropped, which is precisely the
   * reader this message is for.
   */
  sendSocialUnlinkScheduled(
    to: string,
    provider: string,
    unlinkAt: Date,
    ipClass: string,
    antiPhishingCode: string | null,
  ): void {
    this.swallow(
      this.enqueue(
        socialUnlinkScheduledEmail(to, provider, unlinkAt, ipClass),
        'social-unlink-scheduled',
        [],
        antiPhishingCode,
      ),
    );
  }

  /**
   * The account was deleted, and here is how long there is to undo it.
   *
   * Fire-and-forget, like every other notification here, and NOT perishable: the
   * deadline it names is thirty days out and the message stays worth reading right up
   * to it. Handing it an expiry would drop a retry for exactly the reader it is for.
   */
  sendAccountDeleted(
    to: string,
    purgeAt: Date,
    ipClass: string,
    antiPhishingCode: string | null,
  ): void {
    this.swallow(
      this.enqueue(accountDeletedEmail(to, purgeAt, ipClass), 'account-deleted', [], antiPhishingCode),
    );
  }

  /**
   * The code that restores a deleted account.
   *
   * ─── Why this one is awaited and takes no anti-phishing code ────────────────
   *
   * Awaited because it is the whole ceremony rather than a notice about one: a caller
   * that swallowed a send failure would answer "we have emailed you a code" having
   * emailed nothing, and the recovery path is the last one a locked-out owner has.
   * `sendOtp` is awaited for the identical reason.
   *
   * `null` for the code, always, and the parameter is deliberately absent rather than
   * defaulted — `account-reactivation` is not in `ANTI_PHISHING_KINDS`, because this
   * message answers an UNAUTHENTICATED request naming only an address. Stamping it
   * would print the account's anti-phishing code for anyone who can type that address
   * into the restore form, which hands a forger the one thing the code proves they
   * lack. See the exclusion note in mail.constants.ts.
   *
   * Perishable: a one-time code is worthless once it lapses.
   */
  async sendAccountReactivationCode(to: string, code: string, expiresAt: Date): Promise<void> {
    await this.enqueue(
      accountReactivationEmail(to, code, minutesUntil(expiresAt)),
      'account-reactivation',
      [],
      null,
      expiresAt,
    );
  }

  /** The account is live again. Fire-and-forget: the state is already committed and
   *  this is the record of it, not the mechanism. */
  sendAccountReactivated(to: string, ipClass: string, antiPhishingCode: string | null): void {
    this.swallow(
      this.enqueue(accountReactivatedEmail(to, ipClass), 'account-reactivated', [], antiPhishingCode),
    );
  }

  /**
   * The "did you do this?" message sent to the address an email change released — and
   * the ONE notification in this class that is not fire-and-forget.
   *
   * It returns a promise and is awaited by its caller, unlike the three above, because
   * it does not merely report a change: it carries the single-use token that authorises
   * undoing one. A recipient who never gets this message has no route back to an
   * account somebody else may have just taken, so an enqueue failure has to be visible
   * rather than swallowed.
   *
   * What the caller must NOT do is fail the request on it. The change has already
   * committed by the time this is sent, and reporting failure would tell a user their
   * address is unchanged when it is not. The caller logs at `error` and returns
   * success — see `EmailChangeService.notifyChange`.
   *
   * `undo` is empty: nothing metered is charged for this message, and the recovery
   * window is a property of the database row rather than of the mail.
   */
  sendEmailChanged(
    to: string,
    maskedNewEmail: string,
    recoveryUrl: string,
    ipClass: string,
    antiPhishingCode: string | null,
  ): Promise<void> {
    return this.enqueue(
      emailChangedEmail(to, maskedNewEmail, recoveryUrl, ipClass),
      'email-changed',
      [],
      antiPhishingCode,
    );
  }

  /** Goes to the address that just became the account's. Informational, so
   *  fire-and-forget like the three above. */
  sendEmailAdded(to: string, ipClass: string, antiPhishingCode: string | null): void {
    this.swallow(this.enqueue(emailAddedEmail(to, ipClass), 'email-added', [], antiPhishingCode));
  }

  /**
   * Goes to the address a recovery removed from the account — in the compromise case,
   * the attacker's. Deliberately says almost nothing; see the template.
   *
   * Takes no anti-phishing parameter, and that is the signature making the rule
   * unbreakable rather than merely documented: this is the one message that must never
   * carry the code, because the mailbox receiving it may be hostile and the code is
   * exactly what a forger needs. `email-removed` is absent from `ANTI_PHISHING_KINDS`
   * as well, so the rule holds twice — but a caller cannot even express the mistake.
   */
  sendEmailRemoved(to: string, ipClass: string): void {
    this.swallow(this.enqueue(emailRemovedEmail(to, ipClass), 'email-removed', [], null));
  }

  /**
   * Takes no anti-phishing parameter either, for a different reason: this is sent
   * seconds after the account is created, so no code can exist yet. `welcome` is absent
   * from `ANTI_PHISHING_KINDS` for the same reason.
   */
  sendWelcome(to: string, username: string, publicCode: string): void {
    this.swallow(this.enqueue(welcomeEmail(to, username, publicCode), 'welcome', [], null));
  }

  /**
   * Detach a notification's enqueue from the caller, without detaching its failure.
   *
   * The `catch` is the whole point. `enqueue` has already logged the specifics with
   * the recipient and the kind, so this only has to stop the rejection escaping — but
   * it has to do that, because an unhandled rejection is a process exit.
   */
  private swallow(queued: Promise<void>): void {
    void queued.catch(() => undefined);
  }

  /**
   * Render, wrap in a job, and hand it to Redis.
   *
   * Not `async`, and the signature is the contract: there is no promise to await, so
   * a caller cannot accidentally put the enqueue back on the critical path.
   *
   * ─── What happens if REDIS itself is down ───────────────────────────────────
   *
   * The enqueue fails and the message is lost — that is the one remaining single point
   * of failure, and it is a genuine improvement rather than a wash: the window shrank
   * from "the entire life of the SMTP conversation, plus however long the process
   * lives afterwards" to "one Redis round trip on a connection configured never to
   * give up on a command".
   *
   * The compensations DO run in that case. `MailUndoRegistry` depends only on
   * `CacheService` and the handlers other modules register, so injecting it here is
   * not a cycle — and a user must not stay charged for a message that was never even
   * queued. This is the same compensation the worker performs on a dead-lettered
   * message, at the other end of the same failure.
   */
  private async enqueue(
    body: MailBody,
    kind: string,
    undo: readonly MailUndo[],
    /**
     * The account's anti-phishing code, or `null`.
     *
     * ─── Why the stamping happens HERE and nowhere else ────────────────────────
     *
     * This is the only function all eight kinds pass through, and the only place the
     * rendered body and the `kind` exist together — which is what the decision needs.
     * `layout` sees neither: it renders the HTML part only, so a footer added there
     * would be missing from every message's plaintext alternative.
     *
     * Stamping before the `MailJob` is built also means the code is inside the body
     * that gets rendered ONCE and replayed on every retry, per the note in
     * mail.types.ts. A retry cannot deliver a message whose footer disagrees with the
     * one the first attempt carried.
     *
     * Two conditions, both required. The `kind` allowlist is the reviewable statement
     * of which messages carry a code; the null check is the per-account fact. A kind
     * in the set and a null code is the ordinary case for an account that has not set
     * one, and it renders as no footer — identical to the mail this service sent
     * before the feature existed.
     */
    antiPhishingCode: string | null,
    /** When the content stops being useful. Omitted for mail that never goes stale. */
    expiresAt?: Date,
  ): Promise<void> {
    const stamped =
      antiPhishingCode !== null && ANTI_PHISHING_KINDS.has(kind)
        ? withAntiPhishingCode(body, antiPhishingCode)
        : body;

    const job: MailJob = {
      id: randomUUID(),
      kind,
      body: stamped,
      undo,
      attempts: 0,
      queuedAt: new Date().toISOString(),
      ...(expiresAt === undefined ? {} : { validUntil: expiresAt.toISOString() }),
    };

    try {
      await this.queue.enqueue(job);
    } catch (err) {
      this.logger.error(
        { err, jobId: job.id, kind, to: body.to },
        'COULD NOT QUEUE MAIL — the recipient will not get this message',
      );
      // The caller owns the associated challenge and is the only component that can
      // invalidate it safely. Propagating this failure lets it retire that code and
      // run the paired, idempotent refunds before reporting the outage.
      throw err;
    }
  }
}
