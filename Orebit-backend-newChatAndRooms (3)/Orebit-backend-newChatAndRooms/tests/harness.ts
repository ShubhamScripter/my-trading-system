import { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import { ERR } from '../src/contracts';
import { ProblemException } from '../src/http';
import type {
  Credential,
  LoginAttempt,
  Registration,
  RetainedEmail,
  User,
  UsernameReservation,
  VerificationChallenge,
} from '@prisma/client';
import type { Principal } from '../auth/auth.types';
import { signAccessToken, signRefreshToken } from '../auth/security/jwt';
import { SESSION } from '../auth/auth.constants';
import { secondsFromNow } from '../src/utils/public.utils';
import type { PublicUser } from '../auth/auth.types';

/**
 * Shared fixtures and helpers for the unit suites.
 *
 * Every builder returns a COMPLETE row and takes an overrides object, rather
 * than a partial that each spec tops up. Two reasons: a spec then states only
 * the fields its assertion actually depends on, so what the test is about is
 * visible in one line; and adding a column to db/schema.prisma breaks this file
 * once at compile time instead of breaking thirty casts silently at runtime.
 */

/** Fixed instant, so anything asserting on a timestamp is deterministic. */
export const FIXED_NOW = new Date('2026-01-15T10:00:00.000Z');

/**
 * A `RecentSecurityChangePolicy` double that permits everything.
 *
 * Five services now take the policy, and the overwhelming majority of their specs are
 * about something else entirely — a spec for the Payment PIN's weak-PIN rule should not
 * have to know the security cooldown exists. This is the "no recent email change"
 * default, so those specs keep asserting what they were written to assert.
 *
 * A spec that IS about the freeze overrides `assertNoRecentEmailChange` to reject; see
 * tests/settings/security-cooldown.spec.ts, which does exactly that for every protected
 * surface at once.
 */
export function makeSecurityChangePolicy() {
  return { assertNoRecentEmailChange: vi.fn().mockResolvedValue(undefined) };
}

/**
 * A `$queryRaw` double for `assertNoRecentEmailChangeLocked`'s row lock.
 *
 * The guard runs `SELECT email_changed_at ... FOR UPDATE` inside every protected
 * mutation's transaction, so a dboperation spec's fake Prisma has to answer it. The
 * default is the un-frozen account, which is what a spec about predicates and scoping
 * wants. Pass a `Date` to freeze the account and assert the mutation is refused.
 */
export function makeCooldownLockQuery(emailChangedAt: Date | null = null) {
  return vi.fn().mockResolvedValue([{ email_changed_at: emailChangedAt }]);
}

const USER_ID = '01940000-0000-7000-8000-000000000001';

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: USER_ID,
    publicCode: 'OREBiT7Q9K2M4X',
    publicCodeKey: 'OREBIT7Q9K2M4X',
    username: 'ada_lovelace',
    usernameLower: 'ada_lovelace',
    email: 'Ada.Lovelace@example.test',
    emailLower: 'ada.lovelace@example.test',
    emailVerifiedAt: FIXED_NOW,
    /** Never changed. Specs exercising the security cooldown override it — see
     *  tests/auth/services/recent-security-change.policy.spec.ts. */
    emailChangedAt: null,
    status: 'ACTIVE',
    countryDeclared: 'GB',
    countryIp: null,
    avatarUrl: null,
    /** No anti-phishing code configured, which is the state every account is in until
     *  its owner sets one. Specs that need a sealed row build it with
     *  `sealAntiPhishingCode` and override all four — they are written and cleared
     *  together, so a partial override is not a state the service can produce. */
    antiPhishingCiphertext: null,
    antiPhishingIv: null,
    antiPhishingTag: null,
    antiPhishingKeyVersion: null,
    antiPhishingSetAt: null,
    referralCode: 'K7M2P9QR',
    referredByCode: null,
    referredByUserId: null,
    registeredAt: FIXED_NOW,
    lastSeenAt: null,
    /** A live account. The three deletion columns are written and cleared together, so
     *  the states a spec can legitimately build are: all three null (here), `status`
     *  DELETED with the two dates set (inside the recovery window), and all four set
     *  including `deletedAt` (purged). See `User.deletedAt` in db/schema.prisma. */
    deletedAt: null,
    deletionRequestedAt: null,
    purgeAt: null,
    ...overrides,
  };
}

/**
 * The API-boundary projection of `makeUser`, kept consistent with it by hand.
 *
 * Not derived via `toPublicUser(makeUser())`: the specs that assert the mapper
 * would then be asserting it against itself. The duplication is the point.
 */
export function makePublicUser(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    publicCode: 'OREBiT7Q9K2M4X',
    username: 'ada_lovelace',
    email: 'Ada.Lovelace@example.test',
    emailVerified: true,
    country: 'GB',
    referralCode: 'K7M2P9QR',
    hasPassword: true,
    registeredAt: FIXED_NOW,
    avatarUrl: null,
    ...overrides,
  };
}

