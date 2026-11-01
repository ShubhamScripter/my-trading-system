import { beforeEach, describe, expect, it, vi } from 'vitest';
import { policy } from '../../../auth/limits';
import { REVOKE_REASON } from '../../../auth/auth.types';
import { KEYS } from '../../../redis';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { PasswordSettingsService } from '../../../src/settings/password/password.service';
import { makeCredential, makePrincipal, makeSecurityChangePolicy, makeUser } from '../../harness';
import { FACTS, makeRestrictions } from '../../restrictions/double';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * The password is the credential every other one is layered on, so the two questions
 * worth asking are "does an authorised change actually happen" and — far more of the
 * file — "is every unauthorised one refused, and refused before it costs the user
 * anything".
 *
 * The assertions are phrased as OBSERVABLE OUTCOMES rather than as calls to
 * collaborators: was the hash actually written, was the WRITE the create-only one or
 * the replace-only one, was an emailed code actually consumed, and — the ones that
 * matter most — was the code left UNSPENT when the request was going to be refused
 * anyway. The failures worth catching are all of that shape: a `set` that overwrites,
 * a `forgot` that skips a factor, an unavailable method that burns a code to discover
 * itself, a race in which two requests both create a password.
 *
 * ─── The four factor states are enumerated, not parameterised ───────────────
 *
 * `describe.each` over the four is deliberate: "both enrolled" is not the conjunction
 * of "passkey only" and "authenticator only" — it is the case where the CALLER
 * chooses, and the one an under-specified table misses.
 *
 * ─── On the argon2 double ───────────────────────────────────────────────────
 *
 * `CredentialService` is doubled with a hash that is a recognisable function of its
 * input, so "the stored value is not the password" is assertable without spending
 * real argon2 per case. Base64 rather than the plaintext with a prefix, so the
 * password is not a SUBSTRING of the hash — several assertions below depend on that.
 * What a double cannot check is that the real hash is used at all, so there is an
 * explicit test that the service never stores its input.
 *
 * Limits are read through `policy()` rather than transcribed, so a founder changing a
 * number does not change this file.
 */

const USER = makeUser();
const PRINCIPAL = makePrincipal({ userId: USER.id });
const IP_CLASS = '203.0.113.0/24';

const CURRENT = 'C0rrect-Horse!42';
const NEW_PASSWORD = 'Nu-Passw0rd!x9';
const EMAIL_CODE = '000000';
const TOTP_CODE = '123456';
const ASSERTION = { id: 'credential-id' };

const hashOf = (value: string): string => `argon2:${Buffer.from(value).toString('base64')}`;

// ─── the doubles ────────────────────────────────────────────────────────────

/**
 * The factor tables, doubled.
 *
 * Default account: neither factor, because most cases here are about the password
 * rather than about the second proof. The factor suites move THESE, and the derived
 * `MfaService` view follows.
 */
function createFactors() {
  return {
    listConfirmedTotpFactors: vi.fn(async (): Promise<{ id: string }[]> => []),
    listPasskeys: vi.fn(async (): Promise<{ id: string }[]> => []),
    countUnusedRecoveryCodes: vi.fn(async () => 0),
  };
}

/**
 * `MfaService`, DERIVED from the factor doubles rather than stubbed independently.
 *
 * Two independently stubbed doubles can describe an account that does not exist —
 * `listPasskeys: []` alongside `availableMethods: ['passkey']` — and a service tested
 * against an impossible account is tested against nothing in particular. The same
 * arrangement `payment-pin.service.spec.ts` uses, for that reason.
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
      if (recovery > 0 && methods.length > 0) methods.push('recovery_code');
      return methods;
    }),
    /** Retires the account's half-finished sign-ins. `finish` calls it beside the
     *  session sweep — a session sweep cannot see a flow that has no session yet.
     *  Driven for real in password-invalidates-login-attempts.spec.ts. */
    expireLiveAttemptsFor: vi.fn(async () => 0),
  };
}

