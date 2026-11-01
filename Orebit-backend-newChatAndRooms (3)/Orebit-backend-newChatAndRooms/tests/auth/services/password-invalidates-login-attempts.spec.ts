import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginAttempt, LoginState } from '@prisma/client';
import { pepperedHash } from '../../../auth/auth.utility';
import { PasswordService } from '../../../auth/services/password.service';
import type { ChallengeDbOperation } from '../../../auth/persistence/challenge.dboperation';
import type { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import type { SessionService } from '../../../auth/services/session.service';
import type { CredentialService } from '../../../auth/services/credential.service';
import type { ClientContext, Principal } from '../../../auth/auth.types';
import { TwoFactorDbOperation } from '../../../src/2fa/2fa.dboperation';
import { MfaService } from '../../../src/2fa/mfa.service';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import type { MailService } from '../../../src/mail/mail.service';
import type { CacheService } from '../../../redis';
import type { PrismaService } from '../../../db/client';
import { makeUser } from '../../harness';
import { makeRestrictions } from '../../restrictions/double';

/**
 * ═══ CHANGING THE PASSWORD MUST END THE SIGN-IN THAT IS HALF-WAY THROUGH ════
 *
 * The password change swept sessions and stopped there. A sign-in in the middle of
 * its MFA ceremony is not a session yet: it is a `login_attempts` row at
 * `FACTOR_REQUIRED`, holding a `loginId` with roughly fifteen minutes of budget, and
 * NOTHING in the second half of that ceremony reads the password again —
 * `requireAttempt` asks only that the row is live, in that state, and presented from
 * the same device and network class.
 *
 * So the attack the review described worked: know the password, `POST /auth/login`,
 * get promoted to `FACTOR_REQUIRED`, wait for the owner to change their password in
 * response to exactly that suspicion, and finish the flow from the handle already in
 * hand. The session sweep could not see it — there was no session — and the
 * credential write could not either.
 *
 * ─── Why this file drives the REAL persistence code ────────────────────────
 *
 * The brief asks for a test that reproduces the security scenario rather than
 * asserting a field changed, and a doubled `MfaService` returning a canned refusal
 * would prove nothing: the question is whether the actual `updateMany` predicate
 * catches the actual rows the actual guard then reads.
 *
 * So the real `TwoFactorDbOperation` and the real `MfaService` run here, over an
 * in-memory `login_attempts` table that implements the Prisma filter forms those
 * queries use. What the assertions exercise is the production `where` clause, the
 * production `LIVE_STATES` list, and the production `requireAttempt` guard — only the
 * storage is substituted, and it is deliberately dumb enough not to encode any of the
 * behaviour under test.
 */

const USER_ID = '01940000-0000-7000-8000-0000000000a1';
const OTHER_USER_ID = '01940000-0000-7000-8000-0000000000b2';
const NEW_PASSWORD = 'Br4nd!NewPassw0rd';

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: '01940000-0000-7000-8000-0000000000d1',
  // `assertSameContext` compares the row's `deviceFingerprint` against this.
  deviceKey: 'device-key-for-this-suite',
  userAgent: 'Firefox on Windows', country: null,
};

const principal: Principal = {
  userId: USER_ID,
  sessionId: '01940000-0000-7000-8000-0000000000c1',
  publicCode: 'OREBiT7Q9K2M4X',
  familyId: '01940000-0000-7000-8000-0000000000f1',
};

// ─── the in-memory login_attempts table ───────────────────────────────────────

