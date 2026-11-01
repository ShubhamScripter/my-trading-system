import type { FastifyInstance } from 'fastify';

/**
 * The response cache policy, registered once in src/main.ts.
 *
 * ═══ WHY THIS IS A HOOK AND NOT A HEADER PER HANDLER ══════════════════════════
 *
 * It was per handler, and that was F15. `GET /auth/session` set `no-store` on its
 * own 200 and `GET /auth/me` — which returns the admin's name, email and role —
 * set nothing at all, so a private profile response left the service with no
 * `Cache-Control` and whatever a proxy's heuristic freshness rules made of it.
 *
 * A per-handler header cannot fix that class of bug, only its instances. Two
 * properties are needed and neither is available inside a handler:
 *
 *   every route      A new controller is sensitive by default. The inverse policy
 *                    — opt in per route — publishes the next private endpoint
 *                    uncached and nothing anywhere says so. Same direction as
 *                    `@Public()` in auth/security/guards.ts: the omission has to
 *                    fail closed.
 *   every OUTCOME    A guard throws before any handler runs, so a 401 from
 *                    `AuthGuard` never reached the line that set the header. The
 *                    refusals are the responses most worth not caching: a cached
 *                    401 outlives the condition that caused it, and a cached 200
 *                    from a shared proxy is one admin's profile served to another.
 *
 * `onRequest` is the earliest hook Fastify has, so the header is on the reply
 * before routing, before guards and before the handler. Every path out of the
 * service — success, `ProblemJsonFilter`, or a framework 404 that never reaches
 * Nest — carries it, because it was set before any of them could be chosen.
 *
 * ─── Why `onRequest` and not `onSend` ─────────────────────────────────────────
 *
 * `onSend` would have the last word, which sounds stronger and is the wrong
 * property. Setting the header early leaves a route free to override it
 * deliberately — which is what `/docs` below needs — whereas an `onSend` hook that
 * stamps `no-store` unconditionally would silently undo any such decision. Nothing
 * in this service overrides it by accident: `cache-control` is written in exactly
 * the places `grep -rn "cache-control"` finds.
 *
 * ─── The two handlers that still set it themselves ────────────────────────────
 *
 * `auth.routes.ts`'s session-status handler and the `@ExplainsSessionState()` branch
 * of `AuthGuard` both still write this header. That is deliberate redundancy rather
 * than a leftover: those two are unit-tested against a mocked `FastifyReply` with no
 * Fastify instance and therefore no hook, so the assertions there pin the behaviour
 * of the code under test. This hook is what makes the guarantee hold for the other
 * routes — and for the paths, like a guard refusal on `GET /auth/me`, that no
 * handler can reach.
 */

/** `Cache-Control` for everything this service returns, docs excepted. */
export const NO_STORE = 'no-store';

/**
 * The browsable API reference, which is the one thing here worth caching.
 *
 * `/docs` is public, identical for every caller, and pulls a handful of static
 * assets on each load — @fastify/swagger-ui sets its own headers on those, and
 * stamping `no-store` over them would make a documentation page re-download its
 * own JavaScript on every navigation to protect a document that is already public.
 *
 * Matched on the path with the query string removed, so `/docs?foo=1` is exempt and
 * a route merely *starting* with those characters — `/docsomething` — is not.
 */
function isExempt(url: string): boolean {
  // `indexOf`/`slice` rather than `split(...)[0]`, which the compiler types as
  // possibly undefined under `noUncheckedIndexedAccess` even though a split never
  // yields an empty array. A non-null assertion would silence it by asserting
  // something about the runtime; this states the same thing without one.
  const query = url.indexOf('?');
  const path = query === -1 ? url : url.slice(0, query);
  return path === '/docs' || path.startsWith('/docs/');
}

/**
 * Stamp `Cache-Control: no-store` on every response.
 *
 * Takes the Fastify instance rather than the Nest application because a hook is not
 * a plugin: `app.register` is the wrong door, and reaching through
 * `getHttpAdapter().getInstance()` at the call site keeps this module free of a Nest
 * import it would otherwise need only for a type. That is also what lets a spec
 * apply the policy to a bare Fastify app — see tests/http.spec.ts.
 */
export function registerCachePolicy(app: FastifyInstance): void {
  app.addHook('onRequest', (req, reply, done) => {
    if (!isExempt(req.url)) void reply.header('cache-control', NO_STORE);
    done();
  });
}
