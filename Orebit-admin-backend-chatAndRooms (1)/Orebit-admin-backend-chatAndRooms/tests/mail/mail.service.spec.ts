import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailService } from '../../src/mail/mail.service';

/**
 * ═══ WHY A RELAY REFUSED IS NOT WHY A RELAY IS DOWN ════════════════════════
 *
 * `MailOutcome` used to be `'sent' | 'failed'`, and everything below is about the
 * value of having split `'failed'` in two.
 *
 * Two decisions read this type, and they disagree about the collapsed value:
 *
 *   failover        an unreachable relay should be retried on the backup; a
 *                   refused RECIPIENT should not, because a 550 for a mailbox that
 *                   does not exist is a 550 on the second relay too.
 *   the send budget `LoginService` refunds the per-account bucket when no relay
 *                   would take the message — our outage, our cost — and keeps the
 *                   charge when a relay answered and refused the address.
 *
 * With one `'failed'` value both decisions had to guess, and both would have
 * guessed the same way for two cases that need opposite handling.
 *
 * ─── On mocking nodemailer rather than standing up a relay ──────────────────
 *
 * The three failures this file has to reproduce — a rejected recipient, a timeout,
 * and an authentication failure — are precisely the ones that are painful to
 * provoke against a real server and trivial to state as the error nodemailer
 * surfaces. What is under test is the CLASSIFICATION, which is our code; that the
 * errors take these shapes is nodemailer's contract.
 */

const { mockConfig, createTransport } = vi.hoisted(() => {
  const mockConfig = {
    LOG_LEVEL: 'fatal',
    MAIL_TRANSPORT: 'smtp',
    SMTP_HOST: 'primary.test',
    SMTP_PORT: 587,
    SMTP_USER: 'user',
    SMTP_PASSWORD: 'pass',
    SMTP_FROM: 'admin-no-reply@orebit.test',
    smtpBackupEnabled: false,
    SMTP_BACKUP_HOST: '',
    SMTP_BACKUP_PORT: 587,
    SMTP_BACKUP_USER: '',
    SMTP_BACKUP_PASSWORD: '',
  };
  return { mockConfig, createTransport: vi.fn() };
});

// Both hoisted above the import of `mail.service` above, which is what lets that
// module see the doubles rather than the real config and a real transport.
vi.mock('../../src/config', () => ({ config: mockConfig }));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

/** A relay that answers however the spec tells it to. */
function makeRelay() {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: 'm1', accepted: ['a@b.test'], rejected: [] }),
    verify: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
  };
}

/** The SMTP error shapes nodemailer surfaces, as the real thing produces them. */
const ETIMEDOUT = Object.assign(new Error('Connection timeout'), {
  code: 'ETIMEDOUT',
  command: 'CONN',
});
const EAUTH = Object.assign(new Error('Invalid login: 535 Authentication failed'), {
  code: 'EAUTH',
  command: 'AUTH',
  responseCode: 535,
  response: '535 5.7.8 Username and Password not accepted',
});
const ECONNREFUSED = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ESOCKET' });

/** The reply a server gives when it takes the connection and refuses the mailbox. */
const RECIPIENT_REFUSED = {
  messageId: 'm1',
  accepted: [],
  rejected: ['nobody@orebit.test'],
  response: '550 5.1.1 No such user here',
};

let primary: ReturnType<typeof makeRelay>;
let backup: ReturnType<typeof makeRelay>;

/** Build a service with the backup relay on or off. */
function build(withBackup: boolean) {
  primary = makeRelay();
  backup = makeRelay();
  mockConfig.MAIL_TRANSPORT = 'smtp';
  mockConfig.smtpBackupEnabled = withBackup;
  mockConfig.SMTP_BACKUP_HOST = withBackup ? 'backup.test' : '';
  createTransport.mockReset();
  createTransport.mockReturnValueOnce(primary).mockReturnValueOnce(backup);
  return new MailService();
}

function send(service: InstanceType<typeof MailService>) {
  return service.sendLoginOtp('admin@orebit.test', '123456', 10);
}

describe('classifying one relay’s answer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a handover the relay accepted as sent', async () => {
    await expect(send(build(false))).resolves.toBe('sent');
  });

  /** ═══ REQUIRED CASE 1 — REJECTED RECIPIENT ═════════════════════════════ */
  it('reports a refused recipient as rejected, not unreachable', async () => {
    const service = build(false);
    primary.sendMail.mockResolvedValue(RECIPIENT_REFUSED);

    // `sendMail` RESOLVED here — from its point of view the send succeeded. The
    // verdict is in `info.rejected`, and reading only the resolution would call
    // this a delivered message.
    await expect(send(service)).resolves.toBe('rejected');
  });

  /** ═══ REQUIRED CASE 2 — TIMEOUT ════════════════════════════════════════ */
  it('reports a timeout as unreachable', async () => {
    const service = build(false);
    primary.sendMail.mockRejectedValue(ETIMEDOUT);

    await expect(send(service)).resolves.toBe('unreachable');
  });

  /** ═══ REQUIRED CASE 3 — SMTP AUTH FAILURE ══════════════════════════════ */
  it('reports an authentication failure as unreachable', async () => {
    const service = build(false);
    primary.sendMail.mockRejectedValue(EAUTH);

    // Ours to fix, not the admin's, and indistinguishable from an outage from
    // their side — so it takes the same branch a timeout does, including the
    // budget refund.
    await expect(send(service)).resolves.toBe('unreachable');
  });

  it('reports a refused connection as unreachable', async () => {
    const service = build(false);
    primary.sendMail.mockRejectedValue(ECONNREFUSED);

    await expect(send(service)).resolves.toBe('unreachable');
  });

  it('never throws, whatever the relay does', async () => {
    const service = build(false);
    primary.sendMail.mockRejectedValue(new Error('something entirely unexpected'));

    // The login attempt row and its step-up cookie must survive a mail failure, or
    // the client holds a cookie for a flow it cannot resume.
    await expect(send(service)).resolves.toBe('unreachable');
  });
});

