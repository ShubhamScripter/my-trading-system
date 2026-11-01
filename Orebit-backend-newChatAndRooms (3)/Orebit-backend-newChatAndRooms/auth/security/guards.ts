import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { CacheService, KEYS } from '../../redis';
import { safeEqual } from '../../src/utils/public.utils';
import { CSRF, SESSION } from '../auth.constants';
import { policy } from '../limits';
import type { Principal, RefreshContext } from '../auth.types';
import { csrfTokenMatches, headerValue, refreshContextOf } from '../auth.utility';
import { bearerFrom, verifyAccessToken } from './jwt';
import { BffSessionService } from './bff.session';
import { readDeviceKey } from './device.cookie';
import { explainSessionEnd } from './session.message';
import { cookieValue, sessionCookie } from './session.cookie';
import { SessionService } from '../services/session.service';
import { cloudflareCountry } from '../../src/geo/cloudflare';

/**
 * The enforcement point every other module's routes consume.
 *
 * Two checks, and both are necessary. The JWT signature proves the token was
 * minted here and has not expired; the session lookup proves it has not been
 * revoked since. A signature-only guard would keep honouring an access token for
 * its full fifteen minutes after a logout, a password reset, or a detected refresh
 * replay — which would make all three of those close to meaningless.
 *
 * `AuthGuard` is registered globally in src/app.module.ts, so it runs on every
 * route in the service and a new controller is authenticated the moment it is
 * wired up. Opting out is explicit and greppable — see `@Public()` below.
 *
 * ─── The browser presents a cookie; the token model is unchanged ───────────
 *
 * `authenticate` resolves the `orebit_session` cookie to a server-held access token
 * before falling back to an `Authorization` header. Everything after that point is
 * exactly what it was: the same signature check, the same session lookup, the same
 * `Principal`. What changed is only where the token was kept — see
 * security/bff.session.ts.
 */

/** Where the principal is stashed on the request. Symbol-keyed so it cannot
 *  collide with a body or query field named `principal`. */
const PRINCIPAL = Symbol('principal');

/**
 * The authenticated session's stored `lastUsedAt`, stashed beside the principal.
 *
 * Not a field ON the principal, deliberately. A principal is what the CREDENTIAL says
 * — values read out of a verified JWT — and every consumer treats it that way. This is
 * a database fact with a different lifetime, read by `assertLive` on the way past, and
 * only `GET /auth/session` wants it.
 *
 * Stashed rather than re-queried because `assertLive` has already read the row: the
 * alternative is a second primary-key lookup per poll for a value we were holding.
 */
const ACTIVITY = Symbol('lastUsedAt');

const IS_PUBLIC = Symbol('isPublic');

const NOT_ACTIVITY = Symbol('notActivity');

const EXPLAINS_SESSION = Symbol('explainsSessionState');

/**
 * Exempts a route from the global `AuthGuard`.
 *
 * The direction here is the point. Guarding used to be opt-in, one
 * `@UseGuards(AuthGuard)` at a time, which meant a forgotten decorator on a future
 * wallet or merchant route published it to the internet and nothing anywhere would
 * say so. Now the omission fails closed: forget `@Public()` on a route that should
 * be open and it returns 401 the first time anyone calls it, which is a bug that
 * reports itself.
 *
 * Every use is a deliberate statement that the route is safe unauthenticated, and
 * `grep -rn "@Public()"` is the audit.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/**
 * Marks a route whose traffic must NOT reset the idle timeout.
 *
 * ─── The failure this exists to prevent ─────────────────────────────────────
 *
 * The idle window is the whole mechanism behind "walking away ends the session", and
 * it only works if the thing being measured is a person using the product. Anything a
 * CLIENT does on its own schedule — polling a badge count, a websocket keepalive, a
 * prefetch, a health check, asking `GET /auth/session` whether it is still signed in —
 * is the application talking to itself, and counting it as activity means an abandoned
 * tab holds a session open indefinitely. The window still exists; nothing ever reaches
 * the end of it.
 *
 * ─── Why opt-out rather than opt-in ─────────────────────────────────────────
 *
 * Reading the policy literally would make this opt-IN: activity recorded only on
 * routes explicitly marked as intentional. That is stricter and it fails the wrong
 * way — a route nobody remembers to mark stops counting, and real users are logged
 * out mid-task with nothing in the code looking wrong. Marking the background routes
 * fails the other way: a new one that nobody marks keeps a session alive slightly
 * longer than it should, which is visible in the session list and costs nobody their
 * work. Given one of the two mistakes is going to happen, this is the one to have.
 *
 * `grep -rn "@NotActivity()"` is the audit, the same way `@Public()` is.
 *
 * Note that logout already does not count, and not through this decorator: it sits
 * behind `OptionalAuthGuard`, which never touches. See the note there.
 */
