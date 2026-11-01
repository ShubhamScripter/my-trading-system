import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { safeEqual } from '../../src/utils/public.utils';
import { CSRF, SESSION } from '../auth.constants';
import type { ClientContext, Principal } from '../auth.types';
import { clientContextOf, csrfTokenMatches, headerValue } from '../auth.utility';
import { AdminDbOperation } from '../persistence/admin.dboperation';
import { SessionService } from '../services/session.service';
import { BffSessionService } from './bff.session';
import { bearerFrom, verifyAccessToken } from './jwt';
import { explainSessionEnd } from './session.message';
import { cookieValue, sessionCookie } from './session.cookie';

/**
 * The enforcement point every other module's routes consume.
 *
 * Two checks, and both are necessary. The JWT signature proves the token was
 * minted here and has not expired; the session lookup proves it has not been
 * revoked since. A signature-only guard would keep honouring an access token for
 * its full fifteen minutes after a logout, a password reset, or a detected
 * refresh replay — which would make all three of those close to meaningless.
 *
 * `AuthGuard` is registered globally in src/app.module.ts, so it runs on every
 * route in the service and a new controller is authenticated the moment it is
 * wired up. Opting out is explicit and greppable — see `@Public()` below.
 *
 * ─── The browser presents a cookie; the token model is unchanged ───────────
 *
 * `authenticate` now resolves the `orebit_admin_session` cookie to a server-held
 * access token before falling back to an `Authorization` header. Everything after
 * that point is exactly what it was: the same signature check, the same session
 * lookup, the same `Principal`. What changed is only where the token was kept — see
 * security/bff.session.ts.
 */

/** Where the principal is stashed on the request. Symbol-keyed so it cannot
 *  collide with a body or query field named `principal`. */
const PRINCIPAL = Symbol('principal');

/**
 * The authenticated session's stored `lastActiveAt`, stashed beside the principal.
 *
 * Not a field ON the principal, deliberately. A principal is what the CREDENTIAL
 * says — three values read out of a verified JWT — and every consumer treats it that
 * way. This is a database fact with a different lifetime, read by `assertLive` on the
 * way past, and only `GET /auth/session` wants it.
 *
 * Stashed rather than re-queried because `assertLive` has already read the row: the
 * alternative is a second primary-key lookup per poll for a value we were holding.
 */
const ACTIVITY = Symbol('lastActiveAt');

/**
 * The authenticated session's STABLE family id, stashed beside the activity instant
 * for the route that reports it.
 *
 * ═══ THIS USED TO SAY THE OPPOSITE, AND THAT WAS F08 ═══════════════════════
 *
 * It read: "elevation tickets, reauth challenges and reauth rate limits are all
 * keyed on the generation, and quietly redefining that would change how long an MFA
 * elevation survives."
 *
 * All three were, and the consequence was not a design property but a defect.
 * Rotation is automatic, unprompted and invisible to the client — it happens in the
 * last thirty seconds of every fifteen-minute access token — while a ticket lives
 * sixty seconds. So a proof-then-write straddling a rotation was refused, and the
 * admin was told to prove a factor they had just proved. Worse, the rate-limit
 * bucket `rate:reauth:login` was keyed on it too, so forcing a rotation RESET the
 * guess budget: "three attempts per session" actually meant three per generation.
 *
 * "How long an MFA elevation survives" was exactly right as a description. It was
 * surviving until the next background refresh, which is not a security boundary
 * anyone chose. All four are keyed on the family now, and `Principal` carries it —
 * see `Principal.familyId` for why it is resolved rather than claimed.
 *
 * This symbol remains only because `GET /auth/me` reads it through
 * `sessionFamilyId` without needing a principal. The authoritative copy for
 * authorisation is on the principal.
 */
const FAMILY = Symbol('familyId');

const IS_PUBLIC = Symbol('isPublic');

const IS_NOT_ACTIVITY = Symbol('isNotActivity');

const EXPLAINS_SESSION = Symbol('explainsSessionState');

