import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { REVOKE_REASON } from '../../auth/auth.types';
import { policy } from '../../auth/limits';
import { KEYS } from '../../redis';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { NullKycProvider } from '../../src/settings/kyc.service';
import { SettingsService } from '../../src/settings/settings.service';
import type { KycStatusPort } from '../../src/settings/settings.types';
import { FIXED_NOW, makeQuota, makeSecurityChangePolicy, makeUser } from '../harness';
import { FACTS, makeRestrictions } from '../restrictions/double';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * Disabling biometrics is the highest-consequence write in the settings surface: it
 * retires every passkey on the account and signs out every other session. Four
 * different proofs authorise it, one of which — a backup code — needs nothing else.
 *
 * So the assertions here are phrased as OBSERVABLE OUTCOMES rather than as calls to
 * the collaborators: were the credentials actually retired, were the other sessions
 * actually revoked, was an emailed code actually consumed, was a quota actually
 * charged. The failures worth catching are all of that shape — a path that verifies
 * nothing, an unavailable path that charges the user anyway, a disable that forgets
 * the session sweep — and none of them would be visible in a test that only checked
 * a method was reached.
 *
 * Limits are read through `policy()` rather than transcribed, so a founder changing
 * a number does not need to change this file.
 */

const USER = makeUser();
const SESSION_ID = '01940000-0000-7000-8000-0000000000aa';
const IP_CLASS = '203.0.113.0/24';

const ASSERTION = { id: 'credential-id' } as unknown as AuthenticationResponseJSON;

/** The KYC port, doubled. Typed as mocks so `.mock.calls` is reachable while the
 *  object still satisfies the port where the service expects one. */
interface MockedKyc extends KycStatusPort {
  isVerified: Mock<(userId: string) => Promise<boolean>>;
  reverify: Mock<(userId: string, evidence: { reference: string }) => Promise<boolean>>;
}

/**
 * The factor tables, doubled.
 *
 * Default account: two passkeys, no authenticator, eight unused backup codes. Tests
 * that need a different account move THESE, not the derived views below.
 */
function createFactors() {
  return {
    listPasskeys: vi.fn(async (): Promise<{ id: string }[]> => [{ id: 'pk-1' }, { id: 'pk-2' }]),
    listConfirmedTotpFactors: vi.fn(async (): Promise<{ id: string }[]> => []),
    findPendingTotpFactor: vi.fn(async (): Promise<{ id: string } | null> => null),
    countUnusedRecoveryCodes: vi.fn(async () => 8),
    softDeleteAllPasskeys: vi.fn(async () => 2),
    softDeleteAllTotpFactors: vi.fn(async () => 1),
  };
}

/**
 * `MfaService`, doubled — DERIVED from the factor doubles rather than stubbed
 * independently.
 *
 * ─── Why derived, which is the whole point of this function ─────────────────
 *
 * The real `MfaService.availableMethods` computes its answer from
 * `listConfirmedTotpFactors`, `listPasskeys` and `countUnusedRecoveryCodes`, so in
 * production it CANNOT disagree with them. Two independently stubbed doubles can:
 * `listPasskeys: []` alongside `availableMethods: ['passkey']` describes an account
 * that does not exist, and a service tested against an impossible account is tested
 * against nothing in particular.
 *
 * Deriving it makes that state unreachable. A test that wants an authenticator sets
 * `listConfirmedTotpFactors`; one that wants biometrics off sets `listPasskeys`; and
 * the view follows, as it does in the real thing.
 */
function createMfa(factors: ReturnType<typeof createFactors>) {
  return {
    availableMethods: vi.fn(async (): Promise<string[]> => {
      const [totp, passkeys, recovery] = await Promise.all([
        factors.listConfirmedTotpFactors(),
        factors.listPasskeys(),
        factors.countUnusedRecoveryCodes(),
      ]);

      const methods: string[] = [];
      if (totp.length > 0) methods.push('totp');
      if (passkeys.length > 0) methods.push('passkey');
      // Never the only method offered — the same rule the real service applies.
      if (recovery > 0 && methods.length > 0) methods.push('recovery_code');
      return methods;
    }),
  };
}

