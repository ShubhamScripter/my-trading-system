import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TOTP primitives mocked for the same reason as in mfa.service.spec.ts: RFC 6238
 * correctness and the AES envelope are covered exhaustively by totp.spec.ts, and this
 * file is about enrollment/management decisions rather than the arithmetic.
 */
vi.mock('../../src/2fa/totp', () => ({
  openFactorSecret: vi.fn(() => Buffer.from('secret')),
  verifyCode: vi.fn(() => 1_000_000n),
  generateSecret: vi.fn(() => Buffer.from('new-secret')),
  sealSecret: vi.fn(() => ({
    ciphertext: new Uint8Array([1]),
    iv: new Uint8Array([2]),
    tag: new Uint8Array([3]),
  })),
  base32Encode: vi.fn(() => 'BASE32SECRET'),
  otpauthUri: vi.fn(() => 'otpauth://totp/x'),
}));

/**
 * The WebAuthn primitives are mocked for the same reason as the TOTP ones: a real
 * assertion or attestation cannot be constructed in a unit test without a real
 * authenticator, and `passkey.ts` owns that verification. What this file decides is
 * what happens AROUND a successful or failed ceremony — which namespace the challenge
 * lives in, and whether recovery codes are returned.
 */
vi.mock('../../src/2fa/passkey', () => ({
  buildRegistrationOptions: vi.fn(async () => ({ challenge: 'chal' })),
  buildAuthenticationOptions: vi.fn(async () => ({ challenge: 'chal' })),
  challengeOf: vi.fn(() => 'chal'),
  serialiseChallenge: vi.fn((record: unknown) => JSON.stringify(record)),
  parseChallenge: vi.fn((raw: string | null) => {
    if (raw === null) throw new Error('no challenge');
    return JSON.parse(raw) as { mode: string; challenge: string };
  }),
  verifyRegistration: vi.fn(async () => ({
    credentialId: 'cred-1',
    publicKey: new Uint8Array([1]),
    signCount: 0n,
    transports: [],
    aaguid: null,
  })),
  verifyAuthentication: vi.fn(async () => ({ newSignCount: 1n })),
}));

import { verifyCode } from '../../src/2fa/totp';
import type { CredentialService } from '../../auth/services/credential.service';
import type { UserDbOperation } from '../../auth/persistence/user.dboperation';
import type { CacheService } from '../../redis';
import { KEYS } from '../../redis';
import type { TwoFactorDbOperation } from '../../src/2fa/2fa.dboperation';
import type { ElevationService } from '../../src/2fa/elevation';
import { MfaService } from '../../src/2fa/mfa.service';
import { TwoFactorService } from '../../src/2fa/2fa.service';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import type { ChallengeDbOperation } from '../../auth/persistence/challenge.dboperation';
import type { MailService } from '../../src/mail/mail.service';
import { pepperedHash } from '../../auth/auth.utility';
import { makeCredential, makeSecurityChangePolicy, makeUser } from '../harness';

/**
 * TwoFactorService — enrollment, management, and re-authentication.
 *
 * There was no spec for this file, which is why four defects reached review: the
 * TOTP confirm race, the discarded passkey recovery codes, the lost-factor dead end,
 * and the unmetered re-authentication that could lock an account out.
 */

const user = makeUser();
const TICKET = { ticket: 't', expiresInSeconds: 60, action: 'account.mfa.remove' as const };

function createFactors() {
  return {
    listConfirmedTotpFactors: vi.fn().mockResolvedValue([]),
    listPasskeys: vi.fn().mockResolvedValue([]),
    countUnusedRecoveryCodes: vi.fn().mockResolvedValue(0),
    findPendingTotpFactor: vi.fn().mockResolvedValue(null),
    softDeleteTotpFactor: vi.fn().mockResolvedValue(true),
    createTotpFactor: vi.fn(),
    confirmTotpFactor: vi.fn().mockResolvedValue(true),
    claimTotpStep: vi.fn().mockResolvedValue(true),
    hasAnyRecoveryCode: vi.fn().mockResolvedValue(false),
    replaceRecoveryCodes: vi.fn().mockResolvedValue(undefined),
    spendRecoveryCode: vi.fn().mockResolvedValue(false),
    findPasskeyByCredentialId: vi.fn().mockResolvedValue(null),
    createPasskey: vi.fn(),
    touchPasskey: vi.fn().mockResolvedValue(undefined),
    softDeletePasskey: vi.fn().mockResolvedValue(true),
  };
}

