import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { RetainedEmail } from '@prisma/client';
import { EMAIL } from '../../../auth/auth.constants';
import { REVOKE_REASON, type Principal } from '../../../auth/auth.types';
import { pepperedHash } from '../../../auth/auth.utility';
import { policy } from '../../../auth/limits';
import { KEYS } from '../../../redis';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { TwoFactorDbOperation } from '../../../src/2fa/2fa.dboperation';
import { MfaService } from '../../../src/2fa/mfa.service';
import { EmailChangeService } from '../../../src/settings/email/email.service';
import { serialiseGrant } from '../../../src/settings/email/email.utility';
import type { EmailChangeGrant } from '../../../src/settings/email/email.types';
import { makePrincipal, makeQuota, makeRetainedEmail, makeUser } from '../../harness';
import { FACTS, makeRestrictions } from '../../restrictions/double';

/**
 * ═══ WHAT THIS FILE IS FOR ══════════════════════════════════════════════════
 *
 * An email change moves the account's primary identifier and one of its two sign-in
 * credentials. Get it wrong in the permissive direction and the result is not a bug
 * report, it is an account somebody else owns.
 *
 * So the assertions are observable outcomes rather than calls: was the address actually
 * moved, was the released one actually reserved, were the codes actually spent, were the
 * sessions actually swept — and, far more of the file, was every one of those left
 * UNTOUCHED when the request should have been refused.
 *
 * Three areas carry most of the weight, and each has a silent failure mode:
 *
 *  1. TIER ORDERING. Offering the password beside a passkey is invisible in every happy
 *     path and makes the strong tiers unreachable in practice.
 *  2. CODE BINDING. A code mailed to the current inbox satisfying the new-address proof
 *     looks identical to success, and proves nothing about the address being claimed.
 *  3. THE PUBLIC ROUTE. Recovery is reachable without a session; a change must not be.
 *     That boundary is one function, and it is tested directly.
 *
 * Limits are read through `policy()` rather than transcribed, so a founder changing a
 * number does not change this file.
 */

const USER = makeUser({ email: 'Ada@example.test', emailLower: 'ada@example.test' });
const PRINCIPAL = makePrincipal({ userId: USER.id });
const IP = '203.0.113.7';
const IP_CLASS = '203.0.113.0/24';

const NEW_EMAIL = 'New.Address@example.test';
const NEW_LOWER = 'new.address@example.test';
const RETAINED_EMAIL = 'Old.Address@example.test';
const RETAINED_LOWER = 'old.address@example.test';

const RECOVERY_TOKEN = 'recovery-token-value';

/** Codes, one per mailbox, distinct so a swap is detectable. */
const CODES = { current: '111111', new: '222222', retained: '333333' } as const;

// ─── doubles ────────────────────────────────────────────────────────────────

/**
 * The factor tables, doubled. Default account: nothing enrolled and no password, which
 * is the `none` tier — tests that want a stronger tier say so explicitly, so every tier
 * assertion names the state it depends on.
 */
function createFactors() {
  return {
    listConfirmedTotpFactors: vi.fn(async (): Promise<{ id: string }[]> => []),
    listPasskeys: vi.fn(async (): Promise<{ id: string }[]> => []),
    countUnusedRecoveryCodes: vi.fn(async () => 0),
  };
}

/** `MfaService`, DERIVED from the factor doubles — two independently stubbed doubles
 *  can describe an account that does not exist, and a service tested against an
 *  impossible account is tested against nothing in particular. */
function createMfa(factors: ReturnType<typeof createFactors>) {
  return {
    availableMethods: vi.fn(async (): Promise<string[]> => {
      const [totp, passkeys] = await Promise.all([
        factors.listConfirmedTotpFactors(),
        factors.listPasskeys(),
      ]);
      const methods: string[] = [];
      if (totp.length > 0) methods.push('totp');
      if (passkeys.length > 0) methods.push('passkey');
      return methods;
    }),
    /** Retires the account's half-finished sign-ins. Both write paths call it beside
     *  their session sweep — a sweep cannot see a flow that has no session yet. The
     *  real behaviour is driven in email-change-invalidates-login-attempts.spec.ts. */
    expireLiveAttemptsFor: vi.fn(async () => 0),
  };
}

/** The `retained_emails` table, doubled as a live list plus the two mutations. */
function createEmails(initial: RetainedEmail[] = []) {
  let rows = [...initial];
  let currentEmail = { email: USER.email, emailLower: USER.emailLower };

  return {
    findLiveByEmail: vi.fn(async (emailLower: string) =>
      rows.find((r) => r.emailLower === emailLower && r.expiresAt.getTime() > Date.now()) ?? null,
    ),
    listLiveForUser: vi.fn(async (userId: string) =>
      rows.filter((r) => r.userId === userId && r.expiresAt.getTime() > Date.now()),
    ),
    findById: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    findByRecoveryTokenHash: vi.fn(
      async (hash: string) => rows.find((r) => r.recoveryTokenHash === hash) ?? null,
    ),
    findSpendableForUser: vi.fn(
      async (userId: string) =>
        rows.find(
          (r) =>
            r.userId === userId &&
            r.recoveryConsumedAt === null &&
            r.expiresAt.getTime() > Date.now(),
        ) ?? null,
    ),
    changeEmail: vi.fn(async (input: Record<string, unknown>) => {
      rows = rows.filter(
        (r) => !(r.userId === input.userId && r.emailLower === input.newEmailLower),
      );
      currentEmail = {
        email: input.newEmail as string,
        emailLower: input.newEmailLower as string,
      };
      rows.push(
        makeRetainedEmail({
          id: `ret-${rows.length + 1}`,
          userId: input.userId as string,
          email: input.releasedEmail as string,
          emailLower: input.releasedEmailLower as string,
          expiresAt: input.retentionExpiresAt as Date,
          recoveryTokenHash: input.recoveryTokenHash as string,
        }),
      );
      if (input.skippedRetainedId !== null) {
        rows = rows.map((r) =>
          r.id === input.skippedRetainedId ? { ...r, expiresAt: new Date(0) } : r,
        );
      }
    }),
    recoverEmail: vi.fn(async (input: Record<string, unknown>) => {
      const row = rows.find((r) => r.id === input.retainedEmailId);
      if (
        row === undefined ||
        row.recoveryConsumedAt !== null ||
        row.expiresAt.getTime() <= Date.now()
      ) {
        return false;
      }
      currentEmail = {
        email: input.targetEmail as string,
        emailLower: input.targetEmailLower as string,
      };
      if (input.intent === 'restore') {
        rows = rows.filter((r) => r.id !== row.id);
      } else {
        rows = rows.map((r) =>
          r.id === row.id
            ? {
                ...r,
                expiresAt: input.renewedExpiresAt as Date,
                recoveryTokenHash: input.renewedRecoveryTokenHash as string,
                recoveryConsumedAt: null,
              }
            : r,
        );
      }
      return true;
    }),
    /** For assertions. Not part of the real interface. */
    current: () => currentEmail,
    rows: () => rows,
  };
}

