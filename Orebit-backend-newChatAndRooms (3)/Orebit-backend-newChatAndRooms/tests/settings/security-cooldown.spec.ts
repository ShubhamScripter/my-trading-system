import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SECURITY_COOLDOWN } from '../../auth/auth.constants';
import { PasswordService } from '../../auth/services/password.service';
import { RecentSecurityChangePolicy } from '../../auth/services/recent-security-change.policy';
import { TwoFactorService } from '../../src/2fa/2fa.service';
import { MfaService } from '../../src/2fa/mfa.service';
import { AntiPhishingService } from '../../src/settings/antiPhishing/antiPhishing.service';
import { DeleteAccountService } from '../../src/settings/delete-account/delete-account.service';
import { PasswordSettingsService } from '../../src/settings/password/password.service';
import { PaymentPinService } from '../../src/settings/paymentPin/payment-pin.service';
import { SettingsService } from '../../src/settings/settings.service';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { PaymentPinDbOperation } from '../../src/settings/paymentPin/payment-pin.dboperation';
import { TwoFactorDbOperation } from '../../src/2fa/2fa.dboperation';
import { UserDbOperation } from '../../auth/persistence/user.dboperation';
import { makePrincipal, makeQuota, makeUser } from '../harness';
import { CONTEXT, FACTS, makeRestrictions, noPlan } from '../restrictions/double';

/**
 * ═══ THE FREEZE, ACROSS EVERY SURFACE THAT CAN CHANGE A SECURITY SETTING ═════
 *
 * The founder's requirement in one file: after a recent email change, the account
 * cannot change its 2FA, its recovery codes, its Payment PIN or its password.
 *
 * ─── Why one spec rather than a case in each service's own file ─────────────
 *
 * Because the property under test is a property of the SET. Each service's own spec can
 * only show that that service asks; none of them can show that nothing was missed, and
 * "nothing was missed" is the entire security value — a freeze with one hole is not a
 * freeze, it is a signpost to the hole. Listing every protected operation in one place
 * also means adding a sixth surface without adding a row here is visible in review.
 *
 * The doubles are deliberately inert. Every method below is expected to refuse BEFORE
 * it consumes an emailed code, hashes a PIN or verifies an assertion, so a collaborator
 * that would have been reached is a collaborator whose absence fails the test — which
 * is the assertion, not an accident of the setup.
 */

const USER_ID = '01940000-0000-7000-8000-000000000001';
const WINDOW_MS = SECURITY_COOLDOWN.AFTER_EMAIL_CHANGE_SECONDS * 1000;

/** The one knob: what `users.findEmailChangedAt` answers. */
let emailChangedAt: Date | null;

let factors: Record<string, ReturnType<typeof vi.fn>>;
let pins: Record<string, ReturnType<typeof vi.fn>>;
let users: Record<string, ReturnType<typeof vi.fn>>;
let cache: Record<string, ReturnType<typeof vi.fn>>;
let challenges: Record<string, ReturnType<typeof vi.fn>>;
let credentials: Record<string, ReturnType<typeof vi.fn>>;
let sessions: Record<string, ReturnType<typeof vi.fn>>;

let policy: RecentSecurityChangePolicy;
let twoFactor: TwoFactorService;
let settings: SettingsService;
let paymentPin: PaymentPinService;
let password: PasswordService;
/** The `src/settings/password/` surface. Its own variable rather than a reuse of
 *  `password` above: the two are different services on different routes, and this
 *  file's whole point is that neither door lifts the freeze. */
let passwordSettings: PasswordSettingsService;
/** The anti-phishing surface. Not on the founder's original list of four — it is
 *  included because the email-change recovery message CARRIES the code, so an attacker
 *  who has just moved the address must not also be able to change what the owner is
 *  looking for on it. See `AntiPhishingService.assertChangeAllowed`. */
let antiPhishing: AntiPhishingService;
/** Deleting the account. The highest-impact thing a moved address could be used for, so
 *  if any surface owes the freeze this one does — and it is the surface whose refusal
 *  matters most, because the write it guards cannot be undone from the caller's own
 *  session. */
let deleteAccount: DeleteAccountService;
/** The ticket mint. The delete ceremony's only WRITE, and therefore what has to stay
 *  untouched when the freeze refuses it. */
let elevationIssue: ReturnType<typeof vi.fn>;

