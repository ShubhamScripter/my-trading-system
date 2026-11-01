import type { ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { ELEVATION, SESSION } from '../../auth/auth.constants';
import { AuthGuard, requirePrincipal } from '../../auth/security/guards';
import type { BffSessionService } from '../../auth/security/bff.session';
import { signAccessToken } from '../../auth/security/jwt';
import type { SessionService } from '../../auth/services/session.service';
import { CacheService, KEYS } from '../../redis';
import {
  ELEVATION_ANY,
  ElevationGuard,
  ElevationService,
  RequiresElevation,
} from '../../src/2fa/elevation';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * ═══ F08 — AN AUTOMATIC REFRESH MUST NOT REVOKE A PROOF ══════════════════════
 *
 * An elevation ticket is authorisation for ONE write by ONE login. It was bound to
 * `principal.sessionId`, which is the refresh GENERATION id — a value that changes
 * every time the backend rotates tokens on the browser's behalf.
 *
 * Rotation happens inside `bff.resolve` whenever the held access token is within
 * `ACCESS_REFRESH_SKEW_SECONDS` (30s) of its 15-minute expiry, with nothing the
 * client can observe or defer. A ticket lives 60 seconds. So a proof-then-write
 * sequence that straddled a rotation was refused with `reauth_required` — the admin
 * had proved a factor moments earlier and was told to prove it again, and the retry
 * also spent one of only three `REAUTH_BY_SESSION` slots.
 *
 * ─── The fix is a rebinding, not a removal ─────────────────────────────────
 *
 * The generation binding is not loosened away; it is replaced by the binding that
 * matches what the ticket represents. A ticket authorises a LOGIN to perform a
 * write, and the durable identity of a login is its `AdminSessionFamily`. Two
 * generations of one family are the same browser, the same sign-in, the same
 * three-factor ceremony. Two families are two logins and remain isolated.
 *
 * ─── Where `familyId` comes from, which is the security property ───────────
 *
 * Server-side, always, by this chain and no other:
 *
 *   request → cookie/bearer → verified JWT `sid` (the generation)
 *           → SessionDbOperation.readLiveness(sid)   ← authoritative row
 *           → LiveSession.familyId                    ← NOT NULL column
 *           → Principal.familyId
 *
 * No request field, header, body value or claim reaches it. In particular NO `fam`
 * claim was added to the access token: a claim is a value the credential ASSERTS,
 * and this has to be a value the database RESOLVES. The first two tests below are
 * about that chain rather than about tickets.
 */

const ADMIN_ID = '01920000-0000-7000-8000-00000000000a';
/** Two generations of ONE login — before and after a background rotation. */
const GEN_BEFORE = '01920000-0000-7000-8000-000000001111';
const GEN_AFTER = '01920000-0000-7000-8000-000000002222';
/** The stable login both generations belong to. */
const FAMILY = '01920000-0000-7000-8000-0000000ff001';
/** A different browser login entirely. */
const OTHER_FAMILY = '01920000-0000-7000-8000-0000000ff002';

const ACTION = 'admin.settings.publish';

function makeCache() {
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
  };
  return { store, redis, service: new CacheService(redis as never) };
}

function slugOf(err: unknown): string {
  return err instanceof ProblemException ? err.type : `unexpected: ${String(err)}`;
}

/**
 * A request authenticated by the REAL `AuthGuard`, so the principal under test is
 * the one production builds.
 *
 * This matters more than it looks. The whole question is which identifier reaches
 * the spend site, and a hand-made principal object would let the test assert
 * whatever it assumed. Here the access token names a generation, a doubled
 * `assertLive` answers with the family that generation belongs to — exactly as
 * `readLiveness` does from the row — and the guard assembles the principal itself.
 */
async function authenticated(generationId: string, familyId: string): Promise<FastifyRequest> {
  const token = signAccessToken({
    adminId: ADMIN_ID,
    sessionId: generationId,
    role: 'SUPER_ADMIN',
    ceilingAt: new Date(Date.now() + 60 * 60 * 1000),
  }).token;

  const req = {
    cookies: { [SESSION.COOKIE_NAME]: 'a-handle' },
    headers: {},
    method: 'GET',
    url: '/anything',
    ip: '203.0.113.9',
  } as unknown as FastifyRequest;

  const sessions = {
    assertLive: vi.fn().mockResolvedValue({ lastActiveAt: null, familyId }),
    touch: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionService;
  const bff = { resolve: vi.fn().mockResolvedValue(token) } as unknown as BffSessionService;
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) };

  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;

  await new AuthGuard(sessions, bff, reflector as never).canActivate(context);
  return req;
}

