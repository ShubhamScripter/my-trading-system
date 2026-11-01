import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { CSRF, SESSION } from '../../auth/auth.constants';
import { AuthController } from '../../auth/auth.controller';
import { REVOKE_REASON } from '../../auth/auth.types';
import type { BffSessionService } from '../../auth/security/bff.session';
import { AuthGuard, ExplainsSessionState, NotActivity } from '../../auth/security/guards';
import { signAccessToken } from '../../auth/security/jwt';
import {
  SESSION_MESSAGES,
  revokedMessageCode,
  type SessionMessageCode,
} from '../../auth/security/session.message';
import { SessionService } from '../../auth/services/session.service';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { KEYS } from '../../redis';
import { makeAdmin } from '../harness';

/**
 * ═══ WHY THE CURRENT AUTHENTICATION STATE EXISTS ═══════════════════════════
 *
 * `GET /auth/session` answers WHETHER a browser is signed in. These tests are about
 * the second half: WHY it is not, as a code a frontend switches on.
 *
 * Five states, and the whole point of this file is that each is derived from
 * something the backend ALREADY knew and used to discard:
 *
 *   LOGGED_IN            the guard let the request through.
 *   SESSION_EXPIRED      `readLiveness` said 'expired', or the cookie named a BFF
 *                        record that is gone.
 *   SESSION_REVOKED      `AdminSession.revokedReason` names a family revoke.
 *   SESSION_REVOKED_ALL  the same column, naming an all-sessions revoke.
 *   NOT_LOGGED_IN        no cookie was presented.
 *
 * So every test below drives the REAL `SessionService.assertLive` and the REAL
 * `AuthGuard` over doubles for the two stores, rather than asserting that a
 * hand-built exception is echoed back. A test of the plumbing would keep passing if
 * the derivation stopped matching the session lifecycle, which is the only failure
 * mode this requirement actually has.
 *
 * ─── The sentinels ────────────────────────────────────────────────────────
 *
 * `ACCESS`, `REFRESH` and `HANDLE` are spelled as values rather than field names for
 * the reason tests/auth/session-cookie.spec.ts gives: an assertion on FIELD NAMES
 * passes the day someone renames one, and an assertion on the substring `refresh`
 * would trip over `refreshExpiresAt`. A hunt for the value cannot be fooled by
 * either.
 */

const ACCESS = 'at-must-not-appear-in-any-body';
const REFRESH = 'rt-must-not-appear-in-any-body';
const HANDLE = 'bff-handle-must-not-appear-in-any-body';

const ADMIN_ID = '01920000-0000-7000-8000-00000000000a';
const SESSION_ID = '01920000-0000-7000-8000-00000000000b';
/** The stored `last_active_at`, fixed so the reported value can be asserted exactly. */
const ACTIVE_AT = new Date('2026-09-08T10:05:00.000Z');
const ACTIVE_AT_ISO = '2026-09-08T10:05:00.000Z';

/**
 * The route as it is actually declared, decorators and all, read through the REAL
 * `Reflector`.
 *
 * Not a stubbed reflector returning one value for every key: the guard asks three
 * separate questions of it — `@Public()`, `@NotActivity()`, `@ExplainsSessionState()`
 * — and a single-value double answers all three the same, which is how a test comes
 * to pass because the route looked PUBLIC. These two classes carry the real metadata,
 * so what is under test is the decorator, not a mock's return value.
 */
class SessionStatusRoute {
  @NotActivity()
  @ExplainsSessionState()
  handler(): void {}
}

/** Any other endpoint in the service: no marker, so its 401 must not change. */
class BusinessRoute {
  handler(): void {}
}

function accessTokenFor(): string {
  return signAccessToken({
    adminId: ADMIN_ID,
    sessionId: SESSION_ID,
    role: 'ADMIN',
    ceilingAt: new Date(Date.now() + 60 * 60 * 1000),
  }).token;
}

/** The stable login the fixture's generation belongs to. */
const FAMILY_ID = '01920000-0000-7000-8000-0000000000fa';

interface Stores {
  /** The reason `SessionDbOperation.readLiveness` answers with. */
  readonly reason?: 'revoked' | 'revoked-all' | 'expired' | null;
  /** The stored activity instant the row carries. `null` for "no row at all". */
  readonly lastActiveAt?: Date | null;
  /** The deny-only revocation flag: `true` is the cached fast path. */
  readonly flag?: boolean | null;
  /** The flag's VALUE — the reason `cacheRevocations` wrote. */
  readonly flagValue?: string | null;
}

