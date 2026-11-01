import { Injectable, Logger } from '@nestjs/common';
import type { Admin } from '@prisma/client';
import { REVOKE_REASON } from '../../auth/auth.types';
import type { Principal } from '../../auth/auth.types';
import { AUTH_EVENT, AuthEventDbOperation } from '../../auth/auth.dboperation';
import { SessionService } from '../../auth/services/session.service';
import { toAdminPayload } from '../../auth/auth.dto';
import { toPublicAdmin } from '../../auth/auth.utility';
import type { ClientContext } from '../../auth/auth.types';
import { MailService } from '../mail/mail.service';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import { AdminsDbOperation, type LoginReviewRow } from './admins.dboperation';
import type {
  LoginReviewListPayload,
  LoginReviewPayload,
  LoginReviewQuery,
} from './admins.dto';
import { ADMIN_SELF_TARGET_ALLOWED, type AdminAction } from './admins.types';

/**
 * ═══ ADMINISTERING OTHER ADMINS ════════════════════════════════════════════
 *
 * The recovery path finding B5 identified, and the two status writes that went with
 * it. Before this, an admin who lost their authenticator was recovered by a manual
 * UPDATE on the production database — unauditable, unbounded, and performed with a
 * psql prompt open on live data. That is the exact operation an admin panel exists
 * to remove.
 *
 * ─── The three properties that make this safe to have at all ───────────────
 *
 * 1. SUPER_ADMIN only. Enforced here, not at the route, because it depends on the
 *    freshly-read database row rather than the token's `rol` claim — an access token
 *    lives fifteen minutes and its role may be stale, and a demoted admin must not
 *    keep administrative reach until their token expires.
 *
 * 2. A fresh second-factor proof per action, bound to that action's own name from
 *    `ADMIN_ELEVATION` and consumed by one spend. So a proof given to re-enable one
 *    account is not a proof to reset another's factors.
 *
 *    Spent in `AdminsController`, not by `ElevationGuard`: the action is in the body,
 *    and `@RequiresElevation(...)` is handler metadata that can name only one action
 *    per route. Same arrangement as `POST /2fa`, and the split is documented in
 *    src/2fa/elevation.ts.
 *
 * 3. The target is always told. Every action here changes what someone else can do
 *    with their own account, so it ends with mail to them. An administrative action
 *    that could be taken silently is one a compromised admin session could take
 *    silently.
 *
 * ─── What is deliberately NOT here ────────────────────────────────────────
 *
 * No route grants or revokes SUPER_ADMIN. That is the one privilege whose escalation
 * would be total, and there is no design yet for who may grant it to whom — so it
 * stays a `db:seed` operation rather than becoming an endpoint by momentum. See
 * db/seed.ts.
 *
 * No route creates an admin. Same reason, and the same note is in the seed script:
 * an invite flow needs its own token lifetime, its own rate limits, and a decision
 * about who may invite whom.
 */
@Injectable()
export class AdminsService {
  private readonly logger = new Logger('AdminsService');

  constructor(
    private readonly admins: AdminsDbOperation,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    private readonly events: AuthEventDbOperation,
  ) {}

  /**
   * Empty a target's second-factor set, revoke their sessions, and tell them.
   *
   * ─── The order is load-bearing ─────────────────────────────────────────────
   *
   * Factors first, then sessions. The reverse would leave a window in which the
   * target still holds a live session and a live factor — so they could re-enrol a
   * replacement mid-reset and the recovery would silently not have happened.
   *
   * Revoking is not optional politeness either. The reason to reset a factor set is
   * usually that the device holding it is lost or compromised, and a live session on
   * that device outlives the factor by up to twelve hours otherwise.
   */
  async resetFactors(
    actor: Principal,
    targetId: string,
    reason: string,
  ): Promise<{ admin: Admin; retired: { totp: number; passkey: number } }> {
    const target = await this.authorise(actor, targetId, 'reset-factors');

    const retired = await this.admins.retireAllFactors(target.id);
    await this.sessions.revokeAllForAdmin(target.id, REVOKE_REASON.LOGOUT_ALL);

    // WARN, not INFO. This is the single most powerful action in the service: it
    // makes an account signable-into by whoever next completes enrollment on it, so
    // it should be visible in a log filtered to warnings and above.
    this.logger.warn(
      {
        actorAdminId: actor.adminId,
        targetAdminId: target.id,
        retiredTotp: retired.totp,
        retiredPasskeys: retired.passkey,
        reason,
      },
      'second factors reset by a super admin; target sessions revoked',
    );

    // The target is told, always. If this action was taken by someone who stole an
    // admin session, this mail is the only thing that surfaces it.
    await this.mail.sendSecurityChanged(
      target.email,
      'Your second factor was reset by an administrator. Your next sign-in will ask you to set up a new one.',
    );

    // `mfaEnrolledAt: null` rather than the row as it was READ.
    //
    // `target` was loaded before the retirement, so echoing it verbatim reports
    // `mfaEnrolled: true` for an account that no longer has a factor — which is
    // precisely the confusion `retireAllFactors` nulls the column to avoid, handed
    // straight back to the operator who just performed the reset. Re-reading would
    // also work; overriding the one field that changed is cheaper and says what
    // changed. Same shape as `setStatus` below.
    return { admin: { ...target, mfaEnrolledAt: null }, retired };
  }