describe('failover to the backup relay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not build a backup transport when none is configured', () => {
    build(false);
    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it('builds a second transport when one is configured', () => {
    build(true);
    expect(createTransport).toHaveBeenCalledTimes(2);
  });

  it('pools connections to both relays', () => {
    build(true);
    const [[primaryOptions], [backupOptions]] = createTransport.mock.calls as [
      [Record<string, unknown>],
      [Record<string, unknown>],
    ];

    // Unpooled, every sign-in code paid a fresh TCP + TLS + AUTH handshake, and a
    // burst of admins signing in opened one connection apiece — the shape relays
    // throttle and then refuse.
    for (const options of [primaryOptions, backupOptions]) {
      expect(options['pool']).toBe(true);
      expect(options['maxConnections']).toBe(5);
      expect(options['maxMessages']).toBe(100);
    }
  });

  it('closes both pools on shutdown', async () => {
    const service = build(true);
    await service.onModuleDestroy();

    // A pooled transport holds sockets open. Without this the process keeps a
    // handle to the relay and never exits on its own, so a deploy hangs until the
    // orchestrator kills it.
    expect(primary.close).toHaveBeenCalledOnce();
    expect(backup.close).toHaveBeenCalledOnce();
  });

  it('gives the backup the primary’s timeouts and hardening', () => {
    build(true);
    const [[primaryOptions], [backupOptions]] = createTransport.mock.calls as [
      [Record<string, unknown>],
      [Record<string, unknown>],
    ];

    // Spread, not re-listed. A backup that quietly lost the socket timeout is a
    // backup that hangs the request it was added to rescue — and nothing would
    // notice until the primary was already down.
    expect(backupOptions['connectionTimeout']).toBe(primaryOptions['connectionTimeout']);
    expect(backupOptions['socketTimeout']).toBe(primaryOptions['socketTimeout']);
    expect(backupOptions['disableFileAccess']).toBe(true);
    expect(backupOptions['disableUrlAccess']).toBe(true);
    expect(backupOptions['host']).toBe('backup.test');
  });

  it('falls through to the backup when the primary is unreachable', async () => {
    const service = build(true);
    primary.sendMail.mockRejectedValue(ETIMEDOUT);

    await expect(send(service)).resolves.toBe('sent');
    expect(primary.sendMail).toHaveBeenCalledOnce();
    expect(backup.sendMail).toHaveBeenCalledOnce();
  });

  /** ═══ THE ONE THAT KEEPS A 550 FROM BEING SENT TWICE ═══════════════════ */
  it('does NOT fall through when the recipient was rejected', async () => {
    const service = build(true);
    primary.sendMail.mockResolvedValue(RECIPIENT_REFUSED);

    await expect(send(service)).resolves.toBe('rejected');
    // The address is the problem, not the relay. Trying the backup delivers
    // nothing and spends a second provider's reputation on the same 550.
    expect(backup.sendMail).not.toHaveBeenCalled();
  });

  it('does not try the backup when the primary succeeded', async () => {
    const service = build(true);

    await expect(send(service)).resolves.toBe('sent');
    expect(backup.sendMail).not.toHaveBeenCalled();
  });

  it('reports unreachable when both relays are down', async () => {
    const service = build(true);
    primary.sendMail.mockRejectedValue(ETIMEDOUT);
    backup.sendMail.mockRejectedValue(ECONNREFUSED);

    // Still `'unreachable'`, so the budget is still refunded. Two dead relays are
    // more our fault than one, not less.
    await expect(send(service)).resolves.toBe('unreachable');
    expect(backup.sendMail).toHaveBeenCalledOnce();
  });

  it('returns the primary’s outcome unchanged when no backup exists', async () => {
    const service = build(false);
    primary.sendMail.mockRejectedValue(ETIMEDOUT);

    await expect(send(service)).resolves.toBe('unreachable');
  });

  it('verifies both relays at boot', async () => {
    const service = build(true);
    await service.onModuleInit();

    // A backup nobody verified is a backup discovered to be misconfigured at the
    // exact moment it is needed.
    expect(primary.verify).toHaveBeenCalledOnce();
    expect(backup.verify).toHaveBeenCalledOnce();
  });

  it('survives a backup that fails verification', async () => {
    const service = build(true);
    backup.verify.mockRejectedValue(EAUTH);

    // Loud, not fatal — the same rule the primary has always had. A bad backup
    // credential must not stop the API booting.
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('the console transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports sent, and dials nothing', async () => {
    mockConfig.MAIL_TRANSPORT = 'console';
    createTransport.mockReset();
    const service = new MailService();

    // `'sent'` despite nothing leaving: the code DID reach its intended reader,
    // the developer watching the log. Reporting a failure here would make every
    // local resend free and hide the accounting this outcome exists to drive.
    await expect(send(service)).resolves.toBe('sent');
    expect(createTransport).not.toHaveBeenCalled();
  });
});