function createTwoFactor() {
  return {
    consumeCredentialOtp: vi.fn(async () => undefined),
    proveTotpCode: vi.fn(async () => true),
    provePasskeyAssertion: vi.fn(async () => true),
  };
}

function createCredentials() {
  return {
    hash: vi.fn(async (value: string) => hashOf(value)),
    verify: vi.fn(async (hash: string, value: string) => hash === hashOf(value)),
    assertPolicy: vi.fn(),
    // `true` by default: a spec about ordering should not have to say the password
    // was right. The wrong-password cases override it.
    checkPassword: vi.fn(async () => true),
  };
}

/**
 * `UserDbOperation`, doubled around the two direction-aware writes.
 *
 * `passwordSet` is the switch every case turns: it drives what `findWithCredential`
 * reports AND what the two writes do, so a test cannot describe an account whose
 * reads and writes disagree about whether a password exists.
 */
function createUsers() {
  const state = { passwordSet: true, stored: hashOf(CURRENT) };

  return {
    state,
    // Typed as nullable at the source rather than cast at each call site: two cases
    // below need `null` (a token that outlived its account) and one needs a
    // non-ACTIVE row, and `vi.fn` would otherwise infer the happy path only.
    findById: vi.fn(async (): Promise<typeof USER | null> => USER),
    findWithCredential: vi.fn(async () => ({
      user: USER,
      credential: state.passwordSet ? makeCredential({ passwordHash: state.stored }) : null,
    })),
    createPasswordIfAbsent: vi.fn(async (_userId: string, hash: string) => {
      // The real method's contract: the unique index refuses a second live password,
      // so this answers false rather than overwriting.
      if (state.passwordSet) return false;
      state.passwordSet = true;
      state.stored = hash;
      return true;
    }),
    replacePassword: vi.fn(async (_userId: string, hash: string) => {
      if (!state.passwordSet) return false;
      state.stored = hash;
      return true;
    }),
  };
}

let factors: ReturnType<typeof createFactors>;
let mfa: ReturnType<typeof createMfa>;
let twoFactor: ReturnType<typeof createTwoFactor>;
let credentials: ReturnType<typeof createCredentials>;
let users: ReturnType<typeof createUsers>;
let sessions: { revokeAllForUserExcept: ReturnType<typeof vi.fn> };
let cache: { consume: ReturnType<typeof vi.fn> };
let mail: { sendSecurityChanged: ReturnType<typeof vi.fn> };
let cooldown: ReturnType<typeof makeSecurityChangePolicy>;
let restrictions: ReturnType<typeof makeRestrictions>;
let service: PasswordSettingsService;

beforeEach(() => {
  factors = createFactors();
  mfa = createMfa(factors);
  twoFactor = createTwoFactor();
  credentials = createCredentials();
  users = createUsers();
  sessions = { revokeAllForUserExcept: vi.fn(async () => undefined) };
  cache = { consume: vi.fn(async () => undefined) };
  mail = { sendSecurityChanged: vi.fn(async () => true) };
  cooldown = makeSecurityChangePolicy();
  restrictions = makeRestrictions();

  service = new PasswordSettingsService(
    twoFactor as never,
    mfa as never,
    credentials as never,
    users as never,
    sessions as never,
    cache as never,
    mail as never,
    cooldown as never,
    restrictions as never,
  );
});

async function refusal(call: Promise<unknown>): Promise<ProblemException> {
  try {
    await call;
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected a ProblemException, but the call resolved');
}

/** An account with no password — the provider-created and password-skipped case. */
function withoutPassword(): void {
  users.state.passwordSet = false;
}

function enrolPasskey(): void {
  factors.listPasskeys.mockResolvedValue([{ id: 'pk-1' }]);
}

function enrolTotp(): void {
  factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 'totp-1' }]);
}

const setBody = {
  action: 'set' as const,
  password: NEW_PASSWORD,
  confirmPassword: NEW_PASSWORD,
  emailCode: EMAIL_CODE,
};