export const NotActivity = (): MethodDecorator & ClassDecorator =>
  SetMetadata(NOT_ACTIVITY, true);

/**
 * Marks the route whose 401 must say WHICH of the five session states explains it.
 *
 * ═══ WHY THIS IS A MARKER AND NOT THE DEFAULT ══════════════════════════════
 *
 * `GET /auth/session` exists to report authentication state, so its refusal is an
 * ANSWER rather than an error, and it carries `extra.message` for a frontend to switch
 * on — see security/session.message.ts.
 *
 * Every other route's 401 is unchanged, byte for byte, and that is the point of opting
 * in rather than enriching every refusal the guard throws. A business route that
 * started reporting session state in its errors would be a wider contract change than
 * this asks for, and the reason a client needs is already the `type` slug there.
 *
 * `grep -rn "@ExplainsSessionState()"` is the audit, and it should find exactly one
 * route.
 */
export const ExplainsSessionState = (): MethodDecorator & ClassDecorator =>
  SetMetadata(EXPLAINS_SESSION, true);

interface WithPrincipal {
  [PRINCIPAL]?: Principal;
  [ACTIVITY]?: Date | null;
}

/** Methods that cannot change state, and so need no CSRF token. `HEAD` and
 *  `OPTIONS` are here because the browser issues them on its own. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * "This session is over" — as opposed to "this request is malformed".
 *
 * The slugs a session can end with, listed explicitly rather than matched on a 401
 * status, so that a future 401 for a different reason is not silently swallowed by the
 * logout route.
 */
const DEAD_SESSION_TYPES: ReadonlySet<string> = new Set([
  ERR.SESSION_REVOKED,
  // The idle-timeout counterpart of the above. Omitting it would make logout answer
  // 401 for a session that timed out while the user was away — which is the exact
  // regression the revoked case is here to fix, and the commonest way to reach logout
  // at all.
  ERR.SESSION_EXPIRED,
  ERR.SESSION_REUSE_DETECTED,
  ERR.TOKEN_EXPIRED,
  ERR.UNAUTHENTICATED,
]);

function isDeadSession(err: unknown): boolean {
  return err instanceof ProblemException && DEAD_SESSION_TYPES.has(err.type);
}

/**
 * TWO checks, and the second is the one that matters.
 *
 *  1. the cookie and the header carry the same value — classic double-submit. An
 *     attacker's page can cause the cookie to be SENT, which is what CSRF is, but
 *     cannot READ it to populate the header, because reading it cross-origin is what
 *     the same-origin policy forbids.
 *
 *  2. that value was minted by us, FOR THIS SESSION HANDLE.
 *
 * Check 1 alone is what this used to be, and it is satisfiable without ever reading
 * anything. Cookie WRITES are governed by a weaker rule than reads: any sibling
 * subdomain can set a cookie on the parent domain. Anything that can emit a
 * `Set-Cookie` for `.orebit.io` plants a value it already knows in `orebit_csrf`,
 * echoes the same value in the header, and both halves agree — while the user's own
 * session cookie authenticates the request.
 *
 * Check 2 is what that attacker cannot do: forging a token means producing a peppered
 * hash over a handle they cannot read, with a pepper they do not have. See
 * `generateCsrfToken`.
 *
 * `safeEqual` rather than `===` throughout. The comparison is against a value the
 * caller supplies a guess for, which is the condition the rest of this codebase uses
 * to decide between the two.
 */