function createCache() {
  return {
    set: vi.fn().mockResolvedValue(undefined),
    take: vi.fn().mockResolvedValue(null),
    consume: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * The challenge dboperation, doubled.
 *
 * `findLive` returning null by default means "no emailed code outstanding", which is
 * the state most of these cases describe. `withEmailCode()` below supplies one.
 */
function createChallenges() {
  return {
    issue: vi.fn().mockResolvedValue({ id: 'chal-1' }),
    findLive: vi.fn().mockResolvedValue(null),
    incrementAttempts: vi.fn().mockResolvedValue(1),
    consume: vi.fn().mockResolvedValue(true),
    invalidate: vi.fn().mockResolvedValue(undefined),
  };
}

let factors: ReturnType<typeof createFactors>;
let cache: ReturnType<typeof createCache>;
let challenges: ReturnType<typeof createChallenges>;
let mail: { sendOtp: ReturnType<typeof vi.fn> };
let elevation: { issue: ReturnType<typeof vi.fn> };
let credentials: { checkPassword: ReturnType<typeof vi.fn> };
let users: { findWithCredential: ReturnType<typeof vi.fn> };
let securityChanges: ReturnType<typeof makeSecurityChangePolicy>;
let service: TwoFactorService;

const EMAIL_CODE = '123456';

/** An outstanding, correct credential-change code. */
function withEmailCode(): void {
  challenges.findLive.mockResolvedValue({
    id: 'chal-1',
    userId: user.id,
    purpose: 'CREDENTIAL_CHANGE',
    codeHash: pepperedHash(EMAIL_CODE, 'otp'),
    expiresAt: new Date(Date.now() + 600_000),
    attempts: 0,
    consumedAt: null,
  });
}

beforeEach(() => {
  factors = createFactors();
  cache = createCache();
  challenges = createChallenges();
  mail = { sendOtp: vi.fn() };
  elevation = { issue: vi.fn().mockResolvedValue(TICKET) };
  credentials = { checkPassword: vi.fn().mockResolvedValue(true) };
  users = {
    findWithCredential: vi.fn().mockResolvedValue({ user, credential: makeCredential() }),
  };
  securityChanges = makeSecurityChangePolicy();

  service = new TwoFactorService(
    factors as unknown as TwoFactorDbOperation,
    // A REAL MfaService over the same doubled dboperation, so `hasFactor` and
    // `availableMethods` answer from one source of truth rather than from a second
    // double that could disagree with it.
    new MfaService(factors as unknown as TwoFactorDbOperation),
    elevation as unknown as ElevationService,
    credentials as unknown as CredentialService,
    users as unknown as UserDbOperation,
    cache as unknown as CacheService,
    challenges as unknown as ChallengeDbOperation,
    mail as unknown as MailService,
    securityChanges as never,
  );
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

/** An account with a confirmed TOTP factor — i.e. `hasFactor` is true. */
function withTotpEnrolled(): void {
  factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 'totp-1' }]);
}

describe('reauthVerify — the lost-factor path', () => {
  /**
   * The dead end this unsticks: a user whose only authenticator is gone still has
   * `hasFactor === true`, so re-authentication demanded the very factor they lost.
   * They could sign in with a recovery code and then do nothing — every management
   * action is ticket-gated, and adding a password does not help because `hasFactor`
   * is checked first.
   */

  beforeEach(() => {
    withTotpEnrolled();
    factors.countUnusedRecoveryCodes.mockResolvedValue(10);
  });

  it('accepts a recovery code for account.mfa.remove', async () => {
    factors.spendRecoveryCode.mockResolvedValue(true);

    await expect(
      service.reauthVerify(user, 'session-1', 'account.mfa.remove', {
        recoveryCode: 'ABCD-EFGH',
      }),
    ).resolves.toMatchObject({ action: 'account.mfa.remove' });

    expect(elevation.issue).toHaveBeenCalledWith('session-1', 'account.mfa.remove');
  });

  it('refuses a recovery code for enrolling a factor', async () => {
    // The half of the original rule that was right: a found printout must not be able
    // to ADD a credential, or it becomes a takeover.
    factors.spendRecoveryCode.mockResolvedValue(true);

    const err = await problem(
      service.reauthVerify(user, 'session-1', 'account.mfa.enroll', {
        recoveryCode: 'ABCD-EFGH',
      }),
    );

    expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
    expect(elevation.issue).not.toHaveBeenCalled();
  });

  it('refuses a recovery code for attaching an OAuth provider', async () => {
    factors.spendRecoveryCode.mockResolvedValue(true);

    const err = await problem(
      service.reauthVerify(user, 'session-1', 'account.oauth.link', {
        recoveryCode: 'ABCD-EFGH',
      }),
    );
    expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
  });

  it('does not spend the code when the intent forbids it', async () => {
    // Refused before consumption, so a client that asks for the wrong thing does not
    // silently burn one of ten codes.
    await problem(
      service.reauthVerify(user, 'session-1', 'account.mfa.enroll', {
        recoveryCode: 'ABCD-EFGH',
      }),
    );
    expect(factors.spendRecoveryCode).not.toHaveBeenCalled();
  });

  it('refuses a wrong recovery code without issuing a ticket', async () => {
    factors.spendRecoveryCode.mockResolvedValue(false);

    const err = await problem(
      service.reauthVerify(user, 'session-1', 'account.mfa.remove', {
        recoveryCode: 'WRONG',
      }),
    );

    expect(err.type).toBe(ERR.MFA_CODE_INVALID);
    expect(elevation.issue).not.toHaveBeenCalled();
  });

  it('spends the code through the CAS, so it cannot be replayed', async () => {
    factors.spendRecoveryCode.mockResolvedValue(true);

    await service.reauthVerify(user, 'session-1', 'account.mfa.remove', {
      recoveryCode: 'ABCD-EFGH',
    });

    expect(factors.spendRecoveryCode).toHaveBeenCalledTimes(1);
    const [, hash] = factors.spendRecoveryCode.mock.calls[0] as [string, string];
    expect(hash).not.toContain('ABCD-EFGH');
  });

  it('advertises recovery_code for removal and withholds it for enrollment', async () => {
    const removal = await service.reauthChallenge(user.id, 'account.mfa.remove');
    const enroll = await service.reauthChallenge(user.id, 'account.mfa.enroll');

    expect(removal.methods).toContain('recovery_code');
    expect(enroll.methods).not.toContain('recovery_code');
  });

  it('withholds recovery_code when no intent is given', async () => {
    // The stricter default: a client that does not say what it wants is not offered
    // the method with the narrowest permitted use.
    const { methods } = await service.reauthChallenge(user.id);
    expect(methods).not.toContain('recovery_code');
  });
});

describe('reauthVerify — metering and error accuracy', () => {
  it('meters the session before comparing any credential', async () => {
    // A stolen access token used to be able to lock the account out through this
    // endpoint: `proveWithPassword` charges `Credential.failedAttempts` and nothing
    // bounded the route.
    withEmailCode();
    await service.reauthVerify(user, 'session-1', 'account.mfa.enroll', {
      password: 'correct horse',
      emailCode: EMAIL_CODE,
    });

    expect(cache.consume).toHaveBeenCalledWith(
      KEYS.rate.reauthBySession('session-1'),
      expect.anything(),
      'deny',
    );
  });

  it('reports a wrong PASSWORD as invalid credentials, not an invalid code', async () => {
    // On the bootstrap branch the credential compared is the password, and
    // `mfa_code_invalid` told the user to check a code they were never asked for.
    credentials.checkPassword.mockResolvedValue(false);
    withEmailCode();

    const err = await problem(
      service.reauthVerify(user, 'session-1', 'account.mfa.enroll', {
        password: 'wrong',
        emailCode: EMAIL_CODE,
      }),
    );
    expect(err.type).toBe(ERR.INVALID_CREDENTIALS);
  });

  it('reports a wrong TOTP code as an invalid code', async () => {
    withTotpEnrolled();
    withEmailCode();
    vi.mocked(verifyCode).mockReturnValue(null);

    const err = await problem(
      service.reauthVerify(user, 'session-1', 'account.mfa.remove', {
        totpCode: '000000',
        emailCode: EMAIL_CODE,
      }),
    );
    expect(err.type).toBe(ERR.MFA_CODE_INVALID);
  });

  it('tells a passwordless account to set a password, even with no password field', async () => {
    // The message was previously unreachable for the account it was written for: the
    // missing-field check ran first, so a passwordless caller got a bare
    // `invalid_credentials` unless it happened to send a dummy value.
    users.findWithCredential.mockResolvedValue({ user, credential: null });
    withEmailCode();

    const err = await problem(
      service.reauthVerify(user, 'session-1', 'account.mfa.enroll', { emailCode: EMAIL_CODE }),
    );

    expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
    expect(err.detail).toMatch(/set a password/i);
  });

  it('writes the reauth passkey challenge to its OWN namespace', async () => {
    // Shared with enrollment, a bearer-only reauth challenge could clobber a pending
    // enrollment challenge that had cost an elevation ticket.
    factors.listPasskeys.mockResolvedValue([{ id: 'pk-1', credentialId: 'c1', transports: [] }]);

    await service.reauthChallenge(user.id, 'account.mfa.remove');

    const [key] = cache.set.mock.calls[0] as [string];
    expect(key).toBe(KEYS.passkey.reauth(user.id));
    expect(key).not.toBe(KEYS.passkey.registration(user.id));
  });
});

describe('the credential-change email code', () => {
  /**
   * Product scope requires Email OTP on adding a passkey, enabling an authenticator
   * and disabling either. None of those paths sent or checked one: factor management
   * spent an elevation ticket and nothing else.
   */

  it('sends a code and records the requesting address', async () => {
    await expect(service.requestCredentialOtp(user, '203.0.113.7')).resolves.toEqual({
      sent: true,
    });

    expect(challenges.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        purpose: 'CREDENTIAL_CHANGE',
        ipAddress: '203.0.113.7',
      }),
    );
    expect(mail.sendOtp).toHaveBeenCalledTimes(1);
  });

  it('stores only a hash of the code it emails', async () => {
    await service.requestCredentialOtp(user, '203.0.113.7');

    const [issued] = challenges.issue.mock.calls[0] as [{ codeHash: string }];
    const [, emailed] = mail.sendOtp.mock.calls[0] as [string, string];

    expect(issued.codeHash).not.toBe(emailed);
    expect(issued.codeHash).toBe(pepperedHash(emailed, 'otp'));
  });

  it('uses CREDENTIAL_CHANGE, so it cannot clobber a password reset in flight', async () => {
    // `issue` retires the live row for its purpose. Sharing PASSWORD_RESET would mean
    // starting a factor change silently invalidated a reset already in the inbox.
    await service.requestCredentialOtp(user, '203.0.113.7');

    const [issued] = challenges.issue.mock.calls[0] as [{ purpose: string }];
    expect(issued.purpose).toBe('CREDENTIAL_CHANGE');
    expect(issued.purpose).not.toBe('PASSWORD_RESET');
  });

  it('meters sends per account, denying on a cache failure', async () => {
    await service.requestCredentialOtp(user, '203.0.113.7');

    expect(cache.consume).toHaveBeenCalledWith(
      KEYS.rate.credentialOtpByAccount(user.emailLower),
      expect.anything(),
      'deny',
    );
  });

  it('refuses to enrol a factor without an emailed code', async () => {
    const err = await problem(
      service.reauthVerify(user, 'session-1', 'account.mfa.enroll', { password: 'pw' }),
    );

    expect(err.type).toBe(ERR.OTP_REQUIRED);
    expect(elevation.issue).not.toHaveBeenCalled();
  });

  it('refuses to remove a factor without an emailed code', async () => {
    withTotpEnrolled();

    const err = await problem(
      service.reauthVerify(user, 'session-1', 'account.mfa.remove', { totpCode: '123456' }),
    );
    expect(err.type).toBe(ERR.OTP_REQUIRED);
  });

  it('spends the emailed code BEFORE comparing the factor', async () => {
    // So a wrong email code cannot be used to probe whether a TOTP guess was right,
    // and an abandoned request has still consumed it.
    withTotpEnrolled();
    withEmailCode();
    vi.mocked(verifyCode).mockReturnValue(null);

    await problem(
      service.reauthVerify(user, 'session-1', 'account.mfa.remove', {
        totpCode: '000000',
        emailCode: EMAIL_CODE,
      }),
    );

    expect(challenges.consume).toHaveBeenCalledWith('chal-1');
  });

  it('refuses a wrong emailed code without touching the factor', async () => {
    withTotpEnrolled();
    withEmailCode();

    const err = await problem(
      service.reauthVerify(user, 'session-1', 'account.mfa.remove', {
        totpCode: '123456',
        emailCode: '999999',
      }),
    );

    expect(err.type).toBe(ERR.OTP_INVALID);
    expect(elevation.issue).not.toHaveBeenCalled();
  });

  it('does NOT demand one on the recovery-code path', async () => {
    // Scope lists a backup code on its own as sufficient for disabling a factor, and
    // requiring a mailbox round trip too would re-close the lost-factor path.
    withTotpEnrolled();
    factors.spendRecoveryCode.mockResolvedValue(true);
    factors.countUnusedRecoveryCodes.mockResolvedValue(9);

    await expect(
      service.reauthVerify(user, 'session-1', 'account.mfa.remove', {
        recoveryCode: 'ABCD-EFGH',
      }),
    ).resolves.toMatchObject({ action: 'account.mfa.remove' });
  });

  it('does NOT demand one for attaching an OAuth provider', async () => {
    // Already behind a proved factor and a single-use ticket, and not listed in the
    // credential-security scope. Widening it here would change an untouched flow.
    await expect(
      service.reauthVerify(user, 'session-1', 'account.oauth.link', { password: 'pw' }),
    ).resolves.toBeTruthy();
  });
});