const resetBody = {
  action: 'reset' as const,
  currentPassword: CURRENT,
  password: NEW_PASSWORD,
  confirmPassword: NEW_PASSWORD,
  emailCode: EMAIL_CODE,
};

const forgotBody = {
  action: 'forgot' as const,
  password: NEW_PASSWORD,
  confirmPassword: NEW_PASSWORD,
  emailCode: EMAIL_CODE,
};

// ─── status ─────────────────────────────────────────────────────────────────

describe('status', () => {
  it('reports the account, not the request', async () => {
    enrolPasskey();

    await expect(service.status(USER.id)).resolves.toMatchObject({
      passwordSet: true,
      forgot: { factorRequired: true, methods: ['passkey'] },
    });
  });

  it('costs no rate-limit slot — reading is not an attempt', async () => {
    await service.status(USER.id);

    expect(cache.consume).not.toHaveBeenCalled();
  });

  it('does not report the remaining attempt budget', async () => {
    // Deliberately unlike the Payment PIN, which publishes `remaining`. That is a
    // product allowance; this bucket is an anti-guessing bound, and telling a caller
    // how many attempts are left tells them exactly when to pause.
    const raw = JSON.stringify(await service.status(USER.id));

    expect(raw).not.toContain('remaining');
  });
});

// ─── set ────────────────────────────────────────────────────────────────────

describe('set — the account that has no password', () => {
  it('creates the password, sweeps other sessions, and notifies', async () => {
    withoutPassword();

    await service.set(PRINCIPAL, FACTS, setBody);

    expect(users.createPasswordIfAbsent).toHaveBeenCalledWith(
      USER.id,
      hashOf(NEW_PASSWORD),
      expect.anything(),
    );
    expect(users.state.stored).toBe(hashOf(NEW_PASSWORD));
    expect(sessions.revokeAllForUserExcept).toHaveBeenCalledWith(
      USER.id,
      PRINCIPAL.sessionId,
      REVOKE_REASON.PASSWORD_CHANGED,
    );
  });

  it('uses the CREATE-only write, never the replacing one', async () => {
    // The distinction is the authorisation. `upsertPassword` would satisfy this test
    // and silently overwrite a password on the very path that must not.
    withoutPassword();

    await service.set(PRINCIPAL, FACTS, setBody);

    expect(users.replacePassword).not.toHaveBeenCalled();
  });

  it('refuses an account that already has one, and points at the alternatives', async () => {
    const err = await refusal(service.set(PRINCIPAL, FACTS, setBody));

    expect(err.type).toBe(ERR.PASSWORD_ALREADY_SET);
    expect(err.detail).toMatch(/reset/);
    expect(err.detail).toMatch(/forgot/);
  });

  it('leaves the emailed code UNSPENT when the password already exists', async () => {
    // The property the ordering exists for: a refusal the server could issue for
    // free must not first cost the user their code.
    await refusal(service.set(PRINCIPAL, FACTS, setBody));

    expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    expect(credentials.hash).not.toHaveBeenCalled();
  });

  it('refuses the loser of a race between two concurrent requests', async () => {
    // The write is the arbiter, not the read: `createPasswordIfAbsent` answers false
    // once a password exists, whatever the earlier check saw. Both requests pass the
    // cheap check here, because both observed an account with no password.
    withoutPassword();

    const [first, second] = await Promise.allSettled([
      service.set(PRINCIPAL, FACTS, setBody),
      service.set(PRINCIPAL, FACTS, { ...setBody, password: 'Other-Passw0rd!7' }),
    ]);

    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);

    // Exactly one password, and it belongs to the winner.
    expect(users.createPasswordIfAbsent).toHaveBeenCalledTimes(2);
    expect([hashOf(NEW_PASSWORD), hashOf('Other-Passw0rd!7')]).toContain(users.state.stored);
  });

  it('demands no factor even when one is enrolled', async () => {
    // `set` CREATES a credential; there is nothing to downgrade. Demanding a proof
    // here would strand a provider-created account that enrolled a passkey first.
    withoutPassword();
    enrolPasskey();
    enrolTotp();

    await service.set(PRINCIPAL, FACTS, setBody);

    expect(twoFactor.provePasskeyAssertion).not.toHaveBeenCalled();
    expect(twoFactor.proveTotpCode).not.toHaveBeenCalled();
  });

  it('never stores the plaintext', async () => {
    withoutPassword();

    await service.set(PRINCIPAL, FACTS, setBody);

    expect(users.state.stored).not.toContain(NEW_PASSWORD);
    expect(credentials.hash).toHaveBeenCalledWith(NEW_PASSWORD);
  });
});

