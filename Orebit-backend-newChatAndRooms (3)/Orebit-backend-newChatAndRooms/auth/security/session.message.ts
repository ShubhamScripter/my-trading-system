import { ERR, type ErrorType } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { REVOKE_REASON } from '../auth.types';

/**
 * ═══ WHY THE CURRENT AUTHENTICATION STATE EXISTS ═══════════════════════════
 *
 * `GET /auth/session` answers WHETHER a browser is signed in. This file is what lets
 * it answer WHY it is not — as a code a frontend can switch on rather than a sentence
 * it would have to parse.
 *
 * It matters more now than it would have before. The browser holds an opaque handle
 * and nothing else: it cannot inspect a token's expiry, cannot count down to one, and
 * cannot tell "I was never signed in" from "I was signed in and something ended it".
 * The server is the only party that knows, so it has to say.
 *
 * The five codes are the five states the session lifecycle can actually be in, and
 * every one is derived from information the backend ALREADY has. Nothing here
 * introduces a timer, a cron, a polling mechanism, or a second revocation authority:
 *
 *   LOGGED_IN            the guard let the request through.
 *   SESSION_EXPIRED      `readLiveness` said 'expired' — `Session.expiresAt`, which
 *                        `touch` moves forward with `lastUsedAt` — or the session
 *                        record the cookie names is gone, which is the same thing
 *                        arrived at from the other side.
 *   SESSION_REVOKED      `Session.revokedAt` is set, with a reason written by
 *                        `revokeFamily` — one sign-in ended.
 *   SESSION_REVOKED_ALL  the same column, with a reason only the account-wide sweeps
 *                        write — every sign-in ended.
 *   NOT_LOGGED_IN        no session cookie was presented at all.
 *
 * ─── Where the text is allowed to matter, and where it is not ─────────────
 *
 * `code` is the contract; `text` is a default the client may show or replace. The
 * catalogue in src/contracts.ts states the same rule for error slugs, and for the
 * same reason: a client that branched on wording would break the day the wording was
 * improved.
 *
 * ═══ HOW THIS REACHES THE WIRE, AND WHY IT IS NOT GLOBAL ═══════════════════
 *
 * On a 200 it is a field of `SessionStatusPayload`. On a 401 it is `extra` on the
 * problem document, which is the bag src/http.ts already declares for
 * "machine-readable extras a client needs to act on the error" — so the service still
 * has exactly ONE error shape and a client still switches on `type` first.
 *
 * And it is attached ONLY on the route that carries `@ExplainsSessionState()`, which
 * is `GET /auth/session` and nothing else. The deeper layers hand the reason up
 * through `SessionEndedException`, whose extra field the global filter does not
 * render — so a 401 from `GET /auth/me`, or from any business route, is
 * byte-for-byte what it was before this change.
 */

/** The five states, and the default wording for each. */
export const SESSION_MESSAGES = {
  LOGGED_IN: { code: 'LOGGED_IN', text: 'You are logged in.' },
  SESSION_EXPIRED: {
    code: 'SESSION_EXPIRED',
    text: 'You have been logged out due to inactivity.',
  },
  SESSION_REVOKED: {
    code: 'SESSION_REVOKED',
    text: 'Your session was logged out from another device.',
  },
  SESSION_REVOKED_ALL: {
    code: 'SESSION_REVOKED_ALL',
    text: 'Your sessions have been logged out.',
  },
  NOT_LOGGED_IN: { code: 'NOT_LOGGED_IN', text: 'You are not logged in.' },
} as const;

export type SessionMessageCode = keyof typeof SESSION_MESSAGES;

/**
 * ═══ WHAT AN ACTION DID, AS OPPOSED TO WHAT THE STATE IS ═══════════════════
 *
 * `SESSION_MESSAGES` above answers "what is this browser's session, and if it is
 * over, why" — five OBSERVED states, derived by the guard from a row or a flag. This
 * answers something different: the user asked for something and it happened.
 *
 * Deliberately NOT a sixth entry in that table, even though the wire shape is
 * identical and a frontend switches on `code` the same way. `SignedOutCode` is
 * `Exclude<SessionMessageCode, 'LOGGED_IN'>`, so a sixth member would immediately
 * become a legal argument to `signedOutStatus` — a state the guard can never observe
 * and never produce. Keeping the two tables apart is what stops the type admitting an
 * answer no code path can give.
 *
 * `LOGGED_OUT` is therefore the outcome of `POST /auth/session`, and nothing reads it
 * back: the session it describes is already revoked by the time it is serialised.
 */
export const SESSION_ACTION_MESSAGES = {
  LOGGED_OUT: {
    code: 'LOGGED_OUT',
    text: 'You are logged out successfully.',
  },
} as const;

