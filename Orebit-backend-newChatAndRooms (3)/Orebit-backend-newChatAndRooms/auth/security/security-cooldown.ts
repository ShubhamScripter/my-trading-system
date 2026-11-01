import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { SECURITY_COOLDOWN } from '../auth.constants';

/**
 * THE security cooldown decision, and the only place it is made.
 *
 * One pure function answers "is this account frozen, and for how much longer", and
 * one wrapper turns a yes into the refusal. Everything that enforces the freeze — the
 * injectable policy the services call, and the transactional guard the persistence
 * layer runs inside the mutation — routes through these two, so there is exactly one
 * arithmetic and exactly one error shape no matter which layer refuses.
 *
 * ─── Why a free function and not a service ──────────────────────────────────
 *
 * `challenge.ts` next door makes the argument in full and it applies unchanged: the
 * decision needs no collaborator, so an `@Injectable` would add a constructor
 * dependency to every caller in order to hold no state. `RecentSecurityChangePolicy`
 * IS the injectable, and it exists because loading the timestamp needs the database —
 * not because deciding on it needs an object.
 *
 * ─── Why the timestamp is an argument rather than something this loads ──────
 *
 * Because the two enforcement layers obtain it differently and must not: the policy
 * reads it with an ordinary indexed lookup, and the persistence guard reads it under
 * `SELECT ... FOR UPDATE` inside the mutation's own transaction. Taking the value in
 * is what lets both reach the identical verdict from different reads.
 */

/**
 * Seconds left on the freeze, or 0 when the account is not frozen.
 *
 * `null` — never changed, or a recovery `restore` undid the only change — is 0 rather
 * than a special case at every call site.
 *
 * Rounded UP. A caller told "1 second" who retries in one second must not be refused
 * again; the fractional remainder is real time they still have to wait, and rounding
 * it away is how a client ends up in a retry loop against a boundary it keeps missing.
 */
export function securityCooldownRemainingSeconds(
  emailChangedAt: Date | null | undefined,
  now: number = Date.now(),
): number {
  if (emailChangedAt === null || emailChangedAt === undefined) return 0;

  const endsAt = emailChangedAt.getTime() + SECURITY_COOLDOWN.AFTER_EMAIL_CHANGE_SECONDS * 1000;
  const remainingMs = endsAt - now;

  // `<= 0` and not `< 0`: the instant the window closes the operation is allowed. The
  // boundary belongs to the user, which is what makes "at or after expiry -> allowed"
  // true rather than approximately true.
  return remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 1000);
}

/**
 * Refuse a protected security change while the account is inside the window.
 *
 * `retryAfterSeconds` populates the `Retry-After` header through `ProblemException`'s
 * existing contract, and `availableAt` gives a client an instant to render against.
 * Neither discloses `emailChangedAt` itself: the client learns when it may act, which
 * is what it needs, and not when the address moved, which it does not — and a client
 * handed the raw timestamp would have to re-derive the window, which is a second copy
 * of this policy that drifts from this one.
 */
export function assertNotInSecurityCooldown(
  emailChangedAt: Date | null | undefined,
  now: number = Date.now(),
): void {
  const retryAfterSeconds = securityCooldownRemainingSeconds(emailChangedAt, now);
  if (retryAfterSeconds === 0) return;

  throw new ProblemException({
    type: ERR.SECURITY_CHANGE_COOLDOWN,
    detail:
      'Your email address was changed recently, so this security setting is ' +
      'temporarily locked. If you did not make that change, use the recovery link ' +
      'sent to your previous email address.',
    retryAfterSeconds,
    extra: { availableAt: new Date(now + retryAfterSeconds * 1000).toISOString() },
  });
}
