import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailSender } from '../../src/mail/mail.sender';
import type { MailDbOperation } from '../../src/mail/mail.dboperation';
import type { MailJob } from '../../src/mail/mail.types';

/**
 * ═══ THE EXPIRY GUARD ═══════════════════════════════════════════════════════
 *
 * The bug these tests pin down, in the words it was reported in: "only 1 otp is
 * being generated and being resent again and again, even after its expiry of 10
 * minutes".
 *
 * Only the second half was the mail system's doing, and it was the whole of the
 * visible symptom. A queued message stores its RENDERED body, so every retry mails
 * the identical six digits — correct, and the point of storing it. What was missing
 * was any notion that those digits stop working: the retry ladder ran to ~17m35s
 * against a code that dies at 10m, so the last attempts posted a code the recipient
 * could not use. One code, arriving repeatedly, the tail of it useless.
 *
 * `MailJob.validUntil` plus this guard is the fix. The ladder change keeps a
 * perishable message inside its own lifetime; this is the check that holds even when
 * the ladder does not — a reclaimed message from a crashed worker, a long backlog, or
 * a future edit to the wrong array.
 *
 * ─── Why the console transport is the right harness ─────────────────────────
 *
 * `MAIL_TRANSPORT=console` in tests/setup.ts, so `MailSender` builds no transporter
 * and `send` would normally return `skipped`. The expiry check runs BEFORE that
 * branch, so `expired` rather than `skipped` is proof the guard fired first — no
 * nodemailer double required.
 */

const TEN_MINUTES_MS = 10 * 60 * 1_000;

function makeJob(overrides: Partial<MailJob> = {}): MailJob {
  return {
    id: '0194c0de-0000-7000-8000-00000000000a',
    kind: 'otp',
    body: { to: 'ada@example.test', subject: 'Your code', text: '123456', html: '<p>123456</p>' },
    undo: [],
    attempts: 0,
    queuedAt: new Date().toISOString(),
    ...overrides,
  };
}

let deliveries: { record: ReturnType<typeof vi.fn>; attemptsFor: ReturnType<typeof vi.fn> };
let sender: MailSender;

beforeEach(() => {
  deliveries = { record: vi.fn().mockResolvedValue(undefined), attemptsFor: vi.fn() };
  sender = new MailSender(deliveries as unknown as MailDbOperation);
});

/** The status written to `mail_deliveries` for the single recorded attempt. */
function recordedStatus(): string | undefined {
  return (deliveries.record.mock.calls[0]?.[0] as { status?: string } | undefined)?.status;
}

describe('a message whose content has expired is not sent', () => {
  it('refuses a code that died before the attempt', async () => {
    const job = makeJob({ validUntil: new Date(Date.now() - 1_000).toISOString() });

    const outcome = await sender.send(job, 1);

    // `expired`, not `skipped`: the guard ran before the transport was even consulted.
    expect(outcome.status).toBe('expired');
  });

  it('records the refusal as its own status, not as a delivery failure', async () => {
    // FAILED would mean a relay would not take it and the user is owed an
    // explanation. EXPIRED means we declined to post something already dead — the
    // system working. Folding them together would make the bounce-rate metric climb
    // every time the guard did its job.
    await sender.send(makeJob({ validUntil: new Date(Date.now() - 1_000).toISOString() }), 1);

    expect(recordedStatus()).toBe('EXPIRED');
  });

  it('says how late it was, so a mistuned ladder is diagnosable', async () => {
    await sender.send(makeJob({ validUntil: new Date(Date.now() - 90_000).toISOString() }), 1);

    const detail = (deliveries.record.mock.calls[0]?.[0] as { response?: string }).response;
    expect(detail).toMatch(/expired 9\ds ago/);
  });

  it('refuses on a later attempt too, not just the first', async () => {
    // The realistic shape of the bug: attempts 1-3 land inside the code's life and
    // fail on a dead relay, and the relay recovers only after the code has expired.
    const job = makeJob({
      attempts: 3,
      validUntil: new Date(Date.now() - 30_000).toISOString(),
    });

    expect((await sender.send(job, 4)).status).toBe('expired');
  });
});

