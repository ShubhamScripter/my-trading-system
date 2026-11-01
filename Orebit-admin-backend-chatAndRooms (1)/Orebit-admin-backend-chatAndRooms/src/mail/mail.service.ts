import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';
import { loginOtpEmail, securityChangedEmail } from './mail.templates';

export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * Whether the message reached the SMTP server, and if not, whose fault that was.
 *
 * A return value rather than a thrown error, because both callers need to keep
 * going either way — the login attempt row must exist even when the mail did not
 * leave. What changes is only the ACCOUNTING: a code that was never sent must not
 * spend the admin's send budget or start their resend cooldown. Without this,
 * an SMTP outage becomes a self-inflicted lockout that outlasts the outage.
 *
 * ─── Why three values and not two ───────────────────────────────────────────
 *
 * This was `'sent' | 'failed'`, which collapsed a refused RECIPIENT and an
 * unreachable RELAY into one answer. They need different handling in two places,
 * and neither is expressible without the split:
 *
 *  - failover. A 550 for a mailbox that does not exist will be a 550 on the second
 *    relay too, so a rejection must not be retried elsewhere. Only `'unreachable'`
 *    falls through to the backup.
 *  - the send budget. `LoginService` refunds the per-account bucket when no relay
 *    would take the message, because that failure is ours. A rejected recipient is
 *    not ours, and refunding it would hand an admin with a permanently bad address
 *    unlimited free sends.
 */
/**
 * Connection-pool sizing.
 *
 * Beside the transport rather than in auth.constants.ts, which is where the
 * security limits live — nobody changes these in response to a risk review.
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

export type MailOutcome =
  /** Handed to a relay that accepted it, with no recipient rejected. Does NOT mean
   *  delivered — nothing this side of the wire can promise that. */
  | 'sent'
  /** A relay answered and refused this recipient. Terminal: retrying, here or on
   *  another relay, will not change the answer. */
  | 'rejected'
  /** No relay would take it — connection, timeout, or authentication. Ours to own,
   *  and the case the backup relay and the budget refund both exist for. */
  | 'unreachable';

/**
 * Outbound email.
 *
 * No send ever throws: a failure is logged and reported as a `MailOutcome`, never
 * propagated. That is deliberate. If SMTP is down, the password step must still
 * create the login attempt and set its step-up cookie — the admin can then hit
 * resend, and the flow is recoverable. Failing the request instead would leave an
 * attempt the client has no way back into, which is worse than a missing email.
 *
 * The API still never reports "we sent it" to the CLIENT — it reports "we tried",
 * which is all it can honestly promise, and the response shape is identical either
 * way so a caller cannot use it to probe whether an address exists.
 *
 * But the caller INSIDE this service does learn, and that distinction is the whole
 * point of the outcome. Swallowing the failure entirely meant the resend cooldown
 * started and the send counter advanced for a code that never left the process —
 * so an admin retrying during an SMTP outage burned their own budget on nothing,
 * and stayed locked out after the outage was fixed. The emailed code is a MANDATORY
 * second factor here, not a passwordless convenience, so that lockout is total:
 * there is no path past `PASSWORD_VERIFIED` without it. Since the password-recovery
 * flow was removed there is no second way in at all, which is what the backup relay
 * below exists to answer.
 *
 * ─── Two relays ────────────────────────────────────────────────────────────
 *
 * `send` tries the primary and falls through to `SMTP_BACKUP_HOST` when the primary
 * is unreachable. Off unless configured; see `config.smtpBackupEnabled`. What it
 * buys is that one relay's outage is no longer one service's outage — and given that
 * every admin sign-in needs an emailed code, those were the same thing.
 *
 * ─── On the logging in here ────────────────────────────────────────────────
 *
 * It is deliberately verbose, because "the code never arrived" has at least four
 * distinct causes that look identical from outside: the console transport was
 * selected, the connection failed, the server rejected the recipient, or the
 * server accepted it and the mail was filed somewhere the recipient did not look.
 * Only the last one is not a bug, and telling them apart needs the SMTP server's
 * own answer — so `accepted`, `rejected` and the raw `response` are logged on
 * every send rather than a bare "sent".
 *
 * With `LOG_LEVEL=debug` the full SMTP conversation is logged too, via
 * nodemailer's own logger.
 *
 * ─── Who calls this, and from where ────────────────────────────────────────
 *
 * `sendLoginOtp` is now called by `OtpQueueService`'s WORKER, not from inside a
 * request. That is what closed the debt this docblock used to record as pending: the
 * send was synchronous, so a slow relay held an admin's sign-in open for up to 35
 * seconds and a process restart mid-send lost the message with no second copy
 * anywhere. `redis-durable` in docker-compose now has the worker it was waiting for.
 *
 * `sendSecurityChanged` is still synchronous and inside the request, deliberately.
 * There is no budget attached to a notification and no retry story worth building for
 * one; queuing it would add a moving part to a path whose failure costs nothing but a
 * missing courtesy email.
 *
 * The timeouts and the drain below therefore protect the WORKER now rather than a
 * request. They are unchanged: a bounded send is still what stops one dead relay from
 * occupying a worker indefinitely, and losing that race now costs a retry rather than
 * the message, because the queue holds the copy this class never had.
 */