export type SessionActionMessage =
  (typeof SESSION_ACTION_MESSAGES)[keyof typeof SESSION_ACTION_MESSAGES];

export interface SessionMessage {
  readonly code: SessionMessageCode;
  readonly text: string;
}

/** Every code except the one that describes a live session. */
export type SignedOutCode = Exclude<SessionMessageCode, 'LOGGED_IN'>;

/**
 * The signed-out half of the `GET /auth/session` contract.
 *
 * The same three field names the 200 carries, so a frontend reads ONE shape whether
 * the answer arrived as a 200 or a 401 — `authenticated` is the discriminant, and it
 * does not have to know the status code to read the answer.
 *
 * `user: null` and `csrfToken: null` are gone from this half because they are gone
 * from the other one — see `SessionStatusPayload`. Keeping them here would be worse
 * than pointless: a client would find them only on the refusal and could reasonably
 * conclude the 200 had a real profile it was failing to read.
 *
 * `lastActiveAt` is present here too, and is NOT always null: a session that timed
 * out still has a stored activity instant, and telling someone when they were last
 * seen is most of the point of surfacing it. It is null only when no row was read —
 * an anonymous caller, or the cached-revocation fast path that deliberately never
 * queries.
 *
 * A `type` rather than an `interface`, and that is not a style choice: only an object
 * type alias gets TypeScript's implicit index signature, and without one this cannot
 * be assigned to `ProblemInput.extra`, which is a `Record<string, unknown>`.
 */
export type SignedOutStatus = {
  readonly authenticated: false;
  /** `lastUsedAt` inside the service, `lastActiveAt` on the wire — the boundary
   *  rename, applied identically on both halves of the contract. */
  readonly lastActiveAt: string | null;
  readonly message: SessionMessage;
};

export function signedOutStatus(
  code: SignedOutCode,
  lastUsedAt: Date | null,
): SignedOutStatus {
  return {
    authenticated: false,
    // ISO at the boundary, like every other date this service reports.
    lastActiveAt: lastUsedAt?.toISOString() ?? null,
    message: SESSION_MESSAGES[code],
  };
}

/**
 * ═══ WHICH REVOCATIONS ENDED EVERY SESSION ═════════════════════════════════
 *
 * `Session.revokedReason` already distinguishes the two, and it does so reliably
 * rather than by convention — the reason is not a free-form label, it is a fixed set
 * whose members each have exactly one writer:
 *
 *   LOGOUT            `revokeFamily` (plus the device sweep) — one sign-in.
 *   REUSE_DETECTED    `revokeFamily`, from `handleReuse` — the same unit.
 *
 * Everything else in `REVOKE_REASON` reaches a session through `revokeAllForUser` or
 * `revokeAllForUserExcept`, both of which end more than the one sign-in that asked:
 * logout-all, a password change or reset, turning off a passkey or authenticator app,
 * and an email change or recovery. From the point of view of a session that was
 * swept, all of those mean the same thing — "this was not just your other tab".
 *
 * So the SCOPE of a revocation is a fact about its reason, and no new column, flag or
 * bookkeeping is needed to recover it.
 * `grep -rn "revokeAllForUser" auth/ src/` is the audit that this table is complete.
 *
 * An unrecognised or absent reason reads as the narrower `SESSION_REVOKED`. That is
 * the safer default of the two: telling someone that ALL their sessions ended when
 * only one did would send them looking for a breach that did not happen.
 */
const REVOKED_EVERY_SESSION: ReadonlySet<string> = new Set([
  REVOKE_REASON.LOGOUT_ALL,
  REVOKE_REASON.PASSWORD_RESET,
  REVOKE_REASON.PASSWORD_CHANGED,
  REVOKE_REASON.PASSKEY_DISABLED,
  REVOKE_REASON.TOTP_DISABLED,
  REVOKE_REASON.EMAIL_CHANGED,
  REVOKE_REASON.EMAIL_RECOVERED,
  // Deleting the account sweeps every session including the caller's, so this belongs
  // in the wider message for the reason the others do. It is also the one member where
  // the narrower message would be actively misleading: "your other tab signed you out"
  // is the wrong thing to tell somebody whose account no longer exists.
  REVOKE_REASON.ACCOUNT_DELETED,
]);

export function revokedMessageCode(
  reason: string | null,
): 'SESSION_REVOKED' | 'SESSION_REVOKED_ALL' {
  return reason !== null && REVOKED_EVERY_SESSION.has(reason)
    ? 'SESSION_REVOKED_ALL'
    : 'SESSION_REVOKED';
}

