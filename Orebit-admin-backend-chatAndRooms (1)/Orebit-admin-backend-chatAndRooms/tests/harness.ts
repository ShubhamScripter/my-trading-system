import type {
  Admin,
  AdminCredential,
  AdminLoginAttempt,
  AdminLoginState,
  AdminPasskey,
  AdminSession,
  AdminTotpFactor,
} from '@prisma/client';
import type { Principal } from '../auth/auth.types';

/**
 * Complete-row builders.
 *
 * Each returns a fully populated row and takes `Partial<T>` overrides, so a spec
 * names only the fields it cares about. The point is that every field is present:
 * a partial object cast to `Admin` compiles today and breaks silently when a
 * column is added, whereas these fail to compile until the new field has a
 * default here — which is the moment to decide what that default should be.
 */

/** A fixed instant, so a failure is reproducible and no assertion depends on the
 *  wall clock. Chosen arbitrarily; nothing about the date is meaningful. */
export const FIXED_NOW = new Date('2026-06-15T12:00:00.000Z');

/**
 * The authenticated caller, as `AuthGuard` assembles it.
 *
 * Here for the same reason every other builder is: a partial object cast to
 * `Principal` compiles today and breaks silently when a field is added. That is not
 * hypothetical for this type — F08 added `familyId`, and the seventy-odd call sites
 * that had to be visited to add it are why they now go through one function.
 *
 * ═══ `sessionId` AND `familyId` DEFAULT TO DIFFERENT VALUES, ON PURPOSE ══════
 *
 * They are different identifiers with different jobs — the disposable refresh
 * generation and the stable login — and a fixture that made them equal would let a
 * test pass while the code under test used the wrong one. Before Phase 1 a family
 * WAS named by its first generation's id, so the coincidence used to hold; nothing
 * guarantees it now, in either direction.
 */
export function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    adminId: '01920000-0000-7000-8000-000000000001',
    sessionId: '01920000-0000-7000-8000-000000000006',
    familyId: '01920000-0000-7000-8000-0000000000f1',
    role: 'ADMIN',
    ...overrides,
  };
}

export function makeAdmin(overrides: Partial<Admin> = {}): Admin {
  return {
    id: '01920000-0000-7000-8000-000000000001',
    email: 'admin@orebit.io',
    emailLower: 'admin@orebit.io',
    name: 'Test Admin',
    role: 'ADMIN',
    status: 'ACTIVE',
    emailVerifiedAt: FIXED_NOW,
    mfaEnrolledAt: FIXED_NOW,
    // No review has ever been opened — the state of every account that has not been
    // locked twice. A spec exercising the review path sets `loginReviewStatus:
    // 'PENDING'` and `status: 'DISABLED'` together, because that is the only
    // combination the state machine ever writes.
    loginReviewStatus: null,
    loginDisabledAt: null,
    loginDisabledReason: null,
    reviewVersion: 1,
    reviewedAt: null,
    reviewedBy: null,
    reviewReason: null,
    createdAt: FIXED_NOW,
    lastSeenAt: null,
    deletedAt: null,
    ...overrides,
  };
}

export function makeCredential(overrides: Partial<AdminCredential> = {}): AdminCredential {
  return {
    id: '01920000-0000-7000-8000-000000000002',
    adminId: '01920000-0000-7000-8000-000000000001',
    kind: 'PASSWORD',
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$fakehashfortests',
    passwordAlgo: 'argon2id',
    failedAttempts: 0,
    lockedUntil: null,
    // Never locked. A spec testing the SECOND lock sets both — a strike count with no
    // `lockoutStrikeAt` is a state the service never writes, and defaulting to one
    // would let a spec pass against an impossible row.
    lockoutStrikes: 0,
    lockoutStrikeAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    deletedAt: null,
    ...overrides,
  };
}

/**
 * A live login attempt.
 *
 * Defaults to `PASSWORD_VERIFIED` and an expiry an hour out, because that is the
 * state most specs want to start from — the interesting cases are the ones that
 * override it.
 */
export function makeAttempt(overrides: Partial<AdminLoginAttempt> = {}): AdminLoginAttempt {
  return {
    id: '01920000-0000-7000-8000-000000000003',
    adminId: '01920000-0000-7000-8000-000000000001',
    state: 'PASSWORD_VERIFIED',
    stepUpSecretHash: 'a'.repeat(64),
    mfaAttempts: 0,
    otpSentCount: 1,
    lastOtpSentAt: new Date(Date.now() - 1000),
    mfaMethod: null,
    ipAddress: '203.0.113.7',
    userAgent: 'vitest',
    completedAt: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(Date.now() - 1000),
    updatedAt: new Date(Date.now() - 1000),
    ...overrides,
  };
}

export function makeTotpFactor(overrides: Partial<AdminTotpFactor> = {}): AdminTotpFactor {
  return {
    id: '01920000-0000-7000-8000-000000000004',
    adminId: '01920000-0000-7000-8000-000000000001',
    secretCiphertext: new Uint8Array(20),
    secretIv: new Uint8Array(12),
    secretTag: new Uint8Array(16),
    label: 'Authenticator',
    confirmedAt: FIXED_NOW,
    lastUsedStep: null,
    lastUsedAt: null,
    createdAt: FIXED_NOW,
    deletedAt: null,
    ...overrides,
  };
}

export function makePasskey(overrides: Partial<AdminPasskey> = {}): AdminPasskey {
  return {
    id: '01920000-0000-7000-8000-000000000005',
    adminId: '01920000-0000-7000-8000-000000000001',
    credentialId: 'dGVzdC1jcmVkZW50aWFsLWlk',
    publicKey: new Uint8Array(64),
    signCount: 0n,
    transports: ['internal'],
    aaguid: null,
    label: 'Passkey',
    createdAt: FIXED_NOW,
    lastUsedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<AdminSession> = {}): AdminSession {
  const id = '01920000-0000-7000-8000-000000000006';
  return {
    id,
    adminId: '01920000-0000-7000-8000-000000000001',
    familyId: id,
    parentId: null,
    mfaMethod: 'TOTP',
    deviceFingerprint: 'f'.repeat(32),
    ipClass: '203.0.113.0/24',
    userAgent: 'vitest',
    createdAt: FIXED_NOW,
    // Wall-clock, like the two deadlines below rather than like `createdAt`: a
    // fixture is a LIVE session unless a spec says otherwise, and a session whose
    // activity instant sat at `FIXED_NOW` while its clocks were relative to `now()`
    // would be internally inconsistent under `vi.setSystemTime`.
    lastActiveAt: new Date(),
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    reauthenticateAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
    rotatedAt: null,
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

/** Every state the step-up machine has, so a spec can iterate all of them rather
 *  than listing the ones its author happened to think of. */
export const ALL_LOGIN_STATES: readonly AdminLoginState[] = [
  'PASSWORD_VERIFIED',
  'EMAIL_VERIFIED',
  'COMPLETED',
  'EXPIRED',
];