beforeEach(() => {
  emailChangedAt = new Date();

  factors = {
    listConfirmedTotpFactors: vi.fn().mockResolvedValue([]),
    listTotpFactors: vi.fn().mockResolvedValue([]),
    findPendingTotpFactor: vi.fn().mockResolvedValue(null),
    listPasskeys: vi.fn().mockResolvedValue([]),
    countUnusedRecoveryCodes: vi.fn().mockResolvedValue(10),
    hasAnyRecoveryCode: vi.fn().mockResolvedValue(true),
    createTotpFactor: vi.fn(),
    confirmTotpFactor: vi.fn(),
    createPasskey: vi.fn(),
    softDeleteAllTotpFactors: vi.fn().mockResolvedValue(1),
    softDeleteAllPasskeys: vi.fn().mockResolvedValue(1),
    replaceRecoveryCodes: vi.fn(),
    softDeleteTotpFactor: vi.fn(),
  };

  pins = {
    findByUserId: vi.fn().mockResolvedValue({ userId: USER_ID, pinHash: 'argon2id$stored' }),
    create: vi.fn(),
    replaceHash: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
  };

  users = {
    // The single source the policy consults, and the only thing this file varies.
    findEmailChangedAt: vi.fn(async () => emailChangedAt),
    findById: vi.fn().mockResolvedValue(makeUser()),
    findWithCredential: vi
      .fn()
      .mockResolvedValue({ user: makeUser(), credential: { id: 'c1', passwordHash: 'h' } }),
    upsertPassword: vi.fn(),
    // The two writes `src/settings/password/` uses. `true` so a test that reached
    // them would SUCCEED — which is what makes the `unwritten` assertions below
    // meaningful rather than vacuous.
    createPasswordIfAbsent: vi.fn().mockResolvedValue(true),
    replacePassword: vi.fn().mockResolvedValue(true),
    // The anti-phishing reads and writes. `findAntiPhishing` answers "a code is set"
    // so `change` and `replace` would get PAST their eligibility check — the freeze has
    // to be what stops them, not a missing precondition. The writes return `true` so a
    // test that reached them would succeed, which is what makes `unwritten` meaningful.
    findAntiPhishing: vi
      .fn()
      .mockResolvedValue({ ciphertext: new Uint8Array([1]), iv: new Uint8Array([2]), tag: new Uint8Array([3]), keyVersion: 2 }),
    setAntiPhishingIfAbsent: vi.fn().mockResolvedValue(true),
    replaceAntiPhishing: vi.fn().mockResolvedValue(true),
    // The deletion write. `true` so a test that reached it would SUCCEED, which is what
    // makes the `unwritten` assertion meaningful rather than vacuous.
    requestAccountDeletion: vi.fn().mockResolvedValue(true),
  };

  cache = {
    consume: vi.fn().mockResolvedValue(undefined),
    take: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(undefined),
    refund: vi.fn().mockResolvedValue(undefined),
  };

  challenges = { issue: vi.fn(), findLive: vi.fn().mockResolvedValue(null) };
  credentials = {
    hash: vi.fn().mockResolvedValue('argon2id$new'),
    verify: vi.fn().mockResolvedValue(false),
    checkPassword: vi.fn().mockResolvedValue(true),
    assertPolicy: vi.fn(),
  };
  sessions = {
    revokeAllForUser: vi.fn().mockResolvedValue(undefined),
    revokeAllForUserExcept: vi.fn().mockResolvedValue(undefined),
  };

  elevationIssue = vi.fn();

  policy = new RecentSecurityChangePolicy(users as never);

  twoFactor = new TwoFactorService(
    factors as never,
    new MfaService(factors as never),
    { issue: vi.fn(), spend: vi.fn() } as never,
    credentials as never,
    users as never,
    cache as never,
    challenges as never,
    { sendOtp: vi.fn(), sendSecurityChanged: vi.fn() } as never,
    policy,
  );

  settings = new SettingsService(
    twoFactor,
    factors as never,
    new MfaService(factors as never),
    sessions as never,
    users as never,
    cache as never,
    makeQuota() as never,
    { sendSecurityChanged: vi.fn() } as never,
    policy,
    makeRestrictions() as never,
    { isVerified: vi.fn().mockResolvedValue(false), reverify: vi.fn() } as never,
  );

  paymentPin = new PaymentPinService(
    twoFactor,
    new MfaService(factors as never),
    credentials as never,
    pins as never,
    users as never,
    cache as never,
    makeQuota() as never,
    { sendSecurityChanged: vi.fn() } as never,
    policy,
    makeRestrictions() as never,
  );

  password = new PasswordService(
    users as never,
    challenges as never,
    credentials as never,
    sessions as never,
    { sendSecurityChanged: vi.fn(), sendPasswordReset: vi.fn() } as never,
    makeRestrictions() as never,
    cache as never,
    policy,
    // The factor gate on `set`. This suite is about the FREEZE, which is asserted
    // before the gate runs, so a no-factor account is the right default — the same
    // reason `makeSecurityChangePolicy` exists for the inverse case.
    new MfaService(factors as never),
  );

  passwordSettings = new PasswordSettingsService(
    twoFactor,
    new MfaService(factors as never),
    credentials as never,
    users as never,
    sessions as never,
    cache as never,
    { sendSecurityChanged: vi.fn() } as never,
    policy,
    makeRestrictions() as never,
  );

  deleteAccount = new DeleteAccountService(
    twoFactor,
    new MfaService(factors as never),
    { issue: elevationIssue, spend: vi.fn() } as never,
    sessions as never,
    users as never,
    challenges as never,
    policy,
    cache as never,
    { sendAccountDeleted: vi.fn(), sendAccountReactivationCode: vi.fn(), sendAccountReactivated: vi.fn() } as never,
    // `unavailable` - no withdrawal subsystem is bound. Chosen so the freeze is what
    // refuses, rather than a funds check getting there first.
    { check: vi.fn().mockResolvedValue({ state: 'unavailable' }) } as never,
  );

  antiPhishing = new AntiPhishingService(
    twoFactor,
    users as never,
    cache as never,
    { sendSecurityChanged: vi.fn() } as never,
    policy,
  );
});

