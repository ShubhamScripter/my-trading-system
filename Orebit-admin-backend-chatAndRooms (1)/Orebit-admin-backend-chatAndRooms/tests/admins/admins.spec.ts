import { describe, expect, it, vi } from 'vitest';
import { AdminsService } from '../../src/admins/admins.service';
import {
  ADMIN_ACTIONS,
  ADMIN_ELEVATION,
  ADMIN_SELF_TARGET_ALLOWED,
} from '../../src/admins/admins.types';
import { REVOKE_REASON } from '../../auth/auth.types';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { makeAdmin } from '../harness';

/**
 * ═══ THE ONLY CODE IN THIS SERVICE THAT WRITES TO SOMEONE ELSE'S ACCOUNT ═══
 *
 * `AdminsService.resetFactors` empties a target's second-factor set, which makes
 * their account signable-into by whoever next completes enrollment on it. That is
 * the most powerful single action the service has, and it exists because the
 * alternative was worse: before it, an admin who lost their authenticator was
 * recovered by an UPDATE typed into a psql prompt on production.
 *
 * So the tests here are about the GATE rather than the mechanics. If one fails, the
 * question is not "how do I fix the test" but "did I just let a non-super-admin, or
 * a stale token, reach another admin's factors".
 */

const ACTOR_ID = '01920000-0000-7000-8000-00000000a001';
const TARGET_ID = '01920000-0000-7000-8000-00000000a002';

function actor(sessionId = 'session-1') {
  // A distinct family per session id, so a test that keyed on the wrong one fails.
  return { adminId: ACTOR_ID, sessionId, familyId: `fam-${sessionId}`, role: 'SUPER_ADMIN' as const };
}

interface Doubles {
  admins: Record<string, ReturnType<typeof vi.fn>>;
  sessions: Record<string, ReturnType<typeof vi.fn>>;
  mail: Record<string, ReturnType<typeof vi.fn>>;
  events: Record<string, ReturnType<typeof vi.fn>>;
}

/**
 * Defaults to a SUPER_ADMIN actor and a distinct ACTIVE target — the happy path —
 * so every refusal test has to say explicitly what it is changing.
 */
function build(overrides: Partial<Doubles> = {}) {
  const self = makeAdmin({ id: ACTOR_ID, role: 'SUPER_ADMIN', status: 'ACTIVE' });
  const target = makeAdmin({
    id: TARGET_ID,
    email: 'target@orebit.io',
    role: 'ADMIN',
    status: 'ACTIVE',
  });

  const doubles: Doubles = {
    admins: {
      findById: vi.fn(async (id: string) => (id === ACTOR_ID ? self : target)),
      retireAllFactors: vi.fn().mockResolvedValue({ totp: 1, passkey: 2 }),
      setStatus: vi.fn().mockResolvedValue(true),
      ...overrides.admins,
    },
    sessions: {
      revokeAllForAdmin: vi.fn().mockResolvedValue(undefined),
      ...overrides.sessions,
    },
    mail: {
      sendSecurityChanged: vi.fn().mockResolvedValue('sent'),
      ...overrides.mail,
    },
    events: {
      record: vi.fn().mockResolvedValue(undefined),
      ...overrides.events,
    },
  };

  const service = new AdminsService(
    doubles.admins as never,
    doubles.sessions as never,
    doubles.mail as never,
    doubles.events as never,
  );

  return { service, self, target, ...doubles };
}

function slugOf(err: unknown): string {
  return err instanceof ProblemException ? err.type : `unexpected: ${String(err)}`;
}

const REASON = 'lost their phone';

// ─── the tables ──────────────────────────────────────────────────────────────

describe('the action tables', () => {
  it('assigns a distinct elevation action to every admin action', () => {
    const values = ADMIN_ACTIONS.map((a) => ADMIN_ELEVATION[a]);
    expect(new Set(values).size).toBe(ADMIN_ACTIONS.length);
  });

  /**
   * One shared `admin.write` would make a proof given to re-enable an account
   * sufficient to disable a different one — which is exactly the per-action property
   * finding B3 established. Asserted because the cheap refactor is the wrong one.
   */
  it('namespaces them so they cannot collide with the bare 2fa actions', () => {
    for (const action of ADMIN_ACTIONS) {
      expect(ADMIN_ELEVATION[action]).toMatch(/^admin\./);
    }
  });

  it('declares a self-target rule for every action', () => {
    for (const action of ADMIN_ACTIONS) {
      expect(ADMIN_SELF_TARGET_ALLOWED[action]).toBeTypeOf('boolean');
    }
  });

  /** The two destructive ones may not point at the caller. See the table's comment
   *  for why: both are one request from nobody being able to administer anything. */
  it('refuses self-targeting for the destructive actions', () => {
    expect(ADMIN_SELF_TARGET_ALLOWED['reset-factors']).toBe(false);
    expect(ADMIN_SELF_TARGET_ALLOWED.disable).toBe(false);
  });
});

