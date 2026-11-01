import { randomBytes } from 'node:crypto';
import { CanActivate, ExecutionContext, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ELEVATION } from '../../auth/auth.constants';
import { policy } from '../../auth/limits';
import { requirePrincipal } from '../../auth/security/guards';
import { CacheService, KEYS } from '../../redis';
import { ERR } from '../contracts';
import { ProblemException } from '../http';

/**
 * ═══ PER-ACTION RE-AUTHENTICATION ══════════════════════════════════════════
 *
 * Some writes need a fresh proof rather than merely a live session. This file is
 * the whole mechanism: mint a ticket after a proof, spend it on exactly one write.
 *
 * Ported from Orebit-admin-backend/src/2fa/elevation.ts. The admin panel wears this
 * on every mutating route because everything an admin does is sensitive; here it
 * guards the short list of writes that create or destroy a way into the account.
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
 * ─── Why the stored value is the session id AND the action ──────────────────
 *
 * The session id, so a ticket minted by one session cannot be spent by another that
 * obtained it — from a shared log, a proxy, or a second tab belonging to someone
 * else. Without this the ticket would be a bearer credential of its own.
 *
 * The ACTION, so a proof buys the write it was requested for and not a different
 * one. Without it the ticket is per-action only in the sense of being spent once:
 * someone who proved a factor intending to link a Google account holds, for the
 * next sixty seconds, a permit that would authorise deleting their authenticator.
 * The client names the action when it asks for the ticket, and the ROUTE names the
 * action when the ticket is spent, so the two have to agree.
 *
 * Note what this is not: it is not authorisation. It does not decide whether this
 * user may perform the action, only that the proof in hand was given for it.
 *
 * ─── Failure direction ──────────────────────────────────────────────────────
 *
 * Fail-closed at both ends, by two different mechanisms.
 *
 * Spending: `CacheService.take` throws on a Redis failure, and the guard lets that
 * surface rather than treating an outage as a pass. Minting: `cache.set` throws for
 * the same reason, so an outage refuses to hand out a ticket rather than returning
 * one that can never be redeemed.
 *
 * Both are the opposite of the captcha penalty's fail-open, and deliberately:
 * there, an outage degrades quota protection while the real defence (the provider
 * check) still runs; here the ticket IS the defence, so failing open would turn a
 * cache blip into an unguarded write surface.
 */

/**
 * The actions a ticket can be proved for.
 *
 * A closed union rather than free strings, because the client names one when it
 * asks and the route names one when it spends, and a typo on either side would
 * otherwise be a ticket that silently never matches — or, worse, one that matches
 * something it should not.
 */