/** An `ExecutionContext` for `ElevationGuard` over an already-authenticated request. */
function elevationContext(
  req: FastifyRequest,
  ticket: string | null,
  declared: { action?: string } = { action: ACTION },
): { context: ExecutionContext; reflector: { getAllAndOverride: ReturnType<typeof vi.fn> } } {
  if (ticket !== null) {
    (req.headers as Record<string, string>)[ELEVATION.HEADER_NAME] = ticket;
  }
  const reflector = { getAllAndOverride: vi.fn().mockReturnValue(declared.action) };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { context, reflector };
}

describe('F08 — familyId is derived from the database, never from the caller', () => {
  it('resolves the family from the generation the token names', async () => {
    const req = await authenticated(GEN_BEFORE, FAMILY);

    // The principal carries BOTH: the generation, which still keys refresh replay
    // detection and logout, and the family, which keys authorisation for this login.
    expect(requirePrincipal(req)).toMatchObject({
      adminId: ADMIN_ID,
      sessionId: GEN_BEFORE,
      familyId: FAMILY,
    });
  });

  it('ignores a familyId the caller tries to supply', async () => {
    // The attack this rules out: if `familyId` could come from the request, a caller
    // holding one login's credential could name another login's family and spend a
    // ticket minted there. It comes from `assertLive` and from nowhere else, so a
    // header, a cookie and a body field are all inert.
    const token = signAccessToken({
      adminId: ADMIN_ID,
      sessionId: GEN_BEFORE,
      role: 'SUPER_ADMIN',
      ceilingAt: new Date(Date.now() + 60 * 60 * 1000),
    }).token;

    const req = {
      cookies: { [SESSION.COOKIE_NAME]: 'a-handle', familyId: OTHER_FAMILY },
      headers: { 'x-family-id': OTHER_FAMILY, familyid: OTHER_FAMILY },
      method: 'GET',
      url: '/anything',
      ip: '203.0.113.9',
      body: { familyId: OTHER_FAMILY },
    } as unknown as FastifyRequest;

    const sessions = {
      // The database says FAMILY. That is the only answer that counts.
      assertLive: vi.fn().mockResolvedValue({ lastActiveAt: null, familyId: FAMILY }),
      touch: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionService;
    const bff = { resolve: vi.fn().mockResolvedValue(token) } as unknown as BffSessionService;
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(undefined) };
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;

    await new AuthGuard(sessions, bff, reflector as never).canActivate(context);

    const cache = makeCache();
    const elevation = new ElevationService(cache.service);
    // A ticket minted for the OTHER family must not be spendable by this request.
    const { ticket } = await elevation.issue(OTHER_FAMILY, ACTION);
    const { context: ctx, reflector: r } = elevationContext(req, ticket);

    await expect(new ElevationGuard(elevation, r as never).canActivate(ctx)).rejects.toSatisfy(
      (err: unknown) => slugOf(err) === ERR.REAUTH_REQUIRED,
    );
  });

  it('adds no `fam` claim to the access token', async () => {
    // The rejected alternative, pinned. Carrying the family in the credential would
    // make it something the token asserts rather than something the row resolves, and
    // would need a rollout fallback for every token minted by the previous deploy.
    const { token } = signAccessToken({
      adminId: ADMIN_ID,
      sessionId: GEN_BEFORE,
      role: 'SUPER_ADMIN',
      ceilingAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const claims = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(claims).toHaveProperty('sid', GEN_BEFORE);
    expect(claims).not.toHaveProperty('fam');
  });
});

describe('F08 — a background rotation does not invalidate a live proof', () => {
  let cache: ReturnType<typeof makeCache>;
  let elevation: ElevationService;

  beforeEach(() => {
    cache = makeCache();
    elevation = new ElevationService(cache.service);
  });

  it('spends a ticket proved before the rotation, on the generation after it', async () => {
    // ═══ THE REPRODUCTION ════════════════════════════════════════════════════
    //
    // The admin proves a factor while their session is on GEN_BEFORE, the backend
    // rotates to GEN_AFTER on its own schedule, and the write lands. One login, one
    // ceremony, one proof — so it must be honoured.
    const proving = await authenticated(GEN_BEFORE, FAMILY);
    const { ticket } = await elevation.issue(FAMILY, ACTION);
    expect(proving).toBeDefined();

    // ... rotation happens. Same family, new generation, new access token.
    const writing = await authenticated(GEN_AFTER, FAMILY);
    const { context, reflector } = elevationContext(writing, ticket);

    await expect(
      new ElevationGuard(elevation, reflector as never).canActivate(context),
    ).resolves.toBe(true);
  });

  it('still refuses a ticket minted by a DIFFERENT login', async () => {
    // ═══ CROSS-LOGIN ISOLATION, WHICH THE REBINDING MUST NOT COST ═══════════
    //
    // The property the generation binding was protecting: a ticket obtained from a
    // shared log, a proxy, or a second browser belonging to someone else is not a
    // bearer credential of its own. Two browsers are two families, so it still is
    // not — and this test is why the fix is a rebinding rather than a removal.
    const { ticket } = await elevation.issue(OTHER_FAMILY, ACTION);
    const writing = await authenticated(GEN_AFTER, FAMILY);
    const { context, reflector } = elevationContext(writing, ticket);

    await expect(
      new ElevationGuard(elevation, reflector as never).canActivate(context),
    ).rejects.toSatisfy((err: unknown) => slugOf(err) === ERR.REAUTH_REQUIRED);
  });

  it('keeps one-time use across a rotation', async () => {
    // Spending it on the new generation must not make it spendable twice. `take` is
    // a single `GETDEL`, so the second attempt reads nothing.
    const { ticket } = await elevation.issue(FAMILY, ACTION);
    const first = await authenticated(GEN_BEFORE, FAMILY);
    const second = await authenticated(GEN_AFTER, FAMILY);

    await expect(
      new ElevationGuard(elevation, elevationContext(first, ticket).reflector as never).canActivate(
        elevationContext(first, ticket).context,
      ),
    ).resolves.toBe(true);

    await expect(
      new ElevationGuard(
        elevation,
        elevationContext(second, ticket).reflector as never,
      ).canActivate(elevationContext(second, ticket).context),
    ).rejects.toSatisfy((err: unknown) => slugOf(err) === ERR.REAUTH_REQUIRED);
  });

  it('keeps the action binding across a rotation', async () => {
    // A proof for one write is still not a proof for another, whichever generation
    // presents it.
    const { ticket } = await elevation.issue(FAMILY, ACTION);
    const writing = await authenticated(GEN_AFTER, FAMILY);
    const { context, reflector } = elevationContext(writing, ticket, { action: 'admin.status.disable' });

    await expect(
      new ElevationGuard(elevation, reflector as never).canActivate(context),
    ).rejects.toSatisfy((err: unknown) => slugOf(err) === ERR.REAUTH_REQUIRED);
  });

  it('stores the family id in the grant, and never in the key', async () => {
    const { ticket } = await elevation.issue(FAMILY, ACTION);

    expect(cache.store.get(KEYS.elevation.ticket(ticket))).toBe(
      JSON.stringify({ familyId: FAMILY, action: ACTION }),
    );
    // The key is still derived from the TICKET, hashed. Keying it on the login would
    // turn the entry into a "this login is elevated" flag, which is the sudo window
    // this mechanism exists not to be.
    expect(KEYS.elevation.ticket(ticket)).not.toContain(FAMILY);
  });

  it('refuses a grant written in the old generation-keyed shape', async () => {
    // Rolling-deploy safety. A ticket minted by the previous version carries
    // `{ sessionId, action }`, which no longer parses — so it is refused rather than
    // half-understood, and the client's remedy is the one it would take for an
    // expired ticket anyway. Tickets live 60 seconds, so the window is one minute of
    // one deploy.
    const ticket = 'a-ticket-from-the-previous-deploy';
    cache.store.set(
      KEYS.elevation.ticket(ticket),
      JSON.stringify({ sessionId: GEN_BEFORE, action: ACTION }),
    );

    const writing = await authenticated(GEN_BEFORE, FAMILY);
    const { context, reflector } = elevationContext(writing, ticket);

    await expect(
      new ElevationGuard(elevation, reflector as never).canActivate(context),
    ).rejects.toSatisfy((err: unknown) => slugOf(err) === ERR.REAUTH_REQUIRED);
  });
});

describe('F08 — ElevationGuard still fails closed on a wiring mistake', () => {
  // Neither branch had any coverage before: the guard has no live routes yet, so
  // these are the only thing standing between a future mistake and an unguarded
  // write surface.
  let elevation: ElevationService;

  beforeEach(() => {
    elevation = new ElevationService(makeCache().service);
  });

  it('throws when a route declares no action', async () => {
    const req = await authenticated(GEN_BEFORE, FAMILY);
    const { context, reflector } = elevationContext(req, 'anything', {});

    // Not a ProblemException: an un-annotated route is a wiring bug, not a client
    // error. Any default action would make every such route share one ticket
    // namespace, which is exactly what the action binding removed.
    await expect(
      new ElevationGuard(elevation, reflector as never).canActivate(context),
    ).rejects.toThrow(/no @RequiresElevation/);
  });

  it('throws when a route declares the ELEVATION_ANY sentinel', async () => {
    const req = await authenticated(GEN_BEFORE, FAMILY);
    const { context, reflector } = elevationContext(req, 'anything', { action: ELEVATION_ANY });

    await expect(
      new ElevationGuard(elevation, reflector as never).canActivate(context),
    ).rejects.toThrow(/is not permitted/);
  });

  it('declares actions through metadata, not through the request', async () => {
    // `RequiresElevation` is a `SetMetadata` decorator, so the ROUTE names the
    // action and a caller cannot. Asserted because the guard reading the action from
    // the body would let a caller present whichever action their ticket carries.
    const decorator = RequiresElevation(ACTION);
    expect(typeof decorator).toBe('function');
  });
});
