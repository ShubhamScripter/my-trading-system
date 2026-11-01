import { describe, expect, it, vi } from 'vitest';
import { AdminsService } from '../../src/admins/admins.service';
import {
  ADMIN_ACTIONS,
  ADMIN_ELEVATION,
  ADMIN_SELF_TARGET_ALLOWED,
} from '../../src/admins/admins.types';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { makeAdmin } from '../harness';

/**
 * ═══ THE HUMAN HALF OF THE LOCKOUT LADDER ══════════════════════════════════
 *
 * The system can suspend an account on evidence. Only a person can decide what the
 * evidence meant, and this is the surface that person uses.
 *
 * The tests here are about the GATE and the DISCLOSURE rather than the mechanics. If
 * one fails, the question is not "how do I fix the test" but one of:
 *
 *   - did a non-super-admin, or a stale token, just reach another admin's suspension?
 *   - did a suspended super admin just resolve their own case?
 *   - did two reviewers just both act, with the second silently overwriting the first?
 *   - did the review queue just hand somebody a password hash?
 */

const ACTOR_ID = '01920000-0000-7000-8000-00000000a001';
const TARGET_ID = '01920000-0000-7000-8000-00000000a002';

function actor(sessionId = 'session-1') {
  // A distinct family per session id, so a test keyed on the wrong identifier fails
  // rather than passing by coincidence.
  return { adminId: ACTOR_ID, sessionId, familyId: `fam-${sessionId}`, role: 'SUPER_ADMIN' as const };
}

function ctx() {
  return {
    ip: '203.0.113.7',
    ipClass: '203.0.113.0/24',
    deviceFingerprint: 'f'.repeat(32),
    userAgent: 'vitest',
  };
}

/** A pending review on the target, which is the state every resolve test starts from. */
function pendingTarget() {
  return makeAdmin({
    id: TARGET_ID,
    email: 'target@orebit.io',
    role: 'ADMIN',
    status: 'DISABLED',
    loginReviewStatus: 'PENDING',
    loginDisabledAt: new Date('2026-09-01T10:00:00.000Z'),
    loginDisabledReason: 'REPEATED_PASSWORD_LOCKOUT',
    reviewVersion: 3,
  });
}

/** One row as the raw query returns it, counts included. */
function reviewRow(overrides: Record<string, unknown> = {}) {
  const t = pendingTarget();
  return {
    id: t.id,
    email: t.email,
    name: t.name,
    role: t.role,
    status: t.status,
    emailVerifiedAt: t.emailVerifiedAt,
    mfaEnrolledAt: t.mfaEnrolledAt,
    createdAt: t.createdAt,
    loginReviewStatus: 'PENDING' as const,
    loginDisabledAt: t.loginDisabledAt,
    loginDisabledReason: 'REPEATED_PASSWORD_LOCKOUT',
    reviewVersion: 3,
    reviewedAt: null,
    reviewReason: null,
    accountFailures: 20n,
    distinctIps: 7n,
    distinctDevices: 4n,
    lastFailureAt: new Date('2026-09-01T09:59:00.000Z'),
    ...overrides,
  };
}

interface Doubles {
  admins: Record<string, ReturnType<typeof vi.fn>>;
  sessions: Record<string, ReturnType<typeof vi.fn>>;
  mail: Record<string, ReturnType<typeof vi.fn>>;
  events: Record<string, ReturnType<typeof vi.fn>>;
}

function build(overrides: Partial<Doubles> = {}) {
  const self = makeAdmin({ id: ACTOR_ID, role: 'SUPER_ADMIN', status: 'ACTIVE' });
  const target = pendingTarget();

  const doubles: Doubles = {
    admins: {
      findById: vi.fn(async (id: string) => (id === ACTOR_ID ? self : target)),
      listLoginReviews: vi.fn().mockResolvedValue([reviewRow()]),
      resolveLoginReview: vi.fn().mockResolvedValue({ ok: true, reviewVersion: 4 }),
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

const RESOLVE = {
  adminId: TARGET_ID,
  decision: 'ENABLE' as const,
  reason: 'Confirmed with the account owner by phone; they were locked out by a typo.',
  expectedVersion: 3,
};

function slugOf(err: unknown): string {
  return err instanceof ProblemException ? err.type : `unexpected: ${String(err)}`;
}

async function refusal(fn: () => Promise<unknown>): Promise<ProblemException> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProblemException) return err;
    throw err;
  }
  throw new Error('did not throw');
}