function createTwoFactor() {
  return {
    consumeCredentialOtp: vi.fn(async () => undefined),
    provePasskeyAssertion: vi.fn(async () => true),
    proveTotpCode: vi.fn(async () => true),
    proveBackupCode: vi.fn(async () => true),
    clearRecoveryCodesIfLastFactor: vi.fn(async () => undefined),
    passkeyAddChallenge: vi.fn(async () => ({ challenge: 'opts' })),
    passkeyAddVerify: vi.fn(async () => ({
      factor: { id: 'pk-new', label: 'Passkey', createdAt: FIXED_NOW },
      recoveryCodes: ['4X7K9-M2QRT'],
    })),
    totpAdd: vi.fn(async () => ({ secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' })),
    totpConfirm: vi.fn(async () => ({ recoveryCodes: ['4X7K9-M2QRT'] })),
  };
}

function createCache() {
  return {
    // Typed with its real parameters so assertions can read the KEY off a call,
    // which is the whole point of the shared-bucket tests below.
    consume: vi.fn(async (_key: string, _limit: unknown, _onFailure: string) => undefined),
  };
}

describe('SettingsService', () => {
  let factors: ReturnType<typeof createFactors>;
  let twoFactor: ReturnType<typeof createTwoFactor>;
  let cache: ReturnType<typeof createCache>;
  let quota: ReturnType<typeof makeQuota>;
  let mfa: ReturnType<typeof createMfa>;
  let sessions: { revokeAllForUserExcept: ReturnType<typeof vi.fn> };
  let users: { findById: ReturnType<typeof vi.fn>; findWithCredential: ReturnType<typeof vi.fn> };
  let mail: { sendSecurityChanged: ReturnType<typeof vi.fn> };
  let kyc: MockedKyc;
  let service: SettingsService;

  function build(): SettingsService {
    return new SettingsService(
      twoFactor as never,
      factors as never,
      mfa as never,
      sessions as never,
      users as never,
      cache as never,
      quota as never,
      mail as never,
      makeSecurityChangePolicy() as never,
      makeRestrictions() as never,
      kyc,
    );
  }

  beforeEach(() => {
    factors = createFactors();
    twoFactor = createTwoFactor();
    cache = createCache();
    quota = makeQuota();
    mfa = createMfa(factors);
    sessions = { revokeAllForUserExcept: vi.fn(async () => undefined) };
    users = {
      findById: vi.fn(async () => USER),
      findWithCredential: vi.fn(async () => ({ user: USER, credential: null })),
    };
    mail = { sendSecurityChanged: vi.fn(() => undefined) };
    kyc = { isVerified: vi.fn(async () => false), reverify: vi.fn(async () => true) };
    service = build();
  });

  async function problem(call: Promise<unknown>): Promise<ProblemException> {
    try {
      await call;
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemException);
      return err as ProblemException;
    }
    throw new Error('expected the call to reject, but it resolved');
  }

  const disable = (proofs: Record<string, unknown>) =>
    service.disable(USER.id, SESSION_ID, FACTS, proofs);

  // ─── the four paths ───────────────────────────────────────────────────────

  describe('each path proves only its own credential', () => {
    it('backup-code spends the code and checks nothing else', async () => {
      await disable({ backupCode: '4X7K9-M2QRT' });

      expect(twoFactor.proveBackupCode).toHaveBeenCalledWith(USER.id, '4X7K9-M2QRT');
      // The whole point of this path: no mailbox round trip, because it exists for a
      // user whose passkey is gone.
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
      expect(twoFactor.provePasskeyAssertion).not.toHaveBeenCalled();
      expect(twoFactor.proveTotpCode).not.toHaveBeenCalled();
    });

    it('passkey+otp consumes the emailed code and verifies the assertion', async () => {
      await disable({ passkey: ASSERTION, emailCode: '000000' });

      expect(twoFactor.consumeCredentialOtp).toHaveBeenCalledWith(USER.id, '000000');
      expect(twoFactor.provePasskeyAssertion).toHaveBeenCalledWith(USER.id, ASSERTION);
      expect(twoFactor.proveTotpCode).not.toHaveBeenCalled();
    });

    it('totp+otp consumes the emailed code and verifies the TOTP code', async () => {
      factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 'totp-1' }]);

      await disable({ totpCode: '123456', emailCode: '000000' });

      expect(twoFactor.consumeCredentialOtp).toHaveBeenCalledWith(USER.id, '000000');
      expect(twoFactor.proveTotpCode).toHaveBeenCalledWith(USER.id, '123456');
      // The defect this guards: today's generic `remove` tries the passkey branch
      // first and returns on success, so a caller naming TOTP could be authorised by
      // something else entirely.
      expect(twoFactor.provePasskeyAssertion).not.toHaveBeenCalled();
    });

    it('a TOTP code does NOT authorise the passkey path', async () => {
      // Sending a TOTP code names `totp+otp`. If no authenticator is enrolled, that
      // path is closed and the request is refused — it is not silently re-routed to a
      // passkey assertion the caller never sent. (No authenticator is the default
      // account; stated here so the premise is not invisible.)
      expect(await factors.listConfirmedTotpFactors()).toHaveLength(0);

      const err = await problem(disable({ totpCode: '123456', emailCode: '000000' }));

      expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
      expect(factors.softDeleteAllPasskeys).not.toHaveBeenCalled();
    });

    it('refuses proofs for two paths at once, changing nothing', async () => {
      const err = await problem(
        disable({ passkey: ASSERTION, totpCode: '123456', emailCode: '000000' }),
      );

      expect(err.type).toBe(ERR.VALIDATION_FAILED);
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
      expect(factors.softDeleteAllPasskeys).not.toHaveBeenCalled();
    });

    it('refuses a wrong credential with mfa_code_invalid and disables nothing', async () => {
      twoFactor.proveBackupCode.mockResolvedValue(false);

      const err = await problem(disable({ backupCode: 'WRONG-CODE1' }));

      expect(err.type).toBe(ERR.MFA_CODE_INVALID);
      expect(factors.softDeleteAllPasskeys).not.toHaveBeenCalled();
      expect(sessions.revokeAllForUserExcept).not.toHaveBeenCalled();
    });
  });

  // ─── availability is checked before anything is consumed ──────────────────

  describe('an unavailable path costs the caller nothing', () => {
    it('does not consume the emailed code when no authenticator is enrolled', async () => {
      // The default account has none.
      await problem(disable({ totpCode: '123456', emailCode: '000000' }));

      // The reason availability is checked first: discovering the path is closed by
      // spending the user's code would charge them for the server's knowledge.
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('refuses the backup-code path when every code is spent', async () => {
      factors.countUnusedRecoveryCodes.mockResolvedValue(0);

      const err = await problem(disable({ backupCode: '4X7K9-M2QRT' }));

      expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
      expect(twoFactor.proveBackupCode).not.toHaveBeenCalled();
    });

    it('refuses the passkey path when biometrics is already off', async () => {
      factors.listPasskeys.mockResolvedValue([]);

      const err = await problem(disable({ passkey: ASSERTION, emailCode: '000000' }));

      expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });

    it('refuses the KYC path, and charges no quota, when KYC is not verified', async () => {
      const err = await problem(disable({ kyc: { reference: 'handle' }, emailCode: '000000' }));

      expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
      expect(quota.consumeAll).not.toHaveBeenCalled();
      expect(kyc.reverify).not.toHaveBeenCalled();
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    });
  });

  // ─── the write ────────────────────────────────────────────────────────────

  describe('a successful disable', () => {
    it('retires every passkey, not one', async () => {
      const result = await disable({ backupCode: '4X7K9-M2QRT' });

      expect(factors.softDeleteAllPasskeys).toHaveBeenCalledWith(USER.id, expect.anything(), expect.anything());
      expect(result.removed).toBe(2);
      expect(result.path).toBe('backup-code');
    });

    it('signs out every session except the one making the request', async () => {
      await disable({ backupCode: '4X7K9-M2QRT' });

      expect(sessions.revokeAllForUserExcept).toHaveBeenCalledWith(
        USER.id,
        SESSION_ID,
        REVOKE_REASON.PASSKEY_DISABLED,
      );
    });

    it('applies the last-factor rule rather than reimplementing it', async () => {
      await disable({ backupCode: '4X7K9-M2QRT' });
      expect(twoFactor.clearRecoveryCodesIfLastFactor).toHaveBeenCalledWith(USER.id);
    });

    it('emails a notification', async () => {
      await disable({ backupCode: '4X7K9-M2QRT' });

      expect(mail.sendSecurityChanged).toHaveBeenCalledWith(
        USER.email,
        expect.stringContaining('biometric'),
        FACTS.ipClass,
        // No anti-phishing code on the fixture account, so the notification carries
        // null and renders without the footer.
        null,
      );
    });

    it('still reports success when the account row cannot be read for the email', async () => {
      // The setting is already changed by then. Failing the call would report a
      // completed security change as not having happened.
      users.findById.mockResolvedValue(null);

      await expect(disable({ backupCode: '4X7K9-M2QRT' })).resolves.toMatchObject({
        removed: 2,
      });
      expect(mail.sendSecurityChanged).not.toHaveBeenCalled();
    });

    it('meters the attempt on the account, before proving anything', async () => {
      await disable({ backupCode: '4X7K9-M2QRT' });

      expect(cache.consume).toHaveBeenCalledWith(
        KEYS.rate.securitySettingsDisableByAccount(USER.id),
        policy().SECURITY_SETTINGS.DISABLE_BY_ACCOUNT,
        'deny',
      );
    });

    it('refuses before touching anything when the limiter is exhausted', async () => {
      cache.consume.mockRejectedValue(new ProblemException({ type: ERR.RATE_LIMITED }));

      const err = await problem(disable({ backupCode: '4X7K9-M2QRT' }));

      expect(err.type).toBe(ERR.RATE_LIMITED);
      expect(twoFactor.proveBackupCode).not.toHaveBeenCalled();
      expect(factors.softDeleteAllPasskeys).not.toHaveBeenCalled();
    });
  });

  // ─── the KYC path's quota ─────────────────────────────────────────────────

  describe('the KYC reverification cap', () => {
    beforeEach(() => {
      kyc.isVerified = vi.fn(async () => true);
      service = build();
    });

    it('charges both windows in one atomic decision', async () => {
      await disable({ kyc: { reference: 'handle' }, emailCode: '000000' });

      expect(quota.consumeAll).toHaveBeenCalledTimes(1);
      const call = quota.consumeAll.mock.calls[0];
      const entries = call?.[0] ?? [];
      const store = call?.[1];
      expect(entries.map((e) => e.key)).toEqual([
        KEYS.rate.kycReverifyByAccount(USER.id),
        KEYS.rate.kycReverifyByAccountMonthly(USER.id),
      ]);
      // Durable: a ceiling of two per thirty days that a cache restart resets is not
      // a ceiling.
      expect(store).toBe('durable');
    });

    it('charges before the provider is called', async () => {
      const order: string[] = [];
      quota.consumeAll.mockImplementation(async () => {
        order.push('charge');
        return { token: 't', keys: [] };
      });
      kyc.reverify = vi.fn(async () => {
        order.push('reverify');
        return true;
      });
      service = build();

      await disable({ kyc: { reference: 'handle' }, emailCode: '000000' });

      expect(order).toEqual(['charge', 'reverify']);
    });

    it('does NOT refund a genuine mismatch', async () => {
      // A `false` is the provider's answer — it looked, and the face did not match.
      // That is the event the cap exists to ration, so it has to be paid for.
      kyc.reverify = vi.fn(async () => false);
      service = build();

      const err = await problem(
        disable({ kyc: { reference: 'handle' }, emailCode: '000000' }),
      );

      expect(err.type).toBe(ERR.MFA_CODE_INVALID);
      expect(quota.refund).not.toHaveBeenCalled();
      expect(quota.countFor(KEYS.rate.kycReverifyByAccount(USER.id))).toBe(1);
    });

    it('refunds a provider outage', async () => {
      // Not the user's fault, and spending one of two monthly attempts on someone
      // else's incident would turn an outage into a lockout.
      kyc.reverify = vi.fn(async () => {
        throw new Error('provider unreachable');
      });
      service = build();

      await expect(
        disable({ kyc: { reference: 'handle' }, emailCode: '000000' }),
      ).rejects.toThrow('provider unreachable');

      expect(quota.refund).toHaveBeenCalledTimes(1);
      expect(quota.countFor(KEYS.rate.kycReverifyByAccount(USER.id))).toBe(0);
    });

    it('refuses once the daily window is spent, without calling the provider', async () => {
      const daily = policy().SECURITY_SETTINGS.KYC_REVERIFY_BY_ACCOUNT[0]?.limit ?? 1;
      for (let n = 0; n < daily; n += 1) {
        await disable({ kyc: { reference: 'handle' }, emailCode: '000000' });
      }
      const calls = kyc.reverify.mock.calls.length;

      const err = await problem(
        disable({ kyc: { reference: 'handle' }, emailCode: '000000' }),
      );

      expect(err.type).toBe(ERR.RATE_LIMITED);
      expect(kyc.reverify.mock.calls.length).toBe(calls);
    });
  });

  // ─── enabling ─────────────────────────────────────────────────────────────

  describe('enabling', () => {
    it('spends the emailed code before minting the challenge', async () => {
      const order: string[] = [];
      twoFactor.consumeCredentialOtp.mockImplementation(async () => {
        order.push('otp');
      });
      twoFactor.passkeyAddChallenge.mockImplementation(async () => {
        order.push('challenge');
        return { challenge: 'opts' };
      });
      service = build();

      await service.enableChallenge(USER.id, '000000');

      expect(order).toEqual(['otp', 'challenge']);
    });

    it('does not mint a challenge when the emailed code is wrong', async () => {
      twoFactor.consumeCredentialOtp.mockRejectedValue(
        new ProblemException({ type: ERR.OTP_INVALID }),
      );

      const err = await problem(service.enableChallenge(USER.id, 'nope'));

      expect(err.type).toBe(ERR.OTP_INVALID);
      expect(twoFactor.passkeyAddChallenge).not.toHaveBeenCalled();
    });

    it('returns the backup codes the first enrollment mints', async () => {
      const result = await service.enableVerify(USER.id, ASSERTION as never, 'My phone');
      expect(result.backupCodes).toEqual(['4X7K9-M2QRT']);
    });

    it('returns an empty set on a later passkey', async () => {
      // `passkeyAddVerify` mints only on the 0→1 transition, so this is the honest
      // answer rather than an omission — a client renders "keep these safe" exactly
      // when there is something to keep.
      twoFactor.passkeyAddVerify.mockResolvedValue({
        factor: { id: 'pk-3', label: 'Laptop', createdAt: FIXED_NOW },
        recoveryCodes: [],
      });

      const result = await service.enableVerify(USER.id, ASSERTION as never);
      expect(result.backupCodes).toEqual([]);
    });
  });

  // ─── the status read ──────────────────────────────────────────────────────

  describe('biometricsStatus', () => {
    it('reports every path unavailable when biometrics is off', async () => {
      factors.listPasskeys.mockResolvedValue([]);

      const status = await service.biometricsStatus(USER.id);

      expect(status.enabled).toBe(false);
      expect(status.disablePaths.every((p) => !p.available)).toBe(true);
      // Every refusal carries a sentence, because a greyed-out option with no
      // explanation is what a support ticket is about.
      expect(status.disablePaths.every((p) => (p.reason ?? '').length > 0)).toBe(true);
    });

    it('opens exactly the paths the account can use', async () => {
      const status = await service.biometricsStatus(USER.id);

      const open = status.disablePaths.filter((p) => p.available).map((p) => p.path);
      // No authenticator and no KYC, so two of four.
      expect(open.sort()).toEqual(['backup-code', 'passkey+otp']);
    });

    it('opens the TOTP path once an authenticator is enrolled', async () => {
      factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 'totp-1' }]);

      const status = await service.biometricsStatus(USER.id);

      expect(status.disablePaths.find((p) => p.path === 'totp+otp')?.available).toBe(true);
    });

    it('closes the backup-code path when no unused codes remain', async () => {
      factors.countUnusedRecoveryCodes.mockResolvedValue(0);

      const status = await service.biometricsStatus(USER.id);

      expect(status.disablePaths.find((p) => p.path === 'backup-code')?.available).toBe(false);
    });

    it('reports remaining slots from the policy, not a hardcoded number', async () => {
      const status = await service.biometricsStatus(USER.id);
      expect(status.remainingSlots).toBe(policy().MFA.PASSKEYS_PER_ACCOUNT - 2);
    });

    it('says which paths need an emailed code', async () => {
      const status = await service.biometricsStatus(USER.id);

      const needing = status.disablePaths
        .filter((p) => p.emailCodeRequired)
        .map((p) => p.path)
        .sort();
      expect(needing).toEqual(['kyc+otp', 'passkey+otp', 'totp+otp']);
    });
  });

  // ══ the authenticator surface ═════════════════════════════════════════════
  //
  // The same four paths over a different subject, so what is worth asserting is
  // (a) the parts that are genuinely TOTP-specific — the pending-row sweep, the
  // revoke reason, the one-per-account slot — and (b) that the shared machinery
  // really is shared rather than a second copy that happens to agree today.

  /** An account with the authenticator on. */
  function withAuthenticator(): void {
    factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 'totp-1' }]);
  }

  const disableAuth = (proofs: Record<string, unknown>) =>
    service.disableAuthenticator(USER.id, SESSION_ID, FACTS, proofs);

  describe('enabling the authenticator', () => {
    it('spends the emailed code before minting a secret', async () => {
      const result = await service.enableAuthenticatorChallenge(USER.id, '000000', 'Phone');

      expect(twoFactor.consumeCredentialOtp).toHaveBeenCalledWith(USER.id, '000000');
      expect(twoFactor.totpAdd).toHaveBeenCalledWith(USER, 'Phone');
      expect(result).toEqual({ secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' });
    });

    it('does not mint a secret when the emailed code is wrong', async () => {
      // The order that matters: a caller must not be able to obtain an enrollment
      // secret — or leave a pending row behind — with a bad code.
      twoFactor.consumeCredentialOtp.mockRejectedValue(
        new ProblemException({ type: ERR.MFA_CODE_INVALID }),
      );

      const err = await problem(service.enableAuthenticatorChallenge(USER.id, 'WRONG'));

      expect(err.type).toBe(ERR.MFA_CODE_INVALID);
      expect(twoFactor.totpAdd).not.toHaveBeenCalled();
    });

    it('returns the backup codes the confirmation minted', async () => {
      const result = await service.enableAuthenticatorVerify(USER.id, '123456');

      expect(twoFactor.totpConfirm).toHaveBeenCalledWith(USER.id, '123456');
      expect(result.backupCodes).toEqual(['4X7K9-M2QRT']);
    });

    it('reports an empty set when the account already had codes', async () => {
      // Delegated rather than re-decided: confirming a second factor must not
      // invalidate codes the user already wrote down, and `totpConfirm` owns that
      // rule. Empty is the honest answer, not a missing field.
      twoFactor.totpConfirm.mockResolvedValue({ recoveryCodes: [] });

      const result = await service.enableAuthenticatorVerify(USER.id, '123456');

      expect(result.backupCodes).toEqual([]);
    });
  });

  describe('authenticatorStatus', () => {
    it('reports the setting off, and no path open, on a fresh account', async () => {
      const status = await service.authenticatorStatus(USER.id);

      expect(status.factor).toBe('totp');
      expect(status.enabled).toBe(false);
      expect(status.disablePaths.every((p) => !p.available)).toBe(true);
      expect(status.disablePaths.every((p) => (p.reason ?? '').length > 0)).toBe(true);
    });

    it('offers the totp+otp path FIRST, because it is the ordinary one', async () => {
      // Order is the subject's, not the table's: a user disabling their
      // authenticator usually still holds it, so that path must not be third in a
      // list. The biometrics screen orders the same four the other way round.
      withAuthenticator();

      const status = await service.authenticatorStatus(USER.id);

      expect(status.disablePaths[0]?.path).toBe('totp+otp');
      expect((await service.biometricsStatus(USER.id)).disablePaths[0]?.path).toBe(
        'passkey+otp',
      );
    });

    it('opens exactly the paths the account can use', async () => {
      withAuthenticator();

      const status = await service.authenticatorStatus(USER.id);

      const open = status.disablePaths.filter((p) => p.available).map((p) => p.path);
      // Two passkeys and eight codes on the default account, no KYC.
      expect(open.sort()).toEqual(['backup-code', 'passkey+otp', 'totp+otp']);
    });

    it('closes the passkey path when biometrics is off', async () => {
      withAuthenticator();
      factors.listPasskeys.mockResolvedValue([]);

      const status = await service.authenticatorStatus(USER.id);

      expect(status.disablePaths.find((p) => p.path === 'passkey+otp')?.available).toBe(false);
    });

    it('reports one slot free, or none — an authenticator is one per account', async () => {
      // Not `policy().MFA.PASSKEYS_PER_ACCOUNT`, and not a hardcoded number standing
      // in for a policy: one per account is a product rule `totpAdd` enforces, which
      // is why there is nothing in DEFAULTS to read it from.
      expect((await service.authenticatorStatus(USER.id)).remainingSlots).toBe(1);

      withAuthenticator();
      const on = await service.authenticatorStatus(USER.id);
      expect(on.remainingSlots).toBe(0);
      expect(on.factorCount).toBe(1);
    });
  });

  describe('disabling the authenticator', () => {
    beforeEach(withAuthenticator);

    it('sweeps the whole account, not one named factor id', async () => {
      // "The authenticator is off" is a statement about the account, so the sweep is
      // the account-wide call and never `softDeleteTotpFactor(id, …)`. That the
      // sweep's own predicate also takes UNCONFIRMED rows — the hazard that makes
      // this route safe against a later bearer-only `totp-confirm` — is a property
      // of the Prisma predicate, so it is asserted where the predicate lives:
      // tests/2fa/2fa.dboperation.spec.ts.
      const result = await disableAuth({ backupCode: '4X7K9-M2QRT' });

      expect(factors.softDeleteAllTotpFactors).toHaveBeenCalledWith(USER.id, expect.anything(), expect.anything());
      expect(factors.softDeleteAllPasskeys).not.toHaveBeenCalled();
      expect(result.removed).toBe(1);
      expect(result.path).toBe('backup-code');
    });

    it('signs out every other session, naming TOTP as the reason', async () => {
      await disableAuth({ totpCode: '123456', emailCode: '000000' });

      expect(sessions.revokeAllForUserExcept).toHaveBeenCalledWith(
        USER.id,
        SESSION_ID,
        REVOKE_REASON.TOTP_DISABLED,
      );
    });

    it('emails a notification naming the authenticator, not biometrics', async () => {
      await disableAuth({ backupCode: '4X7K9-M2QRT' });

      expect(mail.sendSecurityChanged).toHaveBeenCalledWith(
        USER.email,
        expect.stringContaining('authenticator'),
        FACTS.ipClass,
        null,
      );
    });

    it('applies the last-factor rule rather than reimplementing it', async () => {
      await disableAuth({ backupCode: '4X7K9-M2QRT' });
      expect(twoFactor.clearRecoveryCodesIfLastFactor).toHaveBeenCalledWith(USER.id);
    });

    it('accepts the passkey path as the cross-factor fallback', async () => {
      await disableAuth({ passkey: ASSERTION, emailCode: '000000' });

      expect(twoFactor.provePasskeyAssertion).toHaveBeenCalledWith(USER.id, ASSERTION);
      expect(twoFactor.proveTotpCode).not.toHaveBeenCalled();
      expect(factors.softDeleteAllTotpFactors).toHaveBeenCalledWith(USER.id, expect.anything(), expect.anything());
    });

    it('a passkey assertion does NOT authorise the totp+otp path', async () => {
      // The converse of the passkey surface's isolation case, and the reason
      // `resolveDisablePath` refuses ambiguity rather than picking a winner: a caller
      // who names one path must not be authorised by a different credential.
      const err = await problem(
        disableAuth({ passkey: ASSERTION, totpCode: '123456', emailCode: '000000' }),
      );

      expect(err.type).toBe(ERR.VALIDATION_FAILED);
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
      expect(factors.softDeleteAllTotpFactors).not.toHaveBeenCalled();
    });

    it('refuses the totp+otp path — and spends nothing — when the setting is off', async () => {
      factors.listConfirmedTotpFactors.mockResolvedValue([]);

      const err = await problem(disableAuth({ totpCode: '123456', emailCode: '000000' }));

      expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
      expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
      expect(factors.softDeleteAllTotpFactors).not.toHaveBeenCalled();
    });

    it('refuses a wrong credential and disables nothing', async () => {
      twoFactor.proveBackupCode.mockResolvedValue(false);

      const err = await problem(disableAuth({ backupCode: 'WRONG-CODE1' }));

      expect(err.type).toBe(ERR.MFA_CODE_INVALID);
      expect(factors.softDeleteAllTotpFactors).not.toHaveBeenCalled();
      expect(sessions.revokeAllForUserExcept).not.toHaveBeenCalled();
    });
  });

  // ─── the two surfaces share their budgets ─────────────────────────────────

  describe('both surfaces charge the same buckets', () => {
    beforeEach(withAuthenticator);

    it('meters disables on ONE account key, whichever factor is being turned off', async () => {
      // A per-surface key would let a caller guess backup codes five times on each
      // screen — ten guesses behind a limit that still reads as five. The key carries
      // no subject, and this is what says so.
      await disableAuth({ backupCode: '4X7K9-M2QRT' });
      await disable({ backupCode: '4X7K9-M2QRT' });

      const keys = cache.consume.mock.calls.map((call) => call[0]);
      expect(keys).toEqual([
        KEYS.rate.securitySettingsDisableByAccount(USER.id),
        KEYS.rate.securitySettingsDisableByAccount(USER.id),
      ]);
    });

    it('spends ONE KYC ceiling across both surfaces', async () => {
      // The cap rations image checks — a third-party call, and a user being asked to
      // photograph themselves — and neither cost is halved by which screen asked.
      // Two buckets would turn a documented twice-a-month into four times a month.
      kyc.isVerified.mockResolvedValue(true);
      const daily = policy().SECURITY_SETTINGS.KYC_REVERIFY_BY_ACCOUNT[0]?.limit ?? 1;

      for (let n = 0; n < daily; n += 1) {
        await disableAuth({ kyc: { reference: 'handle' }, emailCode: '000000' });
      }

      // The allowance is now spent — on the OTHER surface.
      const err = await problem(disable({ kyc: { reference: 'handle' }, emailCode: '000000' }));

      expect(err.type).toBe(ERR.RATE_LIMITED);
    });
  });
});

// ─── the shipped KYC stub ───────────────────────────────────────────────────

describe('NullKycProvider', () => {
  const provider = new NullKycProvider();

  it('reports every account unverified, so the path stays dark', async () => {
    await expect(provider.isVerified('any-user')).resolves.toBe(false);
  });

  it('throws rather than returning false', async () => {
    // The distinction is the point even in a stub: `false` is a MISMATCH, which
    // costs the user one of a very few attempts. "There is no provider" is not that,
    // and returning false here would silently spend a monthly allowance.
    await expect(provider.reverify('any-user', { reference: 'x' })).rejects.toBeInstanceOf(
      ProblemException,
    );
  });
});