interface Request {
  /** The `orebit_admin_session` cookie, or absent for an anonymous caller. */
  readonly cookie?: string;
  /** What the BFF record resolves to. `null` is "the record is gone". */
  readonly resolved?: string | null;
  /** A refusal thrown from inside `bff.resolve`, i.e. from the refresh path. */
  readonly resolveRejects?: unknown;
  /** false for an ordinary business route, which must be unaffected. */
  readonly marked?: boolean;
}

function build(req: Request = {}, stores: Stores = {}) {
  const sessions = {
    readLiveness: vi.fn().mockResolvedValue({
      reason: stores.reason ?? null,
      // Present on every answer the row exists for, including the dead ones — see
      // `readLiveness`. Fixed rather than `now()` so the reported value is checkable.
      lastActiveAt: stores.lastActiveAt === undefined ? ACTIVE_AT : stores.lastActiveAt,
      // The stable login id rides along on the same read — `assertLive` returns it
      // for `GET /auth/me`. Null on the "no row at all" fixture, exactly as the real
      // query answers.
      familyId: stores.lastActiveAt === null ? null : FAMILY_ID,
    }),
    touch: vi.fn().mockResolvedValue(undefined),
  };
  const cache = {
    flag: vi.fn().mockResolvedValue(stores.flag ?? false),
    get: vi.fn().mockResolvedValue(stores.flagValue ?? null),
    setFlag: vi.fn().mockResolvedValue(undefined),
    startCooldown: vi.fn().mockResolvedValue(false),
  };
  // The real service, so the mapping under test is the one production runs.
  const service = new SessionService(sessions as never, {} as never, cache as never);

  const resolve = vi.fn();
  if (req.resolveRejects !== undefined) resolve.mockRejectedValue(req.resolveRejects);
  else resolve.mockResolvedValue(req.resolved ?? null);
  const bff = { resolve } as unknown as BffSessionService;

  const route = req.marked === false ? BusinessRoute : SessionStatusRoute;

  /**
   * The reply the guard writes to on the refusal path.
   *
   * It did not need one until the guard started answering a dead session with
   * `Cache-Control: no-store` and the two cookie deletions — the handler that used to
   * set the header never runs when the guard throws. Captured from the closure rather
   * than rebuilt per `switchToHttp()` call, so an assertion sees every write the guard
   * made across the whole request.
   */
  const reply = {
    header: vi.fn(),
    clearCookie: vi.fn(),
    setCookie: vi.fn(),
  };

  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        cookies: req.cookie === undefined ? {} : { [SESSION.COOKIE_NAME]: req.cookie },
        headers: {},
        method: 'GET',
        url: '/auth/session',
        ip: '203.0.113.9',
      }),
      getResponse: () => reply,
    }),
    getHandler: () => route.prototype.handler,
    getClass: () => route,
  } as unknown as ExecutionContext;

  return {
    guard: new AuthGuard(service, bff, new Reflector()),
    context,
    sessions,
    cache,
    reply,
  };
}

/** The refusal, as a `ProblemException` — failing loudly if the call succeeded. */
async function refusal(call: () => Promise<unknown>): Promise<ProblemException> {
  try {
    await call();
  } catch (err) {
    expect(err).toBeInstanceOf(ProblemException);
    return err as ProblemException;
  }
  throw new Error('expected the request to be refused, but it was allowed');
}

/** What a client actually reads off a 401 from this route. */
function statusOf(err: ProblemException): Record<string, unknown> {
  expect(err.extra).toBeDefined();
  return err.extra as Record<string, unknown>;
}

function codeOf(err: ProblemException): unknown {
  return (statusOf(err).message as { code: unknown } | undefined)?.code;
}

// ─── 1. an active session ────────────────────────────────────────────────────