export const ELEVATION_ACTIONS = [
  /** Attach a third-party provider to this account. The reason this exists: a
   *  link outlives a password change, a session sweep and an email change. */
  'account.oauth.link',
  /** Enrol a new factor. Elevated so that someone holding a stolen access token
   *  cannot quietly add an authenticator of their own. */
  'account.mfa.enroll',
  /** Remove a factor, or regenerate the recovery codes. */
  'account.mfa.remove',
  /**
   * Attach a third-party provider from Settings → Social accounts.
   *
   * Its OWN action rather than reusing `account.oauth.link`, and the difference is
   * the proof policy rather than the write. This one demands an emailed code
   * ALWAYS, accepts either enrolled factor, and — on an account with nothing
   * enrolled — accepts the emailed code alone. `account.oauth.link` demands no
   * emailed code and falls back to the account password.
   *
   * Two actions is what keeps those two policies from having to be one. Reusing
   * the existing action would have meant changing `emailCodeRequiredFor`, which is
   * read by `reauthVerify` and would have altered `POST /auth/link` — a flow this
   * release does not otherwise touch.
   *
   * Its ceremony lives in `src/settings/link-accounts/`, NEVER in `reauthVerify` —
   * see `REAUTH_INTENTS` below for what enforces that.
   */
  'account.social.link',
  /**
   * Schedule the removal of a linked provider from Settings → Social accounts.
   *
   * Separate from `account.social.link` even though the two share a proof policy
   * and a `/verify` route, because a ticket is a permit for one write and these
   * are opposite writes. `ElevationService.spend` compares the action, so this one
   * line is the whole of the isolation: a ticket proved for the link cannot
   * authorise the unlink, and neither can the reverse.
   *
   * Absent from `REAUTH_INTENTS` for exactly `account.social.link`'s reason — the
   * emailed code is owed on every path here too.
   */
  'account.social.unlink',
  /**
   * Delete the account, from Settings → Delete account.
   *
   * The most destructive write in the service, and the only one whose effect the
   * caller cannot reverse from the session that made it — deletion revokes every
   * session it has, including the one that asked. So the proof is spent on this
   * action and no other.
   *
   * ─── Why it is not folded into a factor action ──────────────────────────────
   *
   * `account.mfa.remove` is the nearest thing by blast radius and is still not close:
   * removing a factor leaves an account, and a user who is talked into proving one
   * loses a credential rather than everything. A ticket earned for a factor change
   * must not be spendable here, and the comparison in `spend` is what guarantees it.
   *
   * Absent from `REAUTH_INTENTS` for both `account.social.*` actions' reason: the
   * emailed code is owed on every path, and `reauthVerify` would fall back to the
   * account password on an account with no factor enrolled. A password is the one
   * proof a deletion must not accept alone — it is the credential most likely to be
   * already compromised in the case this ceremony exists to stop.
   */
  'account.delete',
] as const;

export type ElevationAction = (typeof ELEVATION_ACTIONS)[number];

/**
 * The subset a client may name at `POST /auth/2fa {action:'reauth-verify'}`.
 *
 * ─── Why this exists, and why it is not just `ELEVATION_ACTIONS` ────────────
 *
 * `reauthVerify` applies ONE policy to whatever action it is handed: an emailed
 * code for the two `account.mfa.*` intents, and the account password as the proof
 * when no factor is enrolled. That policy is right for the three actions listed
 * here and WRONG for both `account.social.*` actions, which owe an emailed code on
 * every path and owe nothing further when no factor exists.
 *
 * So the enum a client may name is narrower than the set of actions that exist. A
 * request naming either social action here is refused by `parseDto` before any
 * ticket is minted — otherwise a caller could obtain a ticket for the Settings
 * write while skipping the emailed code that write requires.
 *
 * Note this is the SAME three values the route accepted before the social actions
 * were added, so the wire contract is unchanged.
 */
export const REAUTH_INTENTS = [
  'account.oauth.link',
  'account.mfa.enroll',
  'account.mfa.remove',
] as const satisfies readonly ElevationAction[];