describe('totpConfirm — the confirmation race', () => {
  beforeEach(() => {
    factors.findPendingTotpFactor.mockResolvedValue({
      id: 'totp-pending',
      userId: user.id,
      secretCiphertext: new Uint8Array([1]),
      secretIv: new Uint8Array([2]),
      secretTag: new Uint8Array([3]),
    });
    vi.mocked(verifyCode).mockReturnValue(1_000_000n);
  });

  it('returns the codes when it wins the swap', async () => {
    factors.confirmTotpFactor.mockResolvedValue(true);

    const { recoveryCodes } = await service.totpConfirm(user.id, '123456');
    expect(recoveryCodes.length).toBeGreaterThan(0);
  });

  it('refuses when it LOSES the swap, rather than reporting a success', async () => {
    // The loser used to insert its recovery-code set anyway, leaving twenty live codes
    // and two distinct plaintext sets handed to two responses.
    factors.confirmTotpFactor.mockResolvedValue(false);

    const err = await problem(service.totpConfirm(user.id, '123456'));
    expect(err.type).toBe(ERR.MFA_ALREADY_ENROLLED);
  });

  it('requires the step claim to succeed', async () => {
    // Its result used to be discarded, so a second request presenting the same six
    // digits inside one 30-second step sailed past a CAS that had already refused it.
    factors.claimTotpStep.mockResolvedValue(false);

    const err = await problem(service.totpConfirm(user.id, '123456'));
    expect(err.type).toBe(ERR.MFA_CODE_ALREADY_USED);
    expect(factors.confirmTotpFactor).not.toHaveBeenCalled();
  });

  it('issues no codes when the account already has a set', async () => {
    factors.hasAnyRecoveryCode.mockResolvedValue(true);

    const { recoveryCodes } = await service.totpConfirm(user.id, '123456');
    expect(recoveryCodes).toEqual([]);
  });

  it('refuses a wrong code before touching the factor', async () => {
    vi.mocked(verifyCode).mockReturnValue(null);

    const err = await problem(service.totpConfirm(user.id, '000000'));
    expect(err.type).toBe(ERR.MFA_CODE_INVALID);
    expect(factors.confirmTotpFactor).not.toHaveBeenCalled();
  });
});