describe('the action table', () => {
  it('declares the action', () => {
    expect(ADMIN_ACTIONS).toContain('resolve-login-review');
  });

  /**
   * ONE elevation action per administrative action, never a shared `admin.write`. A
   * shared value would make a proof given to re-enable one account sufficient to
   * resolve a different one's review.
   */
  it('has its own elevation action, distinct from every other', () => {
    expect(ADMIN_ELEVATION['resolve-login-review']).toBe('admin.login-review.resolve');
    const all = Object.values(ADMIN_ELEVATION);
    expect(new Set(all).size).toBe(all.length);
  });

  /** Namespaced, so it cannot collide with the bare factor actions on `POST /2fa`. */
  it('is namespaced under admin.', () => {
    expect(ADMIN_ELEVATION['resolve-login-review']).toMatch(/^admin\./);
  });

  /**
   * ═══ SELF-RESOLUTION WOULD BE THE REVIEW NOT HAPPENING ═════════════════════
   *
   * The whole mechanism exists to put a human OTHER THAN THE ACCOUNT HOLDER between a
   * repeatedly-locked account and being signable-into again. A super admin resolving
   * their own review is that person re-enabling themselves on their own authority.
   */
  it('may not target the caller', () => {
    expect(ADMIN_SELF_TARGET_ALLOWED['resolve-login-review']).toBe(false);
  });
});

describe('the gate', () => {
  it('refuses a caller who is not a super admin', async () => {
    const { service } = build({
      admins: {
        findById: vi.fn(async (id: string) =>
          id === ACTOR_ID ? makeAdmin({ id: ACTOR_ID, role: 'ADMIN' }) : pendingTarget(),
        ),
      },
    });

    expect(slugOf(await refusal(() => service.resolveLoginReview(actor(), RESOLVE, ctx())))).toBe(
      ERR.FORBIDDEN,
    );
  });

  /** The list is gated too. A read that leaks the review queue to any admin would
   *  disclose which of their colleagues is locked out and how hard they were attacked. */
  it('refuses the list to a caller who is not a super admin', async () => {
    const { service } = build({
      admins: {
        findById: vi.fn().mockResolvedValue(makeAdmin({ id: ACTOR_ID, role: 'ADMIN' })),
      },
    });

    expect(
      slugOf(await refusal(() => service.listLoginReviews(actor(), { status: 'PENDING', limit: 20 }))),
    ).toBe(ERR.FORBIDDEN);
  });

  /**
   * The role is read from the DATABASE, not from `actor.role`. An access token lives
   * fifteen minutes and its `rol` claim may be stale, so trusting it would hand a
   * demoted admin this reach for the rest of their token's life.
   */
  it('reads the role from the database, not the token', async () => {
    const { service, admins } = build({
      admins: {
        findById: vi.fn(async (id: string) =>
          id === ACTOR_ID ? makeAdmin({ id: ACTOR_ID, role: 'ADMIN' }) : pendingTarget(),
        ),
      },
    });

    // The principal CLAIMS super admin; the row says otherwise, and the row wins.
    await refusal(() => service.resolveLoginReview(actor(), RESOLVE, ctx()));

    expect(admins.findById).toHaveBeenCalledWith(ACTOR_ID);
  });

  /**
   * === A SUSPENDED SUPER ADMIN CANNOT RESOLVE THEIR OWN CASE ================
   *
   * Not hypothetical. A review revokes the target's sessions, but an access token
   * minted moments before the second lock still authenticates for up to fifteen
   * minutes — so the window in which a suspended super admin could call this route is
   * real. Their own `status` is DISABLED, and that is what refuses them.
   */
  it('refuses an actor whose own account is not active', async () => {
    const { service } = build({
      admins: {
        findById: vi.fn().mockResolvedValue(
          makeAdmin({
            id: ACTOR_ID,
            role: 'SUPER_ADMIN',
            status: 'DISABLED',
            loginReviewStatus: 'PENDING',
          }),
        ),
      },
    });

    expect(slugOf(await refusal(() => service.resolveLoginReview(actor(), RESOLVE, ctx())))).toBe(
      ERR.UNAUTHENTICATED,
    );
  });

  it('refuses a self-targeted resolve', async () => {
    const { service } = build();

    const problem = await refusal(() =>
      service.resolveLoginReview(actor(), { ...RESOLVE, adminId: ACTOR_ID }, ctx()),
    );

    expect(problem.type).toBe(ERR.VALIDATION_FAILED);
    expect(problem.errors?.[0]?.path).toBe('adminId');
  });

  /** An account with no pending review is not something to decide. */
  it('refuses a target that has no review awaiting a decision', async () => {
    const { service } = build({
      admins: {
        findById: vi.fn(async (id: string) =>
          id === ACTOR_ID
            ? makeAdmin({ id: ACTOR_ID, role: 'SUPER_ADMIN' })
            : makeAdmin({ id: TARGET_ID, loginReviewStatus: null }),
        ),
      },
    });

    expect(slugOf(await refusal(() => service.resolveLoginReview(actor(), RESOLVE, ctx())))).toBe(
      ERR.NOT_FOUND,
    );
  });
});

