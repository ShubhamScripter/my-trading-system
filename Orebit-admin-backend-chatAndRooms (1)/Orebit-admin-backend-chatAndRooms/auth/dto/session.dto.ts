import { z } from 'zod';

/**
 * `POST /auth/session` — logout and logout-all.
 *
 * ═══ WHAT LEFT, AND WHY ═════════════════════════════════════════════════════
 *
 * `refresh` is gone, and so is the optional `refreshToken` body field on all three
 * actions.
 *
 * The browser has no refresh token to present. It holds an opaque handle naming a
 * server-side record, and the backend rotates the tokens inside that record itself,
 * mid-request, when the access token is close to expiring — see
 * auth/security/bff.session.ts. So there is nothing for a client to ask for: a
 * `refresh` action would be a request to do something that has already happened.
 *
 * The body field was a migration path for a frontend that held the token in
 * JavaScript, kept alive behind a WARN so its removal could be scheduled on evidence.
 * It is removed with the contract it served rather than deprecated further: it was
 * the one way into this endpoint that skipped the CSRF check, on the grounds that a
 * body-supplied token is not an ambient credential. That is still true, and it is no
 * longer worth having two doors.
 *
 * ─── Both actions are now bodies with nothing but a discriminator ──────────
 *
 * Kept as a discriminated union rather than collapsed into two routes, because that
 * is the shape every other endpoint in this service uses and `logout-all` is a
 * genuinely different operation from `logout` — one family versus every family.
 *
 * `.strict()` on both: a client still sending `refreshToken` gets a
 * `validation_failed` naming the field rather than a silent success that leaves it
 * believing the token mattered.
 */

const logoutSchema = z.object({ action: z.literal('logout') }).strict();

const logoutAllSchema = z.object({ action: z.literal('logout-all') }).strict();

export const sessionRequestSchema = z.discriminatedUnion('action', [
  logoutSchema,
  logoutAllSchema,
]);

export type SessionRequest = z.infer<typeof sessionRequestSchema>;