describe('passkeyAddVerify — recovery codes must be shown', () => {
  beforeEach(() => {
    cache.take.mockResolvedValue(JSON.stringify({ mode: 'register', challenge: 'chal' }));
    factors.createPasskey.mockResolvedValue({
      id: 'pk-1',
      label: 'Passkey',
      createdAt: new Date(),
      lastUsedAt: null,
    });
  });

  it('returns the plaintext codes when the passkey is the FIRST factor', async () => {
    // They used to be generated, hashed and discarded on one line, so a passkey-first
    // user was told they had ten codes nobody had ever shown them — and a later TOTP
    // confirm then returned an empty set, because `hasAnyRecoveryCode` found the
    // invisible ones.
    factors.hasAnyRecoveryCode.mockResolvedValue(false);

    const { factor, recoveryCodes } = await service.passkeyAddVerify(
      user.id,
      { id: 'cred-1' } as never,
    );

    expect(factor.kind).toBe('PASSKEY');
    expect(recoveryCodes.length).toBeGreaterThan(0);
    expect(factors.replaceRecoveryCodes).toHaveBeenCalledTimes(1);
  });

  it('returns an empty set when the account already had codes', async () => {
    // Confirming a second factor must not invalidate codes already written down.
    factors.hasAnyRecoveryCode.mockResolvedValue(true);

    const { recoveryCodes } = await service.passkeyAddVerify(
      user.id,
      { id: 'cred-1' } as never,
    );

    expect(recoveryCodes).toEqual([]);
    expect(factors.replaceRecoveryCodes).not.toHaveBeenCalled();
  });

  it('stores only hashes of the codes it returns', async () => {
    factors.hasAnyRecoveryCode.mockResolvedValue(false);

    const { recoveryCodes } = await service.passkeyAddVerify(
      user.id,
      { id: 'cred-1' } as never,
    );

    const [, hashes] = factors.replaceRecoveryCodes.mock.calls[0] as [string, string[]];
    for (const code of recoveryCodes) {
      expect(hashes).not.toContain(code);
    }
    expect(hashes).toHaveLength(recoveryCodes.length);
  });
});