async function refusal(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the operation to be refused, but it resolved');
}

/** Every protected operation, and the collaborator that proves it never got near a write. */
function protectedOperations() {
  const principal = makePrincipal({ userId: USER_ID });
  const user = makeUser();

  return [
    // ─── 2FA: the authenticator ───────────────────────────────────────────
    {
      name: 'TOTP enrollment (totpAdd)',
      run: () => twoFactor.totpAdd(user),
      unwritten: () => factors.createTotpFactor,
    },
    {
      name: 'TOTP confirmation (totpConfirm)',
      run: () => twoFactor.totpConfirm(USER_ID, '123456'),
      unwritten: () => factors.confirmTotpFactor,
    },
    {
      name: 'authenticator disable (settings)',
      run: () =>
        settings.disableAuthenticator(USER_ID, 'sess-1', FACTS, {
          emailCode: '123456',
          totpCode: '654321',
        } as never),
      unwritten: () => factors.softDeleteAllTotpFactors,
    },

    // ─── 2FA: passkeys ────────────────────────────────────────────────────
    {
      name: 'passkey add challenge',
      run: () => twoFactor.passkeyAddChallenge(user),
      unwritten: () => factors.createPasskey,
    },
    {
      name: 'passkey add verify',
      run: () => twoFactor.passkeyAddVerify(USER_ID, {} as never),
      unwritten: () => factors.createPasskey,
    },
    {
      name: 'passkey disable (settings)',
      run: () =>
        settings.disable(USER_ID, 'sess-1', FACTS, {
          emailCode: '123456',
          totpCode: '654321',
        } as never),
      unwritten: () => factors.softDeleteAllPasskeys,
    },

    // ─── recovery codes ───────────────────────────────────────────────────
    {
      name: 'recovery-code regeneration',
      run: () => twoFactor.regenerateRecoveryCodes(USER_ID),
      unwritten: () => factors.replaceRecoveryCodes,
    },

    // ─── payment PIN ──────────────────────────────────────────────────────
    {
      name: 'Payment PIN enable',
      run: () =>
        paymentPin.enable(USER_ID, FACTS, {
          action: 'enable',
          pin: '281937',
          emailCode: '123456',
        } as never),
      unwritten: () => pins.create,
    },
    {
      name: 'Payment PIN update',
      run: () =>
        paymentPin.update(principal, FACTS, {
          action: 'update',
          challengeId: 'ch-1',
          newPin: '281937',
        } as never),
      unwritten: () => pins.replaceHash,
    },
    {
      name: 'Payment PIN disable',
      run: () =>
        paymentPin.disable(principal, FACTS, {
          action: 'disable',
          challengeId: 'ch-1',
        } as never),
      unwritten: () => pins.remove,
    },
    {
      name: 'Payment PIN verify (the step that mints the challenge)',
      run: () =>
        paymentPin.verify(principal, {
          operation: 'update',
          method: 'pin',
          emailCode: '123456',
          currentPin: '281937',
        } as never),
      unwritten: () => pins.replaceHash,
    },

    // ─── password ─────────────────────────────────────────────────────────
    {
      name: 'password set (emailed code, no current password)',
      run: () =>
        password.set(
          principal,
          { code: '123456', password: 'Str0ng!Passw0rd' } as never,
          { ip: '203.0.113.1', ipClass: FACTS } as never,
        ),
      unwritten: () => users.upsertPassword,
    },
    {
      name: 'password change (proving the current one)',
      run: () =>
        password.change(
          principal,
          { currentPassword: 'Old!Passw0rd', password: 'Str0ng!Passw0rd' } as never,
          { ip: '203.0.113.1', ipClass: FACTS } as never,
        ),
      unwritten: () => users.upsertPassword,
    },
    /**
     * The three operations on `POST /settings/security/password`.
     *
     * All three are listed, `forgot` included. The existing policy names the password
     * among the four frozen surfaces without exempting any flow, and `forgot` is the
     * one the freeze matters MOST on: it needs no knowledge of the current password,
     * so it is exactly the path an attacker who has just moved the address would take.
     *
     * The exemption that policy DOES define is for the email RECOVERY flow, and it is
     * deliberately not extended here — that flow is how someone whose address was moved
     * without their consent gets back in, and it does not depend on the password.
     */
    {
      name: 'password set (settings surface)',
      run: () =>
        passwordSettings.set(principal, FACTS, {
          action: 'set',
          password: 'Str0ng!Passw0rd',
          confirmPassword: 'Str0ng!Passw0rd',
          emailCode: '000000',
        }),
      unwritten: () => users.createPasswordIfAbsent,
    },
    {
      name: 'password reset (settings surface)',
      run: () =>
        passwordSettings.reset(principal, FACTS, {
          action: 'reset',
          currentPassword: 'Old!Passw0rd',
          password: 'Str0ng!Passw0rd',
          confirmPassword: 'Str0ng!Passw0rd',
          emailCode: '000000',
        }),
      unwritten: () => users.replacePassword,
    },
    {
      name: 'password forgot (settings surface)',
      run: () =>
        passwordSettings.forgot(principal, FACTS, {
          action: 'forgot',
          password: 'Str0ng!Passw0rd',
          confirmPassword: 'Str0ng!Passw0rd',
          emailCode: '000000',
        }),
      unwritten: () => users.replacePassword,
    },

    /**
     * ─── the anti-phishing code ───────────────────────────────────────────
     *
     * All three operations, and this surface is NOT on the founder's original list of
     * four. It is here because of what the freeze protects on this particular setting:
     * the "your email address was changed — did you do this?" message goes to the
     * address the account just left, carries the recovery link, AND carries the
     * anti-phishing code. Without the freeze, an attacker who has just moved the
     * address could also change the code — so the genuine owner would see an
     * unfamiliar one on the single message that gives them their account back, and the
     * correct response to an unfamiliar code is to distrust the message.
     *
     * `replace` is listed for the same reason `password forgot` is: it is the operation
     * needing the least knowledge of the account, so it is exactly the path an attacker
     * who has just moved the address would take.
     */
    {
      name: 'anti-phishing code set',
      run: () =>
        antiPhishing.set(principal, FACTS.ipClass, {
          action: 'set',
          code: 'Ada1815',
          emailCode: '000000',
        }),
      unwritten: () => users.setAntiPhishingIfAbsent,
    },
    {
      name: 'anti-phishing code change',
      run: () =>
        antiPhishing.change(principal, FACTS.ipClass, {
          action: 'change',
          currentCode: 'Old1815',
          code: 'Ada1815',
          emailCode: '000000',
        }),
      unwritten: () => users.replaceAntiPhishing,
    },
    {
      name: 'anti-phishing code replace',
      run: () =>
        antiPhishing.replace(principal, FACTS.ipClass, {
          action: 'replace',
          code: 'Ada1815',
          emailCode: '000000',
        }),
      unwritten: () => users.replaceAntiPhishing,
    },
    /**
     * Deleting the account, at both of its gates.
     *
     * The sixth surface, and the one where the freeze matters most: every other
     * operation here leaves the owner signed in and able to reverse it, while this one
     * revokes every session it has. An attacker who has just moved the address must not
     * be able to end the account before the real owner has read the notification about
     * the address.
     *
     * Both the ceremony and the write are listed, deliberately. Freezing only the write
     * would let a caller bank a valid elevation ticket during the freeze and spend it the
     * instant the window closed; freezing only the ceremony would leave the write
     * reachable by a ticket earned before the address moved.
     */
    {
      name: 'delete-account verification',
      run: () => deleteAccount.verify(principal, { emailCode: '000000' }),
      // The ceremony's write is the elevation ticket. If the freeze failed here, a code
      // would have been spent — so this is the collaborator that must stay untouched.
      unwritten: () => elevationIssue,
    },
    {
      name: 'delete-account deletion',
      run: () => deleteAccount.remove(principal, false, FACTS.ipClass),
      unwritten: () => users.requestAccountDeletion,
    },
  ];
}