/**
 * The subset of Prisma's `where` grammar these queries actually use: scalar equality,
 * `{ in: [...] }`, `{ not: x }`, and `null`. Written once and generically so the table
 * cannot accidentally special-case the predicate under test.
 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, condition]) => {
    const value = row[field];
    if (condition !== null && typeof condition === 'object') {
      const clause = condition as { in?: unknown[]; not?: unknown };
      if (Array.isArray(clause.in)) return clause.in.includes(value);
      if ('not' in clause) return value !== clause.not;
      return false;
    }
    return value === condition;
  });
}

function createAttemptsTable() {
  const rows: Record<string, unknown>[] = [];

  return {
    rows,
    loginAttempt: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return (rows.find((row) => matches(row, where)) ?? null) as LoginAttempt | null;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hit = rows.filter((row) => matches(row, where));
          for (const row of hit) Object.assign(row, data);
          return { count: hit.length };
        },
      ),
    },
  };
}

/** Seed one flow exactly as the login path leaves it, and return its `loginId`. */
function seedAttempt(
  table: ReturnType<typeof createAttemptsTable>,
  overrides: Partial<LoginAttempt> & { loginId: string },
): string {
  const { loginId, ...rest } = overrides;
  table.rows.push({
    id: `attempt-${loginId}`,
    userId: USER_ID,
    // The production hash, so the production finder locates it.
    tokenHash: pepperedHash(loginId, 'mfa'),
    identifierLower: 'ada@example.test',
    state: 'FACTOR_REQUIRED' as LoginState,
    attempts: 0,
    ipClass: client.ipClass,
    deviceFingerprint: client.deviceKey,
    userAgent: client.userAgent,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 15 * 60_000),
    completedAt: null,
    ...rest,
  });
  return loginId;
}

let table: ReturnType<typeof createAttemptsTable>;
let factors: TwoFactorDbOperation;
let mfa: MfaService;
let users: { findWithCredential: ReturnType<typeof vi.fn>; upsertPassword: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn> };
let sessions: { revokeAllForUserExcept: ReturnType<typeof vi.fn> };
let credentials: {
  hash: ReturnType<typeof vi.fn>;
  assertPolicy: ReturnType<typeof vi.fn>;
  checkPassword: ReturnType<typeof vi.fn>;
};
let service: PasswordService;

beforeEach(() => {
  table = createAttemptsTable();
  factors = new TwoFactorDbOperation(table as unknown as PrismaService);
  mfa = new MfaService(factors);

  const user = makeUser({ id: USER_ID });
  users = {
    findWithCredential: vi
      .fn()
      .mockResolvedValue({ user, credential: { id: 'cred-1', userId: USER_ID } }),
    upsertPassword: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(user),
  };
  sessions = { revokeAllForUserExcept: vi.fn().mockResolvedValue(undefined) };
  credentials = {
    hash: vi.fn().mockResolvedValue('$argon2id$fresh'),
    assertPolicy: vi.fn(),
    checkPassword: vi.fn().mockResolvedValue(true),
  };

  service = new PasswordService(
    users as unknown as UserDbOperation,
    { issue: vi.fn(), findLive: vi.fn(), consume: vi.fn() } as unknown as ChallengeDbOperation,
    credentials as unknown as CredentialService,
    sessions as unknown as SessionService,
    { sendSecurityChanged: vi.fn() } as unknown as MailService,
    makeRestrictions() as never,
    { consume: vi.fn().mockResolvedValue(undefined) } as unknown as CacheService,
    { assertNoRecentEmailChange: vi.fn().mockResolvedValue(undefined) } as never,
    mfa,
  );
});

const changePassword = (): Promise<void> =>
  service.change(
    principal,
    {
      action: 'change',
      currentPassword: 'Old!Passw0rd',
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    },
    client,
  );

