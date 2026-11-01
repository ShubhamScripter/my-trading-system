import { z } from 'zod';

/**
 * `POST /auth/session` — the session lifecycle. Three actions.
 *
 * ═══ `refresh` IS GONE, AND THAT IS THE POINT ══════════════════════════════
 *
 * There is no longer a refresh a client can ask for. The backend holds both tokens in
 * a server-side record and rotates them itself, inside `AuthGuard`, on whichever
 * ordinary request finds the access token near expiry — see security/bff.session.ts.
 * So the action has no credential to present, no work to request, and nothing to
 * return.
 *
 * Removed rather than kept as a no-op that answers 200. A stale client polling a
 * successful refresh it never receives would look healthy while doing nothing, and the
 * failure would only surface later as an unexplained sign-out. `validation_failed` on
 * `{"action":"refresh"}` is the honest answer, and it comes free: a
 * `discriminatedUnion` refuses a discriminant it does not list.
 *
 * ═══ WHY EVERY MEMBER IS `.strict()` ═══════════════════════════════════════
 *
 * This file used to rely on the opposite — zod silently stripping an unknown key — so
 * that a stale client still sending `refreshToken` in the body was not rejected for
 * it, and failed later on the missing cookie instead.
 *
 * That tolerance was worth having while the body was the thing being emptied, because
 * the extra key was harmless and the alternative was breaking clients mid-migration.
 * It is worth removing now that the body is empty by design: a client sending a
 * `refreshToken` is a client that believes it holds a credential it cannot hold, and
 * telling it so at the edge is more useful than accepting the request and quietly
 * ignoring the field. There is no longer a version of this route where a token in the
 * body means anything.
 *
 * `logout` and `logout-all` need a principal but must also work when the session
 * behind them is already gone, which is why the route carries `OptionalAuthGuard`
 * rather than no guard or a mandatory one — see guards.ts.
 */

const logoutSchema = z
  .object({
    // Ends every session on the caller's current browser/device. Use `logout-all`
    // only when the user explicitly wants to sign out their other devices too.
    action: z.literal('logout'),
  })
  .strict();

const logoutAllSchema = z
  .object({
    action: z.literal('logout-all'),
  })
  .strict();

/**
 * End one named session — the "that is not me" button on the session list.
 *
 * Requires a live principal, unlike the other two: revoking by id is the only action
 * here that names something other than the caller's own session, so there has to be a
 * principal to check it against. Ownership is verified against the row, never inferred
 * from the id, because session ids are time-ordered UUIDv7 and a neighbouring id is a
 * good guess.
 */
const revokeSessionSchema = z
  .object({
    action: z.literal('revoke-session'),
    sessionId: z.string().uuid(),
  })
  .strict();

export const sessionRequestSchema = z.discriminatedUnion('action', [
  logoutSchema,
  logoutAllSchema,
  revokeSessionSchema,
]);

export type SessionRequest = z.infer<typeof sessionRequestSchema>;
export type RevokeSessionRequest = z.infer<typeof revokeSessionSchema>;
export type SessionLogoutRequest = z.infer<typeof logoutSchema>;