// ─── reset ──────────────────────────────────────────────────────────────────

describe('reset — the account whose owner knows the password', () => {
  it('replaces the password when both proofs check out', async () => {
    await service.reset(PRINCIPAL, FACTS, resetBody);

    expect(users.replacePassword).toHaveBeenCalledWith(
      USER.id,
      hashOf(NEW_PASSWORD),
      expect.anything(),
    );
    expect(users.state.stored).toBe(hashOf(NEW_PASSWORD));
  });

  it('uses the REPLACE-only write, never the creating one', async () => {
    await service.reset(PRINCIPAL, FACTS, resetBody);

    expect(users.createPasswordIfAbsent).not.toHaveBeenCalled();
  });

  it('requires the emailed code as well as the password', async () => {
    // Both, never either. `consumeCredentialOtp` is what enforces it, and this
    // asserts the call is actually made rather than skipped for a caller who
    // presented the stronger proof.
    await service.reset(PRINCIPAL, FACTS, resetBody);

    expect(twoFactor.consumeCredentialOtp).toHaveBeenCalledWith(USER.id, EMAIL_CODE);
  });

  it('refuses a wrong current password without writing', async () => {
    credentials.checkPassword.mockResolvedValue(false);

    const err = await refusal(service.reset(PRINCIPAL, FACTS, resetBody));

    expect(err.type).toBe(ERR.INVALID_CREDENTIALS);
    expect(users.replacePassword).not.toHaveBeenCalled();
    expect(users.state.stored).toBe(hashOf(CURRENT));
  });

  it('says nothing about how close the guess was', async () => {
    credentials.checkPassword.mockResolvedValue(false);

    const err = await refusal(service.reset(PRINCIPAL, FACTS, resetBody));

    expect(JSON.stringify({ detail: err.detail, extra: err.extra })).not.toMatch(
      /close|partial|correct|attempt/i,
    );
  });

  it('counts the guess toward the durable lockout like any other', async () => {
    // `checkPassword` owns `Credential.failedAttempts` and the strike ladder, so
    // calling it — rather than `verify` — is what keeps a session from exempting a
    // password guess from the counter that bounds guessing.
    credentials.checkPassword.mockResolvedValue(false);

    await refusal(service.reset(PRINCIPAL, FACTS, resetBody));

    expect(credentials.checkPassword).toHaveBeenCalled();
    expect(credentials.verify).not.toHaveBeenCalled();
  });

  it('refuses a new password identical to the current one, before spending the code', async () => {
    const err = await refusal(
      service.reset(PRINCIPAL, FACTS, {
        ...resetBody,
        password: CURRENT,
        confirmPassword: CURRENT,
      }),
    );

    expect(err.type).toBe(ERR.PASSWORD_REUSED);
    expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
  });

  it('routes an account with no password to `set` instead', async () => {
    withoutPassword();

    const err = await refusal(service.reset(PRINCIPAL, FACTS, resetBody));

    expect(err.type).toBe(ERR.PASSWORD_NOT_SET);
    expect(err.detail).toMatch(/set/);
    expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
  });

  it('refuses when the credential disappears between the check and the write', async () => {
    // The TOCTOU the predicate on the write exists to close. Nothing is resurrected.
    users.replacePassword.mockResolvedValue(false);

    const err = await refusal(service.reset(PRINCIPAL, FACTS, resetBody));

    expect(err.type).toBe(ERR.PASSWORD_NOT_SET);
  });

  it('sweeps the other sessions and keeps the caller signed in', async () => {
    await service.reset(PRINCIPAL, FACTS, resetBody);

    expect(sessions.revokeAllForUserExcept).toHaveBeenCalledWith(
      USER.id,
      PRINCIPAL.sessionId,
      REVOKE_REASON.PASSWORD_CHANGED,
    );
  });
});