/**
 * Exempts a route from the global `AuthGuard`.
 *
 * The direction here is the point. Guarding used to be opt-in in services built
 * this way, one `@UseGuards(AuthGuard)` at a time, which meant a forgotten
 * decorator on a future route published it to the internet and nothing anywhere
 * would say so. Now the omission fails closed: forget `@Public()` on a route that
 * should be open and it returns 401 the first time anyone calls it, which is a bug
 * that reports itself.
 *
 * That matters more in an admin service than in a consumer one — every route here
 * is a privileged operation by default, so the failure mode of the inverse policy
 * is an unauthenticated door into platform administration.
 *
 * Every use is a deliberate statement that the route is safe unauthenticated, and
 * `grep -rn "@Public()"` is the audit.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/**
 * Marks a route whose traffic must NOT count as activity.
 *
 * The idle window exists to end a session nobody is using. Anything a CLIENT does
 * on its own schedule — polling `GET /auth/session`, a health check, a prefetch — is
 * the application talking to itself, and counting it as activity means an abandoned
 * tab holds an admin session open indefinitely. The spec says so explicitly:
 * background polling and token refresh do not count.
 *
 * Opt-out rather than opt-in, deliberately, and the direction matches `@Public()`:
 * a route that forgets this slides the window slightly too eagerly, which is a small
 * bug. A route that had to opt IN and forgot would not slide it at all, and an admin
 * actively working would be signed out mid-task — which is the failure this whole
 * mechanism exists to prevent.
 *
 * Taken from the consumer backend, which reached the same design.
 */
export const NotActivity = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_NOT_ACTIVITY, true);

/**
 * Marks the route whose 401 must say WHICH of the five session states explains it.
 *
 * ═══ WHY THIS IS A MARKER AND NOT THE DEFAULT ══════════════════════════════
 *
 * `GET /auth/session` exists to report authentication state, so its refusal is an
 * ANSWER rather than an error, and it carries `extra.message` for a frontend to
 * switch on — see security/session.message.ts.
 *
 * Every other route's 401 is unchanged, byte for byte, and that is the point of
 * opting in rather than enriching every refusal the guard throws. A business route
 * that started reporting session state in its errors would be a wider contract
 * change than this requirement asks for, and the reason a client needs is already
 * the `type` slug there.
 *
 * `grep -rn "@ExplainsSessionState()"` is the audit, and it should find exactly one
 * route.
 */
export const ExplainsSessionState = (): MethodDecorator & ClassDecorator =>
  SetMetadata(EXPLAINS_SESSION, true);

