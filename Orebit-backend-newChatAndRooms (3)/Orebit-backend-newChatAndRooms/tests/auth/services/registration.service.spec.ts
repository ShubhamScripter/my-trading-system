import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientContext } from '../../../auth/auth.types';
import { pepperedHash } from '../../../auth/auth.utility';
import type { RegistrationDbOperation } from '../../../auth/persistence/registration.dboperation';
import type { RetainedEmailDbOperation } from '../../../auth/persistence/retained-email.dboperation';
import { RegistrationService } from '../../../auth/services/registration.service';
import type { BlocklistService } from '../../../auth/services/blocklist.service';
import type { CredentialService } from '../../../auth/services/credential.service';
import type { SessionService } from '../../../auth/services/session.service';
import type { UserService } from '../../../auth/services/user.service';
import { KEYS, type CacheService, type QuotaService } from '../../../redis';
import type { GeoResolver } from '../../../src/geo/geo.types';
import type { MailService } from '../../../src/mail/mail.service';
import { ERR } from '../../../src/contracts';
import type { ProblemException } from '../../../src/http';
import { makeQuota, makeRegistration, makeRetainedEmail } from '../../harness';

/**
 * RegistrationService, limited to where `verify-email` lands.
 *
 * Narrow on purpose. The step's OTP discipline — expiry before comparison,
 * attempts incremented before comparison — is already exercised through the
 * controller suite. What is not covered anywhere else is the state it advances
 * to, which stopped being a constant when the OAuth path started skipping the
 * `credentials` step: a direct signup still owes a credential decision and stops
 * at OTP_VERIFIED, while an OAuth-initiated row does not and goes straight to
 * CREDENTIALS_SET.
 *
 * Both are legal states for the row to be in. Neither skips a guard — `country`
 * still demands CREDENTIALS_SET of every caller, which is exactly why the two
 * cases have to be pinned rather than assumed.
 */

const SECRET = 'continuation-secret';
const CODE = '123456';

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

/** A row sitting at OTP_SENT with `CODE` outstanding and plenty of time left. */
function awaitingCode(overrides = {}) {
  return makeRegistration({
    state: 'OTP_SENT',
    emailVerifiedAt: null,
    passwordSet: false,
    otpHash: pepperedHash(CODE, 'otp'),
    otpExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    otpAttempts: 0,
    expiresAt: new Date(Date.now() + 20 * 60 * 1000),
    ...overrides,
  });
}

let registrations: {
  findByContinuationHash: ReturnType<typeof vi.fn>;
  incrementOtpAttempts: ReturnType<typeof vi.fn>;
  markEmailVerified: ReturnType<typeof vi.fn>;
  markExpired: ReturnType<typeof vi.fn>;
};
let service: RegistrationService;

beforeEach(() => {
  registrations = {
    findByContinuationHash: vi.fn(),
    incrementOtpAttempts: vi.fn().mockResolvedValue(1),
    markEmailVerified: vi.fn().mockImplementation((_id, state) => makeRegistration({ state })),
    markExpired: vi.fn().mockResolvedValue(undefined),
  };

  service = new RegistrationService(
    registrations as unknown as RegistrationDbOperation,
    {} as unknown as UserService,
    {} as unknown as CredentialService,
    {} as unknown as SessionService,
    {} as unknown as MailService,
    {} as unknown as CacheService,
    makeQuota() as unknown as QuotaService,
    {} as unknown as BlocklistService,
    { findLiveByEmail: vi.fn().mockResolvedValue(null) } as unknown as RetainedEmailDbOperation,
    { resolve: vi.fn().mockResolvedValue({ ip: client.ip, country: 'GB' }) } as unknown as GeoResolver,
  );
});

describe('RegistrationService.verifyEmail — where verification lands', () => {
  it('stops a direct signup at OTP_VERIFIED, because it still owes a credential decision', async () => {
    registrations.findByContinuationHash.mockResolvedValue(awaitingCode({ oauthProvider: null }));

    await service.verifyEmail(SECRET, { step: 'verify-email', signupId: 's'.repeat(43), code: CODE });

    expect(registrations.markEmailVerified).toHaveBeenCalledWith(
      expect.any(String),
      'OTP_VERIFIED',
    );
  });

  it('sends an OAuth attempt straight to CREDENTIALS_SET, so the client lands on country', async () => {
    // This is the branch where Google would not vouch for the address, so our own
    // code had to prove it. The provider is still the credential, so there is no
    // decision left for the `credentials` step to record — requiring it would put
    // a mandatory no-op between the code screen and the country screen.
    registrations.findByContinuationHash.mockResolvedValue(
      awaitingCode({ oauthProvider: 'GOOGLE', oauthSubject: 'google-sub-1' }),
    );

    await service.verifyEmail(SECRET, { step: 'verify-email', signupId: 's'.repeat(43), code: CODE });

    expect(registrations.markEmailVerified).toHaveBeenCalledWith(
      expect.any(String),
      'CREDENTIALS_SET',
    );
  });

  it('advances nothing when the code is wrong, on either path', async () => {
    // The state decision is made after the comparison, not before it. Worth
    // pinning because a refactor that hoists it would hand an OAuth caller
    // CREDENTIALS_SET for a failed guess.
    registrations.findByContinuationHash.mockResolvedValue(
      awaitingCode({ oauthProvider: 'GOOGLE', oauthSubject: 'google-sub-1' }),
    );

    await expect(
      service.verifyEmail(SECRET, { step: 'verify-email', signupId: 's'.repeat(43), code: '000000' }),
    ).rejects.toThrow();

    expect(registrations.markEmailVerified).not.toHaveBeenCalled();
  });
});

