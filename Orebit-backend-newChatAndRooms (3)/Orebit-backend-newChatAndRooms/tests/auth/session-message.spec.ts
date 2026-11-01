import { describe, expect, it } from 'vitest';
import {
  SESSION_ACTION_MESSAGES,
  SESSION_MESSAGES,
  SessionEndedException,
  explainSessionEnd,
  revokedMessageCode,
  signedOutStatus,
} from '../../auth/security/session.message';
import { REVOKE_REASON } from '../../auth/auth.types';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

/**
 * The five session states, as a code a frontend can switch on.
 *
 * This exists because the browser now holds an opaque handle and nothing else: it
 * cannot inspect a token's expiry, cannot count down to one, and cannot tell "I was
 * never signed in" from "I was signed in and something ended it". The server is the
 * only party that knows, so it has to say — and it has to say it the same way on the
 * 200 and on the 401.
 */

describe('the code table', () => {
  it('has exactly five codes, and each is its own key', () => {
    // The contract `GET /auth/session` publishes. A sixth would immediately become a
    // legal argument to `signedOutStatus` — see the LOGGED_OUT test below.
    expect(Object.keys(SESSION_MESSAGES)).toEqual([
      'LOGGED_IN',
      'SESSION_EXPIRED',
      'SESSION_REVOKED',
      'SESSION_REVOKED_ALL',
      'NOT_LOGGED_IN',
    ]);

    for (const [key, message] of Object.entries(SESSION_MESSAGES)) {
      expect(message.code).toBe(key);
      expect(message.text.length).toBeGreaterThan(0);
    }
  });

  it('keeps LOGGED_OUT out of that table, deliberately', () => {
    // It is the outcome of an ACTION, not an observed state, and the guard can never
    // produce it. Merging the tables would let `signedOutStatus('LOGGED_OUT', …)`
    // typecheck — an answer no code path can give.
    expect(SESSION_MESSAGES).not.toHaveProperty('LOGGED_OUT');
    expect(SESSION_ACTION_MESSAGES.LOGGED_OUT.code).toBe('LOGGED_OUT');
  });
});

describe('signedOutStatus', () => {
  it('mirrors the 200’s field names, so a client reads one shape', () => {
    const status = signedOutStatus('SESSION_EXPIRED', new Date('2026-09-01T12:00:00.000Z'));

    expect(status).toEqual({
      authenticated: false,
      lastActiveAt: '2026-09-01T12:00:00.000Z',
      message: SESSION_MESSAGES.SESSION_EXPIRED,
    });
  });

  it('serialises the instant, and reports null when there is none', () => {
    // Null only when no row was read — an anonymous caller, or the cached-revocation
    // fast path that deliberately never queries. A session that timed out still has
    // a stored instant, and telling someone when they were last seen is most of the
    // point of surfacing it.
    expect(signedOutStatus('NOT_LOGGED_IN', null).lastActiveAt).toBeNull();
    expect(typeof signedOutStatus('SESSION_REVOKED', new Date()).lastActiveAt).toBe('string');
  });
});

describe('revokedMessageCode — the scope of a revocation', () => {
  it('reads a family-scoped reason as one session ending', () => {
    // `revokeFamily` is the only writer of these two, and a family IS one sign-in.
    expect(revokedMessageCode(REVOKE_REASON.LOGOUT)).toBe('SESSION_REVOKED');
    expect(revokedMessageCode(REVOKE_REASON.REUSE_DETECTED)).toBe('SESSION_REVOKED');
  });

  it.each([
    REVOKE_REASON.LOGOUT_ALL,
    REVOKE_REASON.PASSWORD_RESET,
    REVOKE_REASON.PASSWORD_CHANGED,
    REVOKE_REASON.PASSKEY_DISABLED,
    REVOKE_REASON.TOTP_DISABLED,
    REVOKE_REASON.EMAIL_CHANGED,
    REVOKE_REASON.EMAIL_RECOVERED,
    REVOKE_REASON.ACCOUNT_DELETED,
  ])('reads %s as every session ending', (reason) => {
    // Each of these reaches a session through `revokeAllForUser` or
    // `revokeAllForUserExcept`, so from the point of view of a session that was
    // swept they all mean "this was not just your other tab".
    expect(revokedMessageCode(reason)).toBe('SESSION_REVOKED_ALL');
  });

  it('covers every member of REVOKE_REASON', () => {
    // The audit, mechanised. A reason added without a decision here would silently
    // read as the narrower message; this fails the build instead.
    const classified = new Set([
      REVOKE_REASON.LOGOUT,
      REVOKE_REASON.REUSE_DETECTED,
      REVOKE_REASON.LOGOUT_ALL,
      REVOKE_REASON.PASSWORD_RESET,
      REVOKE_REASON.PASSWORD_CHANGED,
      REVOKE_REASON.PASSKEY_DISABLED,
      REVOKE_REASON.TOTP_DISABLED,
      REVOKE_REASON.EMAIL_CHANGED,
      REVOKE_REASON.EMAIL_RECOVERED,
      // Deleting the account sweeps every session including the caller's own, so it
      // classifies with the wider message — see the note on the member itself.
      REVOKE_REASON.ACCOUNT_DELETED,
    ]);
    expect([...Object.values(REVOKE_REASON)].filter((r) => !classified.has(r))).toEqual([]);
  });

  it('degrades to the narrower message for an unknown or absent reason', () => {
    // The safer default of the two: telling someone ALL their sessions ended when
    // only one did would send them looking for a breach that did not happen.
    expect(revokedMessageCode(null)).toBe('SESSION_REVOKED');
    expect(revokedMessageCode('1')).toBe('SESSION_REVOKED');
    expect(revokedMessageCode('SOMETHING_NEW')).toBe('SESSION_REVOKED');
  });
});