describe('a recent email change freezes every protected security setting', () => {
  for (const op of protectedOperations()) {
    it(`refuses ${op.name}`, async () => {
      const problem = await refusal(op.run());

      expect(problem.type).toBe(ERR.SECURITY_CHANGE_COOLDOWN);
      // Told when, so the client renders a deadline instead of a dead end.
      expect(problem.retryAfterSeconds).toBeGreaterThan(0);
      expect(problem.extra?.availableAt).toEqual(expect.any(String));
    });

    it(`performs no write for ${op.name}`, async () => {
      // The refusal is only half of it. A service that threw AFTER its mutation would
      // pass the assertion above and still have changed the account.
      await refusal(op.run());

      expect(op.unwritten()).not.toHaveBeenCalled();
    });
  }
});

describe('the freeze ends on its own', () => {
  it('permits every protected operation once the window has closed', async () => {
    emailChangedAt = new Date(Date.now() - WINDOW_MS - 1000);

    for (const op of protectedOperations()) {
      // The operations still fail for their OWN reasons — no pending factor, no
      // challenge, an inert double — and that is the point: whatever they refuse with,
      // it is no longer the cooldown. Anything else here would be testing the doubles.
      const err = await op.run().catch((e: unknown) => e);
      const type = err instanceof ProblemException ? err.type : null;
      expect(type, `${op.name} was still frozen after expiry`).not.toBe(
        ERR.SECURITY_CHANGE_COOLDOWN,
      );
    }
  });

  it('permits every protected operation for an account that never changed its address', async () => {
    emailChangedAt = null;

    for (const op of protectedOperations()) {
      const err = await op.run().catch((e: unknown) => e);
      const type = err instanceof ProblemException ? err.type : null;
      expect(type, `${op.name} was frozen with no email change on record`).not.toBe(
        ERR.SECURITY_CHANGE_COOLDOWN,
      );
    }
  });

  it('is still frozen one second before the window closes', async () => {
    emailChangedAt = new Date(Date.now() - WINDOW_MS + 1000);

    const problem = await refusal(twoFactor.regenerateRecoveryCodes(USER_ID));
    expect(problem.type).toBe(ERR.SECURITY_CHANGE_COOLDOWN);
  });
});

