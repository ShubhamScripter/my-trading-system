import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';
import { MailDbOperation } from './mail.dboperation';
import type { MailJob } from './mail.types';

/**
 * Connection pooling and dispatch limits. Tuning rather than product policy, so it
 * lives beside the transport instead of in auth.constants.ts — nobody changes these
 * on a Tuesday afternoon in response to a risk review.
 */
const POOL = {
  /**
   * Sockets held open to one relay.
   *
   * Five, and the ceiling is the relay's rather than ours: Gmail and most
   * transactional providers throttle concurrent connections per account, and being
   * refused for opening too many is worse than queueing behind five.
   */
  MAX_CONNECTIONS: 5,
  /**
   * Messages down one socket before it is recycled.
   *
   * Relays commonly cap this themselves and drop the connection when it is hit —
   * recycling first turns "the 101st message of a batch fails" into a reconnect
   * nobody notices.
   */
  MAX_MESSAGES: 100,
  /** How long to let an in-flight send finish when the process is shutting down. */
  DRAIN_TIMEOUT_MS: 5_000,
} as const;

/** What one delivery attempt resolved to. */
export type SendOutcome =
  /** Handed to a relay that accepted it. */
  | { readonly status: 'sent'; readonly detail: string }
  /** A relay answered and refused this RECIPIENT. Terminal — retrying elsewhere will
   *  not help, and a 550 twice is reputation damage for nothing. */
  | { readonly status: 'rejected'; readonly detail: string }
  /** No relay would take it: connection, timeout, or auth. Worth retrying. */
  | { readonly status: 'unreachable'; readonly detail: string }
  /** The console transport. Nothing was dialled; the code is in the log. */
  | { readonly status: 'skipped'; readonly detail: string }
  /**
   * The content died before a relay would take it. Terminal, and NOT a success.
   *
   * Distinct from `rejected` even though both end the message, because they mean
   * opposite things about who is owed what. A rejected recipient is a bad address —
   * nothing we can do, and nothing the user paid for that they should get back. An
   * expired code is our outage: the user was charged a send from their budget for a
   * message that never left, so the worker owes them the refund.
   */
  | { readonly status: 'expired'; readonly detail: string };

/**
 * ═══ THE TRANSPORT ══════════════════════════════════════════════════════════
 *
 * One delivery attempt, and the record of what happened. Nothing about queueing,
 * retrying or compensating lives here — those are `MailQueue` and `MailWorker`.
 *
 * ─── Why this is separate from MailService now ───────────────────────────────
 *
 * They used to be one class, and the split follows the queue. `MailService` runs on
 * the REQUEST path and its job is to render a message and hand it to Redis as fast as
 * possible. This runs in the WORKER and its job is an SMTP conversation that may take
 * twenty seconds. Fusing a fast producer and a slow consumer into one class is how the
 * previous version ended up with an unbounded in-memory set of pending promises.
 *
 * It also makes the worker testable: the loop's decisions — retry, dead-letter,
 * compensate — are a function of a `SendOutcome`, and a double returning one of the
 * four is enough to drive every branch without a relay.
 *
 * ─── Failures are RETURNED, not thrown ──────────────────────────────────────
 *
 * `send` never throws for a delivery failure. The worker has to distinguish a
 * retryable failure from a terminal one to decide what to do next, and an exception
 * carries that distinction badly — it would mean the worker inspecting error shapes
 * to reconstruct what this class already knew.
 */