// ─── the gate ────────────────────────────────────────────────────────────────

describe('who may administer another admin', () => {
  it('lets a SUPER_ADMIN reset a target factor set', async () => {
    const t = build();

    const { retired } = await t.service.resetFactors(actor(), TARGET_ID, REASON);

    expect(t.admins.retireAllFactors).toHaveBeenCalledWith(TARGET_ID);
    expect(retired).toEqual({ totp: 1, passkey: 2 });
  });

  it('refuses a plain ADMIN', async () => {
    const t = build({
      admins: {
        findById: vi.fn(async (id: string) =>
          id === ACTOR_ID
            ? makeAdmin({ id: ACTOR_ID, role: 'ADMIN' })
            : makeAdmin({ id: TARGET_ID }),
        ),
        retireAllFactors: vi.fn(),
        setStatus: vi.fn(),
      },
    });

    await expect(t.service.resetFactors(actor(), TARGET_ID, REASON)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.FORBIDDEN,
    );
    expect(t.admins.retireAllFactors).not.toHaveBeenCalled();
  });

  /**
   * ═══ THE ROLE COMES FROM THE DATABASE, NOT THE TOKEN ═══════════════════════
   *
   * The `Principal` here says SUPER_ADMIN — a fifteen-minute access token minted
   * before a demotion says exactly that. The row says ADMIN. The row wins, or a
   * demoted admin keeps administrative reach until their token expires.
   */
  it('trusts the database row over the token claim', async () => {
    const t = build({
      admins: {
        // Token claims SUPER_ADMIN; the row disagrees.
        findById: vi.fn(async (id: string) =>
          id === ACTOR_ID
            ? makeAdmin({ id: ACTOR_ID, role: 'ADMIN' })
            : makeAdmin({ id: TARGET_ID }),
        ),
        retireAllFactors: vi.fn(),
        setStatus: vi.fn(),
      },
    });

    // `actor()` carries role: 'SUPER_ADMIN'.
    await expect(t.service.resetFactors(actor(), TARGET_ID, REASON)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.FORBIDDEN,
    );
  });

  /** A disabled account's unexpired access token must not still administer. */
  it('refuses an actor whose own account is disabled', async () => {
    const t = build({
      admins: {
        findById: vi.fn(async (id: string) =>
          id === ACTOR_ID
            ? makeAdmin({ id: ACTOR_ID, role: 'SUPER_ADMIN', status: 'DISABLED' })
            : makeAdmin({ id: TARGET_ID }),
        ),
        retireAllFactors: vi.fn(),
        setStatus: vi.fn(),
      },
    });

    await expect(t.service.resetFactors(actor(), TARGET_ID, REASON)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.UNAUTHENTICATED,
    );
  });

  it('refuses an actor whose account has been deleted', async () => {
    const t = build({
      admins: {
        findById: vi.fn().mockResolvedValue(null),
        retireAllFactors: vi.fn(),
        setStatus: vi.fn(),
      },
    });

    await expect(t.service.resetFactors(actor(), TARGET_ID, REASON)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.UNAUTHENTICATED,
    );
  });

  it('answers not_found for a target that does not exist', async () => {
    const t = build({
      admins: {
        findById: vi.fn(async (id: string) =>
          id === ACTOR_ID ? makeAdmin({ id: ACTOR_ID, role: 'SUPER_ADMIN' }) : null,
        ),
        retireAllFactors: vi.fn(),
        setStatus: vi.fn(),
      },
    });

    await expect(t.service.resetFactors(actor(), TARGET_ID, REASON)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.NOT_FOUND,
    );
  });

  /**
   * Self-targeting is refused for `reset-factors`, and this is not paternalism:
   * self-service already exists on `POST /2fa`, bounded by `assertNotLastFactor` so
   * an admin cannot strand themselves. This route bypasses that check by design, so
   * pointing it at yourself is a way to do what the safe path refuses.
   */
  it('refuses resetting your own factors', async () => {
    const t = build();

    await expect(t.service.resetFactors(actor(), ACTOR_ID, REASON)).rejects.toSatisfy(
      (err) => slugOf(err) === ERR.VALIDATION_FAILED,
    );
    expect(t.admins.retireAllFactors).not.toHaveBeenCalled();
  });

  it('refuses disabling your own account', async () => {
    const t = build();

    await expect(
      t.service.setStatus(actor(), ACTOR_ID, 'DISABLED', REASON),
    ).rejects.toSatisfy((err) => slugOf(err) === ERR.VALIDATION_FAILED);
    expect(t.admins.setStatus).not.toHaveBeenCalled();
  });

  /** Cannot lock anyone out, so it is allowed. */
  it('permits enabling your own account', async () => {
    const t = build();
    await expect(
      t.service.setStatus(actor(), ACTOR_ID, 'ACTIVE', undefined),
    ).resolves.toBeDefined();
  });
});

