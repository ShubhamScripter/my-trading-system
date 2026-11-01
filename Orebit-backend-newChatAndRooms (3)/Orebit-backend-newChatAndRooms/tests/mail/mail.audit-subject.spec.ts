import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../db/client';
import { MailDbOperation, safeAuditSubject } from '../../src/mail/mail.dboperation';
import { MailSender } from '../../src/mail/mail.sender';
import { MailService } from '../../src/mail/mail.service';
import type { MailJob } from '../../src/mail/mail.types';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * One finding: the live one-time code was being persisted, in plaintext, to a table
 * with no retention policy.
 *
 * `otpEmail` and `passwordResetEmail` lead their SUBJECT with the code, deliberately —
 * a reader scanning an inbox should see the digits without opening the message. The
 * audit path then wrote that subject to `mail_deliveries.subject`, which is durable
 * storage indexed by `(recipient, created_at)`. So the table whose purpose is
 * "did this message arrive" became a permanent archive of plaintext credentials, in
 * which a row written in the last ten minutes holds a code that still works. Database
 * access, a replica, a backup or a support tool reading the audit trail read live
 * credentials.
 *
 * Two properties have to hold together, and neither is interesting without the other:
 *
 *   THE EMAIL IS UNCHANGED.  The subject, text and html handed to the relay are byte
 *   for byte what they were. A fix that quietly rewrote the subject would have
 *   "solved" this by degrading every OTP email in production.
 *
 *   THE ROW IS CODE-FREE.  Whatever reaches Postgres cannot contain the secret.
 *
 * ─── Why the boundary is tested as a boundary ───────────────────────────────
 *
 * The fix is not "the two known templates now behave". It is that
 * `MailDbOperation.record` — the only writer of this table — derives what it persists
 * and offers no caller the option of storing a raw subject. So the last describe block
 * drives kinds that do not exist, with no template's cooperation at all: that is the
 * future authentication email this boundary is for, and the one thing a
 * template-level fix could never cover.
 *
 * ─── On secrets in test output ──────────────────────────────────────────────
 *
 * The codes below are literals in a spec file, not live credentials. The assertions
 * are still written as `not.toContain` against a named constant rather than by
 * printing what was persisted, and one test pins that the boundary's own alarm log
 * carries the redacted subject and never the raw one — moving the credential from the
 * table into the log would be the same finding in a different store.
 */

/** Shaped like `generateOtp()` — `randomDigits(OTP.LENGTH)`, six digits. */
const OTP = '123456';
const RESET_CODE = '884211';
const TO = 'ada@example.test';
const ANTI_PHISHING = 'Ada1815';
const TEN_MINUTES = 600_000;

// ─── the persistence boundary, on its own ─────────────────────────────────────

describe('safeAuditSubject — the derivation', () => {
  it('prefers the code-free subject the body declared', () => {
    expect(
      safeAuditSubject({
        kind: 'otp',
        subject: `${OTP} is your OREBiT verification code`,
        auditSubject: 'Your OREBiT verification code',
      }),
    ).toBe('Your OREBiT verification code');
  });

  it('falls back to the kind when the body declared nothing', () => {
    // A message queued BEFORE `auditSubject` existed looks exactly like this, and
    // those are still in Redis being retried across the deploy that adds the field.
    expect(
      safeAuditSubject({ kind: 'otp', subject: `${OTP} is your OREBiT verification code` }),
    ).toBe('Your OREBiT verification code');
  });

  it('falls back to the kind for password-reset too', () => {
    expect(
      safeAuditSubject({
        kind: 'password-reset',
        subject: `${RESET_CODE} is your OREBiT password reset code`,
      }),
    ).toBe('Your OREBiT password reset code');
  });

  it('treats a blank declaration as absent rather than storing an empty subject', () => {
    // Taking `'   '` literally would write a blank audit row and call it a success.
    expect(
      safeAuditSubject({
        kind: 'otp',
        subject: `${OTP} is your OREBiT verification code`,
        auditSubject: '   ',
      }),
    ).toBe('Your OREBiT verification code');
  });

  it('redacts a code-shaped run even out of a declared subject', () => {
    // Defence 3 applies to the results of 1 and 2, so a careless `auditSubject` cannot
    // reintroduce exactly what the field was added to prevent.
    const persisted = safeAuditSubject({
      kind: 'otp',
      subject: `${OTP} is your OREBiT verification code`,
      auditSubject: `Your code ${OTP}`,
    });

    expect(persisted).not.toContain(OTP);
    expect(persisted).toBe('Your code [redacted]');
  });

  it('truncates to the column width instead of letting the insert fail', () => {
    // `subject` is VarChar(256). A rejected insert would turn a sent email into a
    // retried one — a duplicate for the sake of bookkeeping.
    const persisted = safeAuditSubject({ kind: 'welcome', subject: 'x'.repeat(400) });

    expect(persisted).toHaveLength(256);
  });
});