describe('optimistic concurrency', () => {
  /**
   * ═══ TWO REVIEWERS, ONE QUEUE ══════════════════════════════════════════════
   *
   * The review list is shared work. Two super admins can be looking at the same
   * pending row, and without a version the second write silently overwrites the first
   * — including in the direction that re-enables an account the first person had just
   * decided to keep disabled. That is the failure this guards, and it is silent
   * without the check.
   */
  it('refuses a stale expectedVersion', async () => {
    const { service } = build({
      admins: {
        findById: vi.fn(async (id: string) =>
          id === ACTOR_ID ? makeAdmin({ id: ACTOR_ID, role: 'SUPER_ADMIN' }) : pendingTarget(),
        ),
        resolveLoginReview: vi.fn().mockResolvedValue({ ok: false, reviewVersion: 3 }),
      },
    });

    const problem = await refusal(() => service.resolveLoginReview(actor(), RESOLVE, ctx()));

    expect(problem.type).toBe(ERR.VALIDATION_FAILED);
    expect(problem.errors?.[0]?.path).toBe('expectedVersion');
  });

  /** And says what to do about it, since the fix is a re-read rather than a retry. */
  it('tells the caller to re-read the queue', async () => {
    const { service } = build({
      admins: {
        findById: vi.fn(async (id: string) =>
          id === ACTOR_ID ? makeAdmin({ id: ACTOR_ID, role: 'SUPER_ADMIN' }) : pendingTarget(),
        ),
        resolveLoginReview: vi.fn().mockResolvedValue({ ok: false, reviewVersion: 3 }),
      },
    });

    const problem = await refusal(() => service.resolveLoginReview(actor(), RESOLVE, ctx()));

    expect(problem.errors?.[0]?.message).toMatch(/re-read/i);
  });

  it('passes the version the caller supplied to the compare-and-swap', async () => {
    const { service, admins } = build();

    await service.resolveLoginReview(actor(), RESOLVE, ctx());

    expect(admins.resolveLoginReview).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 3, adminId: TARGET_ID, reviewedBy: ACTOR_ID }),
    );
  });

  /** The new version comes back, so a client holding the list can update its row
   *  rather than re-fetching — and so a second resolve on stale state is refused. */
  it('reports the version after the write', async () => {
    const { service } = build();
    const result = await service.resolveLoginReview(actor(), RESOLVE, ctx());
    expect(result.reviewVersion).toBe(4);
  });
});

describe('ENABLE', () => {
  it('reports the account as active and the review as resolved', async () => {
    const { service } = build();

    const result = await service.resolveLoginReview(actor(), RESOLVE, ctx());

    expect(result.admin.status).toBe('ACTIVE');
    expect(result.admin.loginReviewStatus).toBe('RESOLVED');
    expect(result.decision).toBe('ENABLE');
  });

  /**
   * The target is TOLD, always — invariant #3 of this service. It matters more here
   * than anywhere else in the module: if the suspension was a real attack, the
   * account's owner has been locked out with no explanation, and this is the message
   * that tells them what happened and that it is over.
   */
  it('tells the target, and says a full sign-in is next', async () => {
    const { service, mail } = build();

    await service.resolveLoginReview(actor(), RESOLVE, ctx());

    const [to, body] = mail['sendSecurityChanged']?.mock.calls[0] as [string, string];
    expect(to).toBe('target@orebit.io');
    expect(body).toMatch(/restored/i);
    expect(body).toMatch(/second factor/i);
  });

  it('records the decision in the audit trail', async () => {
    const { service, events } = build();

    await service.resolveLoginReview(actor(), RESOLVE, ctx());

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ADMIN_LOGIN_REVIEW_RESOLVED',
        adminId: TARGET_ID,
        metadata: { decision: 'ENABLE', resolvedBy: ACTOR_ID },
      }),
    );
  });
});

describe('KEEP_DISABLED', () => {
  const keep = { ...RESOLVE, decision: 'KEEP_DISABLED' as const };

  /** The account stays out of service. Only the review is closed. */
  it('leaves the account disabled', async () => {
    const { service } = build();

    const result = await service.resolveLoginReview(actor(), keep, ctx());

    expect(result.admin.status).toBe('DISABLED');
    expect(result.admin.loginReviewStatus).toBe('REJECTED');
  });

  it('still tells the target', async () => {
    const { service, mail } = build();

    await service.resolveLoginReview(actor(), keep, ctx());

    const [, body] = mail['sendSecurityChanged']?.mock.calls[0] as [string, string];
    expect(body).toMatch(/remains suspended/i);
  });

  it('records the decision', async () => {
    const { service, events } = build();

    await service.resolveLoginReview(actor(), keep, ctx());

    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { decision: 'KEEP_DISABLED', resolvedBy: ACTOR_ID } }),
    );
  });
});