@Injectable()
export class MailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Mail');
  private readonly transporter: Transporter | null;
  /** The second relay, or null when none is configured. See `send`. */
  private readonly backup: Transporter | null;
  /** True when nodemailer should dump the SMTP dialogue itself. */
  private readonly verbose: boolean;
  /** The send currently on the wire, so shutdown can wait for it. */
  private inFlight: Promise<unknown> | null = null;

  constructor() {
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
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
      // Without these a dead host hangs the HTTP request until the OS gives up.
      // They also bound the failover: an unreachable primary costs this much before
      // the backup is tried, and the send is inside the request.
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,

      // ─── Pooling ──────────────────────────────────────────────────────────
      //
      // Reuse sockets between messages rather than paying TCP + TLS + AUTH on every
      // send. Unpooled, each sign-in code opened a fresh connection and a burst of
      // admins signing in at once opened one apiece — the shape relays throttle and
      // then refuse, which on this service means nobody can sign in.
      //
      // This does NOT make the send asynchronous: it is still inside the request,
      // and a slow relay still holds the HTTP call open. What it removes is the
      // handshake, not the wait. The durable queue is the answer to the wait.
      pool: true,
      maxConnections: POOL.MAX_CONNECTIONS,
      maxMessages: POOL.MAX_MESSAGES,

      // ─── SSRF and local-file hardening ────────────────────────────────────
      //
      // Nodemailer will, by default, resolve an attachment or an embedded resource
      // given as `{ path: '/etc/passwd' }` or `{ path: 'http://169.254.169.254/...' }`
      // and put the result in the delivered message. That turns any path where an
      // attacker influences message content into arbitrary local-file read and a
      // full-response SSRF — with the answer exfiltrated by email.
      //
      // Nothing in mail.templates.ts uses attachments or remote content, so this
      // costs nothing today. It is set because "no current call site does that" is a
      // property of today's code rather than of the transport.
      disableFileAccess: true,
      disableUrlAccess: true,

      logger: this.verbose,
      debug: this.verbose,
    };

    // The resolved configuration, so a wrong host or a missing credential is
    // visible without reading .env. The password is never logged — only whether
    // one is present and how long it is, which is enough to catch the two real
    // mistakes: an empty value, or a Gmail app password pasted with its spaces
    // still in (16 characters, no spaces, is correct).
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
      },
      'SMTP transport configured',
    );

    this.transporter = nodemailer.createTransport(options);

    // Spread the primary's options and override only the relay coordinates, so the
    // backup inherits the same timeouts and the same hardening. Listing them again
    // is how the two drift apart, and the one that drifts is the one nobody
    // exercises until the primary is already down.
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
      {
        configured: this.backup !== null,
        host: config.SMTP_BACKUP_HOST || '(none)',
        port: config.SMTP_BACKUP_PORT,
        user: config.SMTP_BACKUP_USER || '(none)',
      },
      'SMTP backup transport',
    );
  }

  /**
   * Say out loud, at boot, whether email actually leaves this process.
   *
   * Credentials are verified eagerly rather than on first use, so a bad password
   * surfaces at startup instead of inside a sign-in nobody is watching. That
   * matters more here than in the consumer backend: an admin who cannot receive
   * the email OTP cannot complete step two, and therefore cannot sign in at all.
   *
   * Non-fatal on purpose: a mail server that is down must not stop the API
   * booting. Loud, not fatal.
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
   * Let the current send finish, then close the pools.
   *
   * A pooled transport holds sockets open, so without `close()` the process keeps a
   * handle to the relay and does not exit on its own — which turns a deploy into a
   * hung container that the orchestrator eventually kills.
   *
   * The drain is bounded and losing the race genuinely loses the message: this send
   * is inside the request and there is no queue holding a copy. That is the honest
   * cost of a synchronous send, and it is what the durable worker would remove.
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

  private async verifyOne(transport: Transporter, which: string): Promise<void> {
    try {
      await transport.verify();
      this.logger.log({ relay: which }, 'SMTP verify OK — host reachable and credentials accepted');
    } catch (err) {
      this.logger.error(
        { relay: which, err: describeSmtpError(err) },
        which === 'primary'
          ? 'SMTP verify FAILED — admins will not be able to complete sign-in unless the backup relay takes over'
          : 'SMTP BACKUP verify FAILED — there is no second relay to fall back to',
      );
    }
  }

  /**
   * The sign-in code, sent after a correct password.
   *
   * Returns the outcome, and the caller is expected to USE it: `LoginService` only
   * charges the send budget and starts the resend cooldown once this says `'sent'`.
   */
  async sendLoginOtp(to: string, code: string, minutesValid: number): Promise<MailOutcome> {
    return this.send(loginOtpEmail(to, code, minutesValid));
  }

  /**
   * Notify that a security-relevant change happened. Never a challenge — there is
   * nothing to click. It exists so an attacker who reaches enrollment cannot do it
   * silently.
   *
   * Returns an outcome for symmetry, but no caller acts on it: there is no budget
   * attached to a notification, and failing the request that triggered it would
   * undo a security change because we could not announce it.
   */
  async sendSecurityChanged(to: string, change: string): Promise<MailOutcome> {
    return this.send(securityChangedEmail(to, change, new Date()));
  }

  /**
   * Try the primary relay, then the backup.
   *
   * Failover covers the case that actually happens — one relay refusing connections,
   * timing out, or rejecting our credentials — and deliberately NOT the case where
   * the RECIPIENT is rejected: a 550 for a mailbox that does not exist will be a 550
   * on the second relay too. Retrying that elsewhere delivers nothing and spends our
   * sending reputation twice for it.
   */
  private async send(mail: Mail): Promise<MailOutcome> {
    const run = this.attemptDelivery(mail);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  private async attemptDelivery(mail: Mail): Promise<MailOutcome> {
    if (this.transporter === null) {
      // The console transport prints the code. config.ts refuses to boot with
      // this selected in production, because that is precisely a credential in
      // the log.
      this.logger.warn(
        { to: mail.to, subject: mail.subject, body: mail.text },
        'mail NOT SENT (console transport) — code printed above',
      );
      // `'sent'`, despite the message above. The code DID reach its intended
      // reader — the developer watching this log — so development must exercise the
      // same cooldown and budget accounting production does. Reporting `'failed'`
      // here would make every local resend free and hide the very behaviour the
      // outcome exists to drive.
      return 'sent';
    }

    const primary = await this.tryRelay(this.transporter, 'primary', mail);
    if (primary !== 'unreachable') return primary;

    if (this.backup === null) return primary;

    this.logger.warn(
      { to: mail.to, subject: mail.subject },
      'primary SMTP unreachable — falling back to backup relay',
    );
    return this.tryRelay(this.backup, 'backup', mail);
  }

  /** One relay, one message. */
  private async tryRelay(
    transport: Transporter,
    which: string,
    mail: Mail,
  ): Promise<MailOutcome> {
    this.logger.debug(
      { to: mail.to, from: config.SMTP_FROM, subject: mail.subject, relay: which },
      'mail dispatching',
    );

    try {
      const info = await transport.sendMail({
        from: config.SMTP_FROM,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });

      // `accepted` / `rejected` are the SMTP server's own verdict per recipient,
      // and `response` is its literal reply line (e.g. "250 2.0.0 OK ..."). This
      // is the difference between "we handed it over successfully" and "we tried"
      // — and when the recipient still sees nothing, a 250 here is what tells you
      // to go looking at spam filing rather than at this code.
      this.logger.log(
        {
          to: mail.to,
          from: config.SMTP_FROM,
          subject: mail.subject,
          relay: which,
          messageId: info.messageId,
          accepted: info.accepted,
          rejected: info.rejected,
          response: info.response,
          envelope: info.envelope,
        },
        'mail accepted by SMTP server',
      );

      // Accepted the connection but refused this recipient — a success from
      // `sendMail`'s point of view that delivers nothing.
      //
      // `'rejected'` rather than `'unreachable'`, and the difference is load-bearing
      // in both directions: this does not fail over to the backup, because the
      // second relay will say 550 to the same dead mailbox; and it does not refund
      // the admin's send budget, because the address being unusable is not an
      // outage on our side.
      if (Array.isArray(info.rejected) && info.rejected.length > 0) {
        this.logger.error(
          { to: mail.to, relay: which, rejected: info.rejected, response: info.response },
          'mail REJECTED for one or more recipients — not delivered, and not retried elsewhere',
        );
        return 'rejected';
      }

      return 'sent';
    } catch (err) {
      // Still swallowed rather than rethrown — see the class docblock: the login
      // attempt row must exist even when the mail did not leave, or the client is
      // left holding a step-up cookie for an attempt it cannot resume.
      //
      // What the outcome adds is that the caller now LEARNS about it, so it can
      // decline to charge a budget for a code nobody received.
      //
      // Connection, timeout and authentication all land here and all become
      // `'unreachable'`. They are not told apart because nothing acts on the
      // difference — all three mean "this relay would not take it", which is exactly
      // the condition the backup exists for and the condition the budget refund
      // exists for. `describeSmtpError` keeps the distinction in the LOG, which is
      // where an operator needs it.
      this.logger.error(
        { to: mail.to, subject: mail.subject, relay: which, err: describeSmtpError(err) },
        'mail send FAILED — this relay would not take the message',
      );
      return 'unreachable';
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
