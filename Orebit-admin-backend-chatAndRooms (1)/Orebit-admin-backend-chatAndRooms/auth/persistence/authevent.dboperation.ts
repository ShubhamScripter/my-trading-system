import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';
import type { ClientContext } from '../auth.types';

/**
 * Prisma access for `admin.admin_auth_events` — the authentication audit trail.
 *
 * ═══ WRITE-ONLY, AND IT NEVER THROWS ═══════════════════════════════════════════
 *
 * There is no update and no delete here, because the table is append-only: a row
 * records that something happened, and nothing that happens later makes it not have
 * happened. Reads live in `AdminsDbOperation`, next to the route that serves them.
 *
 * `record` swallows its own failures, which is the one thing about this file worth
 * arguing over. The reasoning: every call site is on the critical path of a sign-in,
 * and the alternative is a service where a full disk or a lock timeout on the AUDIT
 * table refuses a legitimate admin their session. Audit logging that can deny
 * authentication is a denial-of-service vector wearing a compliance hat.
 *
 * The cost is real and worth stating: a dropped write means the review summary
 * undercounts. That is acceptable because nothing GATES on these rows — they inform a
 * human's decision, and the enforcement they sit beside (`failedAttempts`,
 * `lockoutStrikes`) is durable and separate. A failure is logged at `error`, so it is
 * visible without being fatal.
 */

/**
 * The event vocabulary.
 *
 * A closed union in TypeScript over a `VarChar(64)` column, which is the deliberate
 * half-measure: adding a type is one line here rather than a migration, but a typo
 * still fails the build instead of quietly creating a category nothing queries.
 */