  /** Take an account out of service, or put it back. */
  async setStatus(
    actor: Principal,
    targetId: string,
    status: 'ACTIVE' | 'DISABLED',
    reason: string | undefined,
  ): Promise<Admin> {
    const action: AdminAction = status === 'DISABLED' ? 'disable' : 'enable';
    const target = await this.authorise(actor, targetId, action);

    if (!(await this.admins.setStatus(target.id, status))) {
      throw new ProblemException({ type: ERR.NOT_FOUND });
    }

    // Sessions die with the account. Without this a disabled admin keeps working
    // until their refresh token expires — `rotate` does re-check status, but their
    // fifteen-minute access token does not go through it.
    if (status === 'DISABLED') {
      await this.sessions.revokeAllForAdmin(target.id, REVOKE_REASON.LOGOUT_ALL);
    }

    this.logger.warn(
      { actorAdminId: actor.adminId, targetAdminId: target.id, status, reason },
      'admin status changed by a super admin',
    );

    await this.mail.sendSecurityChanged(
      target.email,
      status === 'DISABLED'
        ? 'Your administrator account has been disabled.'
        : 'Your administrator account has been re-enabled.',
    );

    return { ...target, status };
  }

  // --- the manual-review queue ----------------------------------------------

  /**
   * The accounts the lockout ladder has taken out of service, and the evidence.
   *
   * === WHY THIS IS A READ WITH NO ELEVATION TICKET ===========================
   *
   * Every other method in this file mutates somebody else's account and demands a
   * fresh second-factor proof for that specific action. This one changes nothing. The
   * gate is a full session plus SUPER_ADMIN, which is the same bar `GET /2fa` sets,
   * and demanding a passkey tap to LOOK at a queue would mostly train people to keep a
   * ticket warm.
   *
   * What it does still owe is discretion about what it returns - see `toReviewPayload`.
   */
  async listLoginReviews(
    actor: Principal,
    query: LoginReviewQuery,
  ): Promise<LoginReviewListPayload> {
    await this.assertSuperAdmin(actor, 'resolve-login-review');

    const cursor = decodeCursor(query.cursor);
    const rows = await this.admins.listLoginReviews(query.status, query.limit, cursor);

    // The dboperation fetched `limit + 1` so that "there is more" is answerable
    // without a second query. The extra row is evidence, not content.
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];