interface WithPrincipal {
  [PRINCIPAL]?: Principal;
  [ACTIVITY]?: Date | null;
  [FAMILY]?: string | null;
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
 * The cookie is the browser's. The bearer is kept for callers that are not browsers
 * — a script, an integration test, a future service — and costs nothing to keep: the
 * token it carries is the same token the cookie resolves to, verified the same way.
 * Cookie first because a browser that has both is presenting the newer contract.
 *
 * A dead handle returns null from `resolve` and falls through to the bearer, which
 * for a browser is absent — so an expired session reads as "no credential" and the
 * mandatory guard answers `unauthenticated`. A session that is revoked rather than
 * merely gone throws its own slug from inside `resolve`, which is what lets the
 * client tell "sign in again" from "your session was ended elsewhere".
 */
async function authenticate(
  req: FastifyRequest & WithPrincipal,
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
  // Only for the cookie, and only for unsafe methods. A bearer is not attached
  // ambiently, so there is no cross-site request to forge and demanding a token would
  // only break non-browser clients. A GET changes nothing.
  if (handle !== null && !SAFE_METHODS.has(req.method)) {
    assertCsrf(req, handle);
  }

  let claims;
  let lastActiveAt: Date | null = null;
  // Non-null once `assertLive` has returned — it refuses rather than answering null,
  // so `familyId` can key a security decision. Initialised to null only because the
  // `try` below may not reach the assignment at all.
  let familyId: string | null = null;
  try {
    const token =
      (handle !== null ? await bff.resolve(handle, contextOf(req)) : null) ??
      bearerFrom(req.headers.authorization);
    if (token === null) return false;

    // Throws `token_invalid` for a refresh token presented here. One key signs both
    // types, so the separation is the pinned `aud` claim rather than the signature —
    // enforced inside `jwt.verify`, and re-asserted via `typ`. See jwt.ts.
    claims = verifyAccessToken(token);
    // Returns the session's stored activity instant, which `GET /auth/session`
    // reports. Stashed below, next to the principal, so no route pays for a second
    // read of a row this call already loaded.
    ({ lastActiveAt, familyId } = await sessions.assertLive(claims.sid));
  } catch (err) {
    // ═══ A DEAD SESSION IS "NO CREDENTIAL" FOR THE LOGOUT ROUTES ═══════════
    //
    // Only `OptionalAuthGuard` passes `tolerateDeadSession`, and only these four
    // slugs are swallowed. Everything else — a forged CSRF token, a malformed
    // bearer, an internal error — still throws from both guards.
    //
    // Without it, logging out of a session that was already revoked or has already
    // expired answers 401 instead of succeeding, because the cookie is now what the
    // guard inspects. That is a REGRESSION the cookie introduced rather than a
    // pre-existing rule: before it, a browser sent no `Authorization` header on
    // logout, so `authenticate` found nothing, passed, and the controller cleaned up
    // idempotently. The spec requires a repeated logout to succeed, and an admin
    // whose session died while they were away must still end up signed out rather
    // than stuck looking at an error.
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
  // null family, precisely so its callers need no null branch. This is the
  // type-level narrowing, with the same fail-closed answer.
  //
  // It matters that this is a THROW and not a skip. Everything below binds to
  // `familyId` — the activity write, and the principal that elevation tickets and
  // reauth challenges are checked against — and there is no version of "carry on
  // without it" that is safe: skipping the authorisation key would drop a security
  // boundary, and substituting `claims.sid` would reintroduce F08.
  if (familyId === null) throw new ProblemException({ type: ERR.UNAUTHENTICATED });

  // ═══ ACTIVITY ════════════════════════════════════════════════════════════
  //
  // Floating on purpose: no request should wait on a Redis round trip plus a write
  // to record that it happened. `touch` throttles itself and swallows its own
  // errors, so this promise can neither reject nor slow anything down.
  //
  // AFTER `assertLive`, so a revoked or expired session is refused rather than
  // having its own deadline slid — `touch`'s WHERE clause refuses that too, but
  // ordering it here means the refusal does not depend on the SQL being right.
  //
  // The FAMILY, not `claims.sid`. Activity belongs to the login, and this call is
  // fire-and-forget: it can land after a concurrent request has already rotated the
  // generation this token names, in which case a generation-keyed write would go to
  // a row the session has moved past. `assertLive` just resolved the family id from
  // the row, so this costs nothing.
  if (countsAsActivity) void sessions.touch(familyId);

  req[PRINCIPAL] = {
    adminId: claims.sub,
    sessionId: claims.sid,
    // Resolved from the row by `assertLive`, never from the request. This is the
    // value per-action authorisation binds to — see `Principal.familyId`.
    familyId,
    role: claims.rol,
  };
  // The value as it stood BEFORE this request's own `touch`, which is correct: the
  // write above is fire-and-forget and may not have landed, and reporting a timestamp
  // we only hope was written would be a guess. A poll of `GET /auth/session` never
  // touches anyway.
  req[ACTIVITY] = lastActiveAt;
  req[FAMILY] = familyId;
  return true;
}

/** Methods that cannot change state, and so need no CSRF token. `HEAD` and
 *  `OPTIONS` are here because the browser issues them on its own. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * "This session is over" — as opposed to "this request is malformed".
 *
 * The four slugs a session can end with, listed explicitly rather than matched on a
 * 401 status, so that a future 401 for a different reason is not silently swallowed
 * by the logout routes.
 */
const DEAD_SESSION_TYPES: ReadonlySet<string> = new Set([
  ERR.SESSION_REVOKED,
  // The idle-timeout counterpart of the above. Omitting it would make logout answer
  // 401 for a session that timed out while the admin was away — which is the exact
  // regression the revoked case was added to fix, and the commonest way to reach
  // logout at all.
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
 *     cannot READ it to populate the header, because reading it cross-origin is
 *     what the same-origin policy forbids.
 *
 *  2. that value was minted by us, FOR THIS SESSION HANDLE.
 *
 * Check 1 alone is what this used to be, and it is satisfiable without ever reading
 * anything. Cookie WRITES are governed by a weaker rule than reads: any sibling
 * subdomain can set a cookie on the parent domain. Anything that can emit a
 * `Set-Cookie` for `.orebit.io` plants a value it already knows in
 * `orebit_admin_csrf`, echoes the same value in the header, and both halves agree —
 * while the admin's own session cookie authenticates the request.
 *
 * Check 2 is what that attacker cannot do: forging a token means producing an HMAC
 * over a handle they cannot read, keyed by a pepper they do not have. See
 * `generateCsrfToken`.
 *
 * `safeEqual` rather than `===` throughout. The comparison is against a value the
 * caller supplies a guess for, which is the condition the rest of this codebase uses
 * to decide between the two — see the note in auth/auth.utility.ts.
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
    // caller's business, and for a legitimate client the remedy is identical:
    // read the cookie, send the header.
    throw new ProblemException({
      type: ERR.FORBIDDEN,
      detail:
        `This request is authenticated by cookie and must carry a matching ` +
        `${CSRF.HEADER_NAME} header. Read it from the ${CSRF.COOKIE_NAME} cookie.`,
    });
  }
}

/**
 * The client context a rotation records on the child generation.
 *
 * `req.ip` rather than the socket address, because Fastify resolves it through
 * `trustProxy`. Duplicated from auth.routes.ts rather than shared: a guard cannot
 * import from a routes file without a cycle, and the alternative is a third module
 * for three lines.
 */
function contextOf(req: FastifyRequest): ClientContext {
  return clientContextOf(
    req.ip,
    headerValue(req.headers['user-agent']),
    headerValue(req.headers['accept-language']),
  );
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly bff: BffSessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Checked on the handler AND its controller, so `@Public()` works on a whole
    // controller as well as on one route.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Returning early rather than falling through to `authenticate`: a public
    // route must not reject a caller for holding a bad token it never asked for.
    if (isPublic === true) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest & WithPrincipal>();

    try {
      if (
        !(await authenticate(
          req,
          this.sessions,
          this.bff,
          countsAsActivity(this.reflector, context),
        ))
      ) {
        throw new ProblemException({ type: ERR.UNAUTHENTICATED });
      }
      return true;
    } catch (err) {
      // ═══ THE ONE ROUTE WHOSE 401 IS AN ANSWER ══════════════════════════════
      //
      // Unmarked routes rethrow the identical object, so nothing about their
      // refusals changes. `GET /auth/session` gets the session state attached — the
      // reason is already in `err` (as a slug, or as `SessionEndedException`'s
      // `messageCode`), and this is the last place it exists before the filter
      // renders a document that has thrown it away.
      //
      // Read AFTER the throw rather than before, so an authenticated request pays
      // nothing for a metadata lookup it does not need.
      if (!explainsSessionState(this.reflector, context)) throw err;

      const reply = context.switchToHttp().getResponse<FastifyReply>();
      const handlePresent = cookieValue(req, SESSION.COOKIE_NAME) !== null;
      const explained = explainSessionEnd(err, handlePresent);

      // F15: the handler sets this on the 200, but it never runs on this path.
      void reply.header('cache-control', 'no-store');

      // F14: clear the stale session and CSRF cookies so the browser does not
      // present them on the next login's POST /2fa, where the CSRF check would
      // reject a cookie-authenticated request whose ceremony never set a token.
      //
      // Three conditions, each load-bearing:
      //   status === 401 only — a 503 `session_store_unavailable` must NOT clear;
      //     the cookie is the only value naming the family, and dropping it would
      //     strand a live session nobody could ever revoke.
      //   handlePresent only — an anonymous poll should not emit two Set-Cookie
      //     headers on every request.
      //   Existing helper — sessionCookie(req, reply).clear() is the same path
      //     logout uses; no second cookie-clearing mechanism.
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
    reflector.getAllAndOverride<boolean>(IS_NOT_ACTIVITY, [
      context.getHandler(),
      context.getClass(),
    ]) !== true
  );
}

/**
 * Populates a principal when a valid credential is present, and passes when none is.
 *
 * Exists for `POST /auth/session`, whose logout actions must succeed even when the
 * session behind them is already gone — the spec requires a repeated logout to
 * succeed, and a mandatory guard would answer 401 to an admin signing out of a
 * session that expired while they were away. It is also what `POST /2fa` needs,
 * where the credential varies by action.
 *
 * Never counts as activity. Every route reachable through this guard is either
 * ending a session or partway through establishing one, so there is no session whose
 * idle window it would be correct to slide.
 *
 * Note what it does NOT do: a bearer that is present but invalid still throws.
 * "No credential" and "a bad credential" are different, and only the first is
 * allowed through.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly bff: BffSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest & WithPrincipal>();

    // `tolerateDeadSession`, because the routes behind this guard are the ones that
    // must work when the session is already over — see the note in `authenticate`.
    await authenticate(req, this.sessions, this.bff, false, true);
    return true;
  }
}

/**
 * The principal on a route guarded by `AuthGuard`.
 *
 * Throws rather than returning `Principal | undefined` so a route cannot silently
 * proceed unauthenticated if someone removes the guard decorator. The throw is
 * the backstop for that mistake, and it is a 401 rather than a 500 because the
 * only way to reach it is an unauthenticated request.
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
 * principal means the guard was removed and the route is now unauthenticated, which
 * is a bug worth a 401. A missing activity instant means the row was not read — the
 * cached-revocation fast path — which is an ordinary answer the contract already
 * allows for.
 */
export function sessionLastActiveAt(req: FastifyRequest): Date | null {
  return (req as FastifyRequest & WithPrincipal)[ACTIVITY] ?? null;
}

/**
 * The STABLE identity of this browser login — the session family, constant across
 * every refresh rotation. Null when the row was not read, on the same terms as
 * `sessionLastActiveAt`.
 *
 * `GET /auth/me` reports this rather than `principal.sessionId`. The field it fills
 * exists so a panel can mark which row in a session list is "this device", and a
 * generation id could never answer that: it changes every time the backend refreshes
 * tokens in the background, which is roughly every fifteen minutes and never at a
 * moment the client can observe.
 */
export function sessionFamilyId(req: FastifyRequest): string | null {
  return (req as FastifyRequest & WithPrincipal)[FAMILY] ?? null;
}

/**
 * SUPER_ADMIN only, decided against a FRESHLY-READ database row.
 *
 * ═══ WHY THE ROLE IS NOT TAKEN FROM THE TOKEN ══════════════════════════════
 *
 * `Principal` carries a `rol` claim, and reading it here would be one line and no
 * query. It would also be wrong: an access token lives fifteen minutes, so an admin
 * demoted from SUPER_ADMIN would keep this reach until their current token expired.
 * `GET /auth/me` re-reads for the same reason, and so does `AdminsService`.
 *
 * The actor's own `status` is checked too. A disabled account — or one the lockout
 * ladder has put under manual review, which sets `DISABLED` — must not still be
 * administering the platform on a token minted moments before.
 *
 * ─── Why this is a guard and `AdminsService.authorise` is not ──────────────
 *
 * That method answers a bigger question: it also refuses self-targeting per action
 * and resolves the TARGET admin, so it needs the request body and returns a row.
 * This guard answers only "may this caller be here at all", which is route-level and
 * has no body to read — the same split as `AuthGuard` versus a service's own checks.
 *
 * Pairs with `@UseGuards(ElevationGuard)` and `@RequiresElevation(...)` on writes:
 * this decides WHO, that decides WHAT THEY JUST PROVED. Neither substitutes for the
 * other, and a mutating route wants both.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly admins: AdminDbOperation) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    // Runs AFTER the global `AuthGuard`, so a principal is already present.
    // `requirePrincipal` throwing here means this guard was put on a `@Public()`
    // route, which is a wiring mistake rather than a client error.
    const actor = requirePrincipal(req);

    const self = await this.admins.findById(actor.adminId);
    if (self === null || self.status !== 'ACTIVE') {
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }

    if (self.role !== 'SUPER_ADMIN') {
      throw new ProblemException({
        type: ERR.FORBIDDEN,
        detail: 'Only a super admin may perform this action.',
      });
    }

    return true;
  }
}