describe('SessionEndedException', () => {
  it('is a ProblemException, which every catch in the tree depends on', () => {
    const err = new SessionEndedException('SESSION_REVOKED', ERR.SESSION_REVOKED);

    // `isDeadSession` in guards.ts and every service `catch` tests for exactly this.
    expect(err).toBeInstanceOf(ProblemException);
    expect(err.type).toBe(ERR.SESSION_REVOKED);
    expect(err.status).toBe(401);
  });

  it('carries the reason as a FIELD, not as extra', () => {
    const err = new SessionEndedException('SESSION_EXPIRED', ERR.SESSION_EXPIRED);

    // Which is what keeps the change local: the filter renders only `type`, `title`,
    // `status`, `detail`, `errors` and `extra`, so on the wire this is
    // indistinguishable from the ProblemException it replaced. Only
    // `explainSessionEnd` reads the field, and only for the one route that asked.
    expect(err.messageCode).toBe('SESSION_EXPIRED');
    expect(err.extra).toBeUndefined();
  });
});

describe('explainSessionEnd', () => {
  it('attaches the state to a 401', () => {
    const explained = explainSessionEnd(
      new SessionEndedException('SESSION_REVOKED_ALL', ERR.SESSION_REVOKED, null),
      true,
    ) as ProblemException;

    expect(explained.type).toBe(ERR.SESSION_REVOKED);
    expect(explained.extra).toMatchObject({ message: { code: 'SESSION_REVOKED_ALL' } });
  });

  it('carries the throw site’s lastUsedAt through, as lastActiveAt', () => {
    const lastUsedAt = new Date('2026-09-01T12:00:00.000Z');
    const explained = explainSessionEnd(
      new SessionEndedException('SESSION_EXPIRED', ERR.SESSION_EXPIRED, lastUsedAt),
      true,
    ) as ProblemException;

    // The internal name is `lastUsedAt` all the way up to `signedOutStatus`, which is
    // the one place it becomes the wire name.
    expect(explained.extra).toMatchObject({ lastActiveAt: '2026-09-01T12:00:00.000Z' });
  });

  it('hands back anything that is not a 401, untouched', () => {
    // A 500 is not a statement about the session, and a client reading `message` off
    // one would render "you are not logged in" for an outage. The 503 is the same
    // argument: Redis being away says nothing about who is signed in.
    const outage = new ProblemException({ type: ERR.SESSION_STORE_UNAVAILABLE });
    expect(explainSessionEnd(outage, true)).toBe(outage);

    const internal = new ProblemException({ type: ERR.INTERNAL_ERROR });
    expect(explainSessionEnd(internal, true)).toBe(internal);

    const csrf = new ProblemException({ type: ERR.CSRF_INVALID });
    expect(explainSessionEnd(csrf, true)).toBe(csrf);
  });

  it('hands back a non-problem error untouched', () => {
    const boom = new Error('boom');
    expect(explainSessionEnd(boom, true)).toBe(boom);
  });

  it('reads a bare unauthenticated differently depending on the handle', () => {
    // The one case a slug cannot decide. The guard answers `unauthenticated` both
    // when no cookie was sent and when the cookie named a record that is gone; the
    // first is genuinely anonymous, the second is a session that ran out.
    const anonymous = explainSessionEnd(
      new ProblemException({ type: ERR.UNAUTHENTICATED }),
      false,
    ) as ProblemException;
    expect(anonymous.extra).toMatchObject({ message: { code: 'NOT_LOGGED_IN' } });

    const stale = explainSessionEnd(
      new ProblemException({ type: ERR.UNAUTHENTICATED }),
      true,
    ) as ProblemException;
    expect(stale.extra).toMatchObject({ message: { code: 'SESSION_EXPIRED' } });
  });

  it.each([
    [ERR.SESSION_EXPIRED, 'SESSION_EXPIRED'],
    [ERR.TOKEN_EXPIRED, 'SESSION_EXPIRED'],
    [ERR.SESSION_REVOKED, 'SESSION_REVOKED'],
    [ERR.SESSION_REUSE_DETECTED, 'SESSION_REVOKED'],
    [ERR.TOKEN_INVALID, 'NOT_LOGGED_IN'],
  ])('maps a bare %s to %s', (type, code) => {
    // These are the refusals thrown where the reason was not known — the refresh
    // path, mostly. Mapping them here rather than editing each throw site is what
    // makes the contract TOTAL: every 401 from that route carries a message, so a
    // frontend needs no fallback of its own.
    const explained = explainSessionEnd(new ProblemException({ type }), true) as ProblemException;

    expect(explained.extra).toMatchObject({ message: { code } });
  });

  it('preserves detail, and merges rather than replaces an existing extra', () => {
    const explained = explainSessionEnd(
      new ProblemException({
        type: ERR.SESSION_REVOKED,
        detail: 'Sign in again.',
        extra: { somethingElse: 1 },
      }),
      true,
    ) as ProblemException;

    expect(explained.detail).toBe('Sign in again.');
    // No 401 on that route carries an extra of its own today; merging means a future
    // one keeps whatever it added.
    expect(explained.extra).toMatchObject({ somethingElse: 1, authenticated: false });
  });

  it('produces a new exception rather than mutating the one it was handed', () => {
    // It runs inside the guard's catch, on an object the service tree threw. Mutating
    // it would leak session state onto whatever else holds a reference.
    const original = new ProblemException({ type: ERR.SESSION_REVOKED });
    const explained = explainSessionEnd(original, true);

    expect(explained).not.toBe(original);
    expect(original.extra).toBeUndefined();
  });
});