// ─── forgot ─────────────────────────────────────────────────────────────────

describe('forgot — no factor enrolled', () => {
  it('accepts the emailed code alone', async () => {
    await expect(service.forgot(PRINCIPAL, FACTS, forgotBody)).resolves.toEqual({
      factorVerified: null,
    });

    expect(users.state.stored).toBe(hashOf(NEW_PASSWORD));
  });

  it('asks for no current password', async () => {
    await service.forgot(PRINCIPAL, FACTS, forgotBody);

    expect(credentials.checkPassword).not.toHaveBeenCalled();
  });

  it('refuses a factor proof it cannot use, rather than ignoring it', async () => {
    // Not tidiness: verifying it would spend a live TOTP step or a WebAuthn
    // challenge the user may be part-way through using elsewhere, and dropping it
    // silently would let a client believe a proof was checked.
    const err = await refusal(
      service.forgot(PRINCIPAL, FACTS, { ...forgotBody, totpCode: TOTP_CODE }),
    );

    expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
    expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    expect(twoFactor.proveTotpCode).not.toHaveBeenCalled();
  });

  it('routes an account with no password to `set`', async () => {
    withoutPassword();

    const err = await refusal(service.forgot(PRINCIPAL, FACTS, forgotBody));

    expect(err.type).toBe(ERR.PASSWORD_NOT_SET);
  });
});