/** Try to continue a half-finished sign-in, exactly as `POST /auth/2fa/verify` does. */
async function continueFlow(loginId: string): Promise<ProblemException> {
  try {
    await mfa.requireAttempt(loginId, client);
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the in-flight login attempt to be refused, but it was accepted');
}

const stateOf = (loginId: string): unknown =>
  table.rows.find((row) => row['id'] === `attempt-${loginId}`)?.['state'];

// ─── 1. the core regression ───────────────────────────────────────────────────

describe('a password change ends an in-flight login attempt', () => {
  it('accepts the attempt BEFORE the password changes', async () => {
    // The precondition. Without this the test below could pass for the wrong reason —
    // a handle that was never usable proves nothing about invalidation.
    const loginId = seedAttempt(table, { loginId: 'live-handle-1' });

    const attempt = await mfa.requireAttempt(loginId, client);

    expect(attempt.state).toBe('FACTOR_REQUIRED');
    expect(attempt.userId).toBe(USER_ID);
  });

  it('refuses the SAME handle after the password changes', async () => {
    // ═══ FINDING #4 ═══════════════════════════════════════════════════════════
    //
    // The attacker's flow, in order: promoted to FACTOR_REQUIRED with the old
    // password, then the victim changes it, then the attacker presents the handle
    // they were already holding. This used to resolve and let the ceremony continue.
    const loginId = seedAttempt(table, { loginId: 'live-handle-1' });

    await changePassword();

    const err = await continueFlow(loginId);

    // The handle no longer names anything: the state moved to EXPIRED and the hash was
    // nulled in the same statement, so the finder cannot match it at all.
    expect(err.type).toBe(ERR.MFA_TOKEN_INVALID);
    expect(stateOf(loginId)).toBe('EXPIRED');
  });

  it('retires the handle itself, not just the state', async () => {
    // `tokenHash` is nulled with the state, for the reason `promoteAttempt` gives: a
    // retired row that still carries a matchable value stays matchable the moment some
    // future finder forgets to filter on state.
    const loginId = seedAttempt(table, { loginId: 'live-handle-1' });

    await changePassword();

    expect(table.rows[0]?.['tokenHash']).toBeNull();
  });

  it('sweeps sessions AND attempts, not one or the other', async () => {
    // The two halves of "other authentication activity". Asserting both together is
    // what stops a future edit from removing one and leaving the promise half-kept.
    seedAttempt(table, { loginId: 'live-handle-1' });

    await changePassword();

    expect(sessions.revokeAllForUserExcept).toHaveBeenCalledTimes(1);
    expect(table.loginAttempt.updateMany).toHaveBeenCalled();
  });
});

// ─── 2. every live attempt, not merely the first ──────────────────────────────

describe('multiple in-flight attempts', () => {
  it('invalidates all of the account’s live flows', async () => {
    // A double-clicked button, a second tab, and a flow still at OTP_SENT. Every one
    // of them is drivable, so every one of them has to go.
    const handles = ['handle-a', 'handle-b', 'handle-c'];
    seedAttempt(table, { loginId: 'handle-a' });
    seedAttempt(table, { loginId: 'handle-b' });
    seedAttempt(table, { loginId: 'handle-c', state: 'OTP_SENT' as LoginState });

    await changePassword();

    for (const loginId of handles) {
      expect(stateOf(loginId)).toBe('EXPIRED');
    }
  });

  it('refuses every handle afterwards', async () => {
    seedAttempt(table, { loginId: 'handle-a' });
    seedAttempt(table, { loginId: 'handle-b' });

    await changePassword();

    expect((await continueFlow('handle-a')).type).toBe(ERR.MFA_TOKEN_INVALID);
    expect((await continueFlow('handle-b')).type).toBe(ERR.MFA_TOKEN_INVALID);
  });

  it('retires a STARTED flow too — it is still drivable', async () => {
    // STARTED is in `LIVE_STATES`, so it is swept. It has not proven a first factor,
    // so it could not reach a second one anyway — but leaving it behind would keep a
    // row in the live-handle index for an account whose credential just changed.
    seedAttempt(table, { loginId: 'handle-started', state: 'STARTED' as LoginState });

    await changePassword();

    expect(stateOf('handle-started')).toBe('EXPIRED');
  });
});

// ─── 3. other accounts are not collateral ─────────────────────────────────────

describe('another user’s sign-in', () => {
  it('is untouched by this user’s password change', async () => {
    // The predicate is scoped by `userId` and nothing else. A sweep that caught the
    // wrong rows would sign strangers out of a ceremony they are half-way through.
    seedAttempt(table, { loginId: 'mine' });
    seedAttempt(table, { loginId: 'theirs', userId: OTHER_USER_ID });

    await changePassword();

    expect(stateOf('mine')).toBe('EXPIRED');
    expect(stateOf('theirs')).toBe('FACTOR_REQUIRED');
  });

  it('remains completable afterwards', async () => {
    seedAttempt(table, { loginId: 'theirs', userId: OTHER_USER_ID });

    await changePassword();

    const attempt = await mfa.requireAttempt('theirs', client);
    expect(attempt.userId).toBe(OTHER_USER_ID);
  });
});

// ─── 4. a FAILED password change changes nothing ──────────────────────────────

describe('a password change that does not succeed', () => {
  it('leaves an in-flight attempt usable when the current password is wrong', async () => {
    // The property that ties invalidation to a successful credential change rather
    // than to entering the path. `change` refuses before `commit` runs at all.
    const loginId = seedAttempt(table, { loginId: 'live-handle-1' });
    credentials.checkPassword.mockResolvedValue(false);

    await expect(changePassword()).rejects.toMatchObject({ type: ERR.INVALID_CREDENTIALS });

    expect(stateOf(loginId)).toBe('FACTOR_REQUIRED');
    const attempt = await mfa.requireAttempt(loginId, client);
    expect(attempt.state).toBe('FACTOR_REQUIRED');
  });

  it('leaves it usable when the new password fails policy', async () => {
    const loginId = seedAttempt(table, { loginId: 'live-handle-1' });
    credentials.assertPolicy.mockImplementation(() => {
      throw new ProblemException({ type: ERR.VALIDATION_FAILED });
    });

    await expect(changePassword()).rejects.toBeInstanceOf(ProblemException);

    expect(stateOf(loginId)).toBe('FACTOR_REQUIRED');
    expect(table.loginAttempt.updateMany).not.toHaveBeenCalled();
  });

  it('leaves it usable when the account is not authenticated', async () => {
    const loginId = seedAttempt(table, { loginId: 'live-handle-1' });
    users.findWithCredential.mockResolvedValue(null);

    await expect(changePassword()).rejects.toMatchObject({ type: ERR.UNAUTHENTICATED });

    expect(stateOf(loginId)).toBe('FACTOR_REQUIRED');
  });
});

// ─── 5. terminal rows keep their existing meaning ─────────────────────────────

describe('attempts that were already finished', () => {
  it('does not disturb a COMPLETED attempt', async () => {
    // `COMPLETED` is terminal and carries `completedAt`. Re-marking it EXPIRED would
    // rewrite the record of a sign-in that legitimately succeeded.
    const completedAt = new Date('2026-09-01T12:00:00.000Z');
    seedAttempt(table, {
      loginId: 'already-done',
      state: 'COMPLETED' as LoginState,
      tokenHash: null,
      completedAt,
    });

    await changePassword();

    const row = table.rows[0];
    expect(row?.['state']).toBe('COMPLETED');
    expect(row?.['completedAt']).toBe(completedAt);
  });

  it('does not re-expire an already EXPIRED attempt', async () => {
    seedAttempt(table, {
      loginId: 'already-gone',
      state: 'EXPIRED' as LoginState,
      tokenHash: null,
    });

    await changePassword();

    expect(table.rows[0]?.['state']).toBe('EXPIRED');
  });

  it('counts only the live rows it actually retired', async () => {
    // `LIVE_STATES` is the definition, so the count is the number of flows that were
    // genuinely drivable — one here, not three.
    seedAttempt(table, { loginId: 'live-one' });
    seedAttempt(table, { loginId: 'done', state: 'COMPLETED' as LoginState, tokenHash: null });
    seedAttempt(table, { loginId: 'gone', state: 'EXPIRED' as LoginState, tokenHash: null });

    expect(await mfa.expireLiveAttemptsFor(USER_ID)).toBe(1);
  });

  it('reports zero when the account has no sign-in in flight', async () => {
    // The ordinary case, and it must not be an error: most password changes happen
    // with nothing in flight at all.
    await expect(changePassword()).resolves.toBeUndefined();
    expect(await mfa.expireLiveAttemptsFor(USER_ID)).toBe(0);
  });
});
