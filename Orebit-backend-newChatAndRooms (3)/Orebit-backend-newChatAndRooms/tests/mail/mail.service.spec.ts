import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailService } from '../../src/mail/mail.service';
import type { MailJob } from '../../src/mail/mail.types';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * `MailService` had no coverage before this, and the thing worth covering is the one
 * decision it now makes: WHICH messages carry the anti-phishing code.
 *
 * That decision lives in `enqueue` — it is the only funnel all eight kinds pass
 * through, and the only place the rendered body and the `kind` exist together — so it
 * cannot be tested at the template level. `mail.templates.spec.ts` proves the transform
 * is correct; this file proves it is applied to exactly the right messages.
 *
 * Two exclusions are asserted as hard rules rather than as incidental behaviour:
 *
 *   `email-removed` goes to a mailbox that is no longer the account's and, in a
 *   takeover, is the attacker's. Stamping it would hand the code to precisely the party
 *   who would use it to forge mail the real owner trusts.
 *
 *   `welcome` is sent seconds after the account exists, when no code can have been set.
 *
 * The real templates and the real transform run here — only the queue is doubled — so
 * "the code reaches the message a user would receive" is genuinely asserted rather than
 * modelled.
 */

const TO = 'ada@example.test';
const CODE = 'Ada1815';
const IP_CLASS = '203.0.113.0/24';
const OTP = '123456';
const UNLINK_AT = new Date('2026-09-18T12:00:00.000Z');