function assertCsrf(req: FastifyRequest, handle: string): void {
  const cookie = cookieValue(req, CSRF.COOKIE_NAME);
  const header = headerValue(req.headers[CSRF.HEADER_NAME]);

  if (
    cookie === null ||
    header === null ||
    !safeEqual(cookie, header) ||
    !csrfTokenMatches(cookie, handle)
  ) {
    // One refusal for every way this can fail. Which half was wrong is not the
    // caller's business, and for a legitimate client the remedy is identical: read
    // the cookie, send the header.
    throw new ProblemException({
      type: ERR.CSRF_INVALID,
      detail:
        `This request is authenticated by cookie and must carry a matching ` +
        `${CSRF.HEADER_NAME} header. Read it from the ${CSRF.COOKIE_NAME} cookie, ` +
        `or from the \`csrfToken\` field of GET /auth/session.`,
    });
  }
}

/**
 * The client context a rotation records on the child generation.
 *
 * `req.ip` rather than the socket address, because Fastify resolves it through
 * `trustProxy`. Duplicated from auth.routes.ts rather than shared: a guard cannot
 * import from a routes file without a cycle.
 *
 * `readDeviceKey`, not `deviceCookie` — the latter ISSUES a cookie when there is not a
 * valid one, and a guard must not mint browser identity as a side effect of checking a
 * token. See `readDeviceKey` for the whole argument, and `RefreshContext` for what a
 * null answer means.
 */
function contextOf(req: FastifyRequest): RefreshContext {
  return refreshContextOf(
    req.ip,
    headerValue(req.headers['user-agent']),
    readDeviceKey(req),
    // Read here, on the request, because only the request layer can see a header and
    // only `cloudflareCountry` knows whether this deployment may believe one.
    //
    // This is NOT a per-request country lookup. It is a header read costing one map
    // access, and the only thing that consumes it is `SessionDbOperation.rotate` — so
    // `sessions.country` ends up with one row per generation, matching `ip_class`,
    // rather than being rewritten on every authenticated call.
    cloudflareCountry(req.headers),
  );
}

/**
 * The body both guards share: resolve whatever credential is present, and stash the
 * principal on the request.
 *
 * Returns false for "no credential was offered" — which is the ONLY thing the two
 * guards disagree about, and so the only decision left to them. A credential that is
 * present but invalid throws from in here either way: "no credential" and "a bad
 * credential" are different, and only the first is ever a candidate for passing.
 *
 * ─── Two credential sources, cookie first ─────────────────────────────────
 *
 * The cookie is the browser's. The bearer is kept for callers that are not browsers —
 * a script, an integration test, a future service — and costs nothing to keep: the
 * token it carries is the same token the cookie resolves to, verified the same way.
 * Cookie first because a browser that has both is presenting the newer contract.
 *
 * A dead handle returns null from `resolve` and falls through to the bearer, which for
 * a browser is absent — so a session whose record is gone reads as "no credential" and
 * the mandatory guard answers `unauthenticated`. A session that is revoked rather than
 * merely gone throws its own slug from inside `resolve`, which is what lets a client
 * tell "sign in again" from "your session was ended elsewhere".
 *
 * ─── Why this takes a reply ───────────────────────────────────────────────
 *
 * Only to SLIDE the session cookie after a rotation — re-setting a cookie the browser
 * already has, with the same value and a fresh lifetime. It never mints one. That
 * distinction is the whole justification: this service has no absolute ceiling, so a
 * cookie set once at sign-in would silently become one. See `SessionCookie.slide`.
 */