export function makeCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: '01940000-0000-7000-8000-0000000000c1',
    userId: USER_ID,
    kind: 'PASSWORD',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash',
    passwordAlgo: 'argon2id',
    failedAttempts: 0,
    lockedUntil: null,
    lockoutStrikes: 0,
    lockoutStrikeAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    deletedAt: null,
    ...overrides,
  };
}

/**
 * A registration at the point account creation consumes it: email verified,
 * credentials recorded, nothing provider-related. The OAuth variants set
 * `oauthProvider` / `oauthSubject` explicitly.
 */
export function makeRegistration(overrides: Partial<Registration> = {}): Registration {
  return {
    id: '01940000-0000-7000-8000-0000000000e1',
    email: 'Ada.Lovelace@example.test',
    emailLower: 'ada.lovelace@example.test',
    state: 'CREDENTIALS_SET',
    pendingPasswordHash: null,
    continuationSecretHash: 'a'.repeat(64),
    otpHash: null,
    otpExpiresAt: null,
    otpAttempts: 0,
    otpSentCount: 1,
    lastOtpSentAt: FIXED_NOW,
    emailVerifiedAt: FIXED_NOW,
    passwordSet: true,
    referralCodeEntered: null,
    trustDevice: false,
    countrySuggested: null,
    country: null,
    ipAddress: '203.0.113.7',
    userId: null,
    completedAt: null,
    expiresAt: new Date(FIXED_NOW.getTime() + 60 * 60 * 1000),
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    deletedAt: null,
    oauthProvider: null,
    oauthSubject: null,
    oauthEmailVerified: false,
    oauthAvatarUrl: null,
    ...overrides,
  };
}

/**
 * A live login flow, mid-sign-in.
 *
 * Defaults to `FACTOR_REQUIRED` with an account attached, because that is the
 * state most specs are exercising — the half-authenticated caller finishing a
 * second factor. Pass `{ state: 'STARTED', userId: null, identifierLower: null }`
 * for a flow that has only just been opened, or `{ state: 'OTP_SENT' }` with an
 * `identifierLower` for the passwordless branch.
 *
 * `expiresAt` is relative to the real clock rather than `FIXED_NOW`, for the
 * reason `makeChallenge` gives below: the code under test compares it against
 * `Date.now()`, so a fixture pinned to a fixed date starts reading as expired.
 */
export function makeLoginAttempt(overrides: Partial<LoginAttempt> = {}): LoginAttempt {
  return {
    id: '01940000-0000-7000-8000-0000000000f1',
    userId: '01940000-0000-7000-8000-000000000001',
    tokenHash: 'b'.repeat(64),
    identifierLower: null,
    state: 'FACTOR_REQUIRED',
    attempts: 0,
    ipClass: '203.0.113',
    deviceFingerprint: 'device-key',
    userAgent: 'vitest',
    createdAt: FIXED_NOW,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    completedAt: null,
    ...overrides,
  };
}

/**
 * A live, unexpired, unattempted challenge.
 *
 * `expiresAt` is relative to the real clock rather than `FIXED_NOW`, because the
 * code under test compares it against `Date.now()`. A fixture pinned to
 * `FIXED_NOW` would read as expired the moment that date passes, which is exactly
 * the kind of test that starts failing on a Tuesday for no reason.
 *
 * `codeHash` is left to the caller — a spec that wants the code to MATCH passes
 * `pepperedHash(code, 'otp')`, and one that wants it to miss passes anything
 * else. Hardcoding a hash here would bake the pepper into the fixture.
 */