describe('an active logged-in session', () => {
  function controllerFor(admin: unknown = makeAdmin({ id: ADMIN_ID, role: 'ADMIN' })) {
    const admins = { findById: vi.fn().mockResolvedValue(admin) };
    const controller = new AuthController(
      {} as never,
      {} as never,
      admins as never,
      {} as never,
      {} as never,
    );
    return { controller, principal: { adminId: ADMIN_ID, sessionId: SESSION_ID, familyId: FAMILY_ID, role: 'ADMIN' as const } };
  }

  it('says LOGGED_IN', async () => {
    const { controller, principal } = controllerFor();
    const { data } = await controller.sessionStatus(principal, ACTIVE_AT);

    expect(data.authenticated).toBe(true);
    expect(data.message).toEqual({ code: 'LOGGED_IN', text: 'You are logged in.' });
  });

  /**
   * ═══ `lastActiveAt` IS THE STORED VALUE ════════════════════════════════════
   *
   * Reported as an ISO string, and it is the row's own instant rather than `now()`:
   * the write only happens every five minutes, so this legitimately lags the very
   * request asking for it. A frontend computing `lastActiveAt + timeout` needs the
   * lag to be visible, not smoothed over.
   */
  it('reports the stored lastActiveAt, not the current time', async () => {
    const { controller, principal } = controllerFor();
    const { data } = await controller.sessionStatus(principal, ACTIVE_AT);

    expect(data.lastActiveAt).toBe(ACTIVE_AT_ISO);
  });

  /**
   * Constant by construction rather than computed, and that is the design: reaching
   * the handler IS the live session, because `AuthGuard` refused every other state
   * before it ran. A handler that derived the code would be a second, weaker copy of
   * the guard's decision.
   */
  it('cannot report any other code, because the guard already refused those', async () => {
    const { controller, principal } = controllerFor();
    const { data } = await controller.sessionStatus(principal, ACTIVE_AT);

    expect(data.message.code).toBe('LOGGED_IN');
  });

  it('still reports the role and permissions alongside it', async () => {
    const { controller, principal } = controllerFor();
    const { data } = await controller.sessionStatus(principal, ACTIVE_AT);

    expect(data.role).toBe('ADMIN');
    expect(data.permissions).toEqual([]);
  });

  /** An account that vanished under a live token is a stale credential, not a
   *  session state — and the refusal still carries the contract's shape. */
  it('reports NOT_LOGGED_IN when the account is gone', async () => {
    const { controller, principal } = controllerFor(null);
    const err = await refusal(() => controller.sessionStatus(principal, ACTIVE_AT));

    expect(err.type).toBe(ERR.UNAUTHENTICATED);
    expect(codeOf(err)).toBe('NOT_LOGGED_IN');
  });
});

// ─── 2. no session at all ────────────────────────────────────────────────────

describe('no active session', () => {
  it('says NOT_LOGGED_IN when no cookie was presented', async () => {
    const t = build();
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(err.type).toBe(ERR.UNAUTHENTICATED);
    expect(err.status).toBe(401);
    expect(codeOf(err)).toBe('NOT_LOGGED_IN');
  });

  it('carries the whole signed-out shape, so one reader serves 200 and 401', async () => {
    const t = build();
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(statusOf(err)).toEqual({
      authenticated: false,
      role: null,
      permissions: [],
      // Null, and it has to be: nothing named a session, so there is no row and no
      // activity to report. This is the one state where that is true of a 401.
      lastActiveAt: null,
      message: { code: 'NOT_LOGGED_IN', text: 'You are not logged in.' },
    });
  });

  it('never asks either store about a session that was not named', async () => {
    // The cheap path stays cheap: an anonymous poll costs no Redis read and no query.
    const t = build();
    await refusal(() => t.guard.canActivate(t.context));

    expect(t.cache.flag).not.toHaveBeenCalled();
    expect(t.sessions.readLiveness).not.toHaveBeenCalled();
  });
});

// ─── 3. inactivity ──────────────────────────────────────────────────────────

describe('a session that expired through inactivity', () => {
  /**
   * ═══ THE EXISTING IDLE LOGIC IS THE SOURCE OF TRUTH ════════════════════════
   *
   * `readLiveness` returning 'expired' is the two-clock rule in
   * auth/auth.constants.ts reporting itself: `expires_at` (slid only by
   * `SessionDbOperation.touch`, on requests not marked `@NotActivity()`) or the
   * absolute `reauthenticate_at` ceiling has passed.
   *
   * There is a stored `last_active_at` column now, and this is still not a second
   * mechanism: `expires_at` remains the one deadline every liveness check reads, and
   * it is written as `last_active_at + timeout` in the same statement. No timer, no
   * cron, no poll. The code is READ off the existing lifecycle, and if that lifecycle
   * changed its answer this would change with it.
   */
  it('says SESSION_EXPIRED, from the existing idle/ceiling logic', async () => {
    const t = build(
      { cookie: HANDLE, resolved: accessTokenFor() },
      { reason: 'expired' },
    );
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(err.type).toBe(ERR.SESSION_EXPIRED);
    expect(statusOf(err).message).toEqual({
      code: 'SESSION_EXPIRED',
      text: 'You have been logged out due to inactivity.',
    });
    expect(t.sessions.readLiveness).toHaveBeenCalledWith(SESSION_ID);
  });

  /**
   * ═══ AN EXPIRED SESSION REPORTS WHEN IT WAS LAST ACTIVE ════════════════════
   *
   * Asked for explicitly: the frontend should get the stored value when a session
   * record is still available, including after it has expired. That is the screen
   * where "you were logged out due to inactivity" wants to say "last active 10:05" —
   * and the row is still there, so the value is still knowable.
   *
   * It rides on the 401, in the same `extra` as the message, so a client reads one
   * shape whichever answer it got.
   */
  it('reports the stored lastActiveAt on the expiry 401', async () => {
    const t = build({ cookie: HANDLE, resolved: accessTokenFor() }, { reason: 'expired' });
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(statusOf(err).lastActiveAt).toBe(ACTIVE_AT_ISO);
  });

  /**
   * ═══ THE REASON THE DESTROYED REDIS RECORD USED TO LOSE ════════════════════
   *
   * A cookie whose BFF record is gone resolved to "no credential", which the guard
   * answered as bare `unauthenticated` — indistinguishable from a browser that never
   * signed in at all.
   *
   * It is recoverable without storing anything new, because the record's Redis TTL IS
   * the family's absolute ceiling (see `write` in bff.session.ts): the record
   * disappearing means the session ran out. So "a cookie was presented AND nothing
   * resolved" is itself the evidence, and the guard reads it from the request it
   * already has.
   */
  it('says SESSION_EXPIRED when the cookie names a BFF record that is gone', async () => {
    const t = build({ cookie: HANDLE, resolved: null });
    const err = await refusal(() => t.guard.canActivate(t.context));

    // The SLUG is unchanged — still `unauthenticated`, as it was before this change.
    // Only the message tells the two apart.
    expect(err.type).toBe(ERR.UNAUTHENTICATED);
    expect(codeOf(err)).toBe('SESSION_EXPIRED');
  });

  /** The refresh path's own expiry, thrown from inside `rotate`. Same conclusion by
   *  the other door: the idle deadline passed while the token needed renewing. */
  it('says SESSION_EXPIRED for a token_expired refusal from the refresh path', async () => {
    const t = build({
      cookie: HANDLE,
      resolveRejects: new ProblemException({ type: ERR.TOKEN_EXPIRED }),
    });
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(err.type).toBe(ERR.TOKEN_EXPIRED);
    expect(codeOf(err)).toBe('SESSION_EXPIRED');
  });
});

