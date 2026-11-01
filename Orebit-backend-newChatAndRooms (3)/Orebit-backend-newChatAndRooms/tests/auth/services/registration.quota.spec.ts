import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { KEYS, type CacheService, type QuotaService } from '../../../redis';
import { policy } from '../../../auth/limits';
import type { ClientContext } from '../../../auth/auth.types';
import type { RegistrationDbOperation } from '../../../auth/persistence/registration.dboperation';
import type { RetainedEmailDbOperation } from '../../../auth/persistence/retained-email.dboperation';
import { RegistrationService } from '../../../auth/services/registration.service';
import type { BlocklistService } from '../../../auth/services/blocklist.service';
import type { CredentialService } from '../../../auth/services/credential.service';
import type { SessionService } from '../../../auth/services/session.service';
import type { UserService } from '../../../auth/services/user.service';
import type { GeoResolver } from '../../../src/geo/geo.types';
import type { MailService } from '../../../src/mail/mail.service';
import type { MailUndo } from '../../../src/mail/mail.types';
import { makeQuota, makeRegistration } from '../../harness';

/**
 * ═══ THE OTP EMAIL BUDGET BELONGS TO THE ADDRESS ════════════════════════════
 *
 * The loophole: the budget used to be `Registration.otpSentCount`, a column on the
 * registration row. A caller who exhausted their five codes simply called `start`
 * again for the same address — `supersedeLiveAttempts` retired the old row, and the
 * new one arrived with `otpSentCount` at zero. Five codes per attempt, and attempts
 * were free, so the cap was decorative and the endpoint was an unmetered mail relay
 * pointed at anyone's inbox.
 *
 * The fix is a quota keyed on the RECIPIENT, which has no attempt to reset. These
 * tests are about that key: what it is derived from, when it is charged, and what it
 * is charged against.
 */

const EMAIL = 'ada.lovelace@example.test';

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

/**
 * A registration still inside its thirty-minute life.
 *
 * `makeRegistration`'s fixed clock is in the past relative to a real run, and
 * `loadRaw` expires a row on read — so a resend test using the bare fixture would
 * fail on `registration_expired` before it reached anything about quotas.
 */
function live(overrides: Record<string, unknown> = {}) {
  return makeRegistration({
    state: 'OTP_SENT',
    email: EMAIL,
    emailLower: EMAIL,
    expiresAt: new Date(Date.now() + 20 * 60 * 1000),
    ...overrides,
  });
}

type Fn = ReturnType<typeof vi.fn>;

let quota: ReturnType<typeof makeQuota>;
// Named fields rather than an index signature: `noUncheckedIndexedAccess` makes every
// lookup on the latter `possibly undefined`, so each assertion would need a `?.`.
let registrations: {
  create: Fn;
  supersedeLiveAttempts: Fn;
  findByContinuationHash: Fn;
  recordOtpSent: Fn;
  markExpired: Fn;
};
let mail: { sendOtp: Fn };
let cache: {
  consume: Fn;
  cooldownRemaining: Fn;
  startCooldown: Fn;
  clear: Fn;
  setIfAbsent: Fn;
  clearIfValue: Fn;
};
let users: { emailExists: Fn };
let service: RegistrationService;