export function makeChallenge(
  overrides: Partial<VerificationChallenge> = {},
): VerificationChallenge {
  return {
    id: '01940000-0000-7000-8000-0000000000a1',
    userId: USER_ID,
    purpose: 'LOGIN_OTP',
    codeHash: 'unmatchable',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    attempts: 0,
    consumedAt: null,
    ipAddress: '203.0.113.7',
    // Null for the three purposes that mail the account's own address, which is what
    // every existing spec builds. The email-change purposes set it, and a spec that
    // wants one passes it — see `verifyChallengeCode`'s optional target argument.
    targetEmailLower: null,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

/**
 * An address released by an email change, still inside its retention window.
 *
 * `expiresAt` is relative to the real clock rather than `FIXED_NOW`, for the reason
 * `makeChallenge` gives: the code under test compares it against `Date.now()`, and a
 * fixture pinned to a fixed date reads as expired the moment that date passes.
 *
 * `recoveryTokenHash` is left unmatchable by default. A spec that wants the ticket to
 * RESOLVE passes `pepperedHash(token, 'email-recovery')`; hardcoding one here would bake
 * the pepper into the fixture.
 */
export function makeRetainedEmail(
  overrides: Partial<RetainedEmail> = {},
): RetainedEmail {
  return {
    id: '01940000-0000-7000-8000-0000000000d1',
    userId: USER_ID,
    email: 'Old.Address@example.test',
    emailLower: 'old.address@example.test',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    recoveryTokenHash: 'unmatchable',
    recoveryConsumedAt: null,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

/**
 * A username released by a change, still inside its reservation window.
 *
 * `expiresAt` is relative to the real clock for `makeRetainedEmail`'s reason.
 *
 * The default span is the LONG one — thirty days — which makes the fixture a protected,
 * free-to-reclaim reservation. That is deliberate: `isProtectedReservation` derives the
 * class from `expiresAt - createdAt`, so a spec exercising the churn case has to say so
 * by overriding BOTH timestamps, and cannot get a short reservation by accident.
 */
export function makeUsernameReservation(
  overrides: Partial<UsernameReservation> = {},
): UsernameReservation {
  const createdAt = new Date(Date.now() - 60 * 1000);
  return {
    id: '01940000-0000-7000-8000-0000000000e1',
    userId: USER_ID,
    username: 'Old_Username',
    usernameLower: 'old_username',
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

export function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: USER_ID,
    sessionId: '01940000-0000-7000-8000-00000000005e',
    publicCode: 'OREBiT7Q9K2M4X',
    // Deliberately DIFFERENT from `sessionId`. They are equal only on a family's first
    // generation, and a fixture where they matched would let a quota keyed on the
    // wrong one of the two pass its test.
    familyId: '01940000-0000-7000-8000-00000000fa11',
    ...overrides,
  };
}

/**
 * The unique-constraint violation Prisma raises for a column it owns.
 *
 * Constructed as the real error class rather than a stub, because
 * `isUniqueViolation` in db/client.ts narrows with `instanceof` — a plain
 * `{ code: 'P2002' }` would be classified as an unexpected error and rethrown,
 * so the retry test would pass for the wrong reason or not at all.
 */
export function uniqueViolation(target = 'users_username_lower_key'): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

/**
 * The same violation as raised by a *raw-SQL* partial index — Postgres SQLSTATE
 * 23505 surfaced through the unknown-error class, which is how
 * `ix_users_username_active` reports because Prisma did not create it.
 */
export function rawUniqueViolation(): Error {
  return new Prisma.PrismaClientUnknownRequestError(
    'db error: ERROR: duplicate key value violates unique constraint ' +
      '"ix_users_username_active" (SQLSTATE 23505)',
    { clientVersion: 'test' },
  );
}

/** `Authorization` header value carrying a valid access token for `principal`. */
export function bearerFor(principal: Principal = makePrincipal()): string {
  const { token } = signAccessToken({
    userId: principal.userId,
    sessionId: principal.sessionId,
    publicCode: principal.publicCode,
  });
  return `Bearer ${token}`;
}

/** A refresh token, for asserting it is refused where an access token belongs. */
export function refreshBearerFor(principal: Principal = makePrincipal()): string {
  const { token } = signRefreshToken({
    userId: principal.userId,
    sessionId: principal.sessionId,
    familyId: principal.sessionId,
    expiresAt: secondsFromNow(SESSION.IDLE_TIMEOUT_SECONDS),
  });
  return `Bearer ${token}`;
}

/**
 * A stateful `QuotaService` double.
 *
 * Stateful rather than permissive, because the properties worth testing on a quota
 * are the ones only state can express: that two different endpoints draw on ONE
 * bucket, that a refund actually frees a slot, and that exceeding a limit refuses.
 * A double that always resolved would let all three regress silently.
 *
 * It models the sliding log's semantics rather than its storage — a count per key and
 * a set of live charge tokens is enough for every assertion, and a real sorted set
 * would only add a clock to the test. `consumeAll` is all-or-nothing exactly as the
 * Lua is: nothing is charged unless every entry has room.
 */
export function makeQuota() {
  /** Live charges per key, by token. `Map<key, Set<token>>`. */
  const charges = new Map<string, Set<string>>();
  let issued = 0;

  const used = (key: string): number => charges.get(key)?.size ?? 0;

  const consumeAll = vi.fn(
    async (
      entries: readonly { key: string; rule: { limit: number; windowSeconds: number } }[],
      _store: unknown,
      _onError: unknown,
    ) => {
      // Pass 1: test every entry before charging any of them.
      for (const entry of entries) {
        if (used(entry.key) >= entry.rule.limit) {
          throw new ProblemException({ type: ERR.RATE_LIMITED, retryAfterSeconds: 60 });
        }
      }

      const token = `test-charge-${(issued += 1)}`;
      for (const entry of entries) {
        const held = charges.get(entry.key) ?? new Set<string>();
        held.add(token);
        charges.set(entry.key, held);
      }
      return { token, keys: entries.map((entry) => entry.key) };
    },
  );

  const refund = vi.fn(async (charge: { token: string; keys: readonly string[] }) => {
    // `ZREM` of a named member: removing it twice removes it once.
    for (const key of charge.keys) charges.get(key)?.delete(charge.token);
  });

  return {
    consumeAll,
    refund,
    /** The variant `MailUndoRegistry` uses — same `ZREM` semantics, but it reports a
     *  failure instead of swallowing it, which is what lets a compensation be retried
     *  rather than falsely logged as applied. Idempotent either way. */
    refundOrThrow: refund,
    used: vi.fn(async (key: string) => used(key)),
    /** Live charges against `key`, for assertions. */
    countFor: used,
  };
}