describe('MailService — the anti-phishing gate', () => {
  let jobs: MailJob[];
  let queue: { enqueue: ReturnType<typeof vi.fn> };
  let service: MailService;

  /** Let the `void`-returning notifications finish their detached enqueue. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const only = (): MailJob => {
    expect(jobs).toHaveLength(1);
    return jobs[0] as MailJob;
  };

  /** Did the message a user would receive carry the code — in BOTH parts? */
  const stamped = (job: MailJob): boolean =>
    job.body.text.includes(CODE) && job.body.html.includes(CODE);

  beforeEach(() => {
    jobs = [];
    queue = {
      enqueue: vi.fn(async (job: MailJob) => {
        jobs.push(job);
      }),
    };
    service = new MailService(queue as never, { apply: vi.fn() } as never);
  });

  // ─── the kinds that carry it ──────────────────────────────────────────────

  describe('messages that DO carry the code', () => {
    it('stamps otp — the sign-in and credential-change code', async () => {
      await service.sendOtp(TO, OTP, new Date(Date.now() + 600_000), [], CODE);

      expect(only().kind).toBe('otp');
      expect(stamped(only())).toBe(true);
    });

    it('stamps password-reset', async () => {
      await service.sendPasswordReset(TO, OTP, new Date(Date.now() + 600_000), [], CODE);

      expect(only().kind).toBe('password-reset');
      expect(stamped(only())).toBe(true);
    });

    it('stamps security-changed', async () => {
      service.sendSecurityChanged(TO, 'password changed', IP_CLASS, CODE);
      await flush();

      expect(only().kind).toBe('security-changed');
      expect(stamped(only())).toBe(true);
    });

    it('stamps new-device-login', async () => {
      service.sendNewDeviceLogin(TO, 'Firefox on Windows', IP_CLASS, CODE);
      await flush();

      expect(only().kind).toBe('new-device-login');
      expect(stamped(only())).toBe(true);
    });

    it('stamps social-unlink-scheduled', async () => {
      service.sendSocialUnlinkScheduled(TO, 'GOOGLE', UNLINK_AT, IP_CLASS, CODE);
      await flush();

      expect(only().kind).toBe('social-unlink-scheduled');
      expect(stamped(only())).toBe(true);
    });

    it('stamps email-changed — the recovery message, which needs it most', async () => {
      // Goes to the address the account just left, carrying the recovery link. In a
      // takeover that is the victim's own mailbox, and it is the message asking them to
      // act on a compromise — so an unstamped one reads exactly like the phishing the
      // reader is already primed to suspect.
      await service.sendEmailChanged(TO, 'a***@example.test', 'https://x/recover?t=1', IP_CLASS, CODE);

      expect(only().kind).toBe('email-changed');
      expect(stamped(only())).toBe(true);
    });

    it('stamps email-added', async () => {
      service.sendEmailAdded(TO, IP_CLASS, CODE);
      await flush();

      expect(only().kind).toBe('email-added');
      expect(stamped(only())).toBe(true);
    });
  });

  // ─── the kinds that must not ──────────────────────────────────────────────

  describe('messages that must NOT carry the code', () => {
    it('does not stamp email-removed, even though a code exists', async () => {
      // ═══ THE ONE EXCLUSION THAT IS A SECURITY DECISION ════════════════════
      //
      // This goes to an address a recovery just REMOVED from the account. In the
      // compromise case that mailbox belongs to the attacker, and the code is exactly
      // what they need to write mail the real owner will trust.
      //
      // The signature takes no code at all, so a caller cannot express the mistake —
      // and `email-removed` is absent from ANTI_PHISHING_KINDS, so the rule holds twice.
      service.sendEmailRemoved(TO, IP_CLASS);
      await flush();

      expect(only().kind).toBe('email-removed');
      expect(only().body.text).not.toContain(CODE);
      expect(only().body.html).not.toContain(CODE);
    });

    it('does not stamp welcome', async () => {
      // Sent seconds after the account is created, so no code can exist yet. Listing it
      // would put a permanently unstamped message in the set and teach the "sometimes
      // there is no code" lesson this feature cannot afford.
      service.sendWelcome(TO, 'ada_lovelace', 'OREBiT7Q9K2M4X');
      await flush();

      expect(only().kind).toBe('welcome');
      expect(only().body.text).not.toContain(CODE);
      expect(only().body.html).not.toContain(CODE);
    });
  });

  // ─── the null case ────────────────────────────────────────────────────────

  describe('an account with no code configured', () => {
    it('sends an allowlisted message unchanged, with no empty footer', async () => {
      // The ordinary case for every account until its owner sets one, and it must look
      // exactly like the mail this service sent before the feature existed — an empty
      // box would be worse than nothing.
      await service.sendOtp(TO, OTP, new Date(Date.now() + 600_000), [], null);

      expect(only().body.text).not.toMatch(/anti-phishing/i);
      expect(only().body.html).not.toMatch(/anti-phishing/i);
    });

    it('still delivers the message content', async () => {
      await service.sendOtp(TO, OTP, new Date(Date.now() + 600_000), [], null);

      expect(only().body.text).toContain(OTP);
      expect(only().body.subject).toContain(OTP);
    });

    it('sends a registration-style otp unstamped when passed null', async () => {
      // What `registration.service.ts` and `oauth.service.ts` do: no account exists, so
      // there is no code to show.
      await service.sendOtp(TO, OTP, new Date(Date.now() + 600_000), [], null);

      expect(only().body.html).not.toContain(CODE);
    });
  });

  // ─── what the queue and the audit row see ─────────────────────────────────

  describe('what crosses the queue boundary', () => {
    it('keeps the code out of the SUBJECT on every stamped kind', async () => {
      // `mail_deliveries.subject` is persisted to Postgres forever and indexed by
      // recipient. The body is not written there; the subject is.
      await service.sendOtp(TO, OTP, new Date(Date.now() + 600_000), [], CODE);
      service.sendSecurityChanged(TO, 'password changed', IP_CLASS, CODE);
      service.sendNewDeviceLogin(TO, 'Firefox', IP_CLASS, CODE);
      await flush();

      for (const job of jobs) {
        expect(job.body.subject).not.toContain(CODE);
      }
    });

    it('stamps BEFORE the job is built, so every retry carries the same footer', async () => {
      // The body is rendered once and replayed on each retry (see mail.types.ts). If
      // stamping happened later, a retry could deliver a message whose footer disagreed
      // with the first attempt's.
      await service.sendOtp(TO, OTP, new Date(Date.now() + 600_000), [], CODE);

      const [job] = queue.enqueue.mock.calls[0] as [MailJob];
      expect(job.body.html).toContain(CODE);
      expect(job.attempts).toBe(0);
    });
  });

  // ─── the delayed-unlink notice ────────────────────────────────────────────

  /**
   * This message exists for the reader who did NOT ask for the unlink, so what it
   * has to get right is the deadline and the fact that nothing has happened yet. A
   * notice that read like a receipt would tell that reader they were already too
   * late, when in fact they have a week and a way back.
   */
  describe('social-unlink-scheduled', () => {
    const sent = () => {
      service.sendSocialUnlinkScheduled(TO, 'GOOGLE', UNLINK_AT, IP_CLASS, CODE);
      return flush().then(() => only());
    };

    it('names the provider and the exact deadline, in both parts', async () => {
      const job = await sent();

      for (const part of [job.body.text, job.body.html]) {
        expect(part).toContain('GOOGLE');
        // A reader-facing instant, not an ISO string, and explicitly UTC so the
        // reader can convert it rather than guess which zone it is in.
        expect(part).toContain('18 September 2026 at 12:00 UTC');
      }
    });

    it('says the removal has NOT happened yet', async () => {
      const job = await sent();

      expect(job.body.text).toContain('NOT happened yet');
      expect(job.body.html.toLowerCase()).toContain('not happened yet');
    });

    it('names the way back, since there is no cancel link to offer', async () => {
      const job = await sent();

      expect(job.body.text).toContain('link the same GOOGLE account again');
      expect(job.body.html).toContain('link the same GOOGLE account again');
    });

    it('leaks nothing about the link itself', async () => {
      const job = await sent();
      const whole = `${job.body.subject} ${job.body.text} ${job.body.html}`;

      // The provider's identifier for the person, and anything token-shaped. Naming
      // WHICH provider is what the reader needs; identifying the far-side account is
      // not, and neither is anything that would authorise a request.
      for (const forbidden of ['subject', 'accessToken', 'refresh', 'Bearer', 'ya29.']) {
        expect(whole).not.toContain(forbidden);
      }
    });

    it('carries no expiry, so a retry past the deadline still delivers', async () => {
      // The queue drops an expired job. This message stays worth reading right up to
      // the deadline and after it — and the reader who most needs it is precisely the
      // one whose delivery was slow.
      const job = await sent();

      expect(job.validUntil).toBeUndefined();
    });
  });
});