describe('remove — neither kind is removable here any more', () => {
  /**
   * ─── Why this route refuses both of its kinds ─────────────────────────────
   *
   * Both factors became user SETTINGS, and turning either off has a policy this
   * action cannot express: one of four alternative proofs NAMED strictly, every
   * credential of that kind retired rather than one, and every other session swept.
   *
   * Leaving either kind working here would not be a second way to do the same thing
   * — it would be a one-call bypass of all three. This action accepts any single
   * enrolled factor with no distinction between them, deletes exactly the id it is
   * handed, and leaves other sessions running. `PASSKEY` was closed when biometrics
   * got its settings surface; `TOTP` followed when the authenticator got one.
   *
   * The action survives as a SHAPE — a runtime refusal, not a narrowing of
   * `removeSchema` — so an existing client gets a 4xx naming its replacement rather
   * than a validation error about an action that vanished.
   */
  it('refuses kind PASSKEY and names the route that replaces it', async () => {
    const err = await problem(service.remove(user.id, 'PASSKEY', 'pk-1'));

    expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
    expect(err.detail).toContain('/settings/security/passkeys/disable');
    // Refused before touching the table, not after.
    expect(factors.softDeletePasskey).not.toHaveBeenCalled();
  });

  it('refuses kind TOTP and names the route that replaces it', async () => {
    withTotpEnrolled();

    const err = await problem(service.remove(user.id, 'TOTP', 'totp-1'));

    expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
    expect(err.detail).toContain('/settings/security/authenticator/disable');
    expect(factors.softDeleteTotpFactor).not.toHaveBeenCalled();
  });

  it('refuses an enrolled factor and an unknown id alike, retiring nothing', async () => {
    // No `NOT_FOUND` branch survives: the answer no longer depends on whether the id
    // exists, so this route has stopped being a way to probe which ids are real.
    for (const id of ['totp-1', 'does-not-exist']) {
      const err = await problem(service.remove(user.id, 'TOTP', id));
      expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
    }

    expect(factors.softDeleteTotpFactor).not.toHaveBeenCalled();
  });

  it('does not touch the recovery codes, since it retires nothing', async () => {
    // The last-factor rule moved to the settings routes, which call
    // `clearRecoveryCodesIfLastFactor` after their own write. It must not fire here,
    // where no factor was removed — codes cleared without a removal would strand an
    // account that still has its factor and no way back in.
    await problem(service.remove(user.id, 'TOTP', 'totp-1'));

    expect(factors.replaceRecoveryCodes).not.toHaveBeenCalled();
  });
});