describe('forgot — a factor IS enrolled', () => {
  it.each([
    ['passkey only', [enrolPasskey], ['passkey']],
    ['authenticator only', [enrolTotp], ['authenticator']],
    ['both', [enrolPasskey, enrolTotp], ['passkey', 'authenticator']],
  ] as const)('%s: refuses a body with no proof at all', async (_label, setup, methods) => {
    for (const fn of setup) fn();

    const err = await refusal(service.forgot(PRINCIPAL, FACTS, forgotBody));

    expect(err.type).toBe(ERR.PASSWORD_FACTOR_REQUIRED);
    // The methods that WOULD work, so a client renders the right prompt without a
    // second call and without deciding the policy.
    expect(err.extra).toEqual({ methods });

    // And the code survives, so the user can retry with the proof rather than
    // waiting for another email.
    expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    expect(users.state.stored).toBe(hashOf(CURRENT));
  });

  it('passkey only: accepts an assertion', async () => {
    enrolPasskey();

    await expect(
      service.forgot(PRINCIPAL, FACTS, { ...forgotBody, passkey: ASSERTION }),
    ).resolves.toEqual({ factorVerified: 'passkey' });

    expect(twoFactor.provePasskeyAssertion).toHaveBeenCalledWith(USER.id, ASSERTION);
    expect(users.state.stored).toBe(hashOf(NEW_PASSWORD));
  });

  it('passkey only: refuses a TOTP code as `mfa_method_unavailable`', async () => {
    enrolPasskey();

    const err = await refusal(
      service.forgot(PRINCIPAL, FACTS, { ...forgotBody, totpCode: TOTP_CODE }),
    );

    expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
    // Discovered for free — the server knew this without the user's code.
    expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
  });

  it('authenticator only: accepts a code', async () => {
    enrolTotp();

    await expect(
      service.forgot(PRINCIPAL, FACTS, { ...forgotBody, totpCode: TOTP_CODE }),
    ).resolves.toEqual({ factorVerified: 'authenticator' });

    // `proveTotpCode`, not `verifyCode`: it claims the RFC 6238 step, so a code
    // shoulder-surfed inside its 30-second window cannot be replayed into a second
    // reset.
    expect(twoFactor.proveTotpCode).toHaveBeenCalledWith(USER.id, TOTP_CODE);
  });

  it('authenticator only: refuses an assertion', async () => {
    enrolTotp();

    const err = await refusal(
      service.forgot(PRINCIPAL, FACTS, { ...forgotBody, passkey: ASSERTION }),
    );

    expect(err.type).toBe(ERR.MFA_METHOD_UNAVAILABLE);
  });

  it('both: accepts the passkey', async () => {
    enrolPasskey();
    enrolTotp();

    await expect(
      service.forgot(PRINCIPAL, FACTS, { ...forgotBody, passkey: ASSERTION }),
    ).resolves.toEqual({ factorVerified: 'passkey' });

    expect(twoFactor.proveTotpCode).not.toHaveBeenCalled();
  });

  it('both: accepts the authenticator', async () => {
    enrolPasskey();
    enrolTotp();

    await expect(
      service.forgot(PRINCIPAL, FACTS, { ...forgotBody, totpCode: TOTP_CODE }),
    ).resolves.toEqual({ factorVerified: 'authenticator' });

    expect(twoFactor.provePasskeyAssertion).not.toHaveBeenCalled();
  });

  it('both: refuses two proofs rather than picking the weaker', async () => {
    enrolPasskey();
    enrolTotp();

    const err = await refusal(
      service.forgot(PRINCIPAL, FACTS, {
        ...forgotBody,
        passkey: ASSERTION,
        totpCode: TOTP_CODE,
      }),
    );

    // Enforced in the service as well as the DTO, because a policy that holds only
    // when the HTTP layer is in front of it is not the policy.
    expect(err.type).toBe(ERR.VALIDATION_FAILED);
    expect(twoFactor.provePasskeyAssertion).not.toHaveBeenCalled();
    expect(twoFactor.proveTotpCode).not.toHaveBeenCalled();
  });

  it.each([
    ['a failed assertion', enrolPasskey, { passkey: ASSERTION }, 'provePasskeyAssertion'],
    ['a wrong code', enrolTotp, { totpCode: TOTP_CODE }, 'proveTotpCode'],
  ] as const)('refuses %s without writing', async (_label, setup, proof, prover) => {
    setup();
    twoFactor[prover].mockResolvedValue(false);

    const err = await refusal(service.forgot(PRINCIPAL, FACTS, { ...forgotBody, ...proof }));

    expect(err.type).toBe(ERR.MFA_CODE_INVALID);
    expect(users.state.stored).toBe(hashOf(CURRENT));
    expect(users.replacePassword).not.toHaveBeenCalled();
  });

  it('cannot be downgraded by a client claiming it has no factor', async () => {
    // The whole anti-bypass property. `hasPasskey`/`has2FA` are not fields in any
    // schema, and passing them changes nothing: the requirement is computed from
    // `MfaService.availableMethods` alone.
    enrolPasskey();

    const err = await refusal(
      service.forgot(PRINCIPAL, FACTS, {
        ...forgotBody,
        hasPasskey: false,
        has2FA: false,
        factorRequired: false,
      } as never),
    );

    expect(err.type).toBe(ERR.PASSWORD_FACTOR_REQUIRED);
    expect(mfa.availableMethods).toHaveBeenCalledWith(USER.id);
  });

  it('treats an unconfirmed enrollment as no factor', async () => {
    // `availableMethods` lists CONFIRMED credentials only, so an abandoned TOTP
    // enrollment must not demand a code the user cannot produce. Derived from the
    // factor doubles, so this is the real rule rather than a restatement.
    factors.listConfirmedTotpFactors.mockResolvedValue([]);
    factors.listPasskeys.mockResolvedValue([]);

    await expect(service.forgot(PRINCIPAL, FACTS, forgotBody)).resolves.toEqual({
      factorVerified: null,
    });
  });

  it('does not accept a recovery code as the additional factor', async () => {
    // Scoped out deliberately: a found printout must not be enough to replace the
    // account password. A user who lost their factor removes it first, and then
    // reaches the no-factor branch.
    enrolPasskey();
    factors.countUnusedRecoveryCodes.mockResolvedValue(8);

    const err = await refusal(
      service.forgot(PRINCIPAL, FACTS, {
        ...forgotBody,
        recoveryCode: 'AAAA-BBBB',
      } as never),
    );

    expect(err.type).toBe(ERR.PASSWORD_FACTOR_REQUIRED);
  });
});

