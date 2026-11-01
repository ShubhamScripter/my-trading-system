import { randomBytes } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ELEVATION } from '../../auth/auth.constants';
import { requirePrincipal } from '../../auth/security/guards';
import { CacheService, KEYS } from '../../redis';
import { ERR } from '../contracts';
import { ProblemException } from '../http';

/**
 * ═══ PER-ACTION RE-AUTHENTICATION ══════════════════════════════════════════
 *
 * Every mutating request in the admin panel must carry a fresh second-factor
 * proof. This file is the whole mechanism: mint a ticket after a proof, spend it
 * on exactly one write.
 *
 * ─── Why a ticket and not a flag on the session ─────────────────────────────
 *
 * The obvious implementation is "mark the session elevated for N minutes". That is
 * a sudo WINDOW, not a per-action proof: one tap authorises every write until it
 * expires, so a stolen access token used inside a live window can write freely.
 *
 * A ticket is keyed on itself and read with `take`, which deletes as it reads. One
 * proof buys one write. The distinction is invisible in the happy path and is the
 * entire security difference.
 *
 * ─── Why the stored value is the LOGIN id AND the action ────────────────────
 *
 * The login id, so a ticket minted by one login cannot be spent by another that
 * obtained it — from a shared log, a proxy, or a second browser belonging to someone
 * else. Without this the ticket would be a bearer credential of its own.
 *
 * ═══ THE LOGIN, NOT THE REFRESH GENERATION ════════════════════════════════
 *
 * This was `principal.sessionId`, which is the refresh GENERATION id, and that was
 * F08. A generation is a disposable credential: the backend rotates it on its own
 * schedule, in the last thirty seconds of every fifteen-minute access token, with
 * nothing the client can observe or defer. A ticket lives sixty seconds. So a proof
 * and the write it authorised, separated by a rotation, no longer matched — and the
 * admin was told to prove a factor they had proved moments earlier.
 *
 * The binding is REPLACED rather than removed, and the distinction is the whole of
 * the fix. What a ticket represents is "this login proved a factor for this write",
 * so it binds to the login: `AdminSessionFamily.id`, constant from the three-factor
 * ceremony until the session ends. Two generations of one family are the same
 * browser and the same ceremony; two families are two logins and stay isolated,
 * which is the property the generation binding was there to protect and which the
 * cross-login test still pins.
 *
 * Revocation is unaffected because it was never enforced here. A ticket is only
 * reachable through `AuthGuard`, which calls `assertLive` and refuses a revoked,
 * logged-out or absolutely-expired session before any spend site runs. That ordering
 * is untouched.
 *
 * The ACTION, so a proof buys the write it was requested for and not a different
 * one. Without it the ticket is per-action only in the sense of being spent once:
 * an admin who taps their key intending to rename a factor holds, for the next
 * sixty seconds, a permit that would authorise deleting one — or anything a future
 * mutating route wears this guard on. The client names the action when it asks for
 * the ticket, and the ROUTE names the action when the ticket is spent, so the two
 * have to agree.
 *
 * Note what this is not: it is not authorisation. It does not decide whether this
 * admin may perform the action — that is the role check's job — only that the proof
 * in hand was given for this action. Scoping a proof and granting a permission are
 * different questions and this answers the first.
 *
 * Bound now rather than later on purpose. There are no mutating admin routes yet,
 * so the cost is one field; retrofitting it after there are means auditing every
 * call site to work out what each ticket was meant to buy.
 *
 * ─── Failure direction ──────────────────────────────────────────────────────
 *
 * Fail-closed at both ends, by two different mechanisms.
 *
 * Spending: `CacheService.take` catches its own Redis failure and returns null,
 * which lands in the same branch as "no such ticket" below and REFUSES the write
 * with `reauth_required`. Null rather than a throw is deliberate — it keeps the
 * client's answer typed and actionable ("prove a factor again") instead of an
 * untyped 500 that reads as "retry the same request".
 *
 * Minting: `cache.set(..., 'deny')` throws, so an outage refuses to hand out a
 * ticket rather than returning one that can never be redeemed.
 *
 * Both are the opposite of the captcha penalty's fail-open, and deliberately:
 * there, an outage degrades quota protection while the real defence (the provider
 * check) still runs; here the ticket IS the defence, so failing open would turn a
 * cache blip into an unguarded write surface.
 */
@Injectable()
export class ElevationService {
  private readonly logger = new Logger('Elevation');

  constructor(private readonly cache: CacheService) {}

