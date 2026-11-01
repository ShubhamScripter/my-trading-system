import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientContext, OauthIdentity } from '../../../auth/auth.types';
import type { RegistrationDbOperation } from '../../../auth/persistence/registration.dboperation';
import type { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { OauthProviderRegistry } from '../../../auth/oauth/registry';
import type { BlocklistService } from '../../../auth/services/blocklist.service';
import { OauthService } from '../../../auth/services/oauth.service';
import type { SessionService } from '../../../auth/services/session.service';
import type { MfaService } from '../../../src/2fa/mfa.service';
import type { TwoFactorDbOperation } from '../../../src/2fa/2fa.dboperation';
import { KEYS, type CacheService, type QuotaService } from '../../../redis';
import type { GeoResolver } from '../../../src/geo/geo.types';
import type { MailService } from '../../../src/mail/mail.service';
import { makeQuota, makeRegistration } from '../../harness';

/**
 * ═══ THE OAUTH SIGNUP SPENDS THE SAME BUDGET AS THE DIRECT ONE ══════════════
 *
 * `REGISTRATION.OTP_MAIL_BY_RECIPIENT` meters codes emailed to one ADDRESS, and it is
 * keyed on the address for a specific reason: keyed on the registration, a caller who
 * abandoned and restarted got a fresh allowance every time, so five codes became five
 * codes *per attempt* and attempts were free.
 *
 * That fix was applied in `RegistrationService` and nowhere else. `OauthService`
 * creates a registration and sends the identical first OTP whenever a provider will
 * not vouch for the email — and it charged nothing at all. So the loophole survived
 * intact, one door along: anyone wanting unmetered mail to an address used the OAuth
 * entrance to the same flow.
 *
 * The two paths share `chargeOtpMail` now, which is why these assertions are written
 * against the same key `RegistrationService` charges rather than against a call count.
 */

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

const EMAIL = 'ada.lovelace@example.test';

/** A provider that supplies an email it will NOT vouch for — so a code is owed. */
const UNVERIFIED: OauthIdentity = {
  provider: 'GOOGLE',
  subject: 'google-subject-1',
  email: EMAIL,
  emailVerified: false,
  name: 'Ada',
  avatarUrl: null,
};

/** The same provider vouching for the address — so no code, and nothing to charge. */
const VERIFIED: OauthIdentity = { ...UNVERIFIED, emailVerified: true };

const hourly = KEYS.rate.registerOtpMail(EMAIL);
const daily = KEYS.rate.registerOtpMailDaily(EMAIL);

let quota: ReturnType<typeof makeQuota>;
let registrations: Record<string, ReturnType<typeof vi.fn>>;
let mail: { sendOtp: ReturnType<typeof vi.fn> };
let service: OauthService;

const makeAttempts = () => ({
  createFlow: vi.fn(),
  promoteAttempt: vi.fn().mockResolvedValue(true),
  completeAttempt: vi.fn().mockResolvedValue(true),
  markOtpSent: vi.fn().mockResolvedValue(true),
  findAttemptByTokenHash: vi.fn().mockResolvedValue(null),
  expireAttempt: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  quota = makeQuota();
  registrations = {
    findResumableByOauth: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(makeRegistration({ id: 'reg-1', emailLower: EMAIL })),
    setContinuationSecret: vi.fn(),
    invalidateOtp: vi.fn().mockResolvedValue(undefined),
    refundOtpSend: vi.fn().mockResolvedValue(undefined),
  };
  mail = { sendOtp: vi.fn().mockResolvedValue(undefined) };

  service = new OauthService(
    { findByEmail: vi.fn().mockResolvedValue(null) } as unknown as UserDbOperation,
    registrations as unknown as RegistrationDbOperation,
    { issue: vi.fn() } as unknown as SessionService,
    mail as unknown as MailService,
    {} as unknown as CacheService,
    quota as unknown as QuotaService,
    { assertNotBlocked: vi.fn().mockResolvedValue(undefined) } as unknown as BlocklistService,
    { challengeFor: vi.fn().mockResolvedValue(null) } as unknown as MfaService,
    makeAttempts() as unknown as TwoFactorDbOperation,
    new OauthProviderRegistry([]),
    { resolve: vi.fn().mockResolvedValue({ ip: client.ip, country: 'GB' }) } as unknown as GeoResolver,
  );
});

/**
 * `beginRegistration` is private and is reached through the choice a callback hands
 * back. Called directly here rather than through `callback`, which would need a
 * doubled provider exchange, a doubled state entry and a doubled cache just to arrive
 * at the branch these assertions are about — doubles that would be asserting my own
 * idea of a provider's response shape rather than the budget.
 *
 * `emailLower` is a separate argument because the caller has already normalised and
 * blocklist-checked it.
 */
function begin(identity: OauthIdentity): Promise<unknown> {
  return (
    service as unknown as {
      beginRegistration(i: OauthIdentity, e: string, c: ClientContext): Promise<unknown>;
    }
  ).beginRegistration(identity, EMAIL, client);
}

describe('OauthService.beginRegistration — the recipient mail budget', () => {
  it('charges the address for the first OTP it sends', async () => {
    await begin(UNVERIFIED);

    // The assertion that would have failed before: this path sent a code and spent
    // nothing, so the address's budget was enforced on one signup route and bypassed
    // entirely on the other.
    expect(await quota.used(hourly)).toBe(1);
    expect(await quota.used(daily)).toBe(1);
  });

  it('charges nothing when the provider vouched for the address', async () => {
    // No code is owed, so no message exists to meter. Charging here would take a slot
    // from a budget that counts messages.
    await begin(VERIFIED);

    expect(await quota.used(hourly)).toBe(0);
    expect(mail.sendOtp).not.toHaveBeenCalled();
  });

  it('draws on the SAME bucket the direct signup uses', async () => {
    // One address, one budget, however the signup was started. Two calls, two slots —
    // not two independent allowances.
    await begin(UNVERIFIED);
    await begin(UNVERIFIED);

    expect(await quota.used(hourly)).toBe(2);
  });

  it('awaits the enqueue, so a queue outage is not an unhandled rejection', async () => {
    // The call used to be fire-and-forget. `MailService.sendOtp` rethrows when Redis
    // refuses the job, so a queue outage became an unhandled promise rejection — which
    // Node treats as fatal — while this method returned `registration_required` and
    // left a row in state OTP_SENT holding a live hash for a code that was never
    // queued and never would be.
    mail.sendOtp.mockRejectedValue(new Error('redis down'));

    await expect(begin(UNVERIFIED)).rejects.toThrow('redis down');
  });

  it('refunds the address budget when the message cannot be queued', async () => {
    mail.sendOtp.mockRejectedValue(new Error('redis down'));

    await expect(begin(UNVERIFIED)).rejects.toThrow();

    expect(await quota.used(hourly)).toBe(0);
  });

  it('retires the unsendable OTP rather than leaving a live hash on the row', async () => {
    mail.sendOtp.mockRejectedValue(new Error('redis down'));

    await expect(begin(UNVERIFIED)).rejects.toThrow();

    expect(registrations['invalidateOtp']).toHaveBeenCalled();
    expect(registrations['refundOtpSend']).toHaveBeenCalled();
  });

  it('refunds the budget when the registration row itself cannot be written', async () => {
    // Charged before `create`, so this is the window the direct path also had to close.
    registrations['create']?.mockRejectedValue(new Error('db down'));

    await expect(begin(UNVERIFIED)).rejects.toThrow();

    expect(await quota.used(hourly)).toBe(0);
  });
});
