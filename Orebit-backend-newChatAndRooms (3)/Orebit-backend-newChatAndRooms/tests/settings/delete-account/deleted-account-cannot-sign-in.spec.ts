import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@prisma/client';
import { REVOKE_REASON } from '../../../auth/auth.types';
import { SessionService } from '../../../auth/services/session.service';
import type { SessionDbOperation } from '../../../auth/persistence/session.dboperation';
import type { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import type { DeviceDbOperation } from '../../../auth/persistence/device.dboperation';
import type { MailService } from '../../../src/mail/mail.service';
import type { CacheService, QuotaService } from '../../../redis';
import { signRefreshToken } from '../../../auth/security/jwt';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';
import { makeQuota, makeUser } from '../../harness';

/**
 * ═══ A DELETED ACCOUNT MUST NOT BE ABLE TO OBTAIN A SESSION ═════════════════
 *
 * This is the security property the whole feature rests on, and it is NOT provided by
 * moving `status`. `AuthGuard` never loads the user row — authentication is a valid JWT
 * plus a live session row and nothing else — so a status change on its own stops no
 * request that already carries a token, and stops no path that is about to mint one.
 *
 * Two mechanisms together provide it, and neither is sufficient alone:
 *
 *   1. deleting revokes every session, which ends the tokens ALREADY issued;
 *   2. `SessionService.mint` refuses a non-ACTIVE account, which ends the ones NOT
 *      ISSUED YET.
 *
 * ─── Why the check is at `mint` and not at the five call sites ──────────────
 *
 * Because the call sites demonstrably could not be trusted with it. Before this
 * feature, `status` was read by the two sign-in services and nowhere else — so the 2FA
 * ceremony (`src/2fa/2fa.controller.ts`) and the rotation path (`completeFor`) would
 * both have minted a perfectly valid session for a deleted account. Both re-read the
 * user with `findWithCredential`, which filters `deletedAt` and NOT `status`, and this
 * design deliberately leaves `deletedAt` NULL for the whole recovery window.
 *
 * `completeFor`'s own docblock promises to stop "a user whose account was deleted or
 * disabled refreshing their way back in through the repair path". It did not. Fixing
 * the two would have left five lists that agree today and drift tomorrow, so the
 * assertion lives at the single point every one of them funnels through — which is
 * also what makes it hold for a sixth path that does not exist yet.
 *
 * The specs below exercise that chokepoint through the two entry points a spec can
 * reach without a database, and assert the property for the rest by construction.
 */

const DELETED = makeUser({
  status: 'DELETED',
  deletedAt: null,
  deletionRequestedAt: new Date(),
  purgeAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
});
const ACTIVE = makeUser();

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    userId: ACTIVE.id,
    familyId: 'family-1',
    parentId: null,
    deviceFingerprint: 'd'.repeat(64),
    ipClass: '203.0.113.0/24',
    userAgent: 'spec',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lastUsedAt: new Date(),
    rememberUntil: null,
    trustedDeviceId: null,
    rotatedAt: null,
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  } as Session;
}

let sessions: ReturnType<typeof createSessions>;
let users: { findWithCredential: ReturnType<typeof vi.fn> };
let cache: ReturnType<typeof createCache>;
let service: SessionService;

function createSessions() {
  return {
    createFirstGeneration: vi.fn(async () => makeSession()),
    findById: vi.fn(async () => makeSession()),
    rotate: vi.fn(async (_p: unknown, _c: unknown, expiresAt: Date) =>
      makeSession({ id: 'session-child', expiresAt }),
    ),
    readLiveness: vi.fn(async () => ({ lastUsedAt: new Date(), familyId: 'family-1' })),
    deviceSeenBefore: vi.fn(async () => true),
    applyTrustOnDevice: vi.fn(async () => undefined),
    findRecoverableRotation: vi.fn(async () => null),
    listLiveForUser: vi.fn(async () => []),
    revokeAllForUserExcept: vi.fn(async () => []),
    revokeAllForUserOnDevice: vi.fn(async () => []),
    revokeAllForUser: vi.fn(async (_userId: string, _reason: string): Promise<string[]> => []),
    revokeFamily: vi.fn(async () => []),
    touch: vi.fn(async () => undefined),
  };
}