/**
 * ─── THE BYPASS THAT MATTERS ────────────────────────────────────────────────
 *
 * 2FA has two front doors with DIFFERENT credential requirements:
 * `POST /settings/security/{authenticator,passkeys}` takes an emailed code alone, while
 * `POST /auth/2fa` takes an elevation ticket. A freeze installed on one is a freeze the
 * other does not have, and the frontend can simply call the other endpoint.
 *
 * The defence is structural rather than duplicated: the settings routes DELEGATE to the
 * same `TwoFactorService` methods the 2FA route calls, and the check lives on the
 * method. These tests drive both doors of each pair against one real service and assert
 * both are refused — which is what makes switching endpoints pointless rather than
 * merely discouraged.
 */
describe('switching endpoints does not lift the freeze', () => {
  const pairs = [
    {
      name: 'authenticator enrollment',
      viaSettings: () => settings.enableAuthenticatorChallenge(USER_ID, '123456'),
      viaAuth2fa: () => twoFactor.totpAdd(makeUser()),
    },
    {
      name: 'authenticator confirmation',
      viaSettings: () => settings.enableAuthenticatorVerify(USER_ID, '123456'),
      viaAuth2fa: () => twoFactor.totpConfirm(USER_ID, '123456'),
    },
    {
      name: 'passkey challenge',
      viaSettings: () => settings.enableChallenge(USER_ID, '123456'),
      viaAuth2fa: () => twoFactor.passkeyAddChallenge(makeUser()),
    },
    {
      name: 'passkey verification',
      viaSettings: () => settings.enableVerify(USER_ID, {} as never),
      viaAuth2fa: () => twoFactor.passkeyAddVerify(USER_ID, {} as never),
    },
  ];

  for (const pair of pairs) {
    it(`refuses ${pair.name} through /settings/security/* AND through /auth/2fa`, async () => {
      expect((await refusal(pair.viaSettings())).type).toBe(ERR.SECURITY_CHANGE_COOLDOWN);
      expect((await refusal(pair.viaAuth2fa())).type).toBe(ERR.SECURITY_CHANGE_COOLDOWN);
    });
  }

  it('never reached a credential, so neither door spent the user’s emailed code', async () => {
    // The settings enable paths consume a credential OTP before enrolling. A freeze
    // that refused after that would cost a frozen user a code per attempt — and would
    // also mean the check sat below the thing it was meant to protect.
    for (const pair of pairs) {
      await refusal(pair.viaSettings());
      await refusal(pair.viaAuth2fa());
    }

    expect(challenges.issue).not.toHaveBeenCalled();
    expect(factors.createTotpFactor).not.toHaveBeenCalled();
    expect(factors.createPasskey).not.toHaveBeenCalled();
  });
});