@Injectable()
export class MailSender implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MailSender');
  private readonly transporter: Transporter | null;
  /** Tried only when the primary refuses a message outright. */
  private readonly backup: Transporter | null;
  /** True when nodemailer should dump the SMTP dialogue itself. */
  private readonly verbose: boolean;
  /** The current attempt, so shutdown can wait for it. Never more than one: the
   *  worker delivers sequentially, on purpose — see `MailWorker.deliverAll`. */
  private inFlight: Promise<unknown> | null = null;

  constructor(private readonly deliveries: MailDbOperation) {
    this.verbose = config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace';

    if (config.MAIL_TRANSPORT !== 'smtp') {
      this.transporter = null;
      this.backup = null;
      return;
    }

    const options = {
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      // 465 is implicit TLS; 587 negotiates STARTTLS. Deriving it from the port
      // avoids a second env var that could contradict the first.
      secure: config.SMTP_PORT === 465,
      auth: config.SMTP_USER
        ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
        : undefined,
      // These bound how long a socket sits occupied against the pool's
      // `maxConnections`. They also bound how long one queue entry can hold a worker
      // — which is why `MAIL_QUEUE.RECLAIM_AFTER_MS` has to exceed them.
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,

      // Reuse sockets between messages rather than paying TCP + TLS + AUTH per send.
      pool: true,
      maxConnections: POOL.MAX_CONNECTIONS,
      maxMessages: POOL.MAX_MESSAGES,

      // ─── SSRF and local-file hardening ────────────────────────────────────
      //
      // Nodemailer will, by default, resolve an attachment or an embedded resource
      // given as `{ path: '/etc/passwd' }` or `{ path: 'http://169.254.169.254/...' }`
      // and put the result in the delivered message. That turns any path where an
      // attacker influences message content into arbitrary local-file read and a
      // full-response SSRF — with the answer exfiltrated by email, which is about the
      // most convenient channel there is.
      //
      // Nothing in mail.templates.ts uses attachments or remote content, so this
      // costs nothing today. It is set because "no current call site does that" is a
      // property of today's code rather than of the transport.
      disableFileAccess: true,
      disableUrlAccess: true,

      logger: this.verbose,
      debug: this.verbose,
    };

    // The resolved configuration, so a wrong host or a missing credential is visible
    // without reading .env. The password is never logged — only whether one is
    // present and how long it is, which is enough to catch the two real mistakes: an
    // empty value, or a Gmail app password pasted with its spaces still in.
    this.logger.log(
      {
        host: options.host,
        port: options.port,
        secure: options.secure,
        user: config.SMTP_USER || '(none)',
        passwordLength: config.SMTP_PASSWORD.length,
        passwordHasWhitespace: /\s/.test(config.SMTP_PASSWORD),
        from: config.SMTP_FROM,
        verbose: this.verbose,
        pooled: true,
        maxConnections: POOL.MAX_CONNECTIONS,
      },
      'SMTP transport configured',
    );

    this.transporter = nodemailer.createTransport(options);

    this.backup = config.smtpBackupEnabled
      ? nodemailer.createTransport({
          ...options,
          host: config.SMTP_BACKUP_HOST,
          port: config.SMTP_BACKUP_PORT,
          secure: config.SMTP_BACKUP_PORT === 465,
          auth: config.SMTP_BACKUP_USER
            ? { user: config.SMTP_BACKUP_USER, pass: config.SMTP_BACKUP_PASSWORD }
            : undefined,
        })
      : null;

    this.logger.log(
      { configured: this.backup !== null, host: config.SMTP_BACKUP_HOST || '(none)' },
      'SMTP backup transport',
    );
  }

  /**
   * Say out loud, at boot, whether email actually leaves this process.
   *
   * This exists because of a real failure: with `MAIL_TRANSPORT=console` the service
   * looked healthy, every endpoint returned success, and codes went nowhere.
   * Credentials are verified eagerly rather than on first use, so a bad password
   * surfaces at startup instead of inside a signup nobody is watching.
   *
   * Non-fatal on purpose: a mail server that is down must not stop the API booting —
   * and with the queue in front of it, mail sent during that outage is now waiting
   * rather than lost, which is the difference this release makes.
   */
  async onModuleInit(): Promise<void> {
    if (this.transporter === null) {
      this.logger.warn(
        'MAIL_TRANSPORT is not "smtp" — one-time codes are PRINTED TO THIS LOG and NO email is delivered. ' +
          'Set MAIL_TRANSPORT=smtp to send real mail.',
      );
      return;
    }

    await this.verifyOne(this.transporter, 'primary');
    if (this.backup !== null) await this.verifyOne(this.backup, 'backup');
  }

  /**
   * Let the current attempt finish, then close the pool.
   *
   * A pooled transport holds sockets open, so without `close()` the process keeps a
   * handle to the relay and does not exit on its own.
   *
   * The drain is bounded and, unlike the previous version, losing the race is not a
   * lost message: the worker has not acked it, so it stays in the pending list and is
   * reclaimed. That is the whole change — this timeout used to mean "dropped".
   */
  async onModuleDestroy(): Promise<void> {
    if (this.inFlight !== null) {
      await Promise.race([
        this.inFlight.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, POOL.DRAIN_TIMEOUT_MS)),
      ]);
    }

    this.transporter?.close();
    this.backup?.close();
  }

  /**
   * Deliver one queued message. Tries the primary, then the backup.
   *
   * Failover covers the case that actually happens — one relay refusing or timing out
   * — and deliberately not the case where the RECIPIENT is rejected: a 550 for a
   * mailbox that does not exist will be a 550 on the second relay too. So only an
   * unreachable relay falls through, and a rejection is returned as terminal.
   */
  async send(job: MailJob, attempt: number): Promise<SendOutcome> {
    const run = this.attemptDelivery(job, attempt);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Refuse to dial on behalf of content that has already expired.
   *
   * ─── Why this is checked more than once per attempt ─────────────────────────
   *
   * Because "an attempt" can contain two provider calls and a great deal of time. The
   * primary relay's `socketTimeout` is twenty seconds and `connectionTimeout` fifteen,
   * and a message can wait behind others for a pooled connection before either clock
   * starts. So a code with forty seconds of life left can be perfectly valid when the
   * attempt begins and long dead by the time the primary gives up and the backup is
   * tried. Checking once at the top would let exactly that message go out.
   *
   * The rule is therefore the one the policy states: before EVERY provider call, not
   * once per attempt. It is cheap — a date comparison — and it is the last line of
   * defence. The retry ladder is supposed to keep a perishable message inside its own
   * lifetime, but a ladder is a schedule and schedules slip: a worker parked behind a
   * long backlog, a reclaimed message from a crashed process, or simply a future edit
   * to the wrong array. This check does not care why the message is late.
   */
  private async refuseIfExpired(job: MailJob, attempt: number): Promise<SendOutcome | null> {
    if (job.validUntil === undefined) return null;

    const deadline = Date.parse(job.validUntil);
    // An unparseable deadline is a bug in the producer, not a licence to send
    // forever. Treated as absent so the message still goes, and logged loudly.
    if (Number.isNaN(deadline)) {
      this.logger.error(
        { jobId: job.id, validUntil: job.validUntil },
        'mail job has an unreadable validUntil; delivering without an expiry check',
      );
      return null;
    }

    const overdueMs = Date.now() - deadline;
    if (overdueMs <= 0) return null;

    const detail = `content expired ${Math.round(overdueMs / 1000)}s ago`;
    this.logger.warn(
      { jobId: job.id, kind: job.kind, attempt, to: job.body.to, overdueMs },
      'mail NOT SENT — the code it carries had already expired, so delivering it would ' +
        'hand the recipient a code that cannot work',
    );
    await this.record(job, attempt, 'EXPIRED', null, detail);
    return { status: 'expired', detail };
  }

  private async attemptDelivery(job: MailJob, attempt: number): Promise<SendOutcome> {
    const stale = await this.refuseIfExpired(job, attempt);
    if (stale !== null) return stale;

    if (this.transporter === null) {
      // The console transport prints the code. config.ts refuses to boot with this
      // selected in production, because that is precisely a credential in the log.
      this.logger.warn(
        { to: job.body.to, subject: job.body.subject, body: job.body.text },
        'mail NOT SENT (console transport) — code printed above',
      );
      await this.record(job, attempt, 'SKIPPED', null, 'console transport');
      return { status: 'skipped', detail: 'console transport' };
    }

    const primary = await this.tryRelay(this.transporter, 'primary', job, attempt);
    if (primary.status !== 'unreachable') return primary;

    if (this.backup === null) return primary;

    // The second provider call, and therefore the second check. The primary may have
    // just spent up to twenty seconds timing out.
    const staleAfterPrimary = await this.refuseIfExpired(job, attempt);
    if (staleAfterPrimary !== null) return staleAfterPrimary;

    this.logger.warn({ to: job.body.to }, 'primary SMTP unreachable — falling back to backup');
    return this.tryRelay(this.backup, 'backup', job, attempt);
  }

  /** One relay, one message. */
  private async tryRelay(
    transport: Transporter,
    which: string,
    job: MailJob,
    attempt: number,
  ): Promise<SendOutcome> {
    const { body } = job;
    this.logger.debug({ to: body.to, subject: body.subject, which, attempt }, 'mail dispatching');

    try {
      const info = await transport.sendMail({
        from: config.SMTP_FROM,
        to: body.to,
        subject: body.subject,
        text: body.text,
        html: body.html,
      });

      // `accepted` / `rejected` are the SMTP server's own verdict per recipient, and
      // `response` is its literal reply line. This is the difference between "we
      // handed it over successfully" and "we tried" — and when the recipient still
      // sees nothing, a 250 here is what tells you to go looking at spam filing
      // rather than at this code.
      this.logger.log(
        {
          jobId: job.id,
          attempt,
          to: body.to,
          subject: body.subject,
          which,
          messageId: info.messageId,
          accepted: info.accepted,
          rejected: info.rejected,
          response: info.response,
        },
        'mail accepted by SMTP server',
      );

      const detail = String(info.response ?? '');

      // Accepted the connection but refused this recipient — a success from
      // `sendMail`'s point of view that delivers nothing.
      if (Array.isArray(info.rejected) && info.rejected.length > 0) {
        this.logger.error(
          { jobId: job.id, to: body.to, rejected: info.rejected, response: detail, which },
          'mail REJECTED for one or more recipients — not delivered, and not retryable',
        );
        await this.record(job, attempt, 'REJECTED', which, detail);
        return { status: 'rejected', detail };
      }

      await this.record(job, attempt, 'SENT', which, detail, info.messageId);
      return { status: 'sent', detail };
    } catch (err) {
      const described = describeSmtpError(err);
      const detail = JSON.stringify(described);

      this.logger.error(
        { jobId: job.id, attempt, to: body.to, which, err: described },
        'mail send FAILED — will be retried if attempts remain',
      );
      await this.record(job, attempt, 'FAILED', which, detail);
      return { status: 'unreachable', detail };
    }
  }

  private async verifyOne(transport: Transporter, which: string): Promise<void> {
    try {
      await transport.verify();
      this.logger.log(`SMTP verify OK (${which}) — host reachable and credentials accepted`);
    } catch (err) {
      this.logger.error(
        { err: describeSmtpError(err) },
        `SMTP verify FAILED (${which}) — mail will not be delivered through it until this is fixed`,
      );
    }
  }

  /**
   * Persist the outcome of one attempt.
   *
   * One row per ATTEMPT, not per message, and `jobId` is what ties them together. So
   * "the user says the code never arrived" is answerable as a history — queued at
   * this time, failed twice against the primary, delivered on the third attempt via
   * the backup — rather than as a single final state that hides the retries.
   *
   * Never throws. A delivery record failing to write must not turn a sent email into
   * a retried one, which would mean a duplicate for the sake of bookkeeping.
   */
  private async record(
    job: MailJob,
    attempt: number,
    status: 'SENT' | 'REJECTED' | 'FAILED' | 'SKIPPED' | 'EXPIRED',
    transport: string | null,
    response: string,
    messageId?: string,
  ): Promise<void> {
    try {
      await this.deliveries.record({
        jobId: job.id,
        attempt,
        recipient: job.body.to,
        kind: job.kind,
        // Both, on purpose. `MailDbOperation.record` persists neither verbatim — it
        // derives a code-free subject from them, because the one-time-code templates
        // lead their real subject with the live code and this table keeps rows
        // forever. See `safeAuditSubject`.
        subject: job.body.subject,
        auditSubject: job.body.auditSubject,
        status,
        transport,
        messageId: messageId ?? null,
        response: response.slice(0, 500),
      });
    } catch (err) {
      this.logger.error({ err, jobId: job.id }, 'mail delivery record failed');
    }
  }
}

/**
 * Pull the fields that actually identify an SMTP failure out of the error.
 *
 * A raw nodemailer error stringifies to a one-line message that usually omits the
 * useful part. `responseCode` and `response` carry the server's own words — a 535
 * with "Username and Password not accepted" is a wrong app password, a 553 is a
 * refused sender, an `ETIMEDOUT` with no response at all is a blocked port.
 */
function describeSmtpError(err: unknown): Record<string, unknown> {
  if (typeof err !== 'object' || err === null) return { message: String(err) };
  const e = err as Record<string, unknown>;
  return {
    name: e['name'],
    message: e['message'],
    /** Nodemailer/Node socket class, e.g. EAUTH, ESOCKET, ETIMEDOUT, EENVELOPE. */
    code: e['code'],
    /** The SMTP verb that failed, e.g. AUTH, MAIL FROM, RCPT TO. */
    command: e['command'],
    responseCode: e['responseCode'],
    response: e['response'],
  };
}
