import type { FastifyCorsOptions } from '@fastify/cors';
import { config } from './config';
import { CSRF, ELEVATION } from '../auth/auth.constants';

/**
 * The CORS policy, registered once in src/main.ts.
 *
 * Lives in its own module rather than inline at the registration site for one
 * reason: main.ts starts listening at import time, so a test cannot load it. A
 * policy nobody can assert on is a policy that drifts — and every value here is
 * load-bearing enough that a silent change breaks the admin panel rather than
 * failing loudly. See tests/http.spec.ts.
 */
export const corsOptions: FastifyCorsOptions = {
  // One origin, and it is also the WebAuthn `expectedOrigin`. A passkey
  // assertion is bound to the origin it was created on, so an admin panel served
  // from anywhere else would fail verification even if CORS allowed it — the two
  // values have to agree, and this is where that is visible.
  origin: (origin, cb) => {
    if (
      !origin ||
      origin === config.ADMIN_APP_URL ||
      (config.NODE_ENV === 'development' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
    ) {
      cb(null, true);
      return;
    }
    cb(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
  allowedHeaders: [
    'content-type',
    'authorization',
    // Single-use elevation ticket for per-action administrative writes.
    ELEVATION.HEADER_NAME,
    // The CSRF token echoed back on every mutating request. The session cookie is
    // root-scoped, so every such request is cookie-authenticated and carries this.
    // Without it the browser's preflight refuses the header and every write fails
    // with a CORS error rather than a useful one.
    CSRF.HEADER_NAME,
  ],
  // Response headers the admin panel's JavaScript is allowed to READ. Distinct
  // from `allowedHeaders`, which governs what it may SEND.
  //
  // A browser hands script only a short safelist of response headers by default,
  // and `Retry-After` is not on it: without this line `response.headers.get(...)`
  // returns null cross-origin even though the header arrived on the wire. That is
  // the whole of F13 — a lockout could not render a countdown.
  //
  // Kept to exactly the one header that a client needs and cannot otherwise see.
  // Nothing else is listed, because exposing a header is a decision about what
  // another origin's script may read, not a formality. The duration also travels
  // in the problem body (src/http.ts), which is what most callers should read;
  // this covers the ones already looking at the header.
  exposedHeaders: ['retry-after'],
};