/**
 * ═══ THE MAIL BUDGET IS NEVER SPENT ON MAIL THAT WAS NOT QUEUED ═════════════
 *
 * `OTP_MAIL_BY_RECIPIENT` meters codes actually EMAILED to one address. It is charged
 * before the work, because it has to gate the work — so every failure between the
 * charge and the enqueue owes a refund.
 *
 * It did not always give one. The `try` began at the enqueue, five statements after
 * the charge, so superseding the previous attempt, resolving GEO, creating the row and
 * starting the cooldown could each throw with the budget already spent and nothing
 * handing it back. A Postgres blip during signup quietly cost the address one of its
 * five hourly sends for an email that was never composed; five of those and the
 * address is locked out for an hour with no error naming the reason.
 *
 * One `try` from the charge onwards is the fix, and these are the failure points it
 * has to cover.
 */
describe('RegistrationService.start — the recipient budget survives a failure', () => {
  const EMAIL = 'ada.lovelace@example.test';
  const hourly = KEYS.rate.registerOtpMail(EMAIL);

  let quota: ReturnType<typeof makeQuota>;
  let cache: { startCooldown: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
  let mail: { sendOtp: ReturnType<typeof vi.fn> };
  let geo: { resolve: ReturnType<typeof vi.fn> };
  let db: Record<string, ReturnType<typeof vi.fn>>;
  let start: RegistrationService;

  beforeEach(() => {
    quota = makeQuota();
    cache = {
      startCooldown: vi.fn().mockResolvedValue(true),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    mail = { sendOtp: vi.fn().mockResolvedValue(undefined) };
    geo = { resolve: vi.fn().mockResolvedValue({ ip: client.ip, country: 'GB' }) };
    db = {
      supersedeLiveAttempts: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(makeRegistration({ id: 'reg-1', emailLower: EMAIL })),
      invalidateOtp: vi.fn().mockResolvedValue(undefined),
      refundOtpSend: vi.fn().mockResolvedValue(undefined),
    };

    start = new RegistrationService(
      db as unknown as RegistrationDbOperation,
      { emailExists: vi.fn().mockResolvedValue(false) } as unknown as UserService,
      {} as unknown as CredentialService,
      {} as unknown as SessionService,
      mail as unknown as MailService,
      cache as unknown as CacheService,
      quota as unknown as QuotaService,
      { assertNotBlocked: vi.fn().mockResolvedValue(undefined) } as unknown as BlocklistService,
      { findLiveByEmail: vi.fn().mockResolvedValue(null) } as unknown as RetainedEmailDbOperation,
      geo as unknown as GeoResolver,
    );
  });

  const attempt = () => start.start({ email: EMAIL } as never, client);

  it('spends one send when everything works', async () => {
    await attempt();
    expect(await quota.used(hourly)).toBe(1);
  });

  /**
   * Each of these throws at a different point between the charge and the enqueue.
   * Every one of them left the budget spent before the compensation scope was widened.
   */
  const failures: [string, () => void][] = [
    ['superseding the previous attempt', () => db['supersedeLiveAttempts']?.mockRejectedValue(new Error('db down'))],
    ['resolving GEO', () => geo.resolve.mockRejectedValue(new Error('geo down'))],
    ['creating the registration row', () => db['create']?.mockRejectedValue(new Error('db down'))],
    ['starting the resend cooldown', () => cache.startCooldown.mockRejectedValue(new Error('redis down'))],
    ['queueing the message', () => mail.sendOtp.mockRejectedValue(new Error('redis down'))],
  ];

  for (const [where, breakIt] of failures) {
    it(`refunds the send when ${where} fails`, async () => {
      breakIt();

      await expect(attempt()).rejects.toThrow();

      expect(await quota.used(hourly)).toBe(0);
    });
  }

  it('reports the ORIGINAL failure, not a failure of the compensation', async () => {
    // The compensation runs when Postgres or Redis is already misbehaving, so it is
    // likelier to throw here than anywhere else. Letting it propagate would tell the
    // caller about a failed refund and lose the cause entirely.
    mail.sendOtp.mockRejectedValue(new Error('the real problem'));
    db['invalidateOtp']?.mockRejectedValue(new Error('compensation also broke'));

    await expect(attempt()).rejects.toThrow('the real problem');
  });

  it('does not refund the row’s own send count when the row was never created', async () => {
    // The two compensations undo different mechanisms. Returning a send to a row that
    // does not exist is not merely useless — with `create` having failed there is no
    // id to name, and the address budget is the only thing actually owed.
    db['create']?.mockRejectedValue(new Error('db down'));

    await expect(attempt()).rejects.toThrow();

    expect(db['refundOtpSend']).not.toHaveBeenCalled();
    expect(await quota.used(hourly)).toBe(0);
  });
});

/**
 * ═══ A RELEASED ADDRESS IS NOT REGISTRABLE WHILE IT IS HELD ═════════════════
 *
 * `ix_users_email_active` scopes uniqueness to LIVE accounts, so the moment an email
 * change commits the released address is free by that index's own definition — and it
 * has to be, because the same property is what lets a user move an address back to
 * themselves.
 *
 * That leaves a gap the index cannot close: an address its previous owner may still want
 * back, and which is still receiving their mail, would otherwise be claimable by a
 * stranger the second it was released. `retained_emails` is the reservation, and this is
 * the door it has to be checked at.
 *
 * The check is a live-row lookup rather than a flag, so an expired reservation stops
 * blocking without anything having to sweep it — correctness never depends on a cleanup
 * job running.
 */
describe('RegistrationService.start — an address inside its retention window', () => {
  const EMAIL = 'released.address@example.test';

  let retained: { findLiveByEmail: ReturnType<typeof vi.fn> };
  let userExists: ReturnType<typeof vi.fn>;
  let db: Record<string, ReturnType<typeof vi.fn>>;
  let mail: { sendOtp: ReturnType<typeof vi.fn> };
  let start: RegistrationService;

  beforeEach(() => {
    retained = { findLiveByEmail: vi.fn().mockResolvedValue(null) };
    userExists = vi.fn().mockResolvedValue(false);
    mail = { sendOtp: vi.fn().mockResolvedValue(undefined) };
    db = {
      supersedeLiveAttempts: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(makeRegistration({ id: 'reg-1', emailLower: EMAIL })),
      invalidateOtp: vi.fn().mockResolvedValue(undefined),
      refundOtpSend: vi.fn().mockResolvedValue(undefined),
    };

    start = new RegistrationService(
      db as unknown as RegistrationDbOperation,
      { emailExists: userExists } as unknown as UserService,
      {} as unknown as CredentialService,
      {} as unknown as SessionService,
      mail as unknown as MailService,
      {
        startCooldown: vi.fn().mockResolvedValue(true),
        clear: vi.fn().mockResolvedValue(undefined),
      } as unknown as CacheService,
      makeQuota() as unknown as QuotaService,
      { assertNotBlocked: vi.fn().mockResolvedValue(undefined) } as unknown as BlocklistService,
      retained as unknown as RetainedEmailDbOperation,
      { resolve: vi.fn().mockResolvedValue({ country: 'GB' }) } as unknown as GeoResolver,
    );
  });

  const attempt = () => start.start({ email: EMAIL } as never, client);

  it('is refused, even though no live account holds it', async () => {
    retained.findLiveByEmail.mockResolvedValue(
      makeRetainedEmail({ emailLower: EMAIL }),
    );

    await expect(attempt()).rejects.toMatchObject({ type: ERR.EMAIL_ALREADY_REGISTERED });
    expect(userExists).toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
  });

  it('gives the SAME answer as a taken address, so nothing new is disclosed', async () => {
    // A distinct "in retention" slug would tell a stranger that somebody recently
    // changed away from this address — a fact about another user's account that this
    // endpoint has no business disclosing. The deliberate enumeration above is about
    // accounts that EXIST; this would be enumeration about accounts that moved.
    const refusal = async (): Promise<ProblemException> => {
      try {
        await attempt();
      } catch (err) {
        return err as ProblemException;
      }
      throw new Error('expected a refusal');
    };

    retained.findLiveByEmail.mockResolvedValue(makeRetainedEmail({ emailLower: EMAIL }));
    const held = await refusal();

    retained.findLiveByEmail.mockResolvedValue(null);
    userExists.mockResolvedValue(true);
    const taken = await refusal();

    expect(held.type).toBe(taken.type);
    expect(held.detail).toBe(taken.detail);
  });

  it('is allowed once the reservation has lapsed', async () => {
    // The double returns null for an expired row, exactly as the live-row query does.
    // Nothing had to delete it for the address to become available again.
    retained.findLiveByEmail.mockResolvedValue(null);

    await expect(attempt()).resolves.toBeDefined();
    expect(db.create).toHaveBeenCalled();
  });

  it('checks the reservation AFTER the account check, so both doors are shut', async () => {
    userExists.mockResolvedValue(true);
    await attempt().catch(() => undefined);

    // A live account short-circuits: there is no reason to ask the second question, and
    // asking it would be a second query on the common path.
    expect(retained.findLiveByEmail).not.toHaveBeenCalled();
  });
});