// ─── the shared spine ───────────────────────────────────────────────────────

describe('metering', () => {
  it.each([
    ['set', () => (withoutPassword(), service.set(PRINCIPAL, FACTS, setBody))],
    ['reset', () => service.reset(PRINCIPAL, FACTS, resetBody)],
    ['forgot', () => service.forgot(PRINCIPAL, FACTS, forgotBody)],
  ] as const)('%s charges ONE shared per-account bucket, on entry', async (_label, run) => {
    await run();

    expect(cache.consume).toHaveBeenCalledTimes(1);
    expect(cache.consume).toHaveBeenCalledWith(
      // Keyed on the account, so an email change or a second session cannot reset it.
      KEYS.rate.passwordUpdateByAccount(USER.id),
      policy().PASSWORD.UPDATE_BY_ACCOUNT,
      // `deny` on a cache failure: on `set` and `forgot` no password is presented,
      // so the durable lockout ladder is not behind this and it is the only bound.
      'deny',
    );
  });

  it('charges before anything else can cost the caller', async () => {
    // Entry, not failure. A caller abandoning the request mid-flight has still cost
    // an argon2 hash and two reads.
    cache.consume.mockRejectedValue(new ProblemException({ type: ERR.RATE_LIMITED }));

    const err = await refusal(service.reset(PRINCIPAL, FACTS, resetBody));

    expect(err.type).toBe(ERR.RATE_LIMITED);
    expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    expect(credentials.hash).not.toHaveBeenCalled();
    expect(users.findWithCredential).not.toHaveBeenCalled();
  });

  it('shares one bucket across the three operations', async () => {
    // A per-action key would hand a caller thirty attempts per window while the
    // limit still read ten.
    withoutPassword();
    await service.set(PRINCIPAL, FACTS, setBody);
    await service.reset(PRINCIPAL, FACTS, resetBody);
    await service.forgot(PRINCIPAL, FACTS, forgotBody);

    const keys = new Set(cache.consume.mock.calls.map((call) => call[0] as string));
    expect(keys.size).toBe(1);
  });
});

describe('the security cooldown', () => {
  it.each([
    ['set', () => (withoutPassword(), service.set(PRINCIPAL, FACTS, setBody))],
    ['reset', () => service.reset(PRINCIPAL, FACTS, resetBody)],
    ['forgot', () => service.forgot(PRINCIPAL, FACTS, forgotBody)],
  ] as const)('%s is frozen after a recent email change', async (_label, run) => {
    cooldown.assertNoRecentEmailChange.mockRejectedValue(
      new ProblemException({ type: ERR.SECURITY_CHANGE_COOLDOWN }),
    );

    const err = await refusal(run());

    expect(err.type).toBe(ERR.SECURITY_CHANGE_COOLDOWN);
    // Refused before anything is spent, and nothing is written.
    expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
    expect(users.replacePassword).not.toHaveBeenCalled();
    expect(users.createPasswordIfAbsent).not.toHaveBeenCalled();
  });

  it('is asked after the meter, so a refused caller still spent a slot', async () => {
    // The order every surface in this module uses: meter first, because the freeze
    // is a cheap read and the meter is what bounds hammering.
    cooldown.assertNoRecentEmailChange.mockRejectedValue(
      new ProblemException({ type: ERR.SECURITY_CHANGE_COOLDOWN }),
    );

    await refusal(service.reset(PRINCIPAL, FACTS, resetBody));

    expect(cache.consume).toHaveBeenCalled();
  });
});