beforeEach(() => {
  quota = makeQuota();
  mail = { sendOtp: vi.fn() };
  users = { emailExists: vi.fn().mockResolvedValue(false) };

  registrations = {
    create: vi.fn().mockImplementation(async (input: { email: string }) =>
      makeRegistration({ email: input.email, emailLower: input.email.toLowerCase() }),
    ),
    supersedeLiveAttempts: vi.fn().mockResolvedValue(0),
    findByContinuationHash: vi.fn(),
    recordOtpSent: vi.fn().mockImplementation(async () => live()),
    markExpired: vi.fn().mockResolvedValue(undefined),
  };

  cache = {
    consume: vi.fn().mockResolvedValue(undefined),
    cooldownRemaining: vi.fn().mockResolvedValue(0),
    startCooldown: vi.fn().mockResolvedValue(true),
    clear: vi.fn().mockResolvedValue(undefined),
    setIfAbsent: vi.fn().mockResolvedValue(true),
    clearIfValue: vi.fn().mockResolvedValue(undefined),
  };

  service = new RegistrationService(
    registrations as unknown as RegistrationDbOperation,
    users as unknown as UserService,
    {} as unknown as CredentialService,
    {} as unknown as SessionService,
    mail as unknown as MailService,
    cache as unknown as CacheService,
    quota as unknown as QuotaService,
    { assertNotBlocked: vi.fn().mockResolvedValue(undefined) } as unknown as BlocklistService,
    // No address is reserved by default. The suite that cares about retention overrides
    // this; every other case here is about the recipient budget and wants a clean start.
    { findLiveByEmail: vi.fn().mockResolvedValue(null) } as unknown as RetainedEmailDbOperation,
    { resolve: vi.fn().mockResolvedValue({ country: 'GB' }) } as unknown as GeoResolver,
  );
});

/** The keys charged by the Nth `consumeAll` call. */
/**
 * The `consumeAll` calls that charged the OTP MAIL budget.
 *
 * `start` makes two quota calls — the start ceiling (email, IP, device × hour and
 * day) and then the mail budget — so these tests locate their subject by key rather
 * than by position. Indexing would silently start asserting about the wrong quota the
 * next time an ordering changes.
 */
function mailCalls(): readonly (readonly { key: string; rule: unknown }[])[] {
  return quota.consumeAll.mock.calls
    .map((call) => call[0] ?? [])
    .filter((entries) => entries.some((entry) => entry.key.includes('register-otp-mail')));
}

function mailKeys(nth = 0): string[] {
  return (mailCalls()[nth] ?? []).map((entry) => entry.key);
}

function start(email = EMAIL): Promise<unknown> {
  return service.start({ step: 'start', email, acceptedTerms: true } as never, client);
}

describe('the budget is keyed on the recipient', () => {
  it('charges a key derived from the email address', async () => {
    await start();

    expect(mailKeys()).toEqual([
      KEYS.rate.registerOtpMail(EMAIL),
      KEYS.rate.registerOtpMailDaily(EMAIL),
    ]);
  });

  it('charges the SAME key when registration is restarted for that address', async () => {
    // THE loophole test. Two starts for one address must draw on one budget. Under the
    // old per-row count the second start began with a fresh five.
    await start();
    await start();

    expect(mailCalls()).toHaveLength(2);
    expect(mailKeys(0)).toEqual(mailKeys(1));
  });

  it('charges no key that varies with the registration', async () => {
    // The property behind the previous test, stated so a future refactor that folds
    // the registration id back into the key fails here rather than in production.
    await start();
    const created = registrations.create.mock.calls.length;

    expect(created).toBe(1);
    for (const key of mailKeys()) {
      expect(key).not.toContain('reg:');
    }
  });

  it('gives two different addresses two different budgets', async () => {
    await start('ada@example.test');
    await start('grace@example.test');

    expect(mailKeys(0)).not.toEqual(mailKeys(1));
  });

  it('applies the hourly and the daily quota together', async () => {
    await start();

    const rules = (mailCalls()[0] ?? []).map((entry) => entry.rule);
    expect(rules).toEqual([...policy().REGISTRATION.OTP_MAIL_BY_RECIPIENT]);
  });

  it('charges them atomically, in one call, against the durable store', async () => {
    // Two round trips would let a caller pass the hourly check, be charged, and then
    // be refused by the daily one — billed for a send that never happened. And a
    // budget on the cache instance is a budget a Redis restart hands back.
    await start();

    // One call, not two: the pair is a single atomic decision.
    expect(mailCalls()).toHaveLength(1);
    const call = quota.consumeAll.mock.calls.find((c) =>
      (c[0] ?? []).some((e) => e.key.includes('register-otp-mail')),
    );
    expect(call?.[1]).toBe('durable');
    expect(call?.[2]).toBe('deny');
  });
});