// ─── 4. revoked, and 5. revoked-all ─────────────────────────────────────────

describe('a session revoked remotely', () => {
  it('says SESSION_REVOKED when one family was ended', async () => {
    const t = build(
      { cookie: HANDLE, resolved: accessTokenFor() },
      { reason: 'revoked' },
    );
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(err.type).toBe(ERR.SESSION_REVOKED);
    expect(statusOf(err).message).toEqual({
      code: 'SESSION_REVOKED',
      text: 'Your session was logged out from another device.',
    });
  });

  /**
   * ═══ WHY THE TWO ARE DISTINGUISHABLE AT ALL ════════════════════════════════
   *
   * Because `AdminSession.revokedReason` already records the SCOPE, and the reason
   * set is closed with one writer per member: `LOGOUT` and `REUSE_DETECTED` come from
   * `revokeFamily`, `LOGOUT_ALL` and `PASSWORD_CHANGED` from `revokeAllForAdmin`.
   *
   * So no new mechanism was needed — no second revocation architecture, no extra
   * column, no flag. The column was already selected by the query `assertLive`
   * already ran.
   */
  it('says SESSION_REVOKED_ALL when every session was ended', async () => {
    const t = build(
      { cookie: HANDLE, resolved: accessTokenFor() },
      { reason: 'revoked-all' },
    );
    const err = await refusal(() => t.guard.canActivate(t.context));

    // Still `session_revoked`: a third MESSAGE, not a third error slug. Adding one to
    // the catalogue would make every existing consumer's switch non-exhaustive.
    expect(err.type).toBe(ERR.SESSION_REVOKED);
    expect(statusOf(err).message).toEqual({
      code: 'SESSION_REVOKED_ALL',
      text: 'Your sessions have been logged out.',
    });
  });

  /**
   * The CACHED path, which is the common one: the revocation flag is written by
   * `cacheRevocations` and read for the access token's full lifetime, so most
   * requests after a logout-all never reach Postgres at all.
   *
   * The scope survives because the flag's VALUE is the reason. The decision is still
   * the key's existence — `readLiveness` must not be consulted here, or the fast
   * path is gone — and this test pins both halves.
   */
  it('keeps the scope on the cached fast path, without querying the database', async () => {
    const t = build(
      { cookie: HANDLE, resolved: accessTokenFor() },
      { flag: true, flagValue: REVOKE_REASON.LOGOUT_ALL },
    );
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(codeOf(err)).toBe('SESSION_REVOKED_ALL');
    expect(t.cache.get).toHaveBeenCalledWith(KEYS.session.revoked(SESSION_ID));
    expect(t.sessions.readLiveness).not.toHaveBeenCalled();
    // And `lastActiveAt` is null here, which is the honest answer rather than an
    // omission: this path never read a row, and querying one purely to decorate a
    // refusal would give back the round trip the fast path exists to save.
    expect(statusOf(err).lastActiveAt).toBeNull();
  });

  /** The DATABASE path does have the row, so it reports the instant. */
  it.each([
    ['one session', 'revoked'],
    ['every session', 'revoked-all'],
  ])('reports the stored lastActiveAt when %s was revoked', async (_label, reason) => {
    const t = build(
      { cookie: HANDLE, resolved: accessTokenFor() },
      { reason: reason as 'revoked' | 'revoked-all' },
    );
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(statusOf(err).lastActiveAt).toBe(ACTIVE_AT_ISO);
  });

  /**
   * A flag written before this change stored `'1'`, and a value can also be missing
   * because Redis expired the key between the two reads. Both degrade to the
   * NARROWER message: telling an admin that all their sessions ended when only one
   * did would send them hunting a breach that did not happen.
   */
  it.each([
    ['a legacy flag value', '1'],
    ['no value at all', null],
  ])('falls back to SESSION_REVOKED for %s', async (_label, flagValue) => {
    const t = build(
      { cookie: HANDLE, resolved: accessTokenFor() },
      { flag: true, flagValue },
    );
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(codeOf(err)).toBe('SESSION_REVOKED');
  });

  /** A replayed refresh token revokes one family, so it reads as one session. */
  it('says SESSION_REVOKED for a detected refresh replay', async () => {
    const t = build({
      cookie: HANDLE,
      resolveRejects: new ProblemException({ type: ERR.SESSION_REUSE_DETECTED }),
    });
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(codeOf(err)).toBe('SESSION_REVOKED');
  });
});