  /**
   * Mint a ticket for ONE write of ONE action. Called only after a factor has been
   * re-proved.
   *
   * The token is returned to the caller and never stored in a form that can be
   * reversed to it — `KEYS.elevation.ticket` hashes it, the same way every other
   * caller-supplied secret is keyed.
   *
   * `action` is what the caller said they intended to do. It is stored, not
   * trusted: `spend` compares it against what the ROUTE says is happening, so a
   * client that names one action and calls another is refused.
   */
  async issue(
    familyId: string,
    action: string,
  ): Promise<{ ticket: string; expiresInSeconds: number; action: string }> {
    const ticket = randomBytes(ELEVATION.TICKET_BYTES).toString('base64url');

    // `deny`: a ticket we could not store is a ticket that can never be spent, so
    // returning one would hand the caller a credential guaranteed to be refused a
    // moment later. Refusing here reports the outage at the point it happened.
    await this.cache.set(
      KEYS.elevation.ticket(ticket),
      serialiseGrant({ familyId, action }),
      ELEVATION.TICKET_TTL_SECONDS,
      'deny',
    );

    this.logger.log({ familyId, action }, 'elevation ticket issued');
    return { ticket, expiresInSeconds: ELEVATION.TICKET_TTL_SECONDS, action };
  }

  /**
   * Spend a ticket on `action`, or refuse.
   *
   * `take` is a single `GETDEL`, so a ticket cannot be spent twice even by two
   * concurrent requests — the loser sees null. See redis/cache.ts.
   *
   * `action` comes from the route being executed, never from the request body. That
   * is what makes the binding meaningful: a caller who could name the action at
   * spend time could name whichever one their ticket happens to carry.
   */
  async spend(ticket: string | null, familyId: string, action: string): Promise<void> {
    return this.spendForAny(ticket, familyId, [action]);
  }

  /**
   * Spend a ticket that may have been proved for ANY ONE of `actions`.
   *
   * Exists for exactly one reason: the twelve factor actions on `POST /2fa` predate
   * `intent`, so a client that has not migrated asks for a proof without naming a
   * write and gets one bound to `ELEVATION_ANY`. Those four ticketed actions accept
   * either their own name or that sentinel.
   *
   * `ElevationGuard` deliberately does NOT use this — it calls `spend` with the one
   * action the route declared, so `ELEVATION_ANY` opens nothing on the surface that
   * does not exist yet. The compatibility is confined to what already shipped.
   *
   * Delete this method, and the sentinel, once the admin panel sends `intent`.
   */
  async spendForAny(
    ticket: string | null,
    familyId: string,
    actions: readonly string[],
  ): Promise<void> {
    if (ticket === null || ticket === '') {
      throw new ProblemException({
        type: ERR.REAUTH_REQUIRED,
        detail: 'This action needs a fresh second-factor proof. Obtain a ticket from POST /2fa.',
      });
    }

    const grant = parseGrant(await this.cache.take(KEYS.elevation.ticket(ticket)));

    // ONE answer for every way a ticket can be bad: no such ticket, already spent,
    // expired, belongs to another LOGIN, or was proved for a different action. A
    // caller holding a bad ticket learns nothing about which, and the legitimate
    // remedy is identical in every case — prove a factor again, for this action.
    //
    // Note the action mismatch is deliberately folded in here rather than given its
    // own error. Telling a caller "that ticket was for `remove`, not `rename`" would
    // confirm that a ticket they hold is live and what it is good for.
    if (grant === null || grant.familyId !== familyId || !actions.includes(grant.action)) {
      this.logger.warn(
        {
          familyId,
          wanted: actions,
          matched: grant !== null,
          // Logged so an operator can tell a benign client bug from an attempt to
          // reuse a proof across actions. Safe in a log — it is our own value, and
          // the ticket is already spent by the read above.
          grantedFor: grant?.action ?? null,
        },
        'elevation ticket refused',
      );
      throw new ProblemException({
        type: ERR.REAUTH_REQUIRED,
        detail: 'That proof is no longer valid for this action. Prove a second factor again.',
      });
    }
  }
}

/**
 * What a ticket grants: one LOGIN, one action.
 *
 * JSON rather than a delimited string. A session id is a UUID and an action is from
 * a closed set, so a separator would be safe today — but both values end up in one
 * cache entry, and a format that cannot be confused by a value containing the
 * delimiter is worth more than the bytes it costs. Same reasoning as the WebAuthn
 * challenge record in auth/security/passkey.ts, which does it the same way.
 */
interface ElevationGrant {
  /** `AdminSessionFamily.id` — the stable login, NOT the refresh generation. */
  readonly familyId: string;
  readonly action: string;
}

function serialiseGrant(grant: ElevationGrant): string {
  return JSON.stringify(grant);
}

