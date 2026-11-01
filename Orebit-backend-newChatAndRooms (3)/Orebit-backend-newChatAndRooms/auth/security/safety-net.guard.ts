import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CacheService, KEYS } from '../../redis';
import { SESSION } from '../auth.constants';
import { policy } from '../limits';
import { bearerFrom } from './jwt';
import { cookieValue } from './session.cookie';

/**
 * ═══ THE GLOBAL SAFETY NET ══════════════════════════════════════════════════
 *
 * The outermost ceiling, and the only limit in the service that is not about any
 * particular endpoint.
 *
 * ─── Why per-endpoint limits are not enough on their own ────────────────────
 *
 * Every per-endpoint quota answers "how much of THIS may one caller do". None of them
 * answers "how much may one caller do at all", and the difference is the whole reason
 * this exists. A caller who spreads traffic across register, login, otp-request,
 * oauth-start and the 2FA routes stays under every individual limit while making more
 * requests than any of them contemplated. Worse, a route added tomorrow has no limit
 * until someone remembers to give it one — and the failure mode of forgetting is
 * silent.
 *
 * This runs before all of them, so the answer to "what bounds the endpoint nobody
 * metered" stops being "nothing".
 *
 * ─── Why authenticated traffic gets its own, higher ceiling ─────────────────
 *
 * Because the two populations are shaped differently and one number cannot serve
 * both. Unauthenticated traffic from one IP is, at most, a few people signing in.
 * Authenticated traffic from one IP is an entire office behind a NAT, each with an
 * app making ordinary requests — so the unauthenticated ceiling applied there would
 * take the building offline. Conversely, an account is one person: 120 requests a
 * minute is far above what a human generates and far below what a runaway client
 * does.
 *
 * ─── Why a ten-second bucket as well as a minute ────────────────────────────
 *
 * The minute bucket bounds VOLUME; this bounds SHAPE. A caller may spend an entire
 * minute's allowance in one second and then idle, which is indistinguishable from a
 * broken retry loop and nothing like a person using an app. Two windows separate
 * them: a burst of concurrent tabs passes both, a spin fails the short one
 * immediately rather than a minute later.
 *
 * ─── Why this guard only meters the IP, and AuthGuard meters the account ────
 *
 * This has to run BEFORE authentication — a caller flooding with junk tokens must be
 * refused before it costs a signature verification, and `AuthGuard` throws 401 long
 * before any limiter it ran after would see the request.
 *
 * But at that point nobody has verified anything, so the only account identity
 * available is whatever the caller wrote in an unverified token. Metering on that
 * would be worse than not metering: a caller could mint a fresh `sub` per request to
 * get an unlimited supply of buckets, or reuse a victim's to exhaust theirs. The IP,
 * by contrast, comes from the trusted-proxy chain and cannot be chosen.
 *
 * So the split follows what is actually known when. IP ceilings here; the two
 * per-account ceilings in `AuthGuard`, immediately after the token is verified and
 * the account is a fact rather than a claim.
 *
 * ─── Fail-open, deliberately ────────────────────────────────────────────────
 *
 * `allow` on a cache failure, unlike the mail quotas. This guard sits in front of
 * EVERY route, so denying on a Redis outage does not degrade the service — it takes
 * the entire API down, including the endpoints that have their own durable
 * protections. The per-endpoint limits that actually gate expensive or irreversible
 * work keep their own `deny`, and Postgres-backed lockout keeps enforcing regardless.
 */
@Injectable()
export class SafetyNetGuard implements CanActivate {
  constructor(private readonly cache: CacheService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // HTTP only. A future websocket or RPC transport needs its own accounting rather
    // than silently bypassing this one.
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const { GLOBAL } = policy();

    // `req.ip` resolves through `trustProxy`, which walks the forwarded chain from the
    // right and stops at the first address the caller could not have written. Reading
    // a header directly here would let a caller choose its own bucket.
    const ip = req.ip;

    // ─── Either credential counts as "presented" ─────────────────────────────
    //
    // This read the `Authorization` header alone, and after the session cookie became
    // the browser's credential that was the same as reading nothing: a signed-in
    // user's requests carry no bearer, so every one of them landed in
    // `publicByIp` — the ceiling sized for "a few people signing in", not for an
    // office of authenticated apps. The failure is a shared-egress one and therefore
    // invisible in development: it takes a NAT with enough real users behind it to
    // exhaust the tighter bucket, and then it refuses ordinary authenticated traffic
    // with `rate_limited` for reasons nothing in the request explains.
    //
    // Which ceiling applies is decided by whether a credential was PRESENTED, not by
    // whose it is — nothing has been verified yet and both values are claims. A caller
    // can therefore choose the higher ceiling by attaching any token or any cookie at
    // all, and that is fine: they still cannot choose their IP, and an invalid
    // credential is refused a few microseconds later by `AuthGuard` having spent this
    // quota.
    //
    // `cookieValue` rather than reading `req.cookies` here, so the empty-string case
    // is handled the one way the rest of the auth code handles it.
    const authenticated =
      bearerFrom(req.headers.authorization) !== null ||
      cookieValue(req, SESSION.COOKIE_NAME) !== null;

    await this.cache.consume(
      authenticated ? KEYS.global.authedByIp(ip) : KEYS.global.publicByIp(ip),
      authenticated ? GLOBAL.AUTHED_BY_IP : GLOBAL.PUBLIC_BY_IP,
      'allow',
    );
    return true;
  }
}