describe('ordering — what a refusal costs the user', () => {
  it('checks the password policy before consuming the emailed code', async () => {
    credentials.assertPolicy.mockImplementation(() => {
      throw new ProblemException({ type: ERR.PASSWORD_WEAK });
    });

    const err = await refusal(service.reset(PRINCIPAL, FACTS, resetBody));

    expect(err.type).toBe(ERR.PASSWORD_WEAK);
    // A weak password must not burn the code and force another email.
    expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
  });

  it('consumes the emailed code BEFORE verifying the additional factor', async () => {
    // The repo-wide discipline: a caller cannot use a wrong emailed code to probe
    // whether a factor guess was right, and an abandoned request has still spent
    // the code. The accepted cost is that a wrong factor burns a good code.
    enrolPasskey();
    const order: string[] = [];
    twoFactor.consumeCredentialOtp.mockImplementation(async () => void order.push('otp'));
    twoFactor.provePasskeyAssertion.mockImplementation(async () => {
      order.push('factor');
      return true;
    });

    await service.forgot(PRINCIPAL, FACTS, { ...forgotBody, passkey: ASSERTION });

    expect(order).toEqual(['otp', 'factor']);
  });

  it('hashes only after every proof has been accepted', async () => {
    // argon2 is deliberately expensive. A refusal that could be issued for free must
    // not pay for it first.
    enrolPasskey();
    twoFactor.provePasskeyAssertion.mockResolvedValue(false);

    await refusal(service.forgot(PRINCIPAL, FACTS, { ...forgotBody, passkey: ASSERTION }));

    expect(credentials.hash).not.toHaveBeenCalled();
  });

  it('refuses a stale token rather than answering 500', async () => {
    users.findById.mockResolvedValue(null);

    const err = await refusal(service.reset(PRINCIPAL, FACTS, resetBody));

    expect(err.type).toBe(ERR.UNAUTHENTICATED);
  });

  it('refuses a disabled account without disclosing which of the two it was', async () => {
    users.findById.mockResolvedValue({ ...USER, status: 'DISABLED' });

    const err = await refusal(service.reset(PRINCIPAL, FACTS, resetBody));

    expect(err.type).toBe(ERR.UNAUTHENTICATED);
    expect(twoFactor.consumeCredentialOtp).not.toHaveBeenCalled();
  });
});

describe('the notification', () => {
  it.each([
    ['set', 'password set', () => (withoutPassword(), service.set(PRINCIPAL, FACTS, setBody))],
    ['reset', 'password changed', () => service.reset(PRINCIPAL, FACTS, resetBody)],
    ['forgot', 'password reset', () => service.forgot(PRINCIPAL, FACTS, forgotBody)],
  ] as const)('%s emails the owner', async (_label, what, run) => {
    await run();
    // Fire-and-forget, so the assertion has to survive the microtask it is queued in.
    await new Promise((resolve) => setImmediate(resolve));

    // The trailing null is the anti-phishing code: the fixture account has none, so
    // the notification renders without the footer.
    expect(mail.sendSecurityChanged).toHaveBeenCalledWith(USER.email, what, FACTS.ipClass, null);
  });

  it('does not fail the change when the mail lookup throws', async () => {
    // The password has already changed. A dead lookup must not report a successful
    // change as failed and invite the user to do it again.
    users.findById.mockImplementation(async () => {
      if (users.findById.mock.calls.length > 1) throw new Error('db gone');
      return USER;
    });

    await expect(service.reset(PRINCIPAL, FACTS, resetBody)).resolves.toBeUndefined();
    expect(users.state.stored).toBe(hashOf(NEW_PASSWORD));
  });
});

describe('what never leaves this service', () => {
  it.each([
    ['set', () => (withoutPassword(), service.set(PRINCIPAL, FACTS, setBody))],
    ['reset', () => service.reset(PRINCIPAL, FACTS, resetBody)],
    ['forgot', () => service.forgot(PRINCIPAL, FACTS, forgotBody)],
  ] as const)('%s resolves without returning a password or a hash', async (_label, run) => {
    const result = await run();

    expect(JSON.stringify(result ?? null)).not.toMatch(
      new RegExp(`${NEW_PASSWORD}|${CURRENT}|argon2`),
    );
  });
});
