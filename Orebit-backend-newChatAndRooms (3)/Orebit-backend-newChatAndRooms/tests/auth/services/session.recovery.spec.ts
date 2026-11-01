import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@prisma/client';
import { SessionService } from '../../../auth/services/session.service';
import { SessionRotationConflict } from '../../../auth/persistence/session.dboperation';
import { SESSION } from '../../../auth/auth.constants';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { signRefreshToken } from '../../../auth/security/jwt';
import { makeCredential, makeUser } from '../../harness';

/**
 * ═══ THE REPAIR PATH, AND WHY IT IS NOT AN EXCEPTION TO REUSE DETECTION ════
 *
 * Reuse detection is the same as it always was: present a spent refresh token and the
 * whole family is revoked. What changed is WHO presents one.
 *
 * Refresh used to be something a client asked for, explicitly, once. It is now the
 * backend's own doing — the guard rotates in-request behind a Redis lock — and that
 * creates three ways to reach a spent token that are nobody's fault:
 *
 *   F09  the rotation committed and the write to the session record failed, so the
 *        next request opens the stale record and presents the parent's token.
 *   F10  the refresh lock's TTL lapsed mid-rotation, a second owner appeared, and one
 *        of the two lost the generation CAS.
 *   a logout committing mid-rotation, which used to be unreachable — a person could
 *        not click "sign out" and "refresh" at the same instant — and is now routine,
 *        because the refresh is not theirs to time.
 *
 * Without the repair, each of those costs a user their session and writes a security
 * warning saying their credentials were stolen. So these tests are in two halves, and
 * the second half is the important one: everything the repair does NOT cover still
 * revokes the family.
 */

const CLIENT = { ipClass: '203.0.113.0/24', deviceKey: 'd'.repeat(64), userAgent: 'vitest', country: null, };

const USER = makeUser();

function row(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-parent',
    familyId: 'family-1',
    parentId: null,
    userId: USER.id,
    deviceFingerprint: CLIENT.deviceKey,
    ipClass: CLIENT.ipClass,
    userAgent: CLIENT.userAgent,
    createdAt: new Date(Date.now() - 60_000),
    lastUsedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    rotatedAt: null,
    revokedAt: null,
    revokedReason: null,
    rememberUntil: null,
    trustedDeviceId: null,
    ...overrides, country: null,
  } as Session;
}

function tokenFor(session: Session): string {
  return signRefreshToken({
    userId: session.userId,
    sessionId: session.id,
    familyId: session.familyId,
    expiresAt: session.expiresAt,
  }).token;
}

function createSessions() {
  return {
    findById: vi.fn(),
    readLiveness: vi.fn(),
    findRecoverableRotation: vi.fn().mockResolvedValue(null),
    rotate: vi.fn(),
    revokeFamily: vi.fn().mockResolvedValue([]),
    revokeAllForUserOnDevice: vi.fn().mockResolvedValue([]),
    revokeAllForUser: vi.fn().mockResolvedValue([]),
    revokeAllForUserExcept: vi.fn().mockResolvedValue([]),
    revoke: vi.fn(),
    touch: vi.fn(),
    applyTrustOnDevice: vi.fn(),
    deviceSeenBefore: vi.fn().mockResolvedValue(true),
    listLiveForUser: vi.fn().mockResolvedValue([]),
    createFirstGeneration: vi.fn(),
  };
}

let sessions: ReturnType<typeof createSessions>;
let users: { findWithCredential: ReturnType<typeof vi.fn> };
let cache: Record<string, ReturnType<typeof vi.fn>>;
let service: SessionService;