export function isElevationAction(value: string): value is ElevationAction {
  return (ELEVATION_ACTIONS as readonly string[]).includes(value);
}

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
    sessionId: string,
    action: ElevationAction,
  ): Promise<{ ticket: string; expiresInSeconds: number; action: ElevationAction }> {
    await this.cache.consume(
      KEYS.rate.elevationIssuedBySession(sessionId),
      policy().MFA.ELEVATION_ISSUED_BY_SESSION,
      'deny',
    );
    const ticket = randomBytes(ELEVATION.TICKET_BYTES).toString('base64url');

    // A ticket we could not store is a ticket that can never be spent, so returning
    // one would hand the caller a credential guaranteed to be refused a moment
    // later. `cache.set` throws on failure, which reports the outage where it
    // happened.
    await this.cache.set(
      KEYS.elevation.ticket(ticket),
      serialiseGrant({ sessionId, action }),
      policy().MFA.ELEVATION_TICKET_TTL_SECONDS,
    );

    this.logger.log({ sessionId, action }, 'elevation ticket issued');
    return { ticket, expiresInSeconds: policy().MFA.ELEVATION_TICKET_TTL_SECONDS, action };
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
  async spend(ticket: string | null, sessionId: string, action: ElevationAction): Promise<void> {
    if (ticket === null || ticket === '') {
      throw new ProblemException({
        type: ERR.REAUTH_REQUIRED,
        detail: 'This action needs a fresh second-factor proof. Obtain a ticket from POST /auth/2fa.',
        // Named so a client can request the right ticket without guessing, and
        // without having to hardcode the mapping from route to action.
        extra: { action },
      });
    }

    const grant = parseGrant(await this.cache.take(KEYS.elevation.ticket(ticket)));

    // ONE answer for every way a ticket can be bad: no such ticket, already spent,
    // expired, belongs to another session, or was proved for a different action. A
    // caller holding a bad ticket learns nothing about which, and the legitimate
    // remedy is identical in every case — prove a factor again, for this action.
    //
    // The action mismatch is deliberately folded in here rather than given its own
    // error. Telling a caller "that ticket was for `remove`, not `link`" would
    // confirm that a ticket they hold is live and what it is good for.
    if (grant === null || grant.sessionId !== sessionId || grant.action !== action) {
      this.logger.warn(
        {
          sessionId,
          wanted: action,
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
        extra: { action },
      });
    }
  }
}

/**
 * What a ticket grants: one session, one action.
 *
 * JSON rather than a delimited string. A session id is a UUID and an action is from
 * a closed set, so a separator would be safe today — but both values end up in one
 * cache entry, and a format that cannot be confused by a value containing the
 * delimiter is worth more than the bytes it costs.
 */
interface ElevationGrant {
  readonly sessionId: string;
  readonly action: ElevationAction;
}

function serialiseGrant(grant: ElevationGrant): string {
  return JSON.stringify(grant);
}

/** Read a grant back, or null for anything unreadable. Tickets live sixty seconds,
 *  so a format change costs at most one minute of one deploy. */
function parseGrant(raw: string | null): ElevationGrant | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const { sessionId, action } = parsed as Record<string, unknown>;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (typeof action !== 'string' || !isElevationAction(action)) return null;

  return { sessionId, action };
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
 * `@RequiresElevation('account.oauth.link')` beside `@UseGuards(ElevationGuard)`.
 * The value is the same identifier the client sends to
 * `POST /auth/2fa {action:'reauth-verify', intent:...}` when asking for the ticket,
 * so it is a client-visible contract — changing one is a breaking change.
 *
 * Metadata on the HANDLER rather than an argument the guard reads from the body,
 * because the whole point is that the route decides. A guard that took the action
 * from the request would let a caller present whichever action their ticket carries.
 */
export const ELEVATION_ACTION = 'elevation:action';

export const RequiresElevation = (action: ElevationAction): MethodDecorator =>
  SetMetadata(ELEVATION_ACTION, action);

/**
 * The guard every re-authenticated write wears.
 *
 * `POST /auth/2fa` does not use it — its credential varies per action in the body,
 * so it calls `ElevationService.spend` from the controller against
 * `TWO_FACTOR_REQUIRES` instead. Everything else is `@UseGuards(ElevationGuard)`
 * plus `@RequiresElevation(...)`.
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

    const action = this.reflector.getAllAndOverride<ElevationAction | undefined>(ELEVATION_ACTION, [
      context.getHandler(),
      context.getClass(),
    ]);

    // FAIL CLOSED on a missing declaration, and loudly. An un-annotated route would
    // otherwise need some default action — and any default makes every such route
    // share one ticket namespace, which is precisely the property this guard exists
    // to remove. A wiring mistake must not silently degrade to the weaker behaviour.
    if (action === undefined) {
      throw new Error(
        'ElevationGuard is on a route with no @RequiresElevation(...) declaration. ' +
          'Name the action the ticket must have been proved for.',
      );
    }

    await this.elevation.spend(elevationTicketOf(req), principal.sessionId, action);
    return true;
  }
}