describe('safeAuditSubject — what it must NOT touch', () => {
  /**
   * The guard against over-reach. Blanket digit-stripping would have been the easy
   * implementation and the wrong one: it degrades every legitimate subject to buy
   * nothing, and it hides the leak rather than reporting it.
   *
   * Every subject this service actually renders is here. The threshold is six digits
   * because that is what a one-time code is (`OTP.LENGTH`), and none of these reach it.
   */
  it.each([
    ['welcome', 'Welcome to OREBiT'],
    ['security-changed', 'Your OREBiT password changed'],
    ['security-changed', 'Your OREBiT payment PIN changed'],
    ['email-changed', 'Your OREBiT email address was changed — did you do this?'],
    ['email-added', 'This is now your OREBiT email address'],
    ['email-removed', 'This address is no longer on an OREBiT account'],
    ['new-device-login', 'New sign-in to your OREBiT account'],
  ])('persists the real %s subject verbatim', (kind, subject) => {
    expect(safeAuditSubject({ kind, subject })).toBe(subject);
  });

  it.each([
    'Your OREBiT statement for 2026',
    'Your OREBiT account ends in 4821',
    'New sign-in from network 203.0.113.0/24',
    '3 devices were signed out of your OREBiT account',
  ])('leaves ordinary numbers in a subject alone: %s', (subject) => {
    // A year, a card suffix, an IP class and a count. None is a secret, and a fix that
    // ate them would make the audit trail worse for no security gain.
    expect(safeAuditSubject({ kind: 'notification', subject })).toBe(subject);
  });
});

// ─── the writer, which is the only writer ─────────────────────────────────────

describe('MailDbOperation.record — the enforcement point', () => {
  let create: ReturnType<typeof vi.fn>;
  let deliveries: MailDbOperation;

  const base = {
    jobId: '0194c0de-0000-7000-8000-00000000000a',
    attempt: 1,
    recipient: TO,
    status: 'SENT' as never,
    transport: 'primary',
    messageId: 'abc@relay',
    response: '250 OK',
  };

  /** The `subject` column as Postgres would receive it. */
  const persisted = (): string =>
    (create.mock.calls[0]?.[0] as { data: { subject: string } }).data.subject;

  beforeEach(() => {
    create = vi.fn().mockResolvedValue(undefined);
    deliveries = new MailDbOperation({ mailDelivery: { create } } as unknown as PrismaService);
  });

  it('does not write the live OTP, even when handed it', () => {
    // ═══ FINDING #1, AT THE POINT OF THE WRITE ════════════════════════════════
    void deliveries.record({
      ...base,
      kind: 'otp',
      subject: `${OTP} is your OREBiT verification code`,
      auditSubject: 'Your OREBiT verification code',
    });

    expect(persisted()).not.toContain(OTP);
    expect(persisted()).toBe('Your OREBiT verification code');
  });

  it('does not write the live reset code, even when handed it', () => {
    void deliveries.record({
      ...base,
      kind: 'password-reset',
      subject: `${RESET_CODE} is your OREBiT password reset code`,
      auditSubject: 'Your OREBiT password reset code',
    });

    expect(persisted()).not.toContain(RESET_CODE);
    expect(persisted()).toBe('Your OREBiT password reset code');
  });

  it('stores neither the sent subject nor the declaration as its own column', () => {
    // The row carries ONE subject, and it is the derived one. Leaving the raw value on
    // the insert — as an extra key, or by forgetting to drop it — would persist the
    // very thing this boundary removes.
    void deliveries.record({
      ...base,
      kind: 'otp',
      subject: `${OTP} is your OREBiT verification code`,
      auditSubject: 'Your OREBiT verification code',
    });

    const { data } = create.mock.calls[0]?.[0] as { data: Record<string, unknown> };

    expect(Object.keys(data)).not.toContain('auditSubject');
    expect(JSON.stringify(data)).not.toContain(OTP);
  });

  it('keeps an ordinary subject exactly as it was — the audit trail still works', () => {
    void deliveries.record({ ...base, kind: 'welcome', subject: 'Welcome to OREBiT' });

    expect(persisted()).toBe('Welcome to OREBiT');
  });

  it('still records every other field unchanged', () => {
    void deliveries.record({ ...base, kind: 'welcome', subject: 'Welcome to OREBiT' });

    const { data } = create.mock.calls[0]?.[0] as { data: Record<string, unknown> };

    expect(data).toMatchObject({
      jobId: base.jobId,
      attempt: 1,
      recipient: TO,
      kind: 'welcome',
      status: 'SENT',
      transport: 'primary',
      messageId: 'abc@relay',
      response: '250 OK',
    });
  });
});

