import { Injectable, Logger } from '@nestjs/common';
import type { MailDelivery, MailDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../utils/public.utils';
import { SECRET_SUBJECT_KINDS } from './mail.constants';

/**
 * What replaces a run of digits the last-resort guard will not persist. Not the
 * secret's own length — a placeholder that leaked "it was six digits" would be a
 * smaller leak rather than none.
 */
export const AUDIT_SUBJECT_REDACTED = '[redacted]';

/** `subject` is `@db.VarChar(256)`. Truncating here rather than letting Postgres
 *  reject the insert, because a failed audit write must not fail a sent email. */
const AUDIT_SUBJECT_MAX = 256;

/**
 * A run of digits long enough to be a one-time code rather than a year or a count.
 *
 * Six, because that is what every numeric authentication secret in this codebase
 * actually is: `generateOtp` is `randomDigits(OTP.LENGTH)` with `OTP.LENGTH = 6`, used
 * for the sign-in code, the credential-change code and the password reset code alike,
 * and a TOTP is six digits too. Nothing shorter is a secret here.
 *
 * The threshold is what keeps this from being the blanket digit-stripping it must not
 * be. Four would eat a year (`... for 2026`), five a postcode or an amount. Six matches
 * none of the eight subjects this service renders today — five are static text with no
 * digits at all, and the three that interpolate carry a prose description, a masked
 * address or an IP class.
 */
const CODE_RUN = /\d{6,}/g;

/**
 * ═══ THE SUBJECT THAT GETS PERSISTED ════════════════════════════════════════
 *
 * Derive the subject to write to `mail_deliveries` from the subject that was sent.
 *
 * Pure, and exported so the boundary can be tested as a boundary rather than only
 * through a delivery. `record` calls it on the way into every insert, which is what
 * makes it unavoidable: there is one function that writes this table, and it does not
 * offer a caller the option of persisting a raw subject.
 *
 * ─── The problem this closes ────────────────────────────────────────────────
 *
 * `otpEmail` and `passwordResetEmail` lead their subject with the live code, on
 * purpose — a reader scanning an inbox should see the digits without opening the
 * message. `mail_deliveries` has no retention policy and no TTL, so persisting that
 * subject built a permanent plaintext credential archive, indexed by recipient, in
 * which the most recent rows hold codes that still work.
 *
 * ─── Why this is the boundary and not the templates ────────────────────────
 *
 * Fixing the two templates fixes the two templates. The next authentication email
 * someone adds puts its own secret in a subject, the email looks right, the tests pass,
 * and the leak is silent and durable. So the rule is enforced where the writing
 * happens, and a template's cooperation is an improvement to the audit row rather than
 * the thing standing between a code and Postgres.
 *
 * ─── The three defences, in order ──────────────────────────────────────────
 *
 *   1. `auditSubject` — the body says what is safe to keep. Legible, specific, and the
 *      way a new secret-bearing template should declare itself.
 *
 *   2. `SECRET_SUBJECT_KINDS` — the kind says the subject carries a secret, for a body
 *      that never set the field. Covers messages queued before it existed (still being
 *      retried across the deploy) and a future edit that drops it.
 *
 *   3. `CODE_RUN` — neither of the above spoke, and the subject contains something
 *      shaped like a one-time code anyway. This is the case nobody declared, which is
 *      exactly the case worth catching, and it is also applied to the results of 1 and
 *      2 so that a careless `auditSubject` cannot reintroduce what it was added to
 *      prevent.
 *
 * Only 3 can act on a message nobody thought about, and only 1 and 2 produce a subject
 * a human would want to read. Hence all three.
 */
export function safeAuditSubject(input: {
  kind: string;
  /** The subject as sent to the relay. Read to DERIVE the audit value — never itself
   *  the thing persisted, unless it survives every check below unchanged. */
  subject: string;
  auditSubject?: string;
}): string {
  const declared = input.auditSubject?.trim();

  // An empty or whitespace `auditSubject` is a template bug, and taking it literally
  // would write a blank audit row. Treated as absent so defence 2 or 3 answers instead.
  const candidate =
    declared !== undefined && declared.length > 0
      ? declared
      : (SECRET_SUBJECT_KINDS.get(input.kind) ?? input.subject);

  return candidate.replace(CODE_RUN, AUDIT_SUBJECT_REDACTED).slice(0, AUDIT_SUBJECT_MAX);
}

/**
 * Persistence for `mail_deliveries` — gap M10.
 *
 * One method that inserts, and it is the only writer of this table. That is what lets
 * `safeAuditSubject` be a guarantee rather than a convention — see the note there.
 * The admin surface that reads it (delivered / failed / bounce rate) arrives with the
 * admin panel, and adding query methods now would leave them unused and untested
 * until then.
 */
@Injectable()
export class MailDbOperation {
  private readonly logger = new Logger('MailDb');

  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    /** The queue job, so the attempts at one message can be read as a sequence. */
    jobId: string;
    /** 1-based. Which try this was. */
    attempt: number;
    recipient: string;
    kind: string;
    /**
     * The subject as sent to the relay. NOT what gets stored: it is passed so
     * `safeAuditSubject` can derive a code-free value from it, and a caller cannot
     * bypass that by supplying this alone.
     */
    subject: string;
    /** The body's own code-free subject, when it declared one. */
    auditSubject?: string;
    status: MailDeliveryStatus;
    transport: string | null;
    messageId: string | null;
    response: string | null;
  }): Promise<void> {
    // Both inputs are dropped from the row here rather than merely overwritten. The
    // insert is built by spread, so leaving either in `row` would carry the raw subject
    // into `data` — and `auditSubject` is not a column at all.
    const { subject: _sent, auditSubject: _declared, ...row } = input;
    const subject = safeAuditSubject(input);
    const declared = input.auditSubject?.trim() ?? '';

    // The last-resort guard firing means a subject reached this table carrying
    // something code-shaped that no template and no kind declared — i.e. the leak this
    // boundary exists to stop, from a path nobody registered. Loud, because the fix is
    // in that template and nothing else will report it. Logs only the REDACTED value:
    // printing the raw subject here would move the credential from the table to the
    // log, which is the same finding in a different store.
    if (
      subject !== input.subject &&
      declared.length === 0 &&
      !SECRET_SUBJECT_KINDS.has(input.kind)
    ) {
      this.logger.error(
        { kind: input.kind, jobId: input.jobId, persisted: subject },
        'mail subject carried something code-shaped and was redacted before persisting — ' +
          'this template must set auditSubject, or be added to SECRET_SUBJECT_KINDS',
      );
    }

    await this.prisma.mailDelivery.create({ data: { id: uuidv7(), ...row, subject } });
  }

  /**
   * Every attempt at one message, oldest first.
   *
   * The read the retry loop made necessary. A single final status could not answer
   * "did we try, how many times, and which relay eventually took it" — and that is
   * the question a user reporting a missing code actually raises.
   */
  async attemptsFor(jobId: string): Promise<MailDelivery[]> {
    return this.prisma.mailDelivery.findMany({
      where: { jobId },
      orderBy: { attempt: 'asc' },
    });
  }
}