describe('when the budget is exhausted', () => {
  beforeEach(() => {
    quota.consumeAll.mockRejectedValue(new ProblemException({ type: ERR.RATE_LIMITED }));
  });

  it('refuses the start', async () => {
    await expect(start()).rejects.toBeInstanceOf(ProblemException);
  });

  it('sends nothing', async () => {
    await expect(start()).rejects.toThrow();

    expect(mail.sendOtp).not.toHaveBeenCalled();
  });

  it('creates no registration row for a code that will never be sent', async () => {
    await expect(start()).rejects.toThrow();

    expect(registrations.create).not.toHaveBeenCalled();
  });

  it('does NOT destroy the caller\'s in-flight registration on the way to refusing', async () => {
    // Ordering, and it is the reason the charge sits above `supersedeLiveAttempts`.
    // Charging after it would mean a refused caller had already had their existing
    // attempt retired — losing a registration they could still have completed, in
    // exchange for a code they were never going to get.
    await expect(start()).rejects.toThrow();

    expect(registrations.supersedeLiveAttempts).not.toHaveBeenCalled();
  });
});

describe('the refund travels with the message', () => {
  /** The undo descriptors handed to the queue alongside the code. */
  function undos(): MailUndo[] {
    return (mail.sendOtp.mock.calls[0]?.[3] ?? []) as MailUndo[];
  }

  it('parks a quota refund, so an undeliverable code does not cost the address a slot', async () => {
    await start();

    expect(undos()).toContainEqual(
      expect.objectContaining({ kind: 'quota.refund', store: 'durable' }),
    );
  });

  it('carries the charge token, which is what makes the refund idempotent', async () => {
    // A `cache.refund` is a DECR and running it twice hands back two slots for one
    // failed send. This one is a ZREM of a named member, so a duplicated compensation
    // removes nothing the second time.
    await start();

    const refund = undos().find((undo) => undo.kind === 'quota.refund');
    expect(refund).toMatchObject({ token: expect.stringContaining('test-charge') });
  });

  it('parks the per-attempt refund as well, because they undo different mechanisms', async () => {
    // One returns a slot to the row's count, the other to the address's budget. A
    // user who received nothing is owed both.
    await start();

    const kinds = undos().map((undo) => undo.kind);
    expect(kinds).toContain('registration.refund-otp-send');
    expect(kinds).toContain('quota.refund');
  });
});

describe('resending charges the same budget as starting', () => {
  beforeEach(() => {
    registrations.findByContinuationHash.mockResolvedValue(live({ otpSentCount: 1 }));
  });

  it('draws on the recipient budget, not just the row count', async () => {
    await service.resendOtp('continuation-secret');

    expect(mailKeys()).toEqual([
      KEYS.rate.registerOtpMail(EMAIL),
      KEYS.rate.registerOtpMailDaily(EMAIL),
    ]);
  });

  it('checks the cooldown BEFORE spending budget', async () => {
    // Otherwise a client hammering resend burns the address's whole daily allowance
    // against refusals it was always going to get.
    cache.cooldownRemaining.mockResolvedValue(42);

    await expect(service.resendOtp('continuation-secret')).rejects.toMatchObject({
      type: ERR.OTP_RESEND_TOO_SOON,
    });
    expect(quota.consumeAll).not.toHaveBeenCalled();
  });

  it('checks the per-attempt cap before spending budget too', async () => {
    registrations.findByContinuationHash.mockResolvedValue(live({ otpSentCount: 99 }));

    await expect(service.resendOtp('continuation-secret')).rejects.toMatchObject({
      type: ERR.OTP_SEND_LIMIT_REACHED,
    });
    expect(quota.consumeAll).not.toHaveBeenCalled();
  });
});