async function authenticate(
  req: FastifyRequest & WithPrincipal,
  reply: FastifyReply,
  sessions: SessionService,
  bff: BffSessionService,
  countsAsActivity: boolean,
  tolerateDeadSession = false,
): Promise<boolean> {
  const handle = cookieValue(req, SESSION.COOKIE_NAME);

  // ═══ CSRF, BEFORE THE CREDENTIAL IS SPENT ════════════════════════════════
  //
  // Checked here rather than in one controller because the session cookie is
  // root-scoped: every mutating route is now a cookie-authenticated state change, so
  // every one of them needs the token. One place, and a new controller cannot forget
  // to opt in.
  //
  // BEFORE `bff.resolve`, deliberately. That call can rotate the refresh token, which
  // is a state change of its own — so a forged request must be refused before it can
  // cause one, and the assertion must not depend on the session resolving first.
  //
  // Only for the cookie, and only for unsafe methods. A bearer is not attached
  // ambiently, so there is no cross-site request to forge and demanding a token would
  // only break non-browser clients. A GET changes nothing.
  if (handle !== null && !SAFE_METHODS.has(req.method)) {
    assertCsrf(req, handle);
  }

  let claims;
  let lastUsedAt: Date | null = null;
  // Non-null once `assertLive` has returned — it refuses rather than answering null,
  // so `familyId` can key a security decision. Initialised to null only because the
  // `try` below may not reach the assignment at all.
  let familyId: string | null = null;
  try {
    const resolved = handle !== null ? await bff.resolve(handle, contextOf(req)) : null;
    const token =
      (resolved?.kind === 'session' ? resolved.accessToken : null) ??
      bearerFrom(req.headers.authorization);

    // ═══ THE STORE WAS UNREACHABLE, AND THAT IS NOT A 401 ══════════════════
    //
    // Only when there is no bearer to fall back on — a caller holding both a
    // cookie whose store is away and a valid bearer is authenticated by the bearer,
    // and should not be refused for the cookie.
    //
    // A 503 rather than the `unauthenticated` this used to answer, and the reason is
    // the same one `awaitHolder` gives: nothing has been learned about the session,
    // which is very probably fine. Telling the client to retry is honest; telling it
    // to sign in again is not — and on `GET /auth/session` the lie was compounded,
    // because `explainSessionEnd` labelled it SESSION_EXPIRED ("you have been logged
    // out due to inactivity") and the catch below then CLEARED THE COOKIES over a
    // Redis blip. That is the one thing this file works hardest to avoid: the handle
    // is the only value naming the session, so dropping it strands a live session
    // nobody can ever revoke. Found by curl, not by any unit test — every layer was
    // individually behaving as designed.
    if (token === null && resolved?.kind === 'unavailable') {
      throw new ProblemException({ type: ERR.SESSION_STORE_UNAVAILABLE });
    }

    if (token === null) return false;

    // Throws `token_invalid` for a refresh token presented here. One key signs both
    // types, so the separation is the pinned `aud` claim rather than the signature —
    // enforced inside `jwt.verify`, and re-asserted via `typ`. See jwt.ts.
    claims = verifyAccessToken(token);
    // Returns the session's stored activity instant, which `GET /auth/session`
    // reports, and the family every keyed decision below uses. Stashed next to the
    // principal so no route pays for a second read of a row this call already loaded.
    ({ lastUsedAt, familyId } = await sessions.assertLive(claims.sid));

    // The session's deadline just moved, so the cookie's has to move with it. Only on
    // the request that actually rotated, and only after `assertLive` has agreed the
    // session is live — extending the credential of a session we are about to refuse
    // would be exactly backwards.
    if (resolved?.kind === 'session' && resolved.rotated) sessionCookie(req, reply).slide();
  } catch (err) {
    // ═══ A DEAD SESSION IS "NO CREDENTIAL" FOR THE LOGOUT ROUTE ════════════
    //
    // Only `OptionalAuthGuard` passes `tolerateDeadSession`, and only the slugs in
    // `DEAD_SESSION_TYPES` are swallowed. Everything else — a forged CSRF token, a
    // malformed bearer, `session_store_unavailable`, an internal error — still throws
    // from both guards.
    //
    // Without it, logging out of a session that was already revoked or has already
    // expired answers 401 instead of succeeding, because the cookie is now what the
    // guard inspects. That is a REGRESSION the cookie introduces rather than a
    // pre-existing rule: before it, a browser sent no `Authorization` header on
    // logout, so `authenticate` found nothing, passed, and the controller cleaned up
    // idempotently. A repeated logout has to keep succeeding, and a user whose session
    // died while they were away must still end up signed out rather than stuck looking
    // at an error.
    //
    // It does not weaken `AuthGuard`: a protected route still refuses with the
    // specific reason, which is what lets a client tell "sign in again" from "your
    // session was ended elsewhere".
    if (!tolerateDeadSession || !isDeadSession(err)) throw err;
    return false;
  }

  // ═══ THE FAMILY IS PROVEN PRESENT BEFORE ANYTHING USES IT ════════════════
  //
  // Unreachable: `assertLive` refuses with `UNAUTHENTICATED` rather than answering a
  // null family, precisely so its callers need no null branch. This is the type-level
  // narrowing, with the same fail-closed answer.
  //
  // It matters that this is a THROW and not a skip. Everything below binds to
  // `familyId` — the activity write, and the principal that session-administration
  // quotas are keyed on — and there is no version of "carry on without it" that is
  // safe: skipping the key would drop a rate-limit boundary, and substituting
  // `claims.sid` would restore the bucket a client could reset by refreshing.
  if (familyId === null) throw new ProblemException({ type: ERR.UNAUTHENTICATED });

  // ═══ ACTIVITY ════════════════════════════════════════════════════════════
  //
  // Deliberately not awaited: this is bookkeeping for the idle timeout, and no request
  // should wait on a Redis round trip plus a write to record it. `touch` throttles
  // itself and swallows its own errors, so the floating promise can neither reject nor
  // slow anything down — see `SessionService.touch`.
  //
  // AFTER `assertLive`, so a revoked or expired session is refused rather than having
  // its own deadline slid — `touch`'s WHERE clause refuses that too, but ordering it
  // here means the refusal does not depend on the SQL being right.
  //
  // The FAMILY, not `claims.sid`. Activity belongs to the login, and this call is
  // fire-and-forget: it can land after a concurrent request has already rotated the
  // generation this token names, in which case a generation-keyed write would go to a
  // row the session has moved past.
  if (countsAsActivity) void sessions.touch(familyId);

  req[PRINCIPAL] = {
    userId: claims.sub,
    sessionId: claims.sid,
    publicCode: claims.pid,
    // Resolved from the row by `assertLive`, never claimed by the token.
    familyId,
  };
  // The value as it stood BEFORE this request's own `touch`, which is correct: the
  // write above is fire-and-forget and may not have landed, and reporting a timestamp
  // we only hope was written would be a guess. A poll of `GET /auth/session` never
  // touches anyway.
  req[ACTIVITY] = lastUsedAt;
  return true;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly bff: BffSessionService,
    private readonly reflector: Reflector,
    private readonly cache: CacheService,
  ) {}

  /**
   * Volume and shape, for one account.
   *
   * `allow` on a cache failure: this runs on every authenticated route, so denying
   * during a Redis outage would take the whole API down rather than degrade it — and
   * the limits that gate genuinely expensive work keep their own `deny`.
   */
  private async chargeAccountCeilings(principal: Principal): Promise<void> {
    const { GLOBAL } = policy();
    await this.cache.consume(
      KEYS.global.authedByAccount(principal.userId),
      GLOBAL.AUTHED_BY_ACCOUNT,
      'allow',
    );
    await this.cache.consume(
      KEYS.global.burstByAccount(principal.userId),
      GLOBAL.BURST_BY_ACCOUNT,
      'allow',
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Checked on the handler AND its controller, so `@Public()` works on a whole
    // controller as well as on one route.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Returning early rather than falling through to `authenticate`: a public route
    // must not reject a caller for holding a bad token it never asked for.
    if (isPublic === true) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest & WithPrincipal>();
    const reply = http.getResponse<FastifyReply>();

    try {
      if (
        !(await authenticate(
          req,
          reply,
          this.sessions,
          this.bff,
          countsAsActivity(this.reflector, context),
        ))
      ) {
        throw new ProblemException({ type: ERR.UNAUTHENTICATED });
      }

      // The per-account half of the global safety net, charged here rather than in
      // `SafetyNetGuard` because this is the first moment the account is a verified
      // fact rather than a claim in an unchecked token. See the note there.
      await this.chargeAccountCeilings(req[PRINCIPAL] as Principal);
      return true;
    } catch (err) {
      // ═══ THE ONE ROUTE WHOSE 401 IS AN ANSWER ══════════════════════════════
      //
      // Unmarked routes rethrow the identical object, so nothing about their refusals
      // changes. `GET /auth/session` gets the session state attached — the reason is
      // already in `err` (as a slug, or as `SessionEndedException`'s `messageCode`),
      // and this is the last place it exists before the filter renders a document
      // that has thrown it away.
      //
      // Read AFTER the throw rather than before, so an authenticated request pays
      // nothing for a metadata lookup it does not need.
      if (!explainsSessionState(this.reflector, context)) throw err;

      const handlePresent = cookieValue(req, SESSION.COOKIE_NAME) !== null;
      const explained = explainSessionEnd(err, handlePresent);

      // The handler sets this on the 200, but it never runs on this path — and an
      // answer about whether somebody is signed in must never be cached.
      void reply.header('cache-control', 'no-store');

      // Clear the stale session and CSRF cookies so the browser stops presenting them.
      // The case this exists for: a session that idled out leaves both cookies behind,
      // the user signs in again, and the login POST arrives carrying a CSRF cookie
      // bound to the OLD handle — which `assertCsrf` would refuse, on a request whose
      // whole purpose is to establish a new session. Left uncleared, that is a login
      // the user cannot complete without manually clearing cookies.
      //
      // Three conditions, each load-bearing:
      //   status === 401 only — a 503 `session_store_unavailable` must NOT clear. The
      //     handle is the only value naming this session, and dropping it would
      //     strand a live session nobody could ever revoke, over a Redis blip.
      //   handlePresent only — an anonymous poll should not emit two Set-Cookie
      //     headers on every request.
      //   the existing helper — `sessionCookie(req, reply).clear()` is the same path
      //     logout uses; no second cookie-clearing mechanism to keep in step.
      if (handlePresent && explained instanceof ProblemException && explained.status === 401) {
        sessionCookie(req, reply).clear();
      }
      throw explained;
    }
  }
}