/**
 * ═══ THE SCOPE TABLE, AGAINST THE WHOLE REASON SET ═════════════════════════
 *
 * Iterated over `REVOKE_REASON` rather than over a hand-written list, so adding a
 * reason to auth.types.ts without classifying it here fails this test rather than
 * silently reporting the wrong message. That is the only thing keeping the mapping
 * honest as the reason set grows.
 */
describe('which revoke reasons ended every session', () => {
  const EXPECTED: Readonly<Record<string, 'SESSION_REVOKED' | 'SESSION_REVOKED_ALL'>> = {
    // `revokeFamily` — one family is one sign-in.
    [REVOKE_REASON.LOGOUT]: 'SESSION_REVOKED',
    [REVOKE_REASON.REUSE_DETECTED]: 'SESSION_REVOKED',
    // `revokeAllForAdmin` — every family, including the manual-review and
    // account-disable sweeps, which write LOGOUT_ALL.
    [REVOKE_REASON.LOGOUT_ALL]: 'SESSION_REVOKED_ALL',
    [REVOKE_REASON.PASSWORD_CHANGED]: 'SESSION_REVOKED_ALL',
  };

  it('classifies every reason the service can write', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.values(REVOKE_REASON).sort());
  });

  it.each(Object.entries(EXPECTED))('%s reads as %s', (reason, code) => {
    expect(revokedMessageCode(reason)).toBe(code);
  });

  it('reads an unknown reason as the narrower message', () => {
    expect(revokedMessageCode('SOMETHING_A_LATER_DEPLOY_ADDED')).toBe('SESSION_REVOKED');
    expect(revokedMessageCode(null)).toBe('SESSION_REVOKED');
  });
});

// ─── 6, 7, 8. what must never appear ────────────────────────────────────────

/**
 * ═══ THE MESSAGE MUST NOT BECOME A LEAK ════════════════════════════════════
 *
 * The whole BFF design rests on the browser holding one opaque handle and nothing
 * else. A field added to explain a logout is exactly the kind of change that
 * accidentally attaches the session it is explaining, so every state is checked
 * rather than one representative case.
 */