/**
 * A 401 that already knows which of the five states explains it.
 *
 * Thrown where the reason is KNOWN and would otherwise be discarded — `assertLive`
 * has just read `revokedReason`, and the guard has just seen whether a cookie was
 * presented. Carrying it as a field rather than as `extra` is what keeps the change
 * local: `ProblemJsonFilter` renders only `type`, `title`, `status`, `detail`,
 * `errors` and `extra`, so an instance of this is indistinguishable on the wire from
 * the `ProblemException` it replaces. Only `explainSessionEnd` reads the field, and
 * only for the one route that asked.
 *
 * `instanceof ProblemException` still holds, which matters: `isDeadSession` in
 * guards.ts and every `catch` in the service tree tests for exactly that.
 */
export class SessionEndedException extends ProblemException {
  readonly messageCode: SessionMessageCode;
  /**
   * The session's stored activity instant, when the refusal came from a path that
   * read the row. Null from the cached-revocation fast path, which does not.
   *
   * A field for the same reason `messageCode` is one: it must reach
   * `explainSessionEnd` without being rendered onto every other route's 401.
   */
  readonly lastUsedAt: Date | null;

  constructor(
    messageCode: SessionMessageCode,
    type: ErrorType,
    lastUsedAt: Date | null = null,
    detail?: string,
  ) {
    super(detail === undefined ? { type } : { type, detail });
    this.name = 'SessionEndedException';
    this.messageCode = messageCode;
    this.lastUsedAt = lastUsedAt;
  }
}

/**
 * The code a 401 carries when its reason was NOT known at the throw site.
 *
 * These are the refusals on the refresh path — `rotate` declining an expired or
 * replayed token — plus anything a future 401 adds. Mapping them here rather than
 * editing each throw site is what keeps the contract TOTAL: every 401 from this route
 * carries a message, so a frontend needs no fallback of its own.
 *
 *   token_expired          the refresh token itself had run out. Inactivity, reached
 *                          by the other door.
 *   session_reuse_detected a replay revoked the family. One sign-in, so REVOKED.
 *   token_invalid          a credential that cannot name a session. There is nothing
 *                          to report about a session, so "not logged in".
 */
const CODE_BY_ERROR: Readonly<Partial<Record<ErrorType, SignedOutCode>>> = {
  [ERR.SESSION_EXPIRED]: 'SESSION_EXPIRED',
  [ERR.TOKEN_EXPIRED]: 'SESSION_EXPIRED',
  [ERR.SESSION_REVOKED]: 'SESSION_REVOKED',
  [ERR.SESSION_REUSE_DETECTED]: 'SESSION_REVOKED',
  [ERR.TOKEN_INVALID]: 'NOT_LOGGED_IN',
  [ERR.UNAUTHENTICATED]: 'NOT_LOGGED_IN',
};

/**
 * Re-throw a refusal with the session status attached, or hand it back untouched.
 *
 * Untouched for anything that is not a 401 — a 500 is not a statement about the
 * session, and a client reading `message` off one would render "you are not logged
 * in" for an outage. `session_store_unavailable` is a 503 and so lands here too,
 * deliberately: Redis being away says nothing about whether anyone is signed in.
 *
 * `handlePresent` decides the one case a slug cannot: `AuthGuard` answers
 * `unauthenticated` both when no cookie was sent and when the cookie named a session
 * record that is gone. The first is genuinely anonymous; the second is a session that
 * ran out. Reporting the second as NOT_LOGGED_IN would tell someone who was working a
 * minute ago that they never signed in.
 */
export function explainSessionEnd(err: unknown, handlePresent: boolean): unknown {
  if (!(err instanceof ProblemException) || err.status !== 401) return err;

  const code = codeFor(err, handlePresent);
  if (code === undefined) return err;

  return new ProblemException({
    type: err.type,
    status: err.status,
    ...(err.detail !== undefined ? { detail: err.detail } : {}),
    ...(err.errors !== undefined ? { errors: err.errors } : {}),
    ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    // Merged rather than replaced. No 401 on this route carries an `extra` of its own
    // today; merging means a future one keeps whatever it added.
    //
    // `lastUsedAt` is whatever the throw site read, and null for the refusals that
    // read nothing — a slug alone cannot know when someone was last active.
    extra: {
      ...err.extra,
      ...signedOutStatus(code, err instanceof SessionEndedException ? err.lastUsedAt : null),
    },
  });
}

/** `undefined` only for the impossible case: a 401 that describes a LIVE session. */
function codeFor(err: ProblemException, handlePresent: boolean): SignedOutCode | undefined {
  if (err instanceof SessionEndedException) {
    return err.messageCode === 'LOGGED_IN' ? undefined : err.messageCode;
  }
  if (err.type === ERR.UNAUTHENTICATED && handlePresent) return 'SESSION_EXPIRED';
  // Every 401 this service throws today is in the table; the fallback is for a slug a
  // future change adds without revisiting this file.
  return CODE_BY_ERROR[err.type] ?? 'NOT_LOGGED_IN';
}