/**
 * ─── SESSION INDEPENDENCE ───────────────────────────────────────────────────
 *
 * An email change revokes every session, so the attacker arrives holding a NEW one.
 * A freeze stored in a session, a token claim or a Redis key would therefore be gone
 * exactly when it is needed. `RecentSecurityChangePolicy`'s own spec proves the read
 * takes nothing but a user id; this proves the consequence at the surface.
 */
describe('the freeze is account state, not session state', () => {
  it('holds across different sessions, devices and logins', async () => {
    const elsewhere = [
      makePrincipal({ userId: USER_ID, sessionId: 'sess-a', familyId: 'fam-a' }),
      makePrincipal({ userId: USER_ID, sessionId: 'sess-b', familyId: 'fam-b' }),
      makePrincipal({ userId: USER_ID, sessionId: 'sess-c', familyId: 'fam-c' }),
    ];

    for (const principal of elsewhere) {
      const problem = await refusal(
        password.change(
          principal,
          { currentPassword: 'Old!Passw0rd', password: 'Str0ng!Passw0rd' } as never,
          { ip: '198.51.100.7', ipClass: '198.51.100.0/24' } as never,
        ),
      );
      expect(problem.type).toBe(ERR.SECURITY_CHANGE_COOLDOWN);
    }
  });

  it('survives a cache flush, because nothing about it is in the cache', async () => {
    // Every Redis double answers empty — a flushed instance — and the account is still
    // frozen. The state lives in one Postgres column and nowhere else.
    for (const double of Object.values(cache)) {
      double.mockResolvedValue(null);
    }

    const problem = await refusal(twoFactor.regenerateRecoveryCodes(USER_ID));
    expect(problem.type).toBe(ERR.SECURITY_CHANGE_COOLDOWN);
    expect(users.findEmailChangedAt).toHaveBeenCalledWith(USER_ID);
  });
});

/**
 * ═══ THE RACE ═══════════════════════════════════════════════════════════════
 *
 * Everything above tests the SERVICE-layer check, which runs early — before an emailed
 * code is spent, before argon2, before a WebAuthn verification. That placement is right
 * and it is also precisely what opens a window:
 *
 *   Request B  policy read: no email change on record -> permitted
 *   Request A  email change COMMITS
 *   Request B  ...still working... then writes the password
 *
 * B passed a check that was true when it ran and false when it mattered. These tests
 * drive exactly that interleaving: the fake `$queryRaw` answers with a change that
 * landed AFTER the service said yes, which is what a concurrent `changeEmail` looks
 * like from inside the mutation's own transaction.
 *
 * The assertion is always the same two things — refused, and nothing written — because
 * a guard that threw after its write would close nothing.
 */