/** `CacheService`, with a real store for `set`/`get`/`clear`. */
function createCache() {
  const store = new Map<string, string>();
  return {
    consume: vi.fn(async (_key: string, _rule: unknown, _onError: string) => undefined),
    set: vi.fn(async (key: string, value: string, _ttl: number) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    clear: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    store,
  };
}

/**
 * The OTP table, doubled with real purpose AND target binding.
 *
 * Modelling both is the point: a double that keyed on the purpose alone would let a
 * swapped code pass, and the swap tests would prove nothing.
 */
function createChallenges() {
  let live: {
    id: string;
    userId: string;
    purpose: string;
    codeHash: string;
    targetEmailLower: string | null;
    expiresAt: Date;
    attempts: number;
    consumedAt: Date | null;
  }[] = [];
  let issued = 0;

  return {
    issue: vi.fn(async (input: Record<string, unknown>) => {
      // The real supersede: one live row per (user, purpose). Modelling it matters —
      // it is what makes "three roles need three purposes" testable.
      live = live.filter(
        (c) =>
          !(c.userId === input.userId && c.purpose === input.purpose && c.consumedAt === null),
      );
      const row = {
        id: `challenge-${(issued += 1)}`,
        userId: input.userId as string,
        purpose: input.purpose as string,
        codeHash: input.codeHash as string,
        targetEmailLower: (input.targetEmailLower as string | undefined) ?? null,
        expiresAt: input.expiresAt as Date,
        attempts: 0,
        consumedAt: null,
      };
      live.push(row);
      return row;
    }),
    findLive: vi.fn(
      async (userId: string, purpose: string) =>
        live.find((c) => c.userId === userId && c.purpose === purpose && c.consumedAt === null) ??
        null,
    ),
    incrementAttempts: vi.fn(async (id: string) => {
      const row = live.find((c) => c.id === id);
      if (row === undefined) return 0;
      row.attempts += 1;
      return row.attempts;
    }),
    consume: vi.fn(async (id: string) => {
      const row = live.find((c) => c.id === id && c.consumedAt === null);
      if (row === undefined) return false;
      row.consumedAt = new Date();
      return true;
    }),
    invalidate: vi.fn(async (id: string) => {
      const row = live.find((c) => c.id === id);
      if (row !== undefined) row.consumedAt = new Date();
    }),
    invalidateIfHash: vi.fn(async () => undefined),
    /** For assertions, and for `knownCodes` to rewrite. */
    liveRows: () => live.filter((c) => c.consumedAt === null),
  };
}

describe('EmailChangeService', () => {
  let factors: ReturnType<typeof createFactors>;
  let mfa: ReturnType<typeof createMfa>;
  let emails: ReturnType<typeof createEmails>;
  let cache: ReturnType<typeof createCache>;
  let challenges: ReturnType<typeof createChallenges>;
  let quota: ReturnType<typeof makeQuota>;
  let users: { findById: ReturnType<typeof vi.fn>; findWithCredential: ReturnType<typeof vi.fn>; emailExists: ReturnType<typeof vi.fn> };
  let twoFactor: { proveTotpCode: ReturnType<typeof vi.fn>; provePasskeyAssertion: ReturnType<typeof vi.fn> };
  let credentials: { checkPassword: ReturnType<typeof vi.fn> };
  let blocklist: { assertNotBlocked: ReturnType<typeof vi.fn> };
  let sessions: { revokeAllForUser: ReturnType<typeof vi.fn> };
  let mail: {
    sendOtp: ReturnType<typeof vi.fn>;
    sendEmailChanged: ReturnType<typeof vi.fn>;
    sendEmailAdded: ReturnType<typeof vi.fn>;
    sendEmailRemoved: ReturnType<typeof vi.fn>;
  };
  let kyc: { isVerified: ReturnType<typeof vi.fn>; reverify: ReturnType<typeof vi.fn> };

  function build(): EmailChangeService {
    return new EmailChangeService(
      emails as never,
      users as never,
      challenges as never,
      twoFactor as never,
      mfa as never,
      credentials as never,
      blocklist as never,
      sessions as never,
      cache as never,
      quota as never,
      mail as never,
      makeRestrictions() as never,
      kyc as never,
    );
  }

  beforeEach(() => {
    factors = createFactors();
    mfa = createMfa(factors);
    emails = createEmails();
    cache = createCache();
    challenges = createChallenges();
    quota = makeQuota();
    users = {
      findById: vi.fn(async () => ({ ...USER, ...emails.current() })),
      findWithCredential: vi.fn(async () => ({ user: USER, credential: null })),
      emailExists: vi.fn(async () => false),
    };
    twoFactor = {
      proveTotpCode: vi.fn(async () => true),
      provePasskeyAssertion: vi.fn(async () => true),
    };
    credentials = { checkPassword: vi.fn(async () => true) };
    blocklist = { assertNotBlocked: vi.fn(async () => undefined) };
    sessions = { revokeAllForUser: vi.fn(async () => undefined) };
    mail = {
      sendOtp: vi.fn(async () => undefined),
      sendEmailChanged: vi.fn(async () => undefined),
      sendEmailAdded: vi.fn(() => undefined),
      sendEmailRemoved: vi.fn(() => undefined),
    };
    kyc = { isVerified: vi.fn(async () => false), reverify: vi.fn(async () => true) };
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  const expectProblem = async (run: Promise<unknown>, type: string) => {
    await expect(run).rejects.toThrow(ProblemException);
    await run.catch((err: unknown) => {
      expect((err as ProblemException).type).toBe(type);
    });
  };

  const start = (
    overrides: Record<string, unknown> = {},
    principal: Principal = PRINCIPAL,
  ) =>
    build().start(principal, IP, {
      action: 'start',
      newEmail: NEW_EMAIL,
      method: 'none',
      ...overrides,
    } as never);

  /**
   * Rewrite every live code to a known value, one per mailbox.
   *
   * The service mints a random six digits and only its hash reaches the double, so a
   * spec cannot otherwise know what to present. Rewriting the stored hash is exactly
   * what a user reading their inbox does — and the values are DISTINCT per purpose, so
   * presenting one mailbox's code for another is detectable rather than a coincidence.
   */
  function knownCodes(): void {
    for (const row of challenges.liveRows()) {
      const target =
        row.purpose === 'EMAIL_CHANGE_CURRENT'
          ? CODES.current
          : row.purpose === 'EMAIL_CHANGE_NEW'
            ? CODES.new
            : CODES.retained;
      row.codeHash = pepperedHash(target, 'otp');
    }
  }

  const verifyChange = (
    overrides: Record<string, unknown> = {},
    principal: Principal = PRINCIPAL,
  ) => {
    const grant = JSON.parse(
      cache.store.get(KEYS.emailChange.pending(principal.userId)) as string,
    ) as EmailChangeGrant;

    return build().verifyChange(principal, FACTS, {
      challengeId: grant.challengeId,
      currentEmailCode: CODES.current,
      newEmailCode: CODES.new,
      method: grant.method,
      ...overrides,
    } as never);
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  THE SECURITY MATRIX
  // ══════════════════════════════════════════════════════════════════════════

  describe('the security matrix', () => {
    const TIERS: [string, 'totp' | 'passkey', Record<string, unknown>][] = [
      ['authenticator', 'totp', { totpCode: '123456' }],
      ['passkey', 'passkey', { passkey: { id: 'cred' } }],
    ];

    it.each(TIERS)('completes with %s + both codes', async (method, enrol, proof) => {
      if (enrol === 'totp') {
        factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 't' }]);
      } else {
        factors.listPasskeys.mockResolvedValue([{ id: 'p' }]);
      }

      await start({ method });
      knownCodes();
      await verifyChange(proof);

      expect(emails.current().emailLower).toBe(NEW_LOWER);
    });

    it('completes with KYC + both codes', async () => {
      kyc.isVerified.mockResolvedValue(true);

      await start({ method: 'kyc' });
      knownCodes();
      await verifyChange({ kyc: { reference: 'handle' } });

      expect(emails.current().emailLower).toBe(NEW_LOWER);
      expect(kyc.reverify).toHaveBeenCalled();
    });

    it('completes with the password fallback when nothing stronger exists', async () => {
      users.findWithCredential.mockResolvedValue({ user: USER, credential: { id: 'c' } });

      await start({ method: 'password' });
      knownCodes();
      await verifyChange({ password: 'correct horse' });

      expect(emails.current().emailLower).toBe(NEW_LOWER);
      // `checkPassword`, not a bare verify: guessing here must cost the same as guessing
      // at sign-in, or this is a counter-free oracle for the same secret.
      expect(credentials.checkPassword).toHaveBeenCalled();
    });

    it('completes with the two codes alone when there is no factor and no password', async () => {
      await start({ method: 'none' });
      knownCodes();
      await verifyChange();

      expect(emails.current().emailLower).toBe(NEW_LOWER);
    });

    // ═══ THE REFUSALS ═══════════════════════════════════════════════════════

    it('refuses the password when a passkey exists, even though the password is real', async () => {
      // The permissive bug that would make every strong tier unreachable in practice.
      factors.listPasskeys.mockResolvedValue([{ id: 'p' }]);
      users.findWithCredential.mockResolvedValue({ user: USER, credential: { id: 'c' } });

      await expectProblem(start({ method: 'password' }), ERR.MFA_METHOD_UNAVAILABLE);
    });

    it('refuses "none" on an account that has a password', async () => {
      users.findWithCredential.mockResolvedValue({ user: USER, credential: { id: 'c' } });

      await expectProblem(start({ method: 'none' }), ERR.MFA_METHOD_UNAVAILABLE);
    });

    it('refuses a tier the account has not set up', async () => {
      await expectProblem(start({ method: 'authenticator' }), ERR.MFA_METHOD_UNAVAILABLE);
    });

    it('refuses a wrong TOTP code and changes nothing', async () => {
      factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 't' }]);
      twoFactor.proveTotpCode.mockResolvedValue(false);

      await start({ method: 'authenticator' });
      knownCodes();
      await expectProblem(verifyChange({ totpCode: '000000' }), ERR.MFA_CODE_INVALID);

      expect(emails.current().emailLower).toBe(USER.emailLower);
    });

    it('refuses a wrong password and changes nothing', async () => {
      users.findWithCredential.mockResolvedValue({ user: USER, credential: { id: 'c' } });
      credentials.checkPassword.mockResolvedValue(false);

      await start({ method: 'password' });
      knownCodes();
      await expectProblem(verifyChange({ password: 'wrong' }), ERR.INVALID_CREDENTIALS);

      expect(emails.current().emailLower).toBe(USER.emailLower);
    });

    it('spends the codes BEFORE the security proof', async () => {
      // So a wrong code cannot be used to probe whether a password guess was right, and
      // an abandoned request has still cost the codes.
      const order: string[] = [];
      factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 't' }]);
      challenges.consume.mockImplementation(async () => {
        order.push('code');
        return true;
      });
      twoFactor.proveTotpCode.mockImplementation(async () => {
        order.push('proof');
        return true;
      });

      await start({ method: 'authenticator' });
      knownCodes();
      await verifyChange({ totpCode: '123456' });

      expect(order[order.length - 1]).toBe('proof');
      expect(order.filter((o) => o === 'code')).toHaveLength(2);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  THE CODES
  // ══════════════════════════════════════════════════════════════════════════

  describe('the emailed codes', () => {
    it('sends one to the current address and one to the new one', async () => {
      await start();

      const recipients = mail.sendOtp.mock.calls.map(([to]) => to as string);
      expect(recipients).toHaveLength(2);
      expect(recipients).toContain(USER.email);
      expect(recipients).toContain(NEW_EMAIL);
    });

    it('binds the new-address code to that address and leaves the current one unbound', async () => {
      // ═══ THE BINDING THAT MAKES THE CEREMONY MEAN ANYTHING ═════════════════
      //
      // Without a target, `verifyChallengeCode` finds the live row for (user, purpose)
      // and asks only whether the digits match — so a code the user legitimately
      // received at their CURRENT inbox would satisfy the proof for an address they have
      // shown no control over.
      await start();

      const issued = challenges.issue.mock.calls.map(([input]) => input as Record<string, unknown>);
      const current = issued.find((i) => i.purpose === 'EMAIL_CHANGE_CURRENT');
      const fresh = issued.find((i) => i.purpose === 'EMAIL_CHANGE_NEW');

      expect(current?.targetEmailLower).toBeUndefined();
      expect(fresh?.targetEmailLower).toBe(NEW_LOWER);
    });

    it('uses a DIFFERENT purpose per mailbox, so the codes can coexist', async () => {
      // One live row per (user, purpose) is enforced by `ux_challenges_live`, and `issue`
      // supersedes before inserting — so a shared purpose would silently leave one live
      // code while the user was told two were sent.
      await start();

      const purposes = challenges.liveRows().map((c) => c.purpose);
      expect(new Set(purposes).size).toBe(purposes.length);
      expect(purposes).toContain('EMAIL_CHANGE_CURRENT');
      expect(purposes).toContain('EMAIL_CHANGE_NEW');
    });

    it('refuses the current-address code presented as the new-address proof', async () => {
      await start();
      knownCodes();

      await expectProblem(
        verifyChange({ newEmailCode: CODES.current }),
        ERR.OTP_INVALID,
      );
      expect(emails.current().emailLower).toBe(USER.emailLower);
    });

    it('refuses the new-address code presented as the current-address proof', async () => {
      await start();
      knownCodes();

      await expectProblem(
        verifyChange({ currentEmailCode: CODES.new }),
        ERR.OTP_INVALID,
      );
    });

    it('refuses a request missing a code the ceremony demanded', async () => {
      await start();
      knownCodes();

      await expectProblem(verifyChange({ newEmailCode: undefined }), ERR.VALIDATION_FAILED);
    });

    it('refuses a code the ceremony did not ask for', async () => {
      // Refused rather than ignored, so a client that believes it proved three mailboxes
      // is told it only needed two.
      await start();
      knownCodes();

      await expectProblem(
        verifyChange({ retainedEmailCode: CODES.retained }),
        ERR.VALIDATION_FAILED,
      );
    });

    it('spends each code, so a replayed completion finds them consumed', async () => {
      await start();
      knownCodes();
      await verifyChange();

      expect(challenges.liveRows()).toHaveLength(0);
    });

    it('meters the mail on the DESTINATION, not on the account', async () => {
      // Every other post-account budget keys on `user.emailLower`. Here the caller names
      // the destination, so an account-keyed budget would say nothing about how much
      // mail one stranger's inbox receives.
      await start();

      expect(quota.countFor(KEYS.rate.emailChangeOtpMail(NEW_LOWER))).toBeGreaterThan(0);
      expect(quota.countFor(KEYS.rate.emailChangeOtpMail(USER.emailLower))).toBeGreaterThan(0);
    });

    it('retires the code and refunds the budget when the mail cannot be queued', async () => {
      mail.sendOtp.mockRejectedValue(new Error('queue down'));

      await expect(start()).rejects.toThrow('queue down');
      expect(challenges.invalidateIfHash).toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  THE CHALLENGE
  // ══════════════════════════════════════════════════════════════════════════

  describe('the in-flight change', () => {
    it('binds the account, the login family, the address and the tier', async () => {
      await start();

      const grant = JSON.parse(
        cache.store.get(KEYS.emailChange.pending(USER.id)) as string,
      ) as EmailChangeGrant;

      expect(grant.userId).toBe(USER.id);
      expect(grant.familyId).toBe(PRINCIPAL.familyId);
      expect(grant.newEmailLower).toBe(NEW_LOWER);
      expect(grant.method).toBe('none');
    });

    it('binds the FAMILY, not the session, so a token rotation does not void it', async () => {
      // `sessionId` changes on every refresh and this ceremony lasts half an hour.
      // `makePrincipal` gives the two different values on purpose.
      await start();

      const grant = JSON.parse(
        cache.store.get(KEYS.emailChange.pending(USER.id)) as string,
      ) as EmailChangeGrant;
      expect(grant.familyId).not.toBe(PRINCIPAL.sessionId);
    });

    it('refuses a challenge id that is not the one on record', async () => {
      await start();
      knownCodes();

      await expectProblem(
        verifyChange({ challengeId: 'not-the-one' }),
        ERR.EMAIL_CHANGE_CHALLENGE_INVALID,
      );
    });

    it('refuses a completion from another login family', async () => {
      await start();
      knownCodes();

      const other = makePrincipal({ userId: USER.id, familyId: 'a-different-family' });
      await expectProblem(
        verifyChange({}, other),
        ERR.EMAIL_CHANGE_CHALLENGE_INVALID,
      );
    });

    it('refuses a completion when no change is in flight', async () => {
      await expectProblem(
        build().verifyChange(PRINCIPAL, FACTS, {
          challengeId: 'anything',
          currentEmailCode: CODES.current,
          newEmailCode: CODES.new,
          method: 'none',
        } as never),
        ERR.EMAIL_CHANGE_CHALLENGE_INVALID,
      );
    });

    /**
     * The three refusals above are one 403 to the caller, deliberately. They must not
     * also be one line in the log: `found: true` cannot tell a stale challenge id from
     * a ceremony bound to a login that has since been replaced, and those are entirely
     * different mistakes to go and fix.
     */
    it('logs WHICH binding failed, while answering the caller identically', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const reason = (): string | undefined => {
        const call = warn.mock.calls.find(([, msg]) => msg === 'email change challenge refused');
        return (call?.[0] as { reason?: string } | undefined)?.reason;
      };

      await start();
      knownCodes();

      warn.mockClear();
      await verifyChange({ challengeId: 'not-the-one' }).catch(() => undefined);
      expect(reason()).toBe('different-challenge');

      warn.mockClear();
      const other = makePrincipal({ userId: USER.id, familyId: 'a-different-family' });
      await verifyChange({}, other).catch(() => undefined);
      expect(reason()).toBe('different-login');

      warn.mockClear();
      cache.store.delete(KEYS.emailChange.pending(USER.id));
      await build()
        .verifyChange(PRINCIPAL, FACTS, {
          challengeId: 'anything',
          currentEmailCode: CODES.current,
          newEmailCode: CODES.new,
          method: 'none',
        } as never)
        .catch(() => undefined);
      expect(reason()).toBe('no-pending-change');

      warn.mockRestore();
    });

    it('refuses a tier different from the one the change was started with', async () => {
      // ═══ THE DOWNGRADE ════════════════════════════════════════════════════
      //
      // The tier was fixed at `start`. A completion naming a weaker one must be refused
      // rather than run — that is the whole reason the tier lives in the record.
      factors.listPasskeys.mockResolvedValue([{ id: 'p' }]);
      users.findWithCredential.mockResolvedValue({ user: USER, credential: { id: 'c' } });

      await start({ method: 'passkey' });
      knownCodes();

      await expectProblem(
        verifyChange({ method: 'password', password: 'guess' }),
        ERR.EMAIL_CHANGE_CHALLENGE_INVALID,
      );
      expect(emails.current().emailLower).toBe(USER.emailLower);
    });

    it('cannot be completed against a different address than it was started for', async () => {
      // The substitution attack: the address lives in the record, and the mutation reads
      // it from there. There is no field on the completion that could carry another.
      await start();
      knownCodes();
      await verifyChange();

      expect(emails.current().emailLower).toBe(NEW_LOWER);
      expect(emails.changeEmail).toHaveBeenCalledWith(
        expect.objectContaining({ newEmailLower: NEW_LOWER }) as never,
      );
    });

    it('starting again supersedes the previous change rather than leaving two live', async () => {
      await start();
      await start({ newEmail: 'third@example.test' });

      const grant = JSON.parse(
        cache.store.get(KEYS.emailChange.pending(USER.id)) as string,
      ) as EmailChangeGrant;
      expect(grant.newEmailLower).toBe('third@example.test');
      expect(cache.store.size).toBe(1);
    });

    it('clears the record once the change commits', async () => {
      await start();
      knownCodes();
      await verifyChange();

      // Not strictly required — the codes are spent — but a stale record would let the
      // status screen report a change still in flight.
      expect(emails.current().emailLower).toBe(NEW_LOWER);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  ADDRESS AVAILABILITY
  // ══════════════════════════════════════════════════════════════════════════

  describe('which addresses may be claimed', () => {
    it('refuses the address the account already holds', async () => {
      await expectProblem(start({ newEmail: USER.email }), ERR.EMAIL_SAME_AS_CURRENT);
    });

    it('refuses an address a live account holds', async () => {
      users.emailExists.mockResolvedValue(true);
      await expectProblem(start(), ERR.EMAIL_ALREADY_REGISTERED);
    });

    it('refuses an address retained by ANOTHER account', async () => {
      emails = createEmails([
        makeRetainedEmail({ id: 'other', userId: 'someone-else', emailLower: NEW_LOWER }),
      ]);
      await expectProblem(start(), ERR.EMAIL_ALREADY_REGISTERED);
    });

    it('ALLOWS reclaiming an address this account released', async () => {
      // The main reason retention exists: undoing a change you regret. The reservation
      // blocks other people, not its owner.
      emails = createEmails([
        makeRetainedEmail({ id: 'mine', userId: USER.id, emailLower: NEW_LOWER }),
      ]);

      await start();
      knownCodes();
      await verifyChange({ retainedEmailCode: CODES.retained });

      expect(emails.current().emailLower).toBe(NEW_LOWER);
    });

    it('checks the blocklist — the seventh door', async () => {
      blocklist.assertNotBlocked.mockRejectedValue(
        new ProblemException({ type: ERR.EMAIL_DOMAIN_BLOCKED }),
      );
      await expectProblem(start(), ERR.EMAIL_DOMAIN_BLOCKED);
    });

    it('re-checks availability at completion, because the world moved', async () => {
      await start();
      knownCodes();
      users.emailExists.mockResolvedValue(true);

      await expectProblem(verifyChange(), ERR.EMAIL_ALREADY_REGISTERED);
      expect(emails.current().emailLower).toBe(USER.emailLower);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  RETENTION AND REPEATED CHANGES
  // ══════════════════════════════════════════════════════════════════════════

  describe('retention', () => {
    it('reserves the released address for the configured window', async () => {
      await start();
      knownCodes();
      await verifyChange();

      const [[input]] = emails.changeEmail.mock.calls as [[Record<string, unknown>]];
      const expiry = input.retentionExpiresAt as Date;
      const days = (expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000);

      expect(input.releasedEmailLower).toBe(USER.emailLower);
      expect(Math.round(days)).toBe(EMAIL.RETENTION_DAYS);
    });

    it('demands the retained address’s code on the NEXT change', async () => {
      emails = createEmails([
        makeRetainedEmail({ id: 'ret-a', userId: USER.id, emailLower: RETAINED_LOWER }),
      ]);

      const grant = await start();
      expect(grant.requiredTargets).toEqual(['current', 'new', 'retained']);

      const recipients = mail.sendOtp.mock.calls.map(([to]) => to as string);
      expect(recipients).toHaveLength(3);
    });

    it('does NOT demand it once the retention has lapsed', async () => {
      emails = createEmails([
        makeRetainedEmail({
          id: 'ret-a',
          userId: USER.id,
          emailLower: RETAINED_LOWER,
          expiresAt: new Date(Date.now() - 1000),
        }),
      ]);

      const grant = await start();
      expect(grant.requiredTargets).toEqual(['current', 'new']);
    });

    it('completes a three-mailbox change', async () => {
      emails = createEmails([
        makeRetainedEmail({ id: 'ret-a', userId: USER.id, emailLower: RETAINED_LOWER }),
      ]);

      await start();
      knownCodes();
      await verifyChange({ retainedEmailCode: CODES.retained });

      expect(emails.current().emailLower).toBe(NEW_LOWER);
    });

    it('refuses a three-mailbox change missing the retained code', async () => {
      emails = createEmails([
        makeRetainedEmail({ id: 'ret-a', userId: USER.id, emailLower: RETAINED_LOWER }),
      ]);

      await start();
      knownCodes();
      await expectProblem(verifyChange(), ERR.VALIDATION_FAILED);
      expect(emails.current().emailLower).toBe(USER.emailLower);
    });

    it('refuses to start when more addresses are retained than it can verify', async () => {
      // The invariant, asserted rather than assumed. If `RETENTION_DAYS` and the change
      // window are ever changed apart, this refuses rather than silently verifying fewer
      // mailboxes than the policy requires.
      emails = createEmails([
        makeRetainedEmail({ id: 'a', userId: USER.id, emailLower: 'a@example.test' }),
        makeRetainedEmail({ id: 'b', userId: USER.id, emailLower: 'b@example.test' }),
      ]);

      await expectProblem(start(), ERR.EMAIL_CHANGE_SECURITY_REQUIRED);
    });
  });

  describe('the unreachable-mailbox escape', () => {
    beforeEach(() => {
      emails = createEmails([
        makeRetainedEmail({ id: 'ret-a', userId: USER.id, emailLower: RETAINED_LOWER }),
      ]);
    });

    it('waives the retained code for a strong tier', async () => {
      factors.listPasskeys.mockResolvedValue([{ id: 'p' }]);

      const grant = await start({ method: 'passkey', skipRetainedEmail: true });

      expect(grant.requiredTargets).toEqual(['current', 'new']);
      expect(grant.skippedRetained).toBe(true);
    });

    it('expires the retention when the escape is used', async () => {
      factors.listPasskeys.mockResolvedValue([{ id: 'p' }]);

      await start({ method: 'passkey', skipRetainedEmail: true });
      knownCodes();
      await verifyChange({ passkey: { id: 'cred' } });

      const [[input]] = emails.changeEmail.mock.calls as [[Record<string, unknown>]];
      expect(input.skippedRetainedId).toBe('ret-a');
    });

    it('refuses the escape on the password tier', async () => {
      // On an account whose only proof is a password, an attacker holding that password
      // could otherwise shed the very record the real owner needs to recover.
      users.findWithCredential.mockResolvedValue({ user: USER, credential: { id: 'c' } });

      await expectProblem(
        start({ method: 'password', skipRetainedEmail: true }),
        ERR.EMAIL_CHANGE_SECURITY_REQUIRED,
      );
    });

    it('refuses the escape on the "none" tier', async () => {
      await expectProblem(
        start({ method: 'none', skipRetainedEmail: true }),
        ERR.EMAIL_CHANGE_SECURITY_REQUIRED,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  SESSIONS, BUDGET AND NOTIFICATIONS
  // ══════════════════════════════════════════════════════════════════════════

  describe('what else a completed change does', () => {
    it('revokes EVERY session, including the caller’s', async () => {
      // Unlike a password change, which keeps the caller's. The address that
      // authenticated this session no longer belongs to the account.
      await start();
      knownCodes();
      await verifyChange();

      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
        USER.id,
        REVOKE_REASON.EMAIL_CHANGED,
      );
    });

    it('mails the released address a recovery link and the new one a welcome', async () => {
      await start();
      knownCodes();
      await verifyChange();

      const [[to, masked, url]] = mail.sendEmailChanged.mock.calls as [[string, string, string]];
      expect(to).toBe(USER.email);
      // Masked: this message goes to an address the account no longer controls, and
      // printing the new one in full would hand a stranger the identifier they need.
      expect(masked).not.toBe(NEW_EMAIL);
      expect(url).toContain('token=');
      // Trailing null: no anti-phishing code on the fixture account. When one IS set,
      // both of these carry it — see the anti-phishing mail specs.
      expect(mail.sendEmailAdded).toHaveBeenCalledWith(NEW_EMAIL, FACTS.ipClass, null);
    });

    it('does not fail the change when the recovery mail cannot be queued', async () => {
      // The change has already committed; reporting failure would tell a user their
      // address is unchanged when it is not.
      mail.sendEmailChanged.mockRejectedValue(new Error('queue down'));

      await start();
      knownCodes();
      await expect(verifyChange()).resolves.toBeDefined();

      expect(emails.current().emailLower).toBe(NEW_LOWER);
    });

    it('charges the change budget on SUCCESS', async () => {
      await start();
      knownCodes();
      await verifyChange();

      expect(quota.countFor(KEYS.rate.emailChangeByAccount(USER.id))).toBe(1);
    });

    it('does NOT charge it for a ceremony that failed its proofs', async () => {
      // A product cap on how often the identifier moves, not an anti-abuse bound — those
      // are charged on entry. A failed ceremony must not spend one of two monthly
      // changes.
      factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 't' }]);
      twoFactor.proveTotpCode.mockResolvedValue(false);

      await start({ method: 'authenticator' });
      knownCodes();
      await verifyChange({ totpCode: 'wrong' }).catch(() => undefined);

      expect(quota.countFor(KEYS.rate.emailChangeByAccount(USER.id))).toBe(0);
    });

    it('meters start and verify on the account, on entry', async () => {
      await start();

      expect(cache.consume).toHaveBeenCalledWith(
        KEYS.rate.emailChangeStartByAccount(USER.id),
        policy().EMAIL_CHANGE.START_BY_ACCOUNT,
        'deny',
      );
    });

    /**
     * A resend used to spend a START slot, which made the long challenge TTL — kept
     * long so a resend fits inside one ceremony — unreachable in the case that needs
     * it. A failed verification spends the emailed codes before proving the factor,
     * so recovering from one mistyped authenticator code costs two resends; out of
     * the five-an-hour start budget, two mistakes ended the hour.
     */
    it('meters a resend on its own budget, not the start one', async () => {
      await start();
      const grant = JSON.parse(
        cache.store.get(KEYS.emailChange.pending(USER.id)) as string,
      ) as EmailChangeGrant;

      cache.consume.mockClear();
      await build().resend(PRINCIPAL, IP, {
        action: 'resend',
        challengeId: grant.challengeId,
        target: 'new',
      } as never);

      expect(cache.consume).toHaveBeenCalledWith(
        KEYS.rate.emailChangeResendByAccount(USER.id),
        policy().EMAIL_CHANGE.RESEND_BY_ACCOUNT,
        'deny',
      );
      expect(cache.consume).not.toHaveBeenCalledWith(
        KEYS.rate.emailChangeStartByAccount(USER.id),
        expect.anything(),
        expect.anything(),
      );
    });

    it('lets a ceremony survive two mistyped authenticator codes', async () => {
      // The arithmetic the separation exists for: start, fail, resend both codes,
      // fail, resend both again — six calls that used to need eight start slots and
      // now spend one start and four resends.
      factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 't' }]);
      twoFactor.proveTotpCode.mockResolvedValue(false);

      await start({ method: 'authenticator' });
      const grant = JSON.parse(
        cache.store.get(KEYS.emailChange.pending(USER.id)) as string,
      ) as EmailChangeGrant;

      const resendBoth = async () => {
        for (const target of ['current', 'new'] as const) {
          await build().resend(PRINCIPAL, IP, {
            action: 'resend',
            challengeId: grant.challengeId,
            target,
          } as never);
        }
      };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        knownCodes();
        await verifyChange({ totpCode: 'wrong' }).catch(() => undefined);
        await resendBoth();
      }

      // One start, four resends — and the resends never touched the start bucket.
      const chargesTo = (key: string) =>
        cache.consume.mock.calls.filter((call) => call[0] === key).length;

      expect(chargesTo(KEYS.rate.emailChangeStartByAccount(USER.id))).toBe(1);
      expect(chargesTo(KEYS.rate.emailChangeResendByAccount(USER.id))).toBe(4);
      expect(policy().EMAIL_CHANGE.RESEND_BY_ACCOUNT.limit).toBeGreaterThanOrEqual(4);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  RECOVERY
  // ══════════════════════════════════════════════════════════════════════════

  describe('recovery from a recent change', () => {
    beforeEach(() => {
      emails = createEmails([
        makeRetainedEmail({
          id: 'ret-a',
          userId: USER.id,
          email: RETAINED_EMAIL,
          emailLower: RETAINED_LOWER,
          recoveryTokenHash: pepperedHash(RECOVERY_TOKEN, 'email-recovery'),
        }),
      ]);
    });

    const recoverStart = (overrides: Record<string, unknown> = {}) =>
      build().recoverStart(IP, FACTS.ipClass, {
        action: 'recover-start',
        recoveryId: RECOVERY_TOKEN,
        intent: 'restore',
        ...overrides,
      } as never);

    const recoverVerify = (overrides: Record<string, unknown> = {}) =>
      build().verifyRecovery(IP, FACTS.ipClass, {
        recoveryId: RECOVERY_TOKEN,
        retainedEmailCode: CODES.retained,
        ...overrides,
      } as never);

    it('restores the account WITHOUT any session', async () => {
      // ═══ THE POINT OF THE WHOLE FLOW ══════════════════════════════════════
      //
      // A completed change sweeps every session and the released address cannot sign in,
      // so the person who needs this is precisely the one who cannot authenticate.
      // Nothing in either call takes a principal.
      await recoverStart({ reportedCompromise: true });
      knownCodes();
      await recoverVerify();

      expect(emails.current().emailLower).toBe(RETAINED_LOWER);
    });

    it('sends the code to the released address, not to the account’s current one', async () => {
      await recoverStart();

      const recipients = mail.sendOtp.mock.calls.map(([to]) => to as string);
      expect(recipients).toEqual([RETAINED_EMAIL]);
    });

    it('drops the retention once the address is the account’s again', async () => {
      await recoverStart();
      knownCodes();
      await recoverVerify();

      expect(emails.rows()).toHaveLength(0);
    });

    it('moves the account to a third address on replace, and re-reserves the old one', async () => {
      await recoverStart({ intent: 'replace', newEmail: 'Third@example.test' });
      knownCodes();
      await recoverVerify({ newEmailCode: CODES.new });

      expect(emails.current().emailLower).toBe('third@example.test');

      const [[input]] = emails.recoverEmail.mock.calls as [[Record<string, unknown>]];
      const renewed = input.renewedExpiresAt as Date;
      const days = (renewed.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      // The founder's rule: a replace resets the window to a FULL retention period.
      expect(Math.round(days)).toBe(EMAIL.RETENTION_DAYS);
    });

    it('sends a code to BOTH mailboxes on replace', async () => {
      await recoverStart({ intent: 'replace', newEmail: 'Third@example.test' });

      const recipients = mail.sendOtp.mock.calls.map(([to]) => to as string);
      expect(recipients).toHaveLength(2);
    });

    it('mails a fresh recovery link after a replace, and none after a restore', async () => {
      await recoverStart({ intent: 'replace', newEmail: 'Third@example.test' });
      knownCodes();
      await recoverVerify({ newEmailCode: CODES.new });

      // The released address is on hold again, so it gets the same question again.
      expect(mail.sendEmailChanged).toHaveBeenCalled();
    });

    it('releases the address it takes away, with no reservation of its own', async () => {
      // In the compromise case that is the attacker's address. Reserving it would
      // withhold it from its owner AND make it a mailbox that must answer the victim's
      // next change.
      await recoverStart();
      knownCodes();
      await recoverVerify();

      expect(emails.rows().some((r) => r.emailLower === USER.emailLower)).toBe(false);
      expect(mail.sendEmailRemoved).toHaveBeenCalledWith(USER.email, FACTS.ipClass);
    });

    /**
     * ─── THE FREEZE MUST NOT REACH THIS FLOW ────────────────────────────────
     *
     * A completed change starts a 24-hour security cooldown that blocks 2FA, the
     * Payment PIN and the password. Recovery is the one thing it must never block, and
     * the trap is specific: a live retention and a fresh `emailChangedAt` are BOTH
     * always present here — they are what a recovery is — so the obvious predicate
     * ("has the address moved recently?") is true for every legitimate recovery there
     * will ever be. Applying the policy here would close the flow permanently, for the
     * exact population it exists for: the victim of a takeover, who cannot authenticate
     * because the change swept their sessions and the released address cannot sign in.
     *
     * The defence is that `EmailChangeService` does not have the collaborator at all.
     * These tests hold it to that from the outside.
     */
    describe('the security cooldown does not apply here', () => {
      beforeEach(() => {
        // The account is frozen: its address moved a moment ago. Every protected
        // security setting is refused right now — see tests/settings/security-cooldown.spec.ts.
        users.findById.mockResolvedValue(
          makeUser({
            email: USER.email,
            emailLower: USER.emailLower,
            emailChangedAt: new Date(),
          }),
        );
      });

      it('starts a recovery while the account is frozen', async () => {
        await expect(recoverStart()).resolves.toMatchObject({ intent: 'restore' });
      });

      it('completes a RESTORE while the account is frozen', async () => {
        await recoverStart();
        knownCodes();

        await expect(recoverVerify()).resolves.toMatchObject({ intent: 'restore' });
        expect(emails.current().emailLower).toBe(RETAINED_LOWER);
      });

      it('completes a REPLACE while the account is frozen', async () => {
        await recoverStart({ intent: 'replace', newEmail: 'Third@example.test' });
        knownCodes();

        await expect(recoverVerify({ newEmailCode: CODES.new })).resolves.toMatchObject({
          intent: 'replace',
        });
        expect(emails.current().emailLower).toBe('third@example.test');
      });

      it('does not take a security-cooldown collaborator in the first place', () => {
        // Structural, and deliberately so. A test that only drove the three calls above
        // would keep passing if someone later injected the policy and called it on a
        // path these happen not to reach. The service cannot apply a rule it cannot
        // reach, and this is what pins that down.
        const source = readFileSync(
          join(__dirname, '../../../src/settings/email/email.service.ts'),
          'utf8',
        );
        expect(source).not.toContain('RecentSecurityChangePolicy');
        expect(source).not.toContain('assertNoRecentEmailChange');
      });
    });

    it('revokes every session, with its own reason', async () => {
      await recoverStart();
      knownCodes();
      await recoverVerify();

      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
        USER.id,
        REVOKE_REASON.EMAIL_RECOVERED,
      );
    });

    it('does NOT spend a change-budget slot', async () => {
      // Charging it would let an attacker exhaust the budget and thereby block the
      // victim's recovery.
      await recoverStart();
      knownCodes();
      await recoverVerify();

      expect(quota.countFor(KEYS.rate.emailChangeByAccount(USER.id))).toBe(0);
    });

    it('refuses an unknown ticket', async () => {
      await expectProblem(
        recoverStart({ recoveryId: 'never-issued' }),
        ERR.EMAIL_RECOVERY_INVALID,
      );
    });

    it('refuses an expired ticket', async () => {
      emails = createEmails([
        makeRetainedEmail({
          id: 'ret-a',
          userId: USER.id,
          emailLower: RETAINED_LOWER,
          expiresAt: new Date(Date.now() - 1000),
          recoveryTokenHash: pepperedHash(RECOVERY_TOKEN, 'email-recovery'),
        }),
      ]);

      await expectProblem(recoverStart(), ERR.EMAIL_RECOVERY_INVALID);
    });

    it('refuses an already-spent ticket', async () => {
      emails = createEmails([
        makeRetainedEmail({
          id: 'ret-a',
          userId: USER.id,
          emailLower: RETAINED_LOWER,
          recoveryConsumedAt: new Date(),
          recoveryTokenHash: pepperedHash(RECOVERY_TOKEN, 'email-recovery'),
        }),
      ]);

      await expectProblem(recoverStart(), ERR.EMAIL_RECOVERY_INVALID);
    });

    it('gives the SAME error for unknown, expired and spent', async () => {
      // Sharper here than anywhere else in the feature: this path is reachable without a
      // session, so a caller able to tell them apart would have an oracle for which
      // addresses were recently changed away from.
      const slugs: string[] = [];
      for (const rows of [
        [],
        [makeRetainedEmail({ userId: USER.id, expiresAt: new Date(0), recoveryTokenHash: pepperedHash(RECOVERY_TOKEN, 'email-recovery') })],
        [makeRetainedEmail({ userId: USER.id, recoveryConsumedAt: new Date(), recoveryTokenHash: pepperedHash(RECOVERY_TOKEN, 'email-recovery') })],
      ]) {
        emails = createEmails(rows);
        await recoverStart().catch((err: unknown) => slugs.push((err as ProblemException).type));
      }

      expect(new Set(slugs)).toEqual(new Set([ERR.EMAIL_RECOVERY_INVALID]));
    });

    it('refuses a replayed recovery', async () => {
      await recoverStart();
      knownCodes();
      await recoverVerify();

      await expectProblem(recoverStart(), ERR.EMAIL_RECOVERY_INVALID);
    });

    it('refuses a restore that carries a second code', async () => {
      await recoverStart();
      knownCodes();

      await expectProblem(
        recoverVerify({ newEmailCode: CODES.new }),
        ERR.VALIDATION_FAILED,
      );
    });

    it('refuses a replace whose target is already taken', async () => {
      users.emailExists.mockResolvedValue(true);

      await expectProblem(
        recoverStart({ intent: 'replace', newEmail: 'taken@example.test' }),
        ERR.EMAIL_ALREADY_REGISTERED,
      );
    });

    it('meters by IP on entry, before the ticket resolves', async () => {
      await recoverStart();

      expect(cache.consume).toHaveBeenCalledWith(
        KEYS.rate.emailRecoverByIp(IP),
        policy().EMAIL_CHANGE.RECOVER_BY_IP,
        'deny',
      );
    });

    it('meters by the RECORD once it does, so a fresh ticket cannot mint a fresh budget', async () => {
      await recoverStart();

      expect(cache.consume).toHaveBeenCalledWith(
        KEYS.rate.emailRecoverByRecord('ret-a'),
        policy().EMAIL_CHANGE.RECOVER_BY_TOKEN,
        'deny',
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  CROSS-CUTTING
  // ══════════════════════════════════════════════════════════════════════════

  describe('properties that hold across every path', () => {
    it('never reads an account id from anything but the principal or the ticket', async () => {
      // A grant belonging to another account cannot be spent, whatever the body says.
      const foreign: EmailChangeGrant = {
        challengeId: 'planted',
        userId: 'someone-else',
        familyId: PRINCIPAL.familyId,
        newEmail: 'attacker@example.test',
        newEmailLower: 'attacker@example.test',
        method: 'none',
        requiredTargets: ['current', 'new'],
        retainedEmailLower: null,
        skippedRetained: false,
      };
      await cache.set(KEYS.emailChange.pending(USER.id), serialiseGrant(foreign), 1800);

      await expectProblem(
        build().verifyChange(PRINCIPAL, FACTS, {
          challengeId: 'planted',
          currentEmailCode: CODES.current,
          newEmailCode: CODES.new,
          method: 'none',
        } as never),
        ERR.EMAIL_CHANGE_CHALLENGE_INVALID,
      );
      expect(emails.current().emailLower).toBe(USER.emailLower);
    });

    it('never puts a raw address in the challenge record beyond the one being claimed', async () => {
      await start();

      const raw = cache.store.get(KEYS.emailChange.pending(USER.id)) as string;
      expect(raw).toContain(NEW_LOWER);
      // The recovery token is never in the record — it lives only in the database and
      // the mailbox.
      expect(raw).not.toContain(RECOVERY_TOKEN);
    });

    it('never returns the recovery token from the change path', async () => {
      await start();
      knownCodes();
      const result = await verifyChange();

      expect(JSON.stringify(result)).not.toContain('token');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  THE SIGN-INS THAT WERE HALF-WAY THROUGH
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * ═══ AN EMAIL CHANGE MUST END IN-FLIGHT LOGIN ATTEMPTS TOO ═════════════════
   *
   * The password change learned this first: a session sweep ends sign-ins that
   * FINISHED, and a sign-in half-way through its MFA ceremony has no session yet. It is
   * a `login_attempts` row at `FACTOR_REQUIRED` holding a `loginId`, and nothing in the
   * second half of that ceremony re-reads the identifier the flow started from.
   *
   * It bites harder here than on a password change. `commitChange` revokes EVERY
   * session with no exception kept, on the stated reasoning that the address which
   * authenticated them is no longer the account's — so a flow opened against that same
   * released address was resting on exactly the credential the sweep distrusts, and
   * survived it.
   *
   * ─── Why these run the REAL MfaService ─────────────────────────────────────
   *
   * The `mfa` double elsewhere in this file returns a canned zero, which would pass
   * whether or not the predicate is right. Here `expireLiveAttemptsFor` is the
   * production method, over the production `TwoFactorDbOperation` and its
   * `LIVE_STATES`, against an in-memory `login_attempts` table — and the same real
   * service then answers `requireAttempt`, which is what `POST /auth/2fa/verify`
   * actually calls. Only the storage is substituted.
   */
  describe('live login attempts', () => {
    /** Prisma's `where` grammar, only as far as these two queries use it. */
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
      Object.entries(where).every(([field, condition]) => {
        const value = row[field];
        if (condition !== null && typeof condition === 'object') {
          const clause = condition as { in?: unknown[]; not?: unknown };
          if (Array.isArray(clause.in)) return clause.in.includes(value);
          if ('not' in clause) return value !== clause.not;
          return false;
        }
        return value === condition;
      });

    const CLIENT = {
      ip: IP,
      ipClass: FACTS.ipClass,
      deviceId: 'device-id',
      deviceKey: 'device-key-for-this-suite',
      userAgent: 'Firefox on Windows',
    };

    let rows: Record<string, unknown>[];
    let realMfa: MfaService;

    /** Seed a flow exactly as the login path leaves it; returns its `loginId`. */
    function seed(loginId: string, overrides: Record<string, unknown> = {}): string {
      rows.push({
        id: `attempt-${loginId}`,
        userId: USER.id,
        tokenHash: pepperedHash(loginId, 'mfa'),
        identifierLower: USER.emailLower,
        state: 'FACTOR_REQUIRED',
        attempts: 0,
        ipClass: CLIENT.ipClass,
        deviceFingerprint: CLIENT.deviceKey,
        userAgent: CLIENT.userAgent,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        completedAt: null,
        ...overrides,
      });
      return loginId;
    }

    const stateOf = (loginId: string): unknown =>
      rows.find((r) => r['id'] === `attempt-${loginId}`)?.['state'];

    /** Continue a half-finished sign-in, as `POST /auth/2fa/verify` does. */
    async function continueFlow(loginId: string): Promise<ProblemException> {
      try {
        await realMfa.requireAttempt(loginId, CLIENT as never);
      } catch (err) {
        expect(err).toBeInstanceOf(ProblemException);
        return err as ProblemException;
      }
      throw new Error('expected the in-flight login attempt to be refused, but it was accepted');
    }

    beforeEach(() => {
      rows = [];
      const prisma = {
        loginAttempt: {
          findFirst: async ({ where }: { where: Record<string, unknown> }) =>
            rows.find((r) => matches(r, where)) ?? null,
          updateMany: async ({
            where,
            data,
          }: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            const hit = rows.filter((r) => matches(r, where));
            for (const r of hit) Object.assign(r, data);
            return { count: hit.length };
          },
        },
      };
      realMfa = new MfaService(new TwoFactorDbOperation(prisma as never));
      // The service under test now calls the production invalidation, not a stub.
      mfa.expireLiveAttemptsFor = vi.fn((userId: string) => realMfa.expireLiveAttemptsFor(userId));
    });

    // ─── 1. the core regression ─────────────────────────────────────────────

    it('accepts the handle BEFORE the email changes', async () => {
      // The precondition. A handle that was never usable would prove nothing.
      const loginId = seed('live-handle');

      expect((await realMfa.requireAttempt(loginId, CLIENT as never)).state).toBe(
        'FACTOR_REQUIRED',
      );
    });

    it('refuses the SAME handle after a completed change', async () => {
      // ═══ THE FINDING ══════════════════════════════════════════════════════
      const loginId = seed('live-handle');

      await start();
      knownCodes();
      await verifyChange();

      const err = await continueFlow(loginId);

      // The hash is nulled with the state, so the finder cannot match it at all.
      expect(err.type).toBe(ERR.MFA_TOKEN_INVALID);
      expect(stateOf(loginId)).toBe('EXPIRED');
      expect(rows[0]?.['tokenHash']).toBeNull();
    });

    // ─── 2. every live state ────────────────────────────────────────────────

    it.each(['STARTED', 'OTP_SENT', 'FACTOR_REQUIRED'])(
      'retires a flow in the %s state',
      async (state) => {
        // The three members of `LIVE_STATES`, read from production rather than
        // re-listed here.
        seed('handle', { state });

        await start();
        knownCodes();
        await verifyChange();

        expect(stateOf('handle')).toBe('EXPIRED');
      },
    );

    // ─── 3. all of them ─────────────────────────────────────────────────────

    it('retires every live flow the account has', async () => {
      // A double-clicked button, a second tab, and one still awaiting its code.
      seed('a');
      seed('b');
      seed('c', { state: 'OTP_SENT' });

      await start();
      knownCodes();
      await verifyChange();

      for (const handle of ['a', 'b', 'c']) expect(stateOf(handle)).toBe('EXPIRED');
      expect((await continueFlow('a')).type).toBe(ERR.MFA_TOKEN_INVALID);
    });

    // ─── 4. other accounts ──────────────────────────────────────────────────

    it('leaves another account’s sign-in alone', async () => {
      seed('mine');
      seed('theirs', { userId: 'some-other-user-id' });

      await start();
      knownCodes();
      await verifyChange();

      expect(stateOf('mine')).toBe('EXPIRED');
      expect(stateOf('theirs')).toBe('FACTOR_REQUIRED');
      expect((await realMfa.requireAttempt('theirs', CLIENT as never)).userId).toBe(
        'some-other-user-id',
      );
    });

    // ─── 5. a change that does not succeed ──────────────────────────────────

    it('leaves the handle usable when the emailed code is wrong', async () => {
      const loginId = seed('live-handle');

      await start();
      knownCodes();
      await verifyChange({ currentEmailCode: '999999' }).catch(() => undefined);

      expect(stateOf(loginId)).toBe('FACTOR_REQUIRED');
      expect((await realMfa.requireAttempt(loginId, CLIENT as never)).state).toBe(
        'FACTOR_REQUIRED',
      );
    });

    it('leaves the handle usable when the factor proof is wrong', async () => {
      const loginId = seed('live-handle');
      factors.listConfirmedTotpFactors.mockResolvedValue([{ id: 't' }]);
      twoFactor.proveTotpCode.mockResolvedValue(false);

      await start({ method: 'authenticator' });
      knownCodes();
      await verifyChange({ totpCode: '000000' }).catch(() => undefined);

      expect(stateOf(loginId)).toBe('FACTOR_REQUIRED');
    });

    it('leaves the handle usable when the address was claimed meanwhile', async () => {
      const loginId = seed('live-handle');

      await start();
      knownCodes();
      users.emailExists.mockResolvedValue(true);
      await verifyChange().catch(() => undefined);

      expect(stateOf(loginId)).toBe('FACTOR_REQUIRED');
      expect(mfa.expireLiveAttemptsFor).not.toHaveBeenCalled();
    });

    it('leaves the handle usable when only the change was STARTED', async () => {
      // Sending codes is not a security-boundary transition. Nothing has moved yet, and
      // an abandoned start must not sign anyone out of a ceremony.
      const loginId = seed('live-handle');

      await start();

      expect(stateOf(loginId)).toBe('FACTOR_REQUIRED');
      expect(mfa.expireLiveAttemptsFor).not.toHaveBeenCalled();
    });

    // ─── 6. terminal rows keep their meaning ────────────────────────────────

    it('does not disturb COMPLETED or EXPIRED attempts', async () => {
      const completedAt = new Date('2026-09-01T12:00:00.000Z');
      seed('done', { state: 'COMPLETED', tokenHash: null, completedAt });
      seed('gone', { state: 'EXPIRED', tokenHash: null });

      await start();
      knownCodes();
      await verifyChange();

      expect(stateOf('done')).toBe('COMPLETED');
      expect(rows[0]?.['completedAt']).toBe(completedAt);
      expect(stateOf('gone')).toBe('EXPIRED');
    });

    // ─── 7. the session sweep is unchanged ──────────────────────────────────

    it('still revokes every session, alongside the new invalidation', async () => {
      seed('live-handle');

      await start();
      knownCodes();
      await verifyChange();

      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
        USER.id,
        REVOKE_REASON.EMAIL_CHANGED,
      );
      expect(stateOf('live-handle')).toBe('EXPIRED');
    });

    // ─── the recovery path writes the address too ───────────────────────────

    describe('the recovery path', () => {
      beforeEach(() => {
        emails = createEmails([
          makeRetainedEmail({
            id: 'ret-a',
            userId: USER.id,
            email: RETAINED_EMAIL,
            emailLower: RETAINED_LOWER,
            recoveryTokenHash: pepperedHash(RECOVERY_TOKEN, 'email-recovery'),
          }),
        ]);
      });

      const recoverStart = (overrides: Record<string, unknown> = {}) =>
        build().recoverStart(IP, FACTS.ipClass, {
          action: 'recover-start',
          recoveryId: RECOVERY_TOKEN,
          intent: 'restore',
          ...overrides,
        } as never);

      const recoverVerify = (overrides: Record<string, unknown> = {}) =>
        build().verifyRecovery(IP, FACTS.ipClass, {
          recoveryId: RECOVERY_TOKEN,
          retainedEmailCode: CODES.retained,
          ...overrides,
        } as never);

      it('retires live flows when an address is restored', async () => {
        // The second write path, and the one where the argument is strongest: in the
        // case this flow exists for, whoever holds a live `loginId` is the attacker
        // whose change is being reversed.
        const loginId = seed('live-handle');

        await recoverStart();
        knownCodes();
        await recoverVerify();

        expect((await continueFlow(loginId)).type).toBe(ERR.MFA_TOKEN_INVALID);
        expect(stateOf(loginId)).toBe('EXPIRED');
      });

      it('retires live flows when the address is replaced instead', async () => {
        const loginId = seed('live-handle');

        await recoverStart({ intent: 'replace', newEmail: 'Third@example.test' });
        knownCodes();
        await recoverVerify({ newEmailCode: CODES.new });

        expect(stateOf(loginId)).toBe('EXPIRED');
      });

      it('leaves flows alone when only the recovery was STARTED', async () => {
        const loginId = seed('live-handle');

        await recoverStart();

        expect(stateOf(loginId)).toBe('FACTOR_REQUIRED');
        expect(mfa.expireLiveAttemptsFor).not.toHaveBeenCalled();
      });

      it('leaves flows alone when the released-mailbox code is wrong', async () => {
        const loginId = seed('live-handle');

        await recoverStart();
        knownCodes();
        await recoverVerify({ retainedEmailCode: '999999' }).catch(() => undefined);

        expect(stateOf(loginId)).toBe('FACTOR_REQUIRED');
      });
    });
  });
});