function createCache() {
  return {
    getFlag: vi.fn(async () => null),
    setFlag: vi.fn(async (_key: string, _ttl: number, _value: string) => undefined),
    startCooldown: vi.fn(async () => false),
    consume: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  sessions = createSessions();
  users = { findWithCredential: vi.fn(async () => ({ user: DELETED, credential: null })) };
  cache = createCache();

  service = new SessionService(
    sessions as unknown as SessionDbOperation,
    users as unknown as UserDbOperation,
    { findLive: vi.fn(async () => null), trust: vi.fn(), revoke: vi.fn() } as unknown as DeviceDbOperation,
    { sendNewDeviceLogin: vi.fn(async () => true) } as unknown as MailService,
    cache as unknown as CacheService,
    makeQuota() as unknown as QuotaService,
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

describe('no sign-in path can mint a session for a DELETED account', () => {
  const client = { ip: '203.0.113.7', ipClass: '203.0.113.0/24', userAgent: 'spec', deviceId: null };

  it('refuses `issue` — the path every first-factor login ends at', async () => {
    // `login.service.ts`, `oauth.service.ts`, `registration.service.ts` and
    // `2fa.controller.ts` all reach a session through this method.
    const err = await problem(service.issue(DELETED, null, client as never));

    expect(err.type).toBe(ERR.ACCOUNT_DISABLED);
  });

  it('refuses `rotate` — so a refresh token cannot walk around the deleted state', async () => {
    const token = signRefreshToken({
      userId: DELETED.id,
      sessionId: 'session-1',
      familyId: 'family-1',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const err = await problem(service.rotate(token.token, client as never));

    // The gap `completeFor` promised to close and did not: it re-reads with
    // `findWithCredential`, which filters `deletedAt` — and this design leaves
    // `deletedAt` NULL for the whole window, so that filter never fires.
    expect(err.type).toBe(ERR.ACCOUNT_DISABLED);
  });

  it('still mints for an ACTIVE account — the check is not a blanket refusal', async () => {
    users.findWithCredential.mockResolvedValue({ user: ACTIVE, credential: null });

    const issued = await service.issue(ACTIVE, null, client as never);

    expect(issued.accessToken).toBeTruthy();
    expect(issued.refreshToken).toBeTruthy();
  });

  it('refuses a DISABLED account too, without this feature having to say so', async () => {
    // The check is `!== 'ACTIVE'`, not `=== 'DELETED'`. `UserStatus.DISABLED` has been a
    // reserved value with no writer since the schema was created; the day something
    // writes it, this closes for it as well without a second edit.
    const disabled = makeUser({ status: 'DISABLED' });

    const err = await problem(service.issue(disabled, null, client as never));

    expect(err.type).toBe(ERR.ACCOUNT_DISABLED);
  });

  it('hands back no token of any kind when it refuses', async () => {
    // The session ROW is written before `mint` runs, so a refused login leaves one
    // behind. That is harmless rather than merely tolerated: a row is unusable without a
    // signed token carrying its id, and no token was ever issued. What must not happen
    // is a token escaping — so this asserts the refusal reaches the caller instead of a
    // partially-built session.
    const err = await problem(service.issue(DELETED, null, client as never));

    expect(err.type).toBe(ERR.ACCOUNT_DISABLED);
    expect(sessions.rotate).not.toHaveBeenCalled();
  });
});

describe('deleting revokes the tokens that already exist', () => {
  it('sweeps every session for the user under ACCOUNT_DELETED', async () => {
    await service.revokeAllForUser(DELETED.id, REVOKE_REASON.ACCOUNT_DELETED);

    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
      DELETED.id,
      REVOKE_REASON.ACCOUNT_DELETED,
    );
  });

  it('seeds the deny-cache so an existing access token dies on its next request', async () => {
    sessions.revokeAllForUser.mockResolvedValue(['session-1', 'session-2']);

    await service.revokeAllForUser(DELETED.id, REVOKE_REASON.ACCOUNT_DELETED);

    // This is what makes the kill IMMEDIATE rather than eventual: `assertLive` checks
    // the Redis flag before it reaches Postgres, so a token in somebody's browser is
    // refused on the very next call rather than at its next rotation.
    expect(cache.setFlag).toHaveBeenCalledTimes(2);
    for (const [, , reason] of cache.setFlag.mock.calls) {
      expect(reason).toBe(REVOKE_REASON.ACCOUNT_DELETED);
    }
  });

  it('neither mechanism covers the other', async () => {
    // Stated as an assertion because it is the reason both exist. The sweep cannot
    // revoke a session a login is about to create; the mint check cannot reach a token
    // already issued. Remove either and the deleted state leaks.
    users.findWithCredential.mockResolvedValue({ user: DELETED, credential: null });

    // Sweeping does not stop a fresh login...
    await service.revokeAllForUser(DELETED.id, REVOKE_REASON.ACCOUNT_DELETED);
    const afterSweep = await problem(
      service.issue(DELETED, null, { ip: '1.2.3.4', ipClass: '1.2.3.0/24', userAgent: 's', deviceId: null } as never),
    );
    expect(afterSweep.type).toBe(ERR.ACCOUNT_DISABLED);

    // ...and the mint check does not revoke anything on its own.
    expect(sessions.revokeAllForUser).toHaveBeenCalledTimes(1);
  });
});