/**
 * Read a grant back, or null.
 *
 * Null for anything unreadable, including the two shapes older deploys wrote: a bare
 * session id, and `{ sessionId, action }` from before the binding moved to the login.
 * That is the correct answer for a rolling deploy: a ticket minted by the previous
 * version is refused rather than half-understood, and the client's remedy — prove a
 * factor again — takes one tap and is what it would do for an expired ticket anyway.
 * Tickets live sixty seconds, so the window is one minute of one deploy.
 *
 * Note this is why the field was RENAMED rather than reinterpreted. Had `sessionId`
 * been kept as the key and quietly filled with a family id, a ticket in flight across
 * the deploy would have parsed and then been compared against the wrong kind of
 * identifier — which fails closed here, but only by accident. A rename makes the
 * old shape unparseable, which is a refusal by construction.
 */
function parseGrant(raw: string | null): ElevationGrant | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const { familyId, action } = parsed as Record<string, unknown>;
  if (typeof familyId !== 'string' || typeof action !== 'string') return null;
  if (familyId === '' || action === '') return null;

  return { familyId, action };
}

/** Read the ticket a request presented, from the header or nowhere. */
export function elevationTicketOf(req: FastifyRequest): string | null {
  const raw = req.headers[ELEVATION.HEADER_NAME];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Declare which action a route's elevation ticket must have been proved for.
 *
 * `@RequiresElevation('admin.settings.publish')` beside
 * `@UseGuards(ElevationGuard)`. The value is a stable identifier the client also
 * sends to `POST /2fa {action:'reauth-verify', intent:...}` when asking for the
 * ticket, so pick names and keep them: changing one is a client-visible change.
 *
 * Metadata on the HANDLER rather than an argument the guard reads from the body,
 * because the whole point is that the route decides. A guard that took the action
 * from the request would let a caller present whichever action their ticket carries.
 */
export const ELEVATION_ACTION = 'elevation:action';

/**
 * The "proved for no particular write" sentinel.
 *
 * A `reauth-verify` that omits `intent` binds to this. It is accepted only by the
 * four ticketed actions already on `POST /2fa` — see `elevatedFor` — and is refused
 * outright by `ElevationGuard`, so it cannot reach any future mutating route.
 *
 * A migration aid with a defined end: delete it, `spendForAny`, and the `?? `
 * fallback in the controller once the admin panel sends `intent`, and make the DTO
 * field required at the same time.
 */
export const ELEVATION_ANY = '*';

export const RequiresElevation = (action: string): MethodDecorator =>
  SetMetadata(ELEVATION_ACTION, action);

/**
 * The guard every FUTURE mutating admin route wears.
 *
 * `/2fa` does not use it — its credential varies per action in the body, so it
 * calls `ElevationService.spend` from the controller against
 * `TWO_FACTOR_REQUIRES` instead. Everything else — users, merchants, ledger
 * review — should be `@UseGuards(ElevationGuard)` plus `@RequiresElevation(...)`.
 *
 * It runs AFTER the global `AuthGuard`, so a principal is already present;
 * `requirePrincipal` throwing here would mean the guard was put on a `@Public()`
 * route, which is a wiring mistake rather than a client error.
 */
@Injectable()
export class ElevationGuard implements CanActivate {
  constructor(
    private readonly elevation: ElevationService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = requirePrincipal(req);

    const action = this.reflector.getAllAndOverride<string | undefined>(ELEVATION_ACTION, [
      context.getHandler(),
      context.getClass(),
    ]);

    // FAIL CLOSED on a missing declaration, and loudly. An un-annotated route would
    // otherwise have to be given some default action — and any default makes every
    // such route share one ticket namespace, which is precisely the property this
    // guard was changed to remove. A wiring mistake must not silently degrade to the
    // weaker behaviour it replaced.
    if (action === undefined || action === '') {
      throw new Error(
        'ElevationGuard is on a route with no @RequiresElevation(...) declaration. ' +
          'Name the action the ticket must have been proved for.',
      );
    }

    // And a route may not declare the sentinel. `ELEVATION_ANY` exists so the
    // twelve pre-existing factor actions keep working for an un-migrated client; a
    // route accepting it would reintroduce exactly the unscoped ticket this guard
    // was changed to prevent, on the surface that has not shipped yet.
    if (action === ELEVATION_ANY) {
      throw new Error(
        `@RequiresElevation('${ELEVATION_ANY}') is not permitted. Name a specific action — ` +
          'the sentinel is a migration aid for POST /2fa only.',
      );
    }

    // `familyId`, not `sessionId`: the ticket belongs to this LOGIN, and a
    // background token rotation must not invalidate it. See the header.
    await this.elevation.spend(elevationTicketOf(req), principal.familyId, action);
    return true;
  }
}