describe('what a session answer never carries', () => {
  const CASES: ReadonlyArray<readonly [string, Request, Stores]> = [
    ['no session', {}, {}],
    ['a dead BFF record', { cookie: HANDLE, resolved: null }, {}],
    [
      'inactivity expiry',
      { cookie: HANDLE, resolved: accessTokenFor() },
      { reason: 'expired' },
    ],
    [
      'a revoked session',
      { cookie: HANDLE, resolved: accessTokenFor() },
      { reason: 'revoked' },
    ],
    [
      'every session revoked',
      { cookie: HANDLE, resolved: accessTokenFor() },
      { reason: 'revoked-all' },
    ],
  ];

  it.each(CASES)('carries no access token, refresh token or BFF handle: %s', async (
    _label,
    req,
    stores,
  ) => {
    const t = build(req, stores);
    const err = await refusal(() => t.guard.canActivate(t.context));
    const serialised = JSON.stringify(statusOf(err));

    expect(serialised).not.toContain(ACCESS);
    expect(serialised).not.toContain(REFRESH);
    expect(serialised).not.toContain(HANDLE);
  });

  it.each(CASES)('carries no session id and no internal Redis key: %s', async (
    _label,
    req,
    stores,
  ) => {
    const t = build(req, stores);
    const err = await refusal(() => t.guard.canActivate(t.context));
    const serialised = JSON.stringify(statusOf(err));

    expect(serialised).not.toContain(SESSION_ID);
    expect(serialised).not.toContain(KEYS.session.revoked(SESSION_ID));
    expect(serialised).not.toContain('bff:session');
  });

  /**
   * The structural version, and the one that survives a rename: the signed-out shape
   * has exactly four keys, so a session id or a deadline cannot arrive under a name
   * the substring checks above do not know about.
   */
  it.each(CASES)('has exactly the four contract fields and nothing else: %s', async (
    _label,
    req,
    stores,
  ) => {
    const t = build(req, stores);
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(Object.keys(statusOf(err)).sort()).toEqual([
      'authenticated',
      'lastActiveAt',
      'message',
      'permissions',
      'role',
    ]);
    expect(statusOf(err).authenticated).toBe(false);
    expect(statusOf(err).role).toBeNull();
    expect(statusOf(err).permissions).toEqual([]);
  });

  it('does not carry a token in the 200 either', async () => {
    const admins = { findById: vi.fn().mockResolvedValue(makeAdmin({ id: ADMIN_ID })) };
    const controller = new AuthController(
      {} as never,
      {} as never,
      admins as never,
      {} as never,
      {} as never,
    );
    const serialised = JSON.stringify(
      (
        await controller.sessionStatus(
          { adminId: ADMIN_ID, sessionId: SESSION_ID, familyId: FAMILY_ID, role: 'ADMIN' },
          ACTIVE_AT,
        )
      ).data,
    );

    expect(serialised).not.toContain(ACCESS);
    expect(serialised).not.toContain(REFRESH);
    expect(serialised).not.toContain(HANDLE);
    expect(serialised).not.toContain(SESSION_ID);
  });
});

// ─── 9. the frontend contract ───────────────────────────────────────────────

/**
 * ═══ `code` IS THE CONTRACT; `text` IS A DEFAULT ═══════════════════════════
 *
 * The same rule src/contracts.ts states for error slugs. A client that branched on
 * wording would break the day the wording was improved, and improving the wording is
 * a thing a panel's copy review does routinely.
 */