export const AUTH_EVENT = {
  /** A password was offered for an address that is not a live admin. The rows that
   *  show enumeration; `adminId` is null on every one of them. */
  UNKNOWN_EMAIL: 'ADMIN_LOGIN_UNKNOWN_EMAIL',
  PASSWORD_FAILURE: 'ADMIN_LOGIN_PASSWORD_FAILURE',
  /**
   * A correct password, on an account that had a failure streak going.
   *
   * The most interesting row in the table, and the reason the success path records
   * anything at all. A streak that ends in a success is an admin who fumbled and then
   * remembered; a streak that ends in a lock is something else. Without this event the
   * two are indistinguishable after the fact, because the counter is cleared either
   * way.
   */
  PASSWORD_SUCCESS_AFTER_FAILURES: 'ADMIN_LOGIN_PASSWORD_SUCCESS_AFTER_FAILURES',
  /** The first lock: ten consecutive failures, one hour. */
  LOCKED: 'ADMIN_LOGIN_LOCKED',
  /** The second lock inside the strike memory. The account is now out of service. */
  REVIEW_OPENED: 'ADMIN_LOGIN_REVIEW_OPENED',
  /** A super admin decided. `metadata.decision` carries which way. */
  REVIEW_RESOLVED: 'ADMIN_LOGIN_REVIEW_RESOLVED',
  /** A super admin created or changed a security-restriction policy. `metadata`
   *  carries the action, the context and the two version numbers — the full before and
   *  after live in `identity.security_restriction_policy_versions`, which retains every
   *  version, so nothing needs to be duplicated into this row. */
  SECURITY_POLICY_UPDATED: 'ADMIN_SECURITY_POLICY_UPDATED',
  /** A super admin created, changed or removed a KYC policy. `metadata` carries the
   *  target and the two version numbers; the full before and after live in
   *  `identity.kyc_policy_versions`, which retains every version including the
   *  tombstone a removal appends. */
  KYC_POLICY_UPDATED: 'ADMIN_KYC_POLICY_UPDATED',
  /**
   * A super admin changed the GLOBAL KYC renewal periods — X and Y.
   *
   * Its own event rather than a policy update, because the reach is categorically
   * different: a policy decides who must verify in one region at one level, whereas
   * these two numbers decide, for EVERY account on the platform, whether what it
   * already proved is still current. Setting a mandatory period where there was none
   * invalidates the entire back book at once, with no grace period.
   *
   * `metadata` carries the two periods and `levelsAffected` / `usersAffected` — the
   * blast radius measured immediately BEFORE the write, so the row records the
   * population the operator actually affected rather than one counted afterwards
   * against the new state.
   *
   * ⚠ THIS ROW IS THE WHOLE RECORD OF THE CHANGE. The renewal configuration keeps no
   * history of itself: `identity.kyc_renewal_settings` holds one row of two nullable
   * periods, and the versions table that once sat beside it was dropped. So "what was X
   * in March" is answerable ONLY from this event stream — which is why the periods
   * themselves are on the metadata and not merely a count of who was affected.
   */
  KYC_RENEWAL_SETTINGS_UPDATED: 'ADMIN_KYC_RENEWAL_SETTINGS_UPDATED',
  /**
   * A super admin READ a user's KYC history.
   *
   * The only read on this surface that is audited, and the reason is the data: KYC
   * history is sensitive personal information about a platform user, so who looked is
   * itself a fact a later review needs.
   *
   * `metadata` carries the FILTER and a count, never the rows — copying returned
   * verification records into the audit table would duplicate the very data the audit
   * exists to govern. `metadata.userId` is a platform identifier rather than an admin
   * one, as `KYC_EXEMPTION_GRANTED` already is; `adminId` on the row remains the ACTOR.
   */
  KYC_HISTORY_VIEWED: 'ADMIN_KYC_HISTORY_VIEWED',
  /**
   * A super admin granted a KYC exemption.
   *
   * Its own event rather than a policy update, because the effect is categorically
   * different: the consumer folds a live exemption into `effectiveLevel` on every
   * evaluation, so this raises ONE ACCOUNT'S standing platform-wide the moment it
   * commits, with nothing attesting anything.
   *
   * `metadata.userId` is the first platform (non-admin) identifier to reach this
   * column. It is not a secret and the review queue that serialises this column is
   * super-admin-only, but it is worth knowing it is there — `adminId` on the row
   * remains the ACTOR, never the subject.
   */
  KYC_EXEMPTION_GRANTED: 'ADMIN_KYC_EXEMPTION_GRANTED',
  KYC_EXEMPTION_REVOKED: 'ADMIN_KYC_EXEMPTION_REVOKED',

  /**
   * A super admin imposed a KYC obligation on one account by hand.
   *
   * The mirror of `KYC_EXEMPTION_GRANTED` and the opposite direction: an exemption
   * RAISES an account's effective level with no provider attesting anything, while a
   * requirement only ever WITHHOLDS standing. It cannot manufacture a verification.
   *
   * `metadata` carries `userId`, `requirementId`, `requiredLevel`, `triggerKey`,
   * `reference`, `created` and `reason`. `created: false` means the obligation already
   * stood and this call adopted it — a successful idempotent retry, not a failure.
   *
   * `adminId` on the row is the ACTOR, as it is for every event here; the SUBJECT is
   * `metadata.userId`.
   */
  KYC_REQUIREMENT_RAISED: 'ADMIN_KYC_REQUIREMENT_RAISED',
  /**
   * A super admin discharged a KYC obligation without the account verifying.
   *
   * ⚠ THIS EVENT IS THE ONLY RECORD OF WHY. `identity.kyc_requirements` has
   * `waived_at` and `waived_by` and no reason column — unlike
   * `kyc_exemptions.revoke_reason` — and the table was deliberately left unchanged
   * rather than migrated for this. So `metadata.reason` here is the sole answer to
   * "why was this waived", and that is the accepted trade: the audit log is
   * independent infrastructure with its own retention, which is where
   * `kyc_renewal_settings` already sends the same question.
   */
  KYC_REQUIREMENT_WAIVED: 'ADMIN_KYC_REQUIREMENT_WAIVED',
  /**
   * A super admin changed what one KYC LEVEL grants.
   *
   * ⚠ THIS ROW IS THE WHOLE RECORD OF THE CHANGE, for `KYC_RENEWAL_SETTINGS_UPDATED`'s
   * reason: `identity.kyc_level_entitlements` holds one row per level and has no
   * companion versions table. Mirroring seventy-one columns into a history table would
   * double every migration and give the live row and its log seventy-one places to
   * drift apart, so the audit stream is the history instead — which is why
   * `metadata` carries the FIELDS THAT CHANGED and their new values rather than only a
   * level and a version.
   *
   * The blast radius is platform-wide but bounded by level: it changes what every
   * account at that level may do, and nothing about what any account HAS PROVED. No
   * statement behind this event can reach a verification, a level state, an exemption
   * or a requirement.
   */
  KYC_ENTITLEMENTS_UPDATED: 'ADMIN_KYC_ENTITLEMENTS_UPDATED',
  /**
   * A super admin changed what it takes to become eligible to reach a KYC level.
   *
   * Separate from `KYC_ENTITLEMENTS_UPDATED` because it is keyed the other way round —
   * by the level TARGETED rather than the level held — and because the consequence is
   * different in kind: lowering a minimum balance opens an upgrade route, it does not
   * widen what anybody may currently do.
   *
   * ⚠ It CANNOT revoke an achievement already earned. `identity.kyc_upgrade_achievements`
   * is insert-only and has no writer in this service at all: an account that once
   * cleared the old threshold stays eligible, and the row it holds records the threshold
   * that was in force when it cleared it. `metadata` therefore carries the new
   * configuration only; what it does NOT do is as important as what it does.
   */
  KYC_UPGRADE_REQUIREMENTS_UPDATED: 'ADMIN_KYC_UPGRADE_REQUIREMENTS_UPDATED',

  /**
   * A super admin added a country to the catalogue. `metadata` carries the ISO code, the
   * name, and the two object keys the row was created with.
   *
   * The keys are recorded because they are the binding between a country and its flags,
   * and this is the only record of which assets were chosen at creation.
   *
   * No migration was needed to add this or the event below: `event_type` is
   * `VarChar(64)` free text precisely so a new event is one line here.
   */
  COUNTRY_CREATED: 'ADMIN_COUNTRY_CREATED',

  /**
   * A super admin uploaded a new image into the country image library. `metadata`
   * carries the object key, the type, the ISO code it was filed under and the normalised
   * byte size — slugs and counts, as the type demands, and nothing that could be an image.
   *
   * Recorded even though NO country is created or changed by it: the upload puts an
   * object in a bucket that every admin can then select from, so it is a change to shared
   * state and the only record of who put it there.
   */
  COUNTRY_IMAGE_UPLOADED: 'ADMIN_COUNTRY_IMAGE_UPLOADED',
} as const;