    return {
      reviews: page.map(toReviewPayload),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ disabledAt: last.loginDisabledAt, id: last.id })
          : null,
    };
  }

  /**
   * === PUT AN ACCOUNT BACK IN SERVICE, OR LEAVE IT OUT ======================
   *
   * The human half of the lockout ladder. The system can suspend an account on
   * evidence; only a person can decide what the evidence meant.
   *
   * The target is NOT re-authenticated into anything by this call. An ENABLE clears
   * their lockout state and restores `status`, and that is all: every session was
   * revoked when the review opened, so their next sign-in is a fresh password + email
   * OTP + MFA ceremony by construction. Nothing here needs to enforce that, and it is
   * worth saying so, because "and then force a full sign-in" looks like a missing step
   * rather than a property of the state we are already in.
   */
  async resolveLoginReview(
    actor: Principal,
    input: {
      readonly adminId: string;
      readonly decision: 'ENABLE' | 'KEEP_DISABLED';
      readonly reason: string;
      readonly expectedVersion: number;
    },
    client: ClientContext,
  ): Promise<{ admin: Admin; decision: 'ENABLE' | 'KEEP_DISABLED'; reviewVersion: number }> {
    const target = await this.authorise(actor, input.adminId, 'resolve-login-review');

    if (target.loginReviewStatus !== 'PENDING') {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'That administrator has no review awaiting a decision.',
      });
    }

    const { ok, reviewVersion } = await this.admins.resolveLoginReview({
      adminId: target.id,
      expectedVersion: input.expectedVersion,
      decision: input.decision,
      reviewedBy: actor.adminId,
      reason: input.reason,
    });

    if (!ok) {
      // Lost the compare-and-swap. Reported as a VALIDATION failure on the offending
      // field rather than a 409, because from the caller's side this is a stale
      // payload: they sent a version that is no longer current, and the fix is to
      // re-read the queue. Same shape as the self-target refusal below.
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          {
            path: 'expectedVersion',
            message:
              'This review has changed since you read it - another super admin may ' +
              'have already decided it. Re-read the queue and try again.',
          },
        ],
      });
    }

    const enabled = input.decision === 'ENABLE';

    // WARN rather than INFO, like `resetFactors`. An ENABLE makes an account that the
    // system suspended on evidence signable-into again; a KEEP_DISABLED is the record
    // that somebody looked and decided not to. Both belong in a log filtered to
    // warnings.
    this.logger.warn(
      {
        actorAdminId: actor.adminId,
        targetAdminId: target.id,
        decision: input.decision,
        reason: input.reason,
      },
      'login review resolved by a super admin',
    );

    await this.events.record({
      eventType: AUTH_EVENT.REVIEW_RESOLVED,
      adminId: target.id,
      client,
      metadata: { decision: input.decision, resolvedBy: actor.adminId },
    });

    // The target is told, always - invariant #3 in the class docblock. This mail
    // matters more here than anywhere else in the file: if the suspension was a real
    // attack, the account's owner has been locked out with no explanation, and this is
    // the message that tells them what happened and that it is over.
    await this.mail.sendSecurityChanged(
      target.email,
      enabled
        ? 'Your administrator account was suspended after repeated failed sign-ins and ' +
            'has now been restored by a super administrator. Your next sign-in will ask ' +
            'for your password, an emailed code, and your second factor.'
        : 'Your administrator account remains suspended after a review of repeated ' +
            'failed sign-ins. Contact a super administrator.',
    );

    return {
      // Echo what changed rather than re-reading. Same shape as `setStatus`.
      admin: {
        ...target,
        status: enabled ? 'ACTIVE' : target.status,
        loginReviewStatus: enabled ? 'RESOLVED' : 'REJECTED',
        reviewVersion,
      },
      decision: input.decision,
      reviewVersion,
    };
  }

  /**
   * The role half of `authorise`, on its own.
   *
   * Extracted so the read-only list route can reuse it. The alternative - calling
   * `authorise` with the actor's own id as the target - would be wrong twice over: it
   * would run the self-target refusal against a call that has no target, and it would
   * load an admin row nobody needs.
   *
   * The role is read from the DATABASE, not from `actor.role`. An access token lives
   * fifteen minutes and carries a `rol` claim that may be stale, so trusting it would
   * give a demoted admin administrative reach for the rest of their token's life.
   * `GET /auth/me` re-reads for the same reason.
   *
   * The actor's own status is checked too, and that is what refuses a super admin who
   * is themselves under review: the suspension sets `status = 'DISABLED'`, so their
   * unexpired access token cannot be used to resolve their own case.
   */
  private async assertSuperAdmin(actor: Principal, action: AdminAction): Promise<Admin> {
    const self = await this.admins.findById(actor.adminId);

    if (self === null || self.status !== 'ACTIVE') {
      throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    }

    if (self.role !== 'SUPER_ADMIN') {
      this.logger.warn(
        { actorAdminId: actor.adminId, role: self.role, action },
        'administrative action refused: caller is not a super admin',
      );
      throw new ProblemException({
        type: ERR.FORBIDDEN,
        detail: 'Only a super admin may administer other administrators.',
      });
    }

    return self;
  }

  /**
   * ═══ THE ONE GATE EVERY ACTION IN THIS FILE GOES THROUGH ═══════════════════
   *
   * Four checks, in this order, and each one's position matters.
   *
   * The role is read from the DATABASE, not from `actor.role`. An access token lives
   * fifteen minutes and carries a `rol` claim that may be stale, so trusting it
   * would give a demoted admin administrative reach for the rest of their token's
   * life. `GET /auth/me` re-reads for the same reason.
   *
   * The actor's own status is checked too. A disabled account's unexpired access
   * token must not still administer the platform.
   *
   * Self-targeting is refused before the target is even loaded — see
   * `ADMIN_SELF_TARGET_ALLOWED` for why per action.
   *
   * The target is resolved last, and a missing one answers `not_found`. That does
   * disclose whether an admin id exists, and unlike the unauthenticated routes that
   * is fine: the caller is a proven SUPER_ADMIN who can list admins anyway.
   */
  private async authorise(
    actor: Principal,
    targetId: string,
    action: AdminAction,
  ): Promise<Admin> {
    await this.assertSuperAdmin(actor, action);

    if (targetId === actor.adminId && !ADMIN_SELF_TARGET_ALLOWED[action]) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        errors: [
          {
            path: 'adminId',
            message:
              `"${action}" may not target your own account. Manage your own factors ` +
              'through POST /2fa, which refuses to remove your last one.',
          },
        ],
      });
    }

    const target = await this.admins.findById(targetId);
    if (target === null) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'No such administrator.' });
    }

    return target;
  }
}