describe('what a client is allowed to depend on', () => {
  const CODES: readonly SessionMessageCode[] = [
    'LOGGED_IN',
    'SESSION_EXPIRED',
    'SESSION_REVOKED',
    'SESSION_REVOKED_ALL',
    'NOT_LOGGED_IN',
  ];

  it('publishes exactly the five codes the contract names', () => {
    expect(Object.keys(SESSION_MESSAGES).sort()).toEqual([...CODES].sort());
  });

  it('gives every code a stable identifier a switch can match', () => {
    for (const code of CODES) {
      // Not a sentence, not localised, not punctuated: an identifier.
      expect(code).toMatch(/^[A-Z][A-Z_]*$/);
      expect(SESSION_MESSAGES[code].code).toBe(code);
    }
  });

  it('never repeats a code, so the five states stay distinguishable', () => {
    const codes = Object.values(SESSION_MESSAGES).map((m) => m.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  /**
   * The behavioural statement: every distinct STATE has a distinct CODE, so nothing
   * a client needs to tell apart is only distinguishable by reading `text`. If two
   * states ever shared a code, parsing the sentence would become the only way — which
   * is the thing this contract exists to make unnecessary.
   */
  it('does not make the text load-bearing for any distinction', () => {
    const texts = Object.values(SESSION_MESSAGES).map((m) => m.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  /**
   * ═══ TOTALITY: NO 401 FROM THIS ROUTE LACKS A CODE ═════════════════════════
   *
   * Every slug the route can answer with maps to one of the five, so a frontend
   * needs no fallback of its own — which is what keeps it from writing one that
   * inspects `title` or `detail`.
   */
  it.each([
    [ERR.SESSION_EXPIRED, 'SESSION_EXPIRED'],
    [ERR.TOKEN_EXPIRED, 'SESSION_EXPIRED'],
    [ERR.SESSION_REVOKED, 'SESSION_REVOKED'],
    [ERR.SESSION_REUSE_DETECTED, 'SESSION_REVOKED'],
    [ERR.TOKEN_INVALID, 'NOT_LOGGED_IN'],
    // A cookie was presented and the record behind it is unusable, so the session is
    // over rather than absent. Without the cookie this same slug means anonymous —
    // asserted just below.
    [ERR.UNAUTHENTICATED, 'SESSION_EXPIRED'],
  ])('answers %s with a code: %s', async (slug, code) => {
    // Thrown from inside `bff.resolve`, which is where the refresh path's refusals
    // come from — and which only runs when a cookie named a record to resolve.
    const t = build({ cookie: HANDLE, resolveRejects: new ProblemException({ type: slug }) });
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(codeOf(err)).toBe(code);
  });

  it('answers unauthenticated with NOT_LOGGED_IN when no cookie was presented', async () => {
    // The same slug, the opposite code. This pair is the one distinction the slug
    // alone cannot make, and the guard makes it from the request it already holds.
    const t = build();
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(err.type).toBe(ERR.UNAUTHENTICATED);
    expect(codeOf(err)).toBe('NOT_LOGGED_IN');
  });
});

// ─── the blast radius ───────────────────────────────────────────────────────

/**
 * ═══ NO OTHER ENDPOINT CHANGED ═════════════════════════════════════════════
 *
 * The marker is the whole reason this is a contained change. `GET /auth/me` and every
 * business route still answer the 401 they answered before — same slug, same
 * document, no `extra`.
 *
 * `SessionEndedException` is what makes that possible: it carries the code as a FIELD
 * that `ProblemJsonFilter` does not render, so the reason travels up through the
 * guard without reaching the wire anywhere it was not asked for.
 */
describe('a route without @ExplainsSessionState()', () => {
  const CASES: ReadonlyArray<readonly [string, Request, Stores]> = [
    ['no session', {}, {}],
    [
      'inactivity expiry',
      { cookie: HANDLE, resolved: accessTokenFor() },
      { reason: 'expired' },
    ],
    [
      'a revoked session',
      { cookie: HANDLE, resolved: accessTokenFor() },
      { reason: 'revoked' },
    ],
    [
      'every session revoked',
      { cookie: HANDLE, resolved: accessTokenFor() },
      { reason: 'revoked-all' },
    ],
  ];

  it.each(CASES)('refuses with no session status attached: %s', async (_label, req, stores) => {
    const t = build({ ...req, marked: false }, stores);
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(err.extra).toBeUndefined();
  });

  it.each(CASES)('keeps answering the same slug it always did: %s', async (
    _label,
    req,
    stores,
  ) => {
    const marked = build(req, stores);
    const plain = build({ ...req, marked: false }, stores);

    const a = await refusal(() => marked.guard.canActivate(marked.context));
    const b = await refusal(() => plain.guard.canActivate(plain.context));

    // Only `extra` differs. The status code and the slug a client switches on first
    // are identical on both routes.
    expect(b.type).toBe(a.type);
    expect(b.status).toBe(a.status);
  });

  /** A refusal that is not about the session must not be dressed up as one — a 500
   *  reporting "you are not logged in" would send a client to the login screen for
   *  an outage. */
  it('leaves a non-401 refusal completely alone', async () => {
    const t = build({
      cookie: HANDLE,
      resolveRejects: new ProblemException({ type: ERR.INTERNAL_ERROR }),
    });
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(err.status).toBe(500);
    expect(err.extra).toBeUndefined();
  });
});

// ─── 8. retiring the cookies a dead session left behind ─────────────────────

/**
 * ═══ WHY THE STATUS ROUTE IS WHERE THE COOKIES GET RETIRED ═════════════════
 *
 * A session that ends by INACTIVITY ends without a request. There is no response to
 * carry a `Set-Cookie`, so `orebit_admin_session` and `orebit_admin_csrf` outlive the
 * session they name — by up to the twelve-hour ceiling, which is what their `maxAge`
 * is scoped to and not the idle window.
 *
 * That leftover cookie is not inert. `authenticate` demands a CSRF token from any
 * unsafe request that carries a session cookie, so the next sign-in's `POST /2fa`
 * arrives cookie-authenticated, sends no `x-csrf-token` — the ceremony has no reason
 * to — and is refused 403. The admin cannot log in again until the cookie is gone.
 *
 * `GET /auth/session` is the first request that ASKS whether the session is still
 * alive, so it is the first response able to answer "no, and here are the deletions".
 * It is already the one route that explains a session's end; retiring the credential
 * it just declared dead belongs in the same place.
 *
 * ─── What must NOT be cleared, and why each case is here ───────────────────
 *
 * Clearing on the wrong refusal is worse than not clearing at all: the handle is the
 * only value naming the family, so dropping it when the session might still be live
 * strands a session nobody can revoke. Hence the three negative cases below — a 503,
 * a live session, and an unmarked route.
 */
describe('the cookies a dead session left in the browser', () => {
  /** Cookie names the guard asked the browser to delete, sorted for a stable compare. */
  function cleared(t: ReturnType<typeof build>): string[] {
    return t.reply.clearCookie.mock.calls.map((call) => call[0] as string).sort();
  }

  const BOTH = [CSRF.COOKIE_NAME, SESSION.COOKIE_NAME].sort();

  it('retires both cookies when the session expired through inactivity', async () => {
    const t = build({ cookie: HANDLE, resolved: accessTokenFor() }, { reason: 'expired' });
    const err = await refusal(() => t.guard.canActivate(t.context));

    // The reason still reaches the client unchanged — the deletion rides along with
    // the existing answer rather than replacing it.
    expect(codeOf(err)).toBe('SESSION_EXPIRED');
    expect(cleared(t)).toEqual(BOTH);
  });

  it('retires both cookies when the session was revoked elsewhere', async () => {
    const t = build({ cookie: HANDLE, resolved: accessTokenFor() }, { reason: 'revoked' });
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(codeOf(err)).toBe('SESSION_REVOKED');
    expect(cleared(t)).toEqual(BOTH);
  });

  /**
   * A cookie is only actually removed when the deletion names the same
   * (name, domain, path) triple the creation used — `Secure`, `SameSite` and
   * `HttpOnly` take no part in that match. The scopes are read off the constants
   * rather than written out, so a future change to either path moves both halves at
   * once instead of silently leaving a cookie the browser will keep.
   */
  it('clears each cookie at the scope it was issued with', async () => {
    const t = build({ cookie: HANDLE, resolved: accessTokenFor() }, { reason: 'expired' });
    await refusal(() => t.guard.canActivate(t.context));

    expect(t.reply.clearCookie).toHaveBeenCalledWith(SESSION.COOKIE_NAME, {
      path: SESSION.COOKIE_PATH,
    });
    expect(t.reply.clearCookie).toHaveBeenCalledWith(CSRF.COOKIE_NAME, {
      path: CSRF.COOKIE_PATH,
    });
  });

  it('leaves an anonymous poll alone', async () => {
    // No cookie was presented, so there is nothing to retire and no reason to spend
    // two `Set-Cookie` headers on every unauthenticated poll.
    const t = build();
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(codeOf(err)).toBe('NOT_LOGGED_IN');
    expect(t.reply.clearCookie).not.toHaveBeenCalled();
  });

  /**
   * The one that would be a real bug. `session_store_unavailable` means Redis could
   * not answer — NOT that the session is over. Clearing here would discard the only
   * value naming a family that is very probably still live, leaving a session no
   * logout could ever reach. The same reasoning `POST /auth/session` already applies
   * when it refuses to report a logout it could not perform.
   */
  it('keeps the cookies when the session store could not answer', async () => {
    const t = build({
      cookie: HANDLE,
      resolveRejects: new ProblemException({ type: ERR.SESSION_STORE_UNAVAILABLE }),
    });
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(err.status).toBe(503);
    expect(t.reply.clearCookie).not.toHaveBeenCalled();
  });

  it('keeps the cookies when the refusal is not about the session at all', async () => {
    const t = build({
      cookie: HANDLE,
      resolveRejects: new ProblemException({ type: ERR.INTERNAL_ERROR }),
    });
    const err = await refusal(() => t.guard.canActivate(t.context));

    expect(err.status).toBe(500);
    expect(t.reply.clearCookie).not.toHaveBeenCalled();
  });

  it('keeps the cookies when the session is still live', async () => {
    const t = build({ cookie: HANDLE, resolved: accessTokenFor() }, { reason: null });

    await expect(t.guard.canActivate(t.context)).resolves.toBe(true);
    expect(t.reply.clearCookie).not.toHaveBeenCalled();
  });

  /**
   * The blast radius, stated as a test. Every other endpoint's 401 is byte-for-byte
   * what it was — no status attached, no headers written, no cookies retired. A
   * business route that started deleting credentials on refusal would sign an admin
   * out over one unlucky error.
   */
  it('does not touch the cookies on a route without the marker', async () => {
    const t = build(
      { cookie: HANDLE, resolved: accessTokenFor(), marked: false },
      { reason: 'expired' },
    );
    await refusal(() => t.guard.canActivate(t.context));

    expect(t.reply.clearCookie).not.toHaveBeenCalled();
    expect(t.reply.header).not.toHaveBeenCalled();
  });

  /**
   * F15. The handler sets `Cache-Control: no-store` on the 200, and the handler does
   * not run when the guard throws — so the refusal, which is the response that
   * actually carries session state, went out cacheable. A shared cache holding one
   * admin's "your session ended" is the same class of mistake as caching the 200.
   */
  it('answers no-store on the refusal, not only on the 200', async () => {
    const t = build({ cookie: HANDLE, resolved: accessTokenFor() }, { reason: 'expired' });
    await refusal(() => t.guard.canActivate(t.context));

    expect(t.reply.header).toHaveBeenCalledWith('cache-control', 'no-store');
  });
});