describe('a message whose content is still good is sent', () => {
  it('delivers a code that is still live', async () => {
    const job = makeJob({ validUntil: new Date(Date.now() + TEN_MINUTES_MS).toISOString() });

    // `skipped` is the console transport's answer — it got past the guard.
    expect((await sender.send(job, 1)).status).toBe('skipped');
    expect(recordedStatus()).toBe('SKIPPED');
  });

  it('delivers mail that carries no deadline at all', async () => {
    // A welcome or a security notification never goes stale, so it must not acquire
    // an expiry by accident.
    expect((await sender.send(makeJob({ kind: 'welcome' }), 1)).status).toBe('skipped');
  });

  it('delivers, loudly, when the deadline is unreadable', async () => {
    // A malformed `validUntil` is a producer bug. Refusing would silently stop mail
    // for whichever path introduced it; sending is the recoverable direction, and the
    // error log is what makes it findable.
    const job = makeJob({ validUntil: 'not-a-date' });

    expect((await sender.send(job, 1)).status).toBe('skipped');
  });

  it('sends a code that expires in one second', async () => {
    // The boundary is "already past", not "nearly past". Refusing a live code because
    // it is nearly dead would throw away deliveries that would have arrived in time.
    const job = makeJob({ validUntil: new Date(Date.now() + 1_000).toISOString() });

    expect((await sender.send(job, 1)).status).toBe('skipped');
  });
});

describe('the deadline is rechecked before the BACKUP relay', () => {
  /**
   * The case a single check at the top of the attempt would miss.
   *
   * One "attempt" can contain two provider calls. The primary's `socketTimeout` is
   * twenty seconds and `connectionTimeout` fifteen, and the message may have queued
   * behind others for a pooled connection first. So a code with thirty seconds of
   * life left can be valid when the attempt begins and dead by the time the primary
   * gives up — and the failover would post it anyway.
   */
  function withTransports(primary: unknown, backup: unknown): MailSender {
    const built = new MailSender(deliveries as unknown as MailDbOperation);
    // The transports are private and built from config in the constructor; there is
    // no seam for injecting them, and adding one purely for a test would be a worse
    // trade than reaching in here.
    Object.defineProperty(built, 'transporter', { value: primary, writable: true });
    Object.defineProperty(built, 'backup', { value: backup, writable: true });
    return built;
  }

  it('does not fall back to the backup with a code that died during the primary call', async () => {
    const backupSend = vi.fn();
    const slowFailingPrimary = {
      sendMail: vi.fn(async () => {
        // Stand in for the socket timeout: the code expires while this is in flight.
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
      }),
    };

    const built = withTransports(slowFailingPrimary, { sendMail: backupSend });
    const job = makeJob({ validUntil: new Date(Date.now() + 15).toISOString() });

    const outcome = await built.send(job, 1);

    expect(slowFailingPrimary.sendMail).toHaveBeenCalledOnce();
    // The assertion that matters: the backup was never dialled.
    expect(backupSend).not.toHaveBeenCalled();
    expect(outcome.status).toBe('expired');
  });

  it('still falls back to the backup while the code is alive', async () => {
    // The guard must not have broken failover for the case it was built for.
    const backupSend = vi.fn().mockResolvedValue({ messageId: 'ok', accepted: ['a@b.test'], rejected: [], response: '250 OK' });
    const failingPrimary = {
      sendMail: vi.fn().mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    };

    const built = withTransports(failingPrimary, { sendMail: backupSend });
    const job = makeJob({ validUntil: new Date(Date.now() + TEN_MINUTES_MS).toISOString() });

    const outcome = await built.send(job, 1);

    expect(backupSend).toHaveBeenCalledOnce();
    expect(outcome.status).toBe('sent');
  });
});