// --- review serialisation ----------------------------------------------------

/**
 * One database row, narrowed to what may cross the API boundary.
 *
 * === WHAT IS DELIBERATELY DROPPED ==========================================
 *
 * The IP addresses and device tags themselves. The summary carries COUNTS of distinct
 * values, which is what a reviewer actually needs - "was this one actor or forty?" -
 * and handing over the values would turn the review queue into a way to read the
 * authentication audit trail for any suspended account.
 *
 * `toAdminPayload(toPublicAdmin(...))` for the account itself, so this route discloses
 * exactly what every other route discloses about an admin and cannot drift from it.
 * `toPublicAdmin` lists its fields explicitly, so a column added to `Admin` later is
 * absent here until somebody adds it on purpose.
 */
function toReviewPayload(row: LoginReviewRow): LoginReviewPayload {
  return {
    admin: toAdminPayload(
      toPublicAdmin({
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        status: row.status,
        emailVerifiedAt: row.emailVerifiedAt,
        mfaEnrolledAt: row.mfaEnrolledAt,
        createdAt: row.createdAt,
        // Not selected by the query and not read by `toPublicAdmin`. Present because
        // the parameter is typed `Admin`, and stated here rather than cast away so
        // that a future field `toPublicAdmin` DOES read fails to compile instead of
        // silently serialising a placeholder.
        emailLower: row.email.toLowerCase(),
        lastSeenAt: null,
        deletedAt: null,
        loginReviewStatus: row.loginReviewStatus,
        loginDisabledAt: row.loginDisabledAt,
        loginDisabledReason: null,
        reviewVersion: row.reviewVersion,
        reviewedAt: row.reviewedAt,
        reviewedBy: null,
        reviewReason: row.reviewReason,
      }),
    ),
    reviewStatus: row.loginReviewStatus,
    reviewVersion: row.reviewVersion,
    disabledAt: row.loginDisabledAt,
    disabledReason: row.loginDisabledReason,
    reviewedAt: row.reviewedAt,
    reviewReason: row.reviewReason,
    failureSummary: {
      // Postgres COUNT(*) is int8 and arrives as BigInt. Narrowed here rather than at
      // the query, because `JSON.stringify` throws on a BigInt - so leaving one in the
      // payload is a 500 on the response, not a wrong number.
      accountFailures: Number(row.accountFailures),
      distinctIps: Number(row.distinctIps),
      distinctDevices: Number(row.distinctDevices),
      lastFailureAt: row.lastFailureAt,
    },
  };
}

/**
 * The keyset cursor, base64url.
 *
 * Encoded rather than handed over as two plain fields so that it reads as opaque and
 * clients do not start constructing their own. It is NOT a security boundary and is
 * not signed: everything in it is already in the response body, and a caller who
 * forges one can page to a position they could reach anyway. `decodeCursor` therefore
 * only has to be total, not suspicious - a malformed value starts from the beginning
 * rather than throwing, because a stale cursor is a client bug that should degrade to
 * a first page.
 */
function encodeCursor(cursor: { disabledAt: Date | null; id: string }): string {
  return Buffer.from(
    JSON.stringify({ d: cursor.disabledAt?.toISOString() ?? null, i: cursor.id }),
  ).toString('base64url');
}

function decodeCursor(raw: string | undefined): { disabledAt: Date | null; id: string } | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      d: string | null;
      i: string;
    };
    if (typeof parsed.i !== 'string' || parsed.i === '') return null;
    return { disabledAt: parsed.d === null ? null : new Date(parsed.d), id: parsed.i };
  } catch {
    return null;
  }
}