beforeEach(() => {
  sessions = createSessions();
  users = {
    findWithCredential: vi.fn().mockResolvedValue({ user: USER, credential: makeCredential() }),
  };
  cache = {
    flag: vi.fn(),
    setFlag: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue('1'),
    startCooldown: vi.fn().mockResolvedValue(false),
    consume: vi.fn().mockResolvedValue(undefined),
  };

  service = new SessionService(
    sessions as never,
    users as never,
    { findLive: vi.fn().mockResolvedValue(null), touch: vi.fn(), trust: vi.fn() } as never,
    { sendNewDeviceLogin: vi.fn() } as never,
    cache as never,
    { consumeAll: vi.fn().mockResolvedValue(undefined) } as never,
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

describe('F09 — a rotation that committed and did not publish', () => {
  it('serves the child that consumption produced, instead of revoking the family', async () => {
    // The exact shape: the parent is stamped `rotatedAt`, its child is the family's
    // tip, and the retry is presenting a token the server itself spent moments ago.
    const parent = row({ rotatedAt: new Date(Date.now() - 500) });
    const tip = row({ id: 'session-child', parentId: parent.id });

    sessions.findById.mockResolvedValue(parent);
    sessions.findRecoverableRotation.mockResolvedValue(tip);

    const issued = await service.rotate(tokenFor(parent), CLIENT);

    expect(issued.sessionId).toBe('session-child');
    // The whole point. One dropped cache write used to cost a healthy session.
    expect(sessions.revokeFamily).not.toHaveBeenCalled();
    // And no second generation: this serves what committed, it does not rotate again.
    expect(sessions.rotate).not.toHaveBeenCalled();
  });

  it('asks about the parent’s identity and the family, within a bounded window', async () => {
    const parent = row({ rotatedAt: new Date() });
    sessions.findById.mockResolvedValue(parent);
    sessions.findRecoverableRotation.mockResolvedValue(row({ id: 'c', parentId: parent.id }));

    await service.rotate(tokenFor(parent), CLIENT);

    expect(sessions.findRecoverableRotation).toHaveBeenCalledWith({
      parentId: parent.id,
      familyId: parent.familyId,
      // The bound is what keeps this a repair rather than a general amnesty: a
      // dropped write is retried by the next request, seconds later.
      windowSeconds: SESSION.ROTATION_RECOVERY_WINDOW_SECONDS,
    });
  });

  it('re-reads the account, so a deleted user cannot repair their way back in', async () => {
    // Recovery hands out a working session, so it has to clear the same account
    // checks a rotation does — which is why both go through one helper.
    const parent = row({ rotatedAt: new Date() });
    sessions.findById.mockResolvedValue(parent);
    sessions.findRecoverableRotation.mockResolvedValue(row({ id: 'c', parentId: parent.id }));
    users.findWithCredential.mockResolvedValue(null);

    const err = await problem(service.rotate(tokenFor(parent), CLIENT));

    expect(err.type).toBe(ERR.UNAUTHENTICATED);
  });
});

describe('F10 — the refresh lock lapsed and this caller lost the CAS', () => {
  it('looks at what committed before calling it theft', async () => {
    // The database is what actually guarantees one-use, and it did its job: there is
    // exactly one child. The loser's error was in its INTERPRETATION.
    const parent = row();
    const tip = row({ id: 'session-child', parentId: parent.id });

    sessions.findById.mockResolvedValue(parent);
    sessions.rotate.mockRejectedValue(new SessionRotationConflict(parent.id));
    // The row is re-read on this path: `parent` was loaded before the rotation being
    // repaired, so its own `rotatedAt` is stale by construction.
    sessions.findById.mockResolvedValueOnce(parent).mockResolvedValue(row({ rotatedAt: new Date() }));
    sessions.findRecoverableRotation.mockResolvedValue(tip);

    const issued = await service.rotate(tokenFor(parent), CLIENT);

    expect(issued.sessionId).toBe('session-child');
    expect(sessions.revokeFamily).not.toHaveBeenCalled();
  });

  it('reports a revocation that landed mid-rotation as a revocation', async () => {
    // Routine under the BFF: the CAS predicate includes `revokedAt: null`, so a
    // logout or a password change committing while this is in flight makes the
    // update match zero rows. Routing that to reuse detection would tell the user
    // their credentials were stolen every time somebody signed out at an unlucky
    // moment — and write a security warning saying so.
    const parent = row();
    sessions.findById
      .mockResolvedValueOnce(parent)
      .mockResolvedValue(row({ revokedAt: new Date(), revokedReason: 'LOGOUT' }));
    sessions.rotate.mockRejectedValue(new SessionRotationConflict(parent.id));

    const err = await problem(service.rotate(tokenFor(parent), CLIENT));

    expect(err.type).toBe(ERR.SESSION_REVOKED);
    expect(err).toHaveProperty('messageCode', 'SESSION_REVOKED');
    expect(sessions.revokeFamily).not.toHaveBeenCalled();
    // Not even consulted: a revoked family is finished, and there is nothing to repair.
    expect(sessions.findRecoverableRotation).not.toHaveBeenCalled();
  });

  it('names the wider scope when the revocation was an account-wide sweep', async () => {
    const parent = row();
    sessions.findById
      .mockResolvedValueOnce(parent)
      .mockResolvedValue(row({ revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' }));
    sessions.rotate.mockRejectedValue(new SessionRotationConflict(parent.id));

    const err = await problem(service.rotate(tokenFor(parent), CLIENT));

    expect(err).toHaveProperty('messageCode', 'SESSION_REVOKED_ALL');
  });
});

describe('what the repair deliberately does NOT cover', () => {
  it('revokes the family for a genuine replay', async () => {
    // `findRecoverableRotation` answered null, which is its answer for everything
    // that is not exactly an interrupted publication — a replay from an earlier
    // generation, a replay arriving minutes later, a parent that was revoked. Reuse
    // detection stays the default and this stays the exception that has to prove
    // itself.
    const parent = row({ rotatedAt: new Date(Date.now() - 10 * 60_000) });
    sessions.findById.mockResolvedValue(parent);
    sessions.findRecoverableRotation.mockResolvedValue(null);
    sessions.revokeFamily.mockResolvedValue(['session-parent', 'session-child']);

    const err = await problem(service.rotate(tokenFor(parent), CLIENT));

    expect(err.type).toBe(ERR.SESSION_REUSE_DETECTED);
    expect(sessions.revokeFamily).toHaveBeenCalledWith('family-1', 'REUSE_DETECTED');
    // Every revoked generation is cached, with the reason, so a still-live access
    // token from one of them stops working immediately rather than at its expiry.
    expect(cache.setFlag).toHaveBeenCalledWith(
      expect.stringContaining('session-child'),
      expect.any(Number),
      'REUSE_DETECTED',
    );
  });

  it('revokes the family when a lost CAS has nothing to repair', async () => {
    const parent = row();
    sessions.findById.mockResolvedValue(parent);
    sessions.rotate.mockRejectedValue(new SessionRotationConflict(parent.id));
    sessions.findRecoverableRotation.mockResolvedValue(null);
    sessions.revokeFamily.mockResolvedValue(['session-parent']);

    const err = await problem(service.rotate(tokenFor(parent), CLIENT));

    expect(err.type).toBe(ERR.SESSION_REUSE_DETECTED);
    expect(sessions.revokeFamily).toHaveBeenCalledWith('family-1', 'REUSE_DETECTED');
  });

  it('never reaches the repair for a session that was already revoked', async () => {
    sessions.findById.mockResolvedValue(row({ revokedAt: new Date(), revokedReason: 'LOGOUT' }));

    const err = await problem(service.rotate(tokenFor(row()), CLIENT));

    expect(err.type).toBe(ERR.SESSION_REVOKED);
    expect(sessions.findRecoverableRotation).not.toHaveBeenCalled();
    expect(sessions.rotate).not.toHaveBeenCalled();
  });

  it('never reaches the repair for a session past its deadline', async () => {
    sessions.findById.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1000) }));

    const err = await problem(service.rotate(tokenFor(row()), CLIENT));

    expect(err.type).toBe(ERR.TOKEN_EXPIRED);
    expect(sessions.findRecoverableRotation).not.toHaveBeenCalled();
  });
});

describe('the device key a server-side refresh may not have', () => {
  it('carries the trust when the device cookie is present and matches', async () => {
    const parent = row({
      rememberUntil: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      trustedDeviceId: 'device-1',
    });
    sessions.findById.mockResolvedValue(parent);
    sessions.rotate.mockResolvedValue(row({ id: 'child' }));

    const devices = { findLive: vi.fn().mockResolvedValue({ id: 'device-1', userAgentAtTrust: null }), touch: vi.fn(), trust: vi.fn() };
    service = new SessionService(
      sessions as never,
      users as never,
      devices as never,
      { sendNewDeviceLogin: vi.fn() } as never,
      cache as never,
      { consumeAll: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await service.rotate(tokenFor(parent), CLIENT);

    const [, , , trust] = sessions.rotate.mock.calls[0] as [unknown, unknown, unknown, unknown];
    expect(trust).toEqual({ rememberUntil: parent.rememberUntil, trustedDeviceId: 'device-1' });
  });

  it('withdraws the trust when the request carried no device cookie at all', async () => {
    // `AuthGuard` reads the device cookie without issuing one, so `null` is a real
    // state on this path rather than an error — a browser that has cleared its
    // cookies genuinely presents nothing. The thief case is the same branch: a
    // credential replayed elsewhere arrives without that browser's cookie.
    const parent = row({
      rememberUntil: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      trustedDeviceId: 'device-1',
    });
    sessions.findById.mockResolvedValue(parent);
    sessions.rotate.mockResolvedValue(row({ id: 'child' }));

    await service.rotate(tokenFor(parent), { ...CLIENT, deviceKey: null });

    const [, , , trust] = sessions.rotate.mock.calls[0] as [unknown, unknown, unknown, unknown];
    // The session keeps working — it is a valid credential — but only on the
    // ordinary idle rule. A user who clears cookies is not logged out; they are
    // merely no longer remembered.
    expect(trust).toBeNull();
  });
});