describe('the review queue', () => {
  it('returns the failure summary a decision needs', async () => {
    const { service } = build();

    const { reviews } = await service.listLoginReviews(actor(), { status: 'PENDING', limit: 20 });

    expect(reviews[0]?.failureSummary).toEqual({
      accountFailures: 20,
      distinctIps: 7,
      distinctDevices: 4,
      lastFailureAt: new Date('2026-09-01T09:59:00.000Z'),
    });
  });

  /**
   * The counts arrive from Postgres as BigInt, because `COUNT(*)` is `int8`. Narrowed
   * to numbers before they reach the payload — `JSON.stringify` THROWS on a BigInt, so
   * leaving one in would be a 500 on the response rather than a wrong number.
   */
  it('narrows the bigint counts so the response can serialise', async () => {
    const { service } = build();

    const { reviews } = await service.listLoginReviews(actor(), { status: 'PENDING', limit: 20 });

    expect(typeof reviews[0]?.failureSummary.accountFailures).toBe('number');
    expect(() => JSON.stringify(reviews)).not.toThrow();
  });

  /**
   * ═══ WHAT THE QUEUE MUST NOT DISCLOSE ══════════════════════════════════════
   *
   * No hashes, and no raw addresses. The summary carries COUNTS of distinct IPs and
   * devices — which is what a reviewer actually needs, "was this one actor or forty?"
   * — and handing over the values themselves would turn the review queue into a way to
   * read the authentication audit trail for any suspended account.
   */
  it('discloses no secrets and no raw addresses', async () => {
    const { service } = build();

    const { reviews } = await service.listLoginReviews(actor(), { status: 'PENDING', limit: 20 });
    const serialised = JSON.stringify(reviews);

    for (const forbidden of ['passwordHash', 'codeHash', 'stepUpSecretHash', 'emailLower']) {
      expect(serialised).not.toContain(forbidden);
    }
    expect(serialised).not.toContain('203.0.113');
    expect(serialised).not.toContain('ip_class');
  });

  /** The version travels with the row, because the resolve call needs it and a client
   *  that had to guess would race every time. */
  it('carries the review version for the resolve call', async () => {
    const { service } = build();

    const { reviews } = await service.listLoginReviews(actor(), { status: 'PENDING', limit: 20 });

    expect(reviews[0]?.reviewVersion).toBe(3);
  });

  /**
   * `limit + 1` is fetched so "there is more" is answerable without a second query.
   * The extra row is evidence, not content, and must not appear in the page.
   */
  it('does not leak the lookahead row into the page', async () => {
    const rows = [reviewRow({ id: 'a' }), reviewRow({ id: 'b' }), reviewRow({ id: 'c' })];
    const { service } = build({
      admins: {
        findById: vi.fn().mockResolvedValue(makeAdmin({ id: ACTOR_ID, role: 'SUPER_ADMIN' })),
        listLoginReviews: vi.fn().mockResolvedValue(rows),
      },
    });

    const page = await service.listLoginReviews(actor(), { status: 'PENDING', limit: 2 });

    expect(page.reviews).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  /** A short page is the last page, and says so rather than offering a cursor that
   *  would return nothing. */
  it('reports no cursor on the last page', async () => {
    const { service } = build();

    const page = await service.listLoginReviews(actor(), { status: 'PENDING', limit: 20 });

    expect(page.nextCursor).toBeNull();
  });

  /** A malformed cursor starts from the beginning rather than throwing. It is not a
   *  security boundary — everything in it is already in the response — so a stale one
   *  should degrade to a first page rather than 500. */
  it('treats an unreadable cursor as no cursor', async () => {
    const { service, admins } = build();

    await service.listLoginReviews(actor(), {
      status: 'PENDING',
      limit: 20,
      cursor: 'not-valid-base64url-json',
    });

    expect(admins.listLoginReviews).toHaveBeenCalledWith('PENDING', 20, null);
  });

  /** The status filter reaches the query rather than being applied in memory. */
  it('passes the requested status through', async () => {
    const { service, admins } = build();

    await service.listLoginReviews(actor(), { status: 'REJECTED', limit: 5 });

    expect(admins.listLoginReviews).toHaveBeenCalledWith('REJECTED', 5, null);
  });
});