/** `@ExplainsSessionState()` on the handler or its controller. */
function explainsSessionState(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean>(EXPLAINS_SESSION, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

/** `@NotActivity()` on the handler or its controller, inverted. */
function countsAsActivity(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean>(NOT_ACTIVITY, [
      context.getHandler(),
      context.getClass(),
    ]) !== true
  );
}

/**
 * Populates a principal when a valid credential is present, and passes when none is.
 *
 * Exists for `POST /auth/session`, whose logout actions must succeed even when the
 * session behind them is already gone: a repeated logout has to keep working, and a
 * mandatory guard would answer 401 to a user signing out of a session that expired
 * while they were away.
 *
 * Note what it does NOT do: a credential that is present but invalid still throws.
 * "No credential" and "a bad credential" are different, and only the first is allowed
 * through.
 *
 * ─── Why this guard does not touch `lastUsedAt` ─────────────────────────────
 *
 * Every route reachable through it is ending a session or partway through
 * establishing one, so there is no session whose idle window it would be correct to
 * slide. Counting logout as activity is harmless; counting a refresh as activity is
 * what made the idle timeout unenforceable in the other direction, and although
 * refresh no longer arrives as a request, the argument for never touching here has
 * not changed.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly bff: BffSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest & WithPrincipal>();
    const reply = http.getResponse<FastifyReply>();

    // `tolerateDeadSession`, because the route behind this guard is the one that must
    // work when the session is already over — see the note in `authenticate`.
    await authenticate(req, reply, this.sessions, this.bff, false, true);
    return true;
  }
}

/**
 * The principal on a route guarded by `AuthGuard`.
 *
 * Throws rather than returning `Principal | undefined` so a route cannot silently
 * proceed unauthenticated if someone removes the guard decorator. The throw is the
 * backstop for that mistake, and it is a 401 rather than a 500 because the only
 * way to reach it is an unauthenticated request.
 */
export function requirePrincipal(req: FastifyRequest): Principal {
  const principal = (req as FastifyRequest & WithPrincipal)[PRINCIPAL];
  if (principal === undefined) {
    throw new ProblemException({ type: ERR.UNAUTHENTICATED });
  }
  return principal;
}

/** The principal on a route guarded by `OptionalAuthGuard` — null when the caller
 *  offered no credential. */
export function optionalPrincipal(req: FastifyRequest): Principal | null {
  return (req as FastifyRequest & WithPrincipal)[PRINCIPAL] ?? null;
}

/**
 * The authenticated session's stored activity instant, for the route that reports it.
 *
 * Null rather than throwing when absent, unlike `requirePrincipal`: a missing
 * principal means the guard was removed and the route is now unauthenticated, which is
 * a bug worth a 401. A missing activity instant means the row was not read — the
 * cached-revocation fast path — which is an ordinary answer the contract allows for.
 */
export function sessionLastUsedAt(req: FastifyRequest): Date | null {
  return (req as FastifyRequest & WithPrincipal)[ACTIVITY] ?? null;
}
