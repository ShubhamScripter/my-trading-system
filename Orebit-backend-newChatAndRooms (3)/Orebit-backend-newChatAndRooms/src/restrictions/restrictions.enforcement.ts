import { Injectable } from '@nestjs/common';
import type { UserFeatureRestriction } from '@prisma/client';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import { RestrictionDbOperation } from './restrictions.dboperation';

/**
 * ═══ THE ONE PLACE A FEATURE IS REFUSED ════════════════════════════════════
 *
 * Every future feature API asks this and nothing else. There is no second query, no
 * per-service copy of the expiry arithmetic, and no way for two features to disagree
 * about whether a restriction is live.
 *
 * The shape mirrors `RecentSecurityChangePolicy`: one injectable, one `assert…`
 * method, one error with a `retryAfterSeconds` the client can act on. A caller that
 * wants a decision rather than an exception uses `check`.
 */

/** What a live restriction means to a caller, with the arithmetic already done. */
export interface RestrictionVerdict {
  readonly restricted: boolean;
  /** Seconds until the LAST live restriction on this target ends. 0 when allowed. */
  readonly retryAfterSeconds: number;
  /** The same instant as an ISO string, or null when allowed. */
  readonly availableAt: string | null;
}

const ALLOWED: RestrictionVerdict = { restricted: false, retryAfterSeconds: 0, availableAt: null };

/**
 * Seconds until every live restriction in `rows` has ended.
 *
 * ═══ THE LATEST DEADLINE WINS — NEVER THE SUM, NEVER THE LAST WRITE ════════
 *
 * Pure, so the rule is testable without a database, and stated as `max` for two
 * reasons that are both security properties:
 *
 * SUMMING would let repeated sensitive actions compound toward an effectively
 * permanent lock, which is a denial of service a user could inflict on themselves —
 * or an attacker could inflict on a victim by repeatedly triggering cheap actions.
 *
 * TAKING THE MOST RECENT would let a later, SHORTER restriction shorten an earlier
 * long one. That is the dangerous direction: an attacker who has just triggered a
 * 24-hour freeze could perform a second action configured for 30 minutes and walk out
 * of the first one. `max` makes every restriction a floor that nothing can lower.
 *
 * Rounded UP, matching `securityCooldownRemainingSeconds`: a caller told "1 second"
 * who retries in one second must not be refused again.
 */
export function remainingSeconds(
  rows: readonly Pick<UserFeatureRestriction, 'expiresAt'>[],
  now: Date,
): number {
  let latest = 0;
  for (const row of rows) {
    const ms = row.expiresAt.getTime() - now.getTime();
    if (ms > latest) latest = ms;
  }
  return latest <= 0 ? 0 : Math.ceil(latest / 1000);
}

@Injectable()
export class RestrictionService {
  constructor(private readonly restrictions: RestrictionDbOperation) {}

  /**
   * Is this account allowed to use this feature right now?
   *
   * `subFeature` omitted asks about the feature as a whole. Naming one also picks up
   * any whole-feature restriction, because withholding `withdrawal` necessarily
   * withholds everything under it — resolved in one query, not two.
   *
   * No transactional re-check and no row lock: a restriction expiring between this
   * read and the caller's action is a race in the USER's favour, and the alternative
   * would put a lock on the enforcement path of every feature request.
   */
  async check(userId: string, feature: string, subFeature: string | null = null): Promise<RestrictionVerdict> {
    const now = new Date();
    const rows = await this.restrictions.liveRestrictionsFor(userId, feature, subFeature, now);
    if (rows.length === 0) return ALLOWED;

    const retryAfterSeconds = remainingSeconds(rows, now);
    // Every row came back filtered on `expiresAt > now`, so this is only reachable if
    // the clock moved between the query and here. Allowing is the correct answer.
    if (retryAfterSeconds === 0) return ALLOWED;

    return {
      restricted: true,
      retryAfterSeconds,
      availableAt: new Date(now.getTime() + retryAfterSeconds * 1000).toISOString(),
    };
  }

  /**
   * Refuse if this feature is withheld.
   *
   * ─── What the client is told, and what it is not ──────────────────────────
   *
   * `retryAfterSeconds` (which `ProblemException` turns into a `Retry-After` header)
   * and `availableAt`, plus the feature that was refused — enough to render "available
   * in 30 minutes" against the right control.
   *
   * NOT which sensitive action caused it, not the classification, not which signal
   * looked unfamiliar, not the policy version. Those are on the row for an
   * investigator; telling the client would hand an attacker a probe for what the
   * evaluator thinks of them, and telling a victim which of their signals was
   * unfamiliar is security history they did not ask for.
   *
   * `FEATURE_RESTRICTED`, never `SECURITY_CHANGE_COOLDOWN` — that slug means "you may
   * not change a security setting because your address moved", which is a different
   * sentence on screen and a different remedy.
   */
  async assertAllowed(userId: string, feature: string, subFeature: string | null = null): Promise<void> {
    const verdict = await this.check(userId, feature, subFeature);
    if (!verdict.restricted) return;

    throw new ProblemException({
      type: ERR.FEATURE_RESTRICTED,
      detail:
        'This feature is temporarily unavailable after a recent change to your ' +
        'account security. It will become available again automatically.',
      retryAfterSeconds: verdict.retryAfterSeconds,
      extra: { availableAt: verdict.availableAt, feature, subFeature },
    });
  }

  /** Every live restriction on an account, for the user's own screen. */
  async listLive(userId: string): Promise<readonly UserFeatureRestriction[]> {
    return this.restrictions.liveRestrictions(userId, new Date());
  }
}