export type AuthEventType = (typeof AUTH_EVENT)[keyof typeof AUTH_EVENT];

/** Which stage of the ceremony refused. Null on events that are not a refusal. */
export type AuthFailureStage = 'password' | 'otp' | 'mfa' | 'refresh';

export interface AuthEventInput {
  readonly eventType: AuthEventType;
  /** Null when the attempt named an address that is not a live admin. */
  readonly adminId: string | null;
  readonly client: ClientContext;
  readonly failureStage?: AuthFailureStage;
  readonly requestId?: string;
  /**
   * Slugs and counts ONLY.
   *
   * Never a password, an OTP code, a step-up secret or a token. This column is
   * serialised into an API response by `GET /admins/login-reviews`, so a secret
   * landing here is a secret handed to whoever can read the review queue.
   */
  readonly metadata?: Record<string, string | number | boolean | null>;
}

@Injectable()
export class AuthEventDbOperation {
  private readonly logger = new Logger('AuthEvent');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append one event. Never throws — see the class docblock.
   *
   * `void`-returning rather than returning the row: no caller has any use for the id,
   * and handing one back would invite somebody to await it for a reason other than
   * ordering.
   */
  async record(input: AuthEventInput): Promise<void> {
    try {
      await this.prisma.adminAuthEvent.create({
        data: {
          id: uuidv7(),
          adminId: input.adminId,
          eventType: input.eventType,
          ipAddress: input.client.ip,
          ipClass: input.client.ipClass,
          deviceKeyHash: input.client.deviceFingerprint,
          userAgent: input.client.userAgent,
          failureStage: input.failureStage ?? null,
          requestId: input.requestId ?? null,
          metadata: input.metadata ?? {},
        },
      });
    } catch (err) {
      // Logged rather than propagated. A sign-in must not fail because the audit
      // table would not take a row.
      this.logger.error(
        { err, eventType: input.eventType, adminId: input.adminId },
        'failed to record an auth event; continuing',
      );
    }
  }
}
