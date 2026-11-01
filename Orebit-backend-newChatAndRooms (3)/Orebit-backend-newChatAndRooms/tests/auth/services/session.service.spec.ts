import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import type { SessionDbOperation } from '../../../auth/persistence/session.dboperation';
import { SessionService } from '../../../auth/services/session.service';
import type { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import type { DeviceDbOperation } from '../../../auth/persistence/device.dboperation';
import { KEYS, type CacheService, type QuotaService } from '../../../redis';
import type { MailService } from '../../../src/mail/mail.service';
import { SESSION } from '../../../auth/auth.constants';
import { policy } from '../../../auth/limits';
import { makeQuota } from '../../harness';
import { signRefreshToken } from '../../../auth/security/jwt';
import type { ClientContext } from '../../../auth/auth.types';

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

function createSessions() {
  return {
    findById: vi.fn(),
    readLiveness: vi.fn(),
    findRecoverableRotation: vi.fn().mockResolvedValue(null),
    revoke: vi.fn(),
    revokeFamily: vi.fn(),
    revokeAllForUserOnDevice: vi.fn(),
    revokeAllForUser: vi.fn(),
    rotate: vi.fn(),
    touch: vi.fn(),
    applyTrustOnDevice: vi.fn(),
    deviceSeenBefore: vi.fn().mockResolvedValue(true),
    listLiveForUser: vi.fn().mockResolvedValue([]),
    revokeAllForUserExcept: vi.fn(),
    createFirstGeneration: vi.fn(),
  };
}

function createDevices() {
  return {
    trust: vi.fn(),
    findLive: vi.fn().mockResolvedValue(null),
    revoke: vi.fn(),
    touch: vi.fn(),
  };
}

function createCache() {
  return {
    flag: vi.fn(),
    setFlag: vi.fn(),
    /** The revoke reason a positive flag carries, read only to choose a message.
     *  `'1'` is what every other flag in the service holds, so it is the honest
     *  default for a spec that is not about the scope distinction. */
    get: vi.fn().mockResolvedValue('1'),
    startCooldown: vi.fn(),
    // The refresh and session-admin ceilings. Permissive by default so every spec
    // about rotation or logout describes the flow it did before the quotas existed;
    // a spec that is ABOUT a ceiling overrides it to throw.
    consume: vi.fn().mockResolvedValue(undefined),
  };
}

let sessions: ReturnType<typeof createSessions>;
let cache: ReturnType<typeof createCache>;
let users: { findWithCredential: ReturnType<typeof vi.fn> };
let devices: ReturnType<typeof createDevices>;
let mail: { sendNewDeviceLogin: ReturnType<typeof vi.fn> };
let quota: ReturnType<typeof makeQuota>;
let service: SessionService;

beforeEach(() => {
  sessions = createSessions();
  cache = createCache();
  users = { findWithCredential: vi.fn() };
  devices = createDevices();
  mail = { sendNewDeviceLogin: vi.fn().mockResolvedValue(true) };
  quota = makeQuota();
  service = new SessionService(
    sessions as unknown as SessionDbOperation,
    users as unknown as UserDbOperation,
    devices as unknown as DeviceDbOperation,
    mail as unknown as MailService,
    cache as unknown as CacheService,
    quota as unknown as QuotaService,
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

describe('SessionService.logout', () => {
  const principal = {
    userId: 'user-1',
    sessionId: 'session-current',
    publicCode: 'OREBIT123',
    // Distinct from `sessionId`: they coincide only on a family's first generation,
    // and the whole point of these quotas is that they follow the family.
    familyId: 'family-1',
  };

  it('revokes every live session on the caller’s device, but not sessions on other devices', async () => {
    const deviceKey = 'd'.repeat(64);
    sessions.findById.mockResolvedValue({
      userId: principal.userId,
      familyId: 'family-1',
      deviceFingerprint: deviceKey,
    });
    sessions.revokeFamily.mockResolvedValue([principal.sessionId]);
    sessions.revokeAllForUserOnDevice.mockResolvedValue([
      principal.sessionId,
      'session-other-tab',
    ]);
    cache.setFlag.mockResolvedValue(undefined);

    await service.logout(principal);

    expect(sessions.revokeAllForUserOnDevice).toHaveBeenCalledWith(
      principal.userId,
      deviceKey,
      'LOGOUT',
    );
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(cache.setFlag).toHaveBeenCalledWith(
      KEYS.session.revoked(principal.sessionId),
      expect.any(Number),
      // The revoke reason rides along as the flag's VALUE, so `assertLive` can tell
      // "one session ended" from "all of them" without asking Postgres.
      'LOGOUT',
    );
    expect(cache.setFlag).toHaveBeenCalledWith(
      KEYS.session.revoked('session-other-tab'),
      expect.any(Number),
      'LOGOUT',
    );
  });

  it('falls back to family scope for a legacy header-derived session', async () => {
    sessions.findById.mockResolvedValue({
      userId: principal.userId,
      familyId: 'family-1',
      deviceFingerprint: 'f'.repeat(32),
    });
    sessions.revokeFamily.mockResolvedValue([principal.sessionId]);
    cache.setFlag.mockResolvedValue(undefined);

    await service.logout(principal);

    // Never grouped on the legacy value — two distinct devices could share it.
    expect(sessions.revokeFamily).toHaveBeenCalledWith('family-1', 'LOGOUT');
    expect(sessions.revokeAllForUserOnDevice).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('revokes the caller’s family even when the live child sits on another fingerprint', async () => {
    // The hole the unconditional family sweep closes. A family's fingerprint drifts
    // when the browser's device cookie is cleared: the next refresh stamps the child
    // with a NEW deviceKey. Log out afterwards holding the older refresh token and
    // the device sweep covers the ancestor's fingerprint only — the live child under
    // the new one is missed, and the user is told they are signed out while their
    // refresh token keeps minting sessions.
    const oldKey = 'd'.repeat(64);
    sessions.findById.mockResolvedValue({
      userId: principal.userId,
      familyId: 'family-1',
      deviceFingerprint: oldKey,
      rotatedAt: new Date(),
    });
    sessions.revokeFamily.mockResolvedValue(['session-ancestor', 'session-live-child']);
    sessions.revokeAllForUserOnDevice.mockResolvedValue([]);
    cache.setFlag.mockResolvedValue(undefined);

    await service.logout(principal);

    // The family, whatever the fingerprints of its generations.
    expect(sessions.revokeFamily).toHaveBeenCalledWith('family-1', 'LOGOUT');
    // And still the device, so a second tab's independent login dies with it.
    expect(sessions.revokeAllForUserOnDevice).toHaveBeenCalledWith(
      principal.userId,
      oldKey,
      'LOGOUT',
    );
    expect(cache.setFlag).toHaveBeenCalledWith(
      KEYS.session.revoked('session-live-child'),
      expect.any(Number),
      'LOGOUT',
    );
  });

  it('kills the live generation when logout names an already-rotated one', async () => {
    // The two-tab race: tab A refreshed, so session-spent is stamped `rotatedAt`
    // and session-live is its child. Tab B still holds the old refresh token and
    // clicks logout. Revoking only the id the token names would "succeed" against
    // the spent generation — `revoke` matches on `revokedAt: null`, which a rotated
    // row still satisfies — and leave the live child running behind a success.
    sessions.findById.mockResolvedValue({
      userId: principal.userId,
      familyId: 'family-1',
      deviceFingerprint: 'f'.repeat(32),
      rotatedAt: new Date(),
    });
    sessions.revokeFamily.mockResolvedValue(['session-spent', 'session-live']);
    cache.setFlag.mockResolvedValue(undefined);

    await service.logout(principal);

    expect(sessions.revoke).not.toHaveBeenCalled();
    expect(cache.setFlag).toHaveBeenCalledWith(
      KEYS.session.revoked('session-live'),
      expect.any(Number),
      'LOGOUT',
    );
  });

  it('is idempotent when the session row is already gone', async () => {
    sessions.findById.mockResolvedValue(null);

    await expect(service.logout(principal)).resolves.toBeUndefined();

    expect(sessions.revoke).not.toHaveBeenCalled();
    expect(sessions.revokeFamily).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUserOnDevice).not.toHaveBeenCalled();
  });

  it('uses logout-all only when explicitly requested', async () => {
    sessions.revokeAllForUser.mockResolvedValue(['session-current', 'session-other-device']);
    cache.setFlag.mockResolvedValue(undefined);

    await service.logoutAll(principal);

    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(principal.userId, 'LOGOUT_ALL');
    expect(sessions.revokeAllForUserOnDevice).not.toHaveBeenCalled();
  });
});

describe('SessionService.assertLive', () => {
  it('rejects an explicitly cached revocation without a database query', async () => {
    const sessionId = 'session-revoked';
    cache.flag.mockResolvedValue(true);
    cache.get.mockResolvedValue('LOGOUT');

    const err = await problem(service.assertLive(sessionId));

    expect(err.type).toBe(ERR.SESSION_REVOKED);
    expect(cache.flag).toHaveBeenCalledWith(KEYS.session.revoked(sessionId));
    // The whole point of the fast path. A `readLiveness` here would be the database
    // round trip the flag exists to spare on exactly the traffic a stolen token
    // floods.
    expect(sessions.readLiveness).not.toHaveBeenCalled();
  });

  it('reads the revoke SCOPE off the cached flag, not off Postgres', async () => {
    // The flag's value is the reason it was written with, so logout-all can say "your
    // sessions have been logged out" rather than naming a device that was not
    // involved — without giving up the fast path to find out.
    cache.flag.mockResolvedValue(true);
    cache.get.mockResolvedValue('LOGOUT_ALL');

    const err = await problem(service.assertLive('session-swept'));

    expect(err).toHaveProperty('messageCode', 'SESSION_REVOKED_ALL');
    expect(sessions.readLiveness).not.toHaveBeenCalled();
  });

  it('degrades to the narrower message when the flag carries no reason', async () => {
    // Fail-open by design: `setFlag` swallows its own failures and legacy flags hold
    // `'1'`. Reporting "all your sessions ended" when only one did would send someone
    // looking for a breach that did not happen, so the absent case reads as the
    // narrower of the two.
    cache.flag.mockResolvedValue(true);
    cache.get.mockResolvedValue('1');

    const err = await problem(service.assertLive('session-legacy-flag'));

    expect(err).toHaveProperty('messageCode', 'SESSION_REVOKED');
  });

  it('does not turn a Redis blip between the two reads into a 500', async () => {
    // `cache.get` is fail-closed and throws `internal_error`. Reaching it means
    // `exists` just answered, so a throw here is a blip mid-request — and it must not
    // upgrade an honest 401 into an outage the client is told to retry.
    cache.flag.mockResolvedValue(true);
    cache.get.mockRejectedValue(new ProblemException({ type: ERR.INTERNAL_ERROR }));

    const err = await problem(service.assertLive('session-blip'));

    expect(err.type).toBe(ERR.SESSION_REVOKED);
    expect(err.status).toBe(401);
  });

  it('tells a revoked session from an expired one on a cache miss', async () => {
    // These were one answer — `session_revoked` for both — and that told a user whose
    // session simply timed out that it had been revoked, which reads as somebody
    // else's deliberate act on their account.
    cache.flag.mockResolvedValue(false);
    sessions.readLiveness.mockResolvedValue({
      reason: 'revoked',
      lastUsedAt: new Date('2026-09-01T00:00:00.000Z'),
      familyId: 'family-1',
    });

    const revoked = await problem(service.assertLive('session-revoked-no-flag'));
    expect(revoked.type).toBe(ERR.SESSION_REVOKED);
    expect(revoked).toHaveProperty('messageCode', 'SESSION_REVOKED');

    sessions.readLiveness.mockResolvedValue({
      reason: 'expired',
      lastUsedAt: new Date('2026-09-01T00:00:00.000Z'),
      familyId: 'family-1',
    });

    const expired = await problem(service.assertLive('session-idled-out'));
    expect(expired.type).toBe(ERR.SESSION_EXPIRED);
    expect(expired).toHaveProperty('messageCode', 'SESSION_EXPIRED');
  });

  it('carries lastUsedAt on the refusal, so a timed-out user can be told when', async () => {
    const lastUsedAt = new Date('2026-09-01T12:00:00.000Z');
    cache.flag.mockResolvedValue(false);
    sessions.readLiveness.mockResolvedValue({ reason: 'expired', lastUsedAt, familyId: 'f' });

    const err = await problem(service.assertLive('session-idled-out'));

    expect(err).toHaveProperty('lastUsedAt', lastUsedAt);
  });

  it('reports the wider scope for an account-wide sweep', async () => {
    cache.flag.mockResolvedValue(false);
    sessions.readLiveness.mockResolvedValue({
      reason: 'revoked-all',
      lastUsedAt: null,
      familyId: 'family-1',
    });

    const err = await problem(service.assertLive('session-swept'));

    // Still `session_revoked` on the wire. `revoked-all` is a third MESSAGE, not a
    // third slug — adding one would make every consumer's switch non-exhaustive.
    expect(err.type).toBe(ERR.SESSION_REVOKED);
    expect(err).toHaveProperty('messageCode', 'SESSION_REVOKED_ALL');
  });

  it('checks Postgres when Redis is unavailable', async () => {
    const sessionId = 'session-after-redis-failure';
    cache.flag.mockResolvedValue(null);
    sessions.readLiveness.mockResolvedValue({ reason: 'revoked', lastUsedAt: null, familyId: null });

    const err = await problem(service.assertLive(sessionId));

    expect(err.type).toBe(ERR.SESSION_REVOKED);
    expect(sessions.readLiveness).toHaveBeenCalledWith(sessionId);
  });

  it('allows a session only after Postgres confirms it is usable', async () => {
    const sessionId = 'live-session';
    const lastUsedAt = new Date('2026-09-01T12:00:00.000Z');
    cache.flag.mockResolvedValue(false);
    sessions.readLiveness.mockResolvedValue({ reason: null, lastUsedAt, familyId: 'family-1' });

    // Returns both facts the row already yielded: the guard keys the activity write
    // and every session quota on the family, and `GET /auth/session` reports the
    // activity instant.
    await expect(service.assertLive(sessionId)).resolves.toEqual({
      lastUsedAt,
      familyId: 'family-1',
    });
    expect(sessions.readLiveness).toHaveBeenCalledWith(sessionId);
  });

  it('refuses rather than returning a live session with no family', async () => {
    // Unreachable — `family_id` is NOT NULL — but the direction matters: a caller
    // handed `null` would have no correct branch, since skipping the key drops a
    // rate-limit boundary and substituting the generation id restores a bucket a
    // refresh could reset.
    cache.flag.mockResolvedValue(false);
    sessions.readLiveness.mockResolvedValue({ reason: null, lastUsedAt: null, familyId: null });

    const err = await problem(service.assertLive('schema-violation'));

    expect(err.type).toBe(ERR.UNAUTHENTICATED);
  });
});

/**
 * The property logout actually promises: a refresh token is a POINTER, not a
 * self-contained credential, so ending the session it names ends the token.
 *
 * These sit apart from the trust-window suite because they guard a different
 * thing. `signRefreshToken` gives every token an `exp`, but that expiry is not
 * what makes logout work — a token minted a minute ago has hours left on it. The
 * session row is the authority, and these assert `rotate` consults it in all three
 * ways it can say no. Nothing covered this before.
 */
describe('SessionService.rotate — a dead session cannot mint a new one', () => {
  const user = { id: 'user-1', publicCode: 'OREBIT123', status: 'ACTIVE' };

  /** A token with real time left on it, so no assertion below can pass by expiry. */
  function tokenFor(session: { userId: string; id: string; familyId: string }): string {
    return signRefreshToken({
      userId: session.userId,
      sessionId: session.id,
      familyId: session.familyId,
      expiresAt: new Date(Date.now() + SESSION.IDLE_TIMEOUT_SECONDS * 1000),
    }).token;
  }

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 'session-1',
      userId: user.id,
      familyId: 'family-1',
      deviceFingerprint: client.deviceKey,
      rememberUntil: null,
      trustedDeviceId: null,
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rotatedAt: null,
      revokedAt: null,
      ...overrides,
    };
  }

  it('refuses a refresh token whose session was revoked — manual logout', async () => {
    // The whole point of logout. The token is signed, unexpired and names a real
    // session; the only thing wrong with it is that `revokedAt` is set.
    const session = row({ revokedAt: new Date() });
    sessions.findById.mockResolvedValue(session);

    const err = await problem(service.rotate(tokenFor(session), client));

    expect(err.type).toBe(ERR.SESSION_REVOKED);
    // Refused before any write — a dead token must not stamp a rotation.
    expect(sessions.rotate).not.toHaveBeenCalled();
  });

  it('refuses a refresh token whose session expired — automatic logout', async () => {
    // The idle timeout. The TOKEN still has hours of `exp` left, which is exactly
    // why the row has to be checked: a session that idled out must not be
    // resurrectable by a credential minted before it died.
    const session = row({ expiresAt: new Date(Date.now() - 1_000) });
    sessions.findById.mockResolvedValue(session);

    const err = await problem(service.rotate(tokenFor(session), client));

    expect(err.type).toBe(ERR.TOKEN_EXPIRED);
    expect(sessions.rotate).not.toHaveBeenCalled();
  });

  it('refuses a refresh token whose session row is gone', async () => {
    sessions.findById.mockResolvedValue(null);

    const err = await problem(service.rotate(tokenFor(row()), client));

    // `token_invalid`, not `not_found`: which session ids exist is not a caller's
    // business, and the remedy is the same either way.
    expect(err.type).toBe(ERR.TOKEN_INVALID);
    expect(sessions.rotate).not.toHaveBeenCalled();
  });

  it('refuses a token whose familyId does not match the row it names', async () => {
    // Guards the claim binding rather than the row's state: a token cannot borrow
    // another chain's session by naming a `sid` its `fam` does not belong to.
    const session = row();
    const token = signRefreshToken({
      userId: session.userId,
      sessionId: session.id,
      familyId: 'family-somebody-else',
      expiresAt: new Date(Date.now() + SESSION.IDLE_TIMEOUT_SECONDS * 1000),
    }).token;
    sessions.findById.mockResolvedValue(session);

    expect((await problem(service.rotate(token, client))).type).toBe(ERR.TOKEN_INVALID);
  });

  it('revokes the family when a spent generation is replayed', async () => {
    // Reuse detection: the row is live and unexpired but already rotated, so this
    // token is in two places. Both holders lose access.
    const session = row({ rotatedAt: new Date() });
    sessions.findById.mockResolvedValue(session);
    sessions.revokeFamily.mockResolvedValue(['session-1', 'session-child']);
    cache.setFlag.mockResolvedValue(undefined);

    const err = await problem(service.rotate(tokenFor(session), client));

    expect(err.type).toBe(ERR.SESSION_REUSE_DETECTED);
    expect(sessions.revokeFamily).toHaveBeenCalledWith('family-1', 'REUSE_DETECTED');
    expect(cache.setFlag).toHaveBeenCalledWith(
      KEYS.session.revoked('session-child'),
      expect.any(Number),
      'REUSE_DETECTED',
    );
  });
});

describe('SessionService.rotate — the trust window must not drift', () => {
  const user = { id: 'user-1', publicCode: 'OREBIT123', status: 'ACTIVE' };

  function liveSession(rememberUntil: Date | null, lastUsedAt: Date = new Date()) {
    return {
      id: 'session-parent',
      userId: user.id,
      familyId: 'family-1',
      // Same browser the refresh is arriving from — otherwise the trust is
      // deliberately not honoured. That binding is its own test below.
      deviceFingerprint: client.deviceKey,
      rememberUntil,
      trustedDeviceId: rememberUntil === null ? null : 'device-1',
      // Present on the fixture because the service now READS it — the child's
      // expiry is measured from here, not from the clock.
      lastUsedAt,
      expiresAt: new Date(Date.now() + 60_000),
      rotatedAt: null,
      revokedAt: null,
    };
  }

  function primeRotation(parent: ReturnType<typeof liveSession>) {
    sessions.findById.mockResolvedValue(parent);
    // Note this mock fabricates the child by spreading the parent, which means it
    // CANNOT prove the persistence layer copies anything. That is why the columns
    // the child must carry are asserted against the ARGUMENTS below, and proved
    // end to end in session.dboperation.spec.ts.
    sessions.rotate.mockImplementation(async (_parent: unknown, _client: unknown, expiresAt: Date) => ({
      ...parent,
      id: 'session-child',
      expiresAt,
    }));
    users.findWithCredential.mockResolvedValue({ user, credential: null });
    devices.findLive.mockResolvedValue(
      parent.rememberUntil === null
        ? null
        : { id: 'device-1', userId: user.id, userAgentAtTrust: client.userAgent },
    );
    cache.startCooldown.mockResolvedValue(false);
  }

  /** A refresh token for the parent, signed the way the service will verify it. */
  function tokenFor(parent: ReturnType<typeof liveSession>): string {
    return signRefreshToken({
      userId: parent.userId,
      sessionId: parent.id,
      familyId: parent.familyId,
      expiresAt: parent.expiresAt,
    }).token;
  }

  it('carries rememberUntil into the child UNCHANGED', async () => {
    // The failure this guards is invisible: recompute `rememberUntil` on each
    // rotation and the trust window advances every ~15 minutes, so a 7-day
    // remember-me silently becomes permanent. Nothing about the session looks
    // wrong afterwards — which is why this is asserted rather than reviewed.
    const rememberUntil = new Date(Date.now() + SESSION.REMEMBER_ME_SECONDS * 1000);
    const parent = liveSession(rememberUntil);
    primeRotation(parent);

    await service.rotate(tokenFor(parent), client);

    const [, , expiresAt] = sessions.rotate.mock.calls[0] as [unknown, unknown, Date];
    expect(expiresAt).toEqual(rememberUntil);
  });

  it('hands the persistence layer the trust to write on the child', async () => {
    // The bug this guards: `rotate` computed the child's expiry from the trust and
    // then wrote a child with no `rememberUntil`, so the NEXT refresh saw an
    // untrusted session and dropped a 7-day window to 24 hours. One rotation looked
    // perfect; two did not. Asserting the fourth argument is what makes the
    // difference visible from here.
    const rememberUntil = new Date(Date.now() + SESSION.REMEMBER_ME_SECONDS * 1000);
    const parent = liveSession(rememberUntil);
    primeRotation(parent);

    await service.rotate(tokenFor(parent), client);

    const [, , , trust] = sessions.rotate.mock.calls[0] as [unknown, unknown, unknown, unknown];
    expect(trust).toEqual({ rememberUntil, trustedDeviceId: 'device-1' });
  });

  it('passes no trust when the refresh arrives without the trusted device cookie', async () => {
    const rememberUntil = new Date(Date.now() + SESSION.REMEMBER_ME_SECONDS * 1000);
    const parent = liveSession(rememberUntil);
    // A token copied out of the browser and replayed elsewhere: valid, but not from
    // the device the trust belongs to. The session must survive on the idle rule
    // and the child must NOT inherit the window.
    parent.deviceFingerprint = 'b'.repeat(64);
    primeRotation(parent);

    await service.rotate(tokenFor(parent), client);

    const [, , , trust] = sessions.rotate.mock.calls[0] as [unknown, unknown, unknown, unknown];
    expect(trust).toBeNull();
  });

  it('measures the child idle window from lastUsedAt, not from the refresh', async () => {
    // The bug this guards is the one that made the idle timeout decorative: the
    // child's expiry was `now + idle` on every rotation, so a client refreshing on
    // a timer renewed the window forever while nobody used the account. Anchored to
    // `lastUsedAt`, twelve idle hours have to still be twelve hours gone.
    const lastUsedAt = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const parent = liveSession(null, lastUsedAt);
    primeRotation(parent);

    await service.rotate(tokenFor(parent), client);

    const [, , expiresAt] = sessions.rotate.mock.calls[0] as [unknown, unknown, Date];
    const remaining = (expiresAt.getTime() - Date.now()) / 1000;
    expect(remaining).toBeGreaterThan(SESSION.IDLE_TIMEOUT_SECONDS - 12 * 60 * 60 - 10);
    expect(remaining).toBeLessThanOrEqual(SESSION.IDLE_TIMEOUT_SECONDS - 12 * 60 * 60);
  });

  it('gives an untrusted session the idle window, not the old 30 days', async () => {
    const parent = liveSession(null);
    primeRotation(parent);

    await service.rotate(tokenFor(parent), client);

    const [, , expiresAt] = sessions.rotate.mock.calls[0] as [unknown, unknown, Date];
    const seconds = (expiresAt.getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(SESSION.IDLE_TIMEOUT_SECONDS - 10);
    expect(seconds).toBeLessThanOrEqual(SESSION.IDLE_TIMEOUT_SECONDS);
  });

  it('falls back to the idle window once the trust window has passed', async () => {
    const parent = liveSession(new Date(Date.now() - 1_000));
    primeRotation(parent);

    await service.rotate(tokenFor(parent), client);

    const [, , expiresAt] = sessions.rotate.mock.calls[0] as [unknown, unknown, Date];
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('signs the refresh token to the session row, so trust cannot outlive its token', async () => {
    const rememberUntil = new Date(Date.now() + SESSION.REMEMBER_ME_SECONDS * 1000);
    const parent = liveSession(rememberUntil);
    primeRotation(parent);

    const issued = await service.rotate(tokenFor(parent), client);

    // Signed from a constant instead, a trusted device's token would expire a day
    // into a week-long window and log the user out with the row still live.
    expect(issued.refreshExpiresAt).toEqual(rememberUntil);
  });
});

describe('SessionService.touch', () => {
  it('writes when the throttle window is open', async () => {
    cache.startCooldown.mockResolvedValue(true);

    await service.touch('session-1');

    expect(sessions.touch).toHaveBeenCalledWith('session-1');
  });

  it('skips the write while a recent one is still inside the window', async () => {
    cache.startCooldown.mockResolvedValue(false);

    await service.touch('session-1');

    expect(sessions.touch).not.toHaveBeenCalled();
  });

  it('never propagates a failure — the request is already authorised', async () => {
    cache.startCooldown.mockResolvedValue(true);
    sessions.touch.mockRejectedValue(new Error('connection lost'));

    await expect(service.touch('session-1')).resolves.toBeUndefined();
  });
});

describe('SessionService — trust is bound to the device, not the token', () => {
  const user = { id: 'user-1', publicCode: 'OREBIT123', status: 'ACTIVE' };
  const rememberUntil = new Date(Date.now() + SESSION.REMEMBER_ME_SECONDS * 1000);

  function trustedSession(overrides: Record<string, unknown> = {}) {
    return {
      id: 'session-parent',
      userId: user.id,
      familyId: 'family-1',
      deviceFingerprint: client.deviceKey,
      rememberUntil,
      expiresAt: new Date(Date.now() + 60_000),
      rotatedAt: null,
      revokedAt: null,
      ...overrides,
    };
  }

  function rotateWith(parent: ReturnType<typeof trustedSession>, ctx = client) {
    sessions.findById.mockResolvedValue(parent);
    sessions.rotate.mockImplementation(
      async (_p: unknown, _c: unknown, expiresAt: Date) => ({ ...parent, id: 'child', expiresAt }),
    );
    users.findWithCredential.mockResolvedValue({ user, credential: null });
    cache.startCooldown.mockResolvedValue(false);

    const token = signRefreshToken({
      userId: parent.userId,
      sessionId: parent.id,
      familyId: parent.familyId,
      expiresAt: parent.expiresAt,
    }).token;
    return service.rotate(token, ctx);
  }

  function grantedWindow(): Date {
    const [, , expiresAt] = sessions.rotate.mock.calls[0] as [unknown, unknown, Date];
    return expiresAt;
  }

  it('honours the window when the request carries the trusted device cookie', async () => {
    devices.findLive.mockResolvedValue({
      id: 'device-1',
      userId: user.id,
      userAgentAtTrust: client.userAgent,
    });

    await rotateWith(trustedSession());

    expect(grantedWindow()).toEqual(rememberUntil);
  });

  it('withholds the window from a token replayed without that cookie', async () => {
    // The theft case. A refresh token lifted out of the browser still works — it is
    // a valid credential — but arriving from a different browser it carries a
    // different device key, so it buys a day rather than a week.
    devices.findLive.mockResolvedValue(null);

    await rotateWith(trustedSession(), { ...client, deviceKey: 'b'.repeat(64) });

    expect(grantedWindow()).not.toEqual(rememberUntil);
    expect(devices.findLive).not.toHaveBeenCalled();
  });

  it('withholds the window once the device has been untrusted', async () => {
    devices.findLive.mockResolvedValue(null);

    await rotateWith(trustedSession());

    const seconds = (grantedWindow().getTime() - Date.now()) / 1000;
    expect(seconds).toBeLessThanOrEqual(SESSION.IDLE_TIMEOUT_SECONDS);
  });

  it('asks for the trust belonging to THIS session, not to the browser', async () => {
    // Same browser, two accounts — and the guarantee moved. It used to be a check in
    // application code: fetch whichever trust existed for the cookie, then compare
    // `userId` and discard a foreign one. That worked only because the unique index
    // guaranteed one trust per browser, which is exactly the constraint that made a
    // shared machine unable to remember two people.
    //
    // Uniqueness is now per (user, browser), so the scoping has to be in the QUERY:
    // an unscoped lookup would return an arbitrary one of two legitimate rows. This
    // asserts the service asks the right question; device.dboperation.spec.ts
    // asserts the question is answered with the account in the predicate. Together
    // they are the property the old single assertion covered.
    const session = trustedSession();

    await rotateWith(session);

    expect(devices.findLive).toHaveBeenCalledWith(client.deviceKey, session.userId);
  });

  it('withholds the window when this user has no trust on the browser', async () => {
    // What the scoped query returns for someone else's browser trust: nothing. The
    // session keeps working on the ordinary idle rule rather than inheriting a
    // window it was never granted.
    devices.findLive.mockResolvedValue(null);

    await rotateWith(trustedSession());

    expect(grantedWindow()).not.toEqual(rememberUntil);
  });

  it('still honours the window when the user-agent has changed', async () => {
    // Browsers rewrite their UA on every update. Treating that as theft would sign
    // users out on a routine Tuesday and catch nobody who holds the cookie.
    devices.findLive.mockResolvedValue({
      id: 'device-1',
      userId: user.id,
      userAgentAtTrust: 'an older browser build',
    });

    await rotateWith(trustedSession());

    expect(grantedWindow()).toEqual(rememberUntil);
  });
});

describe('SessionService.untrustDevice', () => {
  const principal = {
    userId: 'user-1',
    sessionId: 'session-1',
    publicCode: 'OREBIT123',
    familyId: 'family-1',
  };

  it('revokes the sessions the trust was holding open', async () => {
    // Revoking the trust row alone would leave them running on a rememberUntil
    // whose authority no longer exists — "sign out this device" that does not.
    devices.revoke.mockResolvedValue({ id: 'device-1', tokenHash: 'c'.repeat(64) });
    sessions.revokeAllForUserOnDevice.mockResolvedValue(['session-1', 'session-2']);
    cache.setFlag.mockResolvedValue(undefined);

    await service.untrustDevice(principal, 'device-1');

    expect(sessions.revokeAllForUserOnDevice).toHaveBeenCalledWith(
      principal.userId,
      'c'.repeat(64),
      'LOGOUT',
    );
    expect(cache.setFlag).toHaveBeenCalledWith(
      KEYS.session.revoked('session-2'),
      expect.any(Number),
      'LOGOUT',
    );
  });

  it('refuses a device id belonging to someone else', async () => {
    // Ownership lives in the query predicate; ids are time-ordered UUIDv7 and so
    // are far more guessable than random ones.
    devices.revoke.mockResolvedValue(null);

    const err = await problem(service.untrustDevice(principal, 'someone-elses-device'));

    expect(err.type).toBe(ERR.NOT_FOUND);
    expect(sessions.revokeAllForUserOnDevice).not.toHaveBeenCalled();
  });
});

describe('SessionService.issue — the new-device notification (M4)', () => {
  const user = { id: 'user-1', email: 'ada@example.test', publicCode: 'OREBIT123', status: 'ACTIVE' };

  beforeEach(() => {
    sessions.createFirstGeneration.mockResolvedValue({
      id: 'session-1',
      userId: user.id,
      familyId: 'session-1',
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  it('notifies on a browser this account has not used before', async () => {
    sessions.deviceSeenBefore.mockResolvedValue(false);

    await service.issue(user as never, null, client);

    expect(mail.sendNewDeviceLogin).toHaveBeenCalledWith(
      user.email,
      expect.any(String),
      client.ipClass,
      // No anti-phishing code configured on the fixture account.
      null,
    );
  });

  it('stays quiet on a familiar one', async () => {
    // A notification that arrives on every sign-in is one nobody reads, which
    // costs exactly the case it exists for.
    sessions.deviceSeenBefore.mockResolvedValue(true);

    await service.issue(user as never, null, client);

    expect(mail.sendNewDeviceLogin).not.toHaveBeenCalled();
  });

  it('asks BEFORE writing the row, or every device looks familiar', async () => {
    sessions.deviceSeenBefore.mockResolvedValue(false);

    await service.issue(user as never, null, client);

    const askedAt = sessions.deviceSeenBefore.mock.invocationCallOrder[0] ?? 0;
    const wroteAt = sessions.createFirstGeneration.mock.invocationCallOrder[0] ?? 0;
    expect(askedAt).toBeLessThan(wroteAt);
  });

  it('signs the session in even when the notification fails', async () => {
    sessions.deviceSeenBefore.mockResolvedValue(false);
    mail.sendNewDeviceLogin.mockRejectedValue(new Error('smtp down'));

    await expect(service.issue(user as never, null, client)).resolves.toBeDefined();
  });
});

/**
 * ═══ THE QUOTAS FOLLOW THE FAMILY, NOT THE GENERATION ═══════════════════════
 *
 * Every session quota used to be keyed on the session id, and a rotation mints a
 * child with a NEW id. So the limit a client could actually reach was one refresh
 * per generation — which is to say none at all: each success moved the goalposts,
 * and the only caller the quota ever refused was one replaying a single generation,
 * which reuse detection already catches on its own.
 *
 * `familyId` is the id of the first generation and is copied unchanged onto every
 * child, so it is the one identifier here that a client cannot rotate away from.
 * These tests are the reason to believe that: they rotate the id on every call and
 * assert the bucket does not move with it.
 */
describe('SessionService — session quotas are keyed on the family', () => {
  const user = { id: 'user-1', publicCode: 'OREBIT123', status: 'ACTIVE' };
  const FAMILY = 'family-stable';

  function tokenFor(sessionId: string): string {
    return signRefreshToken({
      userId: user.id,
      sessionId,
      familyId: FAMILY,
      expiresAt: new Date(Date.now() + SESSION.IDLE_TIMEOUT_SECONDS * 1000),
    }).token;
  }

  function row(id: string) {
    return {
      id,
      userId: user.id,
      familyId: FAMILY,
      deviceFingerprint: client.deviceKey,
      rememberUntil: null,
      trustedDeviceId: null,
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      rotatedAt: null,
      revokedAt: null,
    };
  }

  /** One full rotation, from generation `n` to `n + 1`. */
  async function refreshOnce(generation: number): Promise<void> {
    const current = `session-gen-${generation}`;
    const child = row(`session-gen-${generation + 1}`);
    sessions.findById.mockResolvedValue(row(current));
    sessions.rotate.mockResolvedValue(child);
    users.findWithCredential.mockResolvedValue({ user, credential: null });
    await service.rotate(tokenFor(current), client);
  }

  it('refuses the eleventh refresh even though every generation has a new id', async () => {
    // REFRESH_SHORT is 10 per ten minutes. Ten succeed; the eleventh must not,
    // despite arriving on a token whose `sid` this bucket has never seen.
    for (let generation = 0; generation < policy().SESSION.REFRESH_SHORT.limit; generation += 1) {
      await refreshOnce(generation);
    }

    const err = await problem(refreshOnce(99));
    expect(err.type).toBe(ERR.RATE_LIMITED);
  });

  it('charges every generation to the one family bucket', async () => {
    await refreshOnce(0);
    await refreshOnce(1);
    await refreshOnce(2);

    // Keyed on the family the tokens share, not on any of the three session ids.
    expect(await quota.used(KEYS.rate.refreshByFamily(FAMILY))).toBe(3);
    expect(await quota.used(KEYS.rate.refreshByFamily('session-gen-0'))).toBe(0);
  });

  it('charges the short and hourly windows together, or neither', async () => {
    // The two used to be sequential `INCR`s, so a request refused by the hourly
    // window had already spent a slot in the short one — and the Retry-After it
    // returned described a window it had not actually exhausted. `consumeAll` tests
    // both before charging either.
    await refreshOnce(0);

    expect(await quota.used(KEYS.rate.refreshByFamily(FAMILY))).toBe(1);
    expect(await quota.used(KEYS.rate.refreshByFamilyHourly(FAMILY))).toBe(1);
  });
});

/**
 * One bucket for every state-changing session operation.
 *
 * `trustDevice` and `revokeSession` charged it; `untrustDevice`, `logout` and
 * `logoutAll` did not — so three of the five mutations the bucket was documented as
 * covering were unmetered, including the two that revoke the most.
 */
describe('SessionService — every session mutation draws on one bucket', () => {
  const principal = {
    userId: 'user-1',
    sessionId: 'session-current',
    publicCode: 'OREBIT123',
    familyId: 'family-1',
  };
  const adminKey = KEYS.rate.sessionAdminByFamily(principal.familyId);

  beforeEach(() => {
    sessions.findById.mockResolvedValue({
      id: principal.sessionId,
      userId: principal.userId,
      familyId: principal.familyId,
      deviceFingerprint: client.deviceKey,
    });
    sessions.revokeFamily.mockResolvedValue([principal.sessionId]);
    sessions.revokeAllForUserOnDevice.mockResolvedValue([]);
    sessions.revokeAllForUser.mockResolvedValue([principal.sessionId]);
    sessions.revoke.mockResolvedValue({ id: 'other-session' });
    devices.revoke.mockResolvedValue({ id: 'device-1', tokenHash: client.deviceKey });
    devices.trust.mockResolvedValue({ id: 'device-1', expiresAt: new Date(Date.now() + 60_000) });
    cache.setFlag.mockResolvedValue(undefined);
  });

  it('charges logout', async () => {
    await service.logout(principal);
    expect(cache.consume).toHaveBeenCalledWith(adminKey, expect.anything(), 'allow');
  });

  it('charges logout-all', async () => {
    await service.logoutAll(principal);
    expect(cache.consume).toHaveBeenCalledWith(adminKey, expect.anything(), 'allow');
  });

  it('charges untrust, not only trust', async () => {
    await service.untrustDevice(principal, 'device-1');
    expect(cache.consume).toHaveBeenCalledWith(adminKey, expect.anything(), 'allow');
  });

  it('charges trust', async () => {
    await service.trustDevice(principal, client);
    expect(cache.consume).toHaveBeenCalledWith(adminKey, expect.anything(), 'allow');
  });

  it('keys the bucket on the family, so refreshing cannot reset it', async () => {
    await service.logout(principal);

    // Not `sessionAdminByFamily(principal.sessionId)`: the two are different values
    // in this fixture precisely so a mix-up cannot pass.
    expect(cache.consume).not.toHaveBeenCalledWith(
      KEYS.rate.sessionAdminByFamily(principal.sessionId),
      expect.anything(),
      expect.anything(),
    );
  });

  it('refuses the mutation when the bucket is exhausted, before revoking anything', async () => {
    cache.consume.mockRejectedValue(new ProblemException({ type: ERR.RATE_LIMITED }));

    const err = await problem(service.logout(principal));

    expect(err.type).toBe(ERR.RATE_LIMITED);
    expect(sessions.revokeFamily).not.toHaveBeenCalled();
  });
});