describe('a concurrent email change cannot be outrun', () => {
  /** A Prisma double whose row lock reports a change that committed a moment ago. */
  function racingPrisma(models: Record<string, unknown>) {
    const prisma: Record<string, unknown> = {
      ...models,
      // The email change won the row lock. This is what `SELECT ... FOR UPDATE` returns
      // once it unblocks — the value the winner committed, not the one the service read.
      $queryRaw: vi.fn().mockResolvedValue([{ email_changed_at: new Date() }]),
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(prisma),
    };
    return prisma;
  }

  it('refuses the password write and leaves the credential untouched', async () => {
    const upsert = vi.fn();
    const prisma = racingPrisma({ credential: { upsert } });
    const ops = new UserDbOperation(prisma as never);

    // The service already said yes; this is the write it authorised.
    await expect(ops.upsertPassword(USER_ID, 'argon2id$new')).rejects.toMatchObject({
      type: ERR.SECURITY_CHANGE_COOLDOWN,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses every Payment PIN write and leaves the row untouched', async () => {
    const create = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = racingPrisma({ paymentPin: { create, updateMany, deleteMany } });
    const ops = new PaymentPinDbOperation(prisma as never);

    for (const call of [
      ops.create(USER_ID, 'argon2id$pin'),
      ops.replaceHash(USER_ID, 'argon2id$pin', CONTEXT, noPlan()),
      ops.remove(USER_ID, CONTEXT, noPlan()),
    ]) {
      await expect(call).rejects.toMatchObject({ type: ERR.SECURITY_CHANGE_COOLDOWN });
    }

    expect(create).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('refuses every 2FA write and leaves the factors untouched', async () => {
    const totpCreate = vi.fn();
    const totpUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const passkeyCreate = vi.fn();
    const passkeyUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const recoveryCreateMany = vi.fn();
    const prisma = racingPrisma({
      totpFactor: { create: totpCreate, updateMany: totpUpdateMany },
      passkey: { create: passkeyCreate, updateMany: passkeyUpdateMany },
      recoveryCode: { createMany: recoveryCreateMany, updateMany: vi.fn() },
    });
    const ops = new TwoFactorDbOperation(prisma as never);

    for (const call of [
      ops.createTotpFactor({
        id: 'f1',
        userId: USER_ID,
        secretCiphertext: new Uint8Array(1) as Uint8Array<ArrayBuffer>,
        secretIv: new Uint8Array(1) as Uint8Array<ArrayBuffer>,
        secretTag: new Uint8Array(1) as Uint8Array<ArrayBuffer>,
        keyVersion: 1,
        label: 'Authenticator',
      }),
      ops.confirmTotpFactor('f1', USER_ID, ['h1']),
      ops.createPasskey({
        userId: USER_ID,
        credentialId: 'cred',
        publicKey: new Uint8Array(1) as Uint8Array<ArrayBuffer>,
        signCount: 0n,
        transports: [],
        aaguid: null,
        label: 'Passkey',
      }),
      ops.softDeleteAllTotpFactors(USER_ID, CONTEXT, noPlan()),
      ops.softDeleteAllPasskeys(USER_ID, CONTEXT, noPlan()),
    ]) {
      await expect(call).rejects.toMatchObject({ type: ERR.SECURITY_CHANGE_COOLDOWN });
    }

    expect(totpCreate).not.toHaveBeenCalled();
    expect(totpUpdateMany).not.toHaveBeenCalled();
    expect(passkeyCreate).not.toHaveBeenCalled();
    expect(passkeyUpdateMany).not.toHaveBeenCalled();
    // The confirmation is the write that mints an account's FIRST recovery codes, so a
    // guard that ran after the compare-and-swap would hand them out during the freeze.
    expect(recoveryCreateMany).not.toHaveBeenCalled();
  });

  it('takes the lock BEFORE the write, which is the only ordering that closes the race', async () => {
    // A guard placed after the mutation would satisfy "it throws" and close nothing.
    // The order of the calls is therefore the assertion, not a detail of the setup.
    const order: string[] = [];
    const prisma: Record<string, unknown> = {
      paymentPin: {
        updateMany: vi.fn(async () => {
          order.push('write');
          return { count: 1 };
        }),
      },
      $queryRaw: vi.fn(async () => {
        order.push('lock');
        return [{ email_changed_at: null }];
      }),
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(prisma),
    };

    // The un-frozen case, so the write actually happens and both entries are recorded.
    await new PaymentPinDbOperation(prisma as never).replaceHash(USER_ID, 'argon2id$pin', CONTEXT, noPlan());

    expect(order).toEqual(['lock', 'write']);
  });
});