// ─── the case a template-level fix could not reach ────────────────────────────

describe('a FUTURE authentication email that declares nothing', () => {
  /**
   * The reason the fix is here and not in `mail.templates.ts`.
   *
   * Patching the two known templates fixes the two known templates. The next
   * authentication email someone adds interpolates its own secret into a subject, the
   * email looks right, the tests pass, and the leak is silent and durable. These kinds
   * do not exist, set no `auditSubject`, and are absent from `SECRET_SUBJECT_KINDS` —
   * they have no cooperation with this fix whatsoever.
   */
  let create: ReturnType<typeof vi.fn>;
  let deliveries: MailDbOperation;

  const base = {
    jobId: '0194c0de-0000-7000-8000-00000000000b',
    attempt: 1,
    recipient: TO,
    status: 'SENT' as never,
    transport: 'primary',
    messageId: null,
    response: null,
  };

  const persisted = (): string =>
    (create.mock.calls[0]?.[0] as { data: { subject: string } }).data.subject;

  beforeEach(() => {
    create = vi.fn().mockResolvedValue(undefined);
    deliveries = new MailDbOperation({ mailDelivery: { create } } as unknown as PrismaService);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('cannot write its secret to the subject column', () => {
    void deliveries.record({
      ...base,
      kind: 'device-approval',
      subject: `Approve this device with code ${RESET_CODE}`,
    });

    expect(persisted()).not.toContain(RESET_CODE);
    expect(persisted()).toBe('Approve this device with code [redacted]');
  });

  it('reports itself, so the template gets fixed rather than the leak being papered over', () => {
    // Nothing else would notice: the email is unaffected and the row looks fine.
    void deliveries.record({
      ...base,
      kind: 'device-approval',
      subject: `Approve this device with code ${RESET_CODE}`,
    });

    expect(Logger.prototype.error).toHaveBeenCalledOnce();
  });

  it('does not move the secret from the table into the log', () => {
    void deliveries.record({
      ...base,
      kind: 'device-approval',
      subject: `Approve this device with code ${RESET_CODE}`,
    });

    // The alarm names the kind and the REDACTED subject. Logging the raw one would be
    // the same finding in a different store.
    expect(JSON.stringify(vi.mocked(Logger.prototype.error).mock.calls)).not.toContain(RESET_CODE);
  });

  it('stays quiet for a declared kind, which is not a mistake', () => {
    void deliveries.record({
      ...base,
      kind: 'otp',
      subject: `${OTP} is your OREBiT verification code`,
    });

    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });
});

// ─── template → sender → relay → row, with the real templates ─────────────────

describe('the whole path: the email is unchanged and the row is clean', () => {
  /**
   * The two properties asserted together, through the real templates and the real
   * sender. A fix that rewrote the subject would pass every test above and still be
   * wrong, because the thing being protected is an email a user has been told to
   * expect.
   */
  let jobs: MailJob[];
  let service: MailService;

  const flush = (): Promise<unknown> => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    jobs = [];
    service = new MailService(
      {
        enqueue: vi.fn(async (job: MailJob) => {
          jobs.push(job);
        }),
      } as never,
      { apply: vi.fn() } as never,
    );
  });

  /** Deliver a queued job through a doubled relay, and report both sides. */
  async function deliver(job: MailJob): Promise<{
    sent: { subject: string; text: string; html: string };
    row: string;
  }> {
    const sendMail = vi.fn().mockResolvedValue({
      messageId: 'id@relay',
      accepted: [job.body.to],
      rejected: [],
      response: '250 OK',
    });
    const create = vi.fn().mockResolvedValue(undefined);

    const sender = new MailSender(
      new MailDbOperation({ mailDelivery: { create } } as unknown as PrismaService),
    );
    // The transports are private and built from config in the constructor; the existing
    // sender spec reaches in the same way rather than adding a seam purely for a test.
    Object.defineProperty(sender, 'transporter', { value: { sendMail }, writable: true });
    Object.defineProperty(sender, 'backup', { value: null, writable: true });

    const outcome = await sender.send(job, 1);
    expect(outcome.status).toBe('sent');

    return {
      sent: sendMail.mock.calls[0]?.[0] as { subject: string; text: string; html: string },
      row: (create.mock.calls[0]?.[0] as { data: { subject: string } }).data.subject,
    };
  }

  it('otp: the user still gets the code in the subject line', async () => {
    await service.sendOtp(TO, OTP, new Date(Date.now() + TEN_MINUTES), [], ANTI_PHISHING);
    const { sent } = await deliver(jobs[0] as MailJob);

    // Byte for byte what this template has always produced.
    expect(sent.subject).toBe(`${OTP} is your OREBiT verification code`);
    expect(sent.text).toContain(`Your OREBiT verification code is ${OTP}.`);
    expect(sent.html).toContain(OTP);
    // And the anti-phishing footer is still stamped into both parts.
    expect(sent.text).toContain(ANTI_PHISHING);
    expect(sent.html).toContain(ANTI_PHISHING);
  });

  it('otp: the row keeps no trace of the code', async () => {
    await service.sendOtp(TO, OTP, new Date(Date.now() + TEN_MINUTES), [], ANTI_PHISHING);
    const { row } = await deliver(jobs[0] as MailJob);

    expect(row).not.toContain(OTP);
    expect(row).toBe('Your OREBiT verification code');
  });

  it('password-reset: the user still gets the code in the subject line', async () => {
    await service.sendPasswordReset(
      TO,
      RESET_CODE,
      new Date(Date.now() + TEN_MINUTES),
      [],
      ANTI_PHISHING,
    );
    const { sent } = await deliver(jobs[0] as MailJob);

    expect(sent.subject).toBe(`${RESET_CODE} is your OREBiT password reset code`);
    expect(sent.text).toContain(`Use ${RESET_CODE} to reset your OREBiT password.`);
    expect(sent.html).toContain(RESET_CODE);
  });

  it('password-reset: the row keeps no trace of the code', async () => {
    await service.sendPasswordReset(
      TO,
      RESET_CODE,
      new Date(Date.now() + TEN_MINUTES),
      [],
      ANTI_PHISHING,
    );
    const { row } = await deliver(jobs[0] as MailJob);

    expect(row).not.toContain(RESET_CODE);
    expect(row).toBe('Your OREBiT password reset code');
  });

  it('a code that survived a RETRY is still not persisted', async () => {
    // The body is rendered once and replayed on every attempt (mail.types.ts), so the
    // fourth attempt at a message carries the same six digits the first did. Each
    // attempt writes its own row, and each one has to be clean.
    await service.sendOtp(TO, OTP, new Date(Date.now() + TEN_MINUTES), [], ANTI_PHISHING);
    const { sent, row } = await deliver({ ...(jobs[0] as MailJob), attempts: 3 });

    expect(sent.subject).toContain(OTP);
    expect(row).not.toContain(OTP);
  });

  it('an ordinary notification is persisted with its real subject', async () => {
    // The regression that matters: six of the eight kinds carry no secret, and their
    // audit rows must be exactly as useful as they were.
    service.sendNewDeviceLogin(TO, 'Firefox on Windows', '203.0.113.0/24', ANTI_PHISHING);
    await flush();
    const { sent, row } = await deliver(jobs[0] as MailJob);

    expect(sent.subject).toBe('New sign-in to your OREBiT account');
    expect(row).toBe('New sign-in to your OREBiT account');
  });

  it('welcome mail is persisted with its real subject', async () => {
    service.sendWelcome(TO, 'ada_lovelace', 'OREBiT7Q9K2M4X');
    await flush();
    const { sent, row } = await deliver(jobs[0] as MailJob);

    expect(sent.subject).toBe('Welcome to OREBiT');
    expect(row).toBe('Welcome to OREBiT');
  });

  it('a legacy job queued before auditSubject existed is still clean', async () => {
    // Rendered by the old code and sitting in Redis across the deploy: the real subject,
    // and no `auditSubject` at all. Defence 2 answers for it.
    await service.sendOtp(TO, OTP, new Date(Date.now() + TEN_MINUTES), [], ANTI_PHISHING);
    const legacy = jobs[0] as MailJob;
    const { auditSubject: _dropped, ...body } = legacy.body;

    const { sent, row } = await deliver({ ...legacy, body });

    expect(sent.subject).toBe(`${OTP} is your OREBiT verification code`);
    expect(row).not.toContain(OTP);
    expect(row).toBe('Your OREBiT verification code');
  });
});