// ─── what a reset actually does ──────────────────────────────────────────────

describe('resetting a factor set', () => {
  /**
   * ═══ FACTORS FIRST, THEN SESSIONS ══════════════════════════════════════════
   *
   * The reverse leaves a window in which the target holds both a live session and a
   * live factor, so they could enrol a replacement mid-reset and the recovery would
   * silently not have happened.
   */
  it('retires the factors BEFORE revoking the sessions', async () => {
    const order: string[] = [];
    const t = build({
      admins: {
        findById: vi.fn(async (id: string) =>
          id === ACTOR_ID
            ? makeAdmin({ id: ACTOR_ID, role: 'SUPER_ADMIN' })
            : makeAdmin({ id: TARGET_ID }),
        ),
        retireAllFactors: vi.fn(async () => {
          order.push('factors');
          return { totp: 1, passkey: 0 };
        }),
        setStatus: vi.fn(),
      },
      sessions: {
        revokeAllForAdmin: vi.fn(async () => {
          order.push('sessions');
        }),
      },
    });

    await t.service.resetFactors(actor(), TARGET_ID, REASON);

    expect(order).toEqual(['factors', 'sessions']);
  });

  /** A live session on the lost device outlives the factor by twelve hours
   *  otherwise. */
  it('revokes every session the target has', async () => {
    const t = build();

    await t.service.resetFactors(actor(), TARGET_ID, REASON);

    expect(t.sessions.revokeAllForAdmin).toHaveBeenCalledWith(
      TARGET_ID,
      REVOKE_REASON.LOGOUT_ALL,
    );
  });

  /**
   * The echoed payload must describe the account AFTER the reset.
   *
   * `authorise` loads the target before the retirement, so returning that row
   * verbatim reports `mfaEnrolled: true` for an account that no longer has a factor
   * — handing the operator who just performed the reset exactly the confusion that
   * nulling the column was meant to prevent. Caught by a live run, not by a double,
   * which is why it is pinned here now.
   */
  it('reports the target as no longer enrolled', async () => {
    const t = build();

    const { admin } = await t.service.resetFactors(actor(), TARGET_ID, REASON);

    expect(admin.mfaEnrolledAt).toBeNull();
  });

  /**
   * ═══ THE TARGET IS ALWAYS TOLD ═════════════════════════════════════════════
   *
   * If this action was taken by someone who stole an admin session, this mail is the
   * only thing that surfaces it. It goes to the TARGET, not the actor.
   */
  it('notifies the target, not the actor', async () => {
    const t = build();

    await t.service.resetFactors(actor(), TARGET_ID, REASON);

    expect(t.mail['sendSecurityChanged']).toHaveBeenCalledOnce();
    const [to] = (t.mail['sendSecurityChanged']?.mock.calls[0] ?? []) as [string];
    expect(to).toBe('target@orebit.io');
    expect(to).not.toBe(t.self.email);
  });
});

describe('changing a status', () => {
  it('revokes sessions when disabling', async () => {
    const t = build();

    await t.service.setStatus(actor(), TARGET_ID, 'DISABLED', REASON);

    expect(t.admins.setStatus).toHaveBeenCalledWith(TARGET_ID, 'DISABLED');
    expect(t.sessions.revokeAllForAdmin).toHaveBeenCalledWith(
      TARGET_ID,
      REVOKE_REASON.LOGOUT_ALL,
    );
  });

  /**
   * `rotate` does re-check status, so a disabled admin cannot refresh — but their
   * existing fifteen-minute access token does not go through it. Revoking is what
   * makes "disabled" take effect now rather than within fifteen minutes.
   */
  it('does not revoke sessions when enabling', async () => {
    const t = build();

    await t.service.setStatus(actor(), TARGET_ID, 'ACTIVE', undefined);

    expect(t.sessions.revokeAllForAdmin).not.toHaveBeenCalled();
  });

  it('answers not_found when the status write matches nothing', async () => {
    const t = build({
      admins: {
        findById: vi.fn(async (id: string) =>
          id === ACTOR_ID
            ? makeAdmin({ id: ACTOR_ID, role: 'SUPER_ADMIN' })
            : makeAdmin({ id: TARGET_ID }),
        ),
        retireAllFactors: vi.fn(),
        setStatus: vi.fn().mockResolvedValue(false),
      },
    });

    await expect(
      t.service.setStatus(actor(), TARGET_ID, 'DISABLED', REASON),
    ).rejects.toSatisfy((err) => slugOf(err) === ERR.NOT_FOUND);
  });

  it('notifies the target either way', async () => {
    const t = build();
    await t.service.setStatus(actor(), TARGET_ID, 'DISABLED', REASON);
    expect(t.mail['sendSecurityChanged']).toHaveBeenCalledOnce();
  });
});
