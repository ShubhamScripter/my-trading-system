import { Injectable } from '@nestjs/common';
import type { PremiumStatus, PremiumStatusPort } from './username.types';

/**
 * STUB. Reports every account non-Premium, always, and reports that nobody's
 * entitlement has ever lapsed.
 *
 * ─── What is and is not stubbed ─────────────────────────────────────────────
 *
 * All of it, and unusually there is not even a partial answer to give. `NullGeoResolver`
 * still records the IP it cannot resolve; `NullKycProvider` at least corresponds to a
 * concept the product has decided on. This corresponds to nothing: there is no
 * subscription model, no entitlement table, no plan column, no billing integration and
 * no payment provider anywhere in this repository. `src/wallet`, `src/ledger`,
 * `src/earning` and `src/merchant` are empty files.
 *
 * ─── The consequences, which are precise and intended ───────────────────────
 *
 * `statusFor` returns inactive, so `lengthBandFor` gives every account the free floor
 * and a two-character username cannot be claimed by anyone. The Premium band exists in
 * the policy table, is enforced on both paths, and is covered by tests — and grants
 * nothing, because nothing reports as Premium.
 *
 * `listRecentlyExpired` returns nothing, so `UsernameComplianceService` sweeps an empty
 * list and renames nobody. That is the correct behaviour rather than a disabled one:
 * with no entitlement system there are no short usernames to lengthen, because there
 * was never a way to obtain one. The reconciler is written, race-safe and tested
 * against its own doubles; it simply has no work.
 *
 * ─── Why `listRecentlyExpired` returns empty rather than throwing ───────────
 *
 * The opposite of `NullKycProvider.reverify`, and the difference is who is asking.
 * `reverify` throws because it is answering a USER, and returning `false` would spend
 * one of their few attempts on a provider that does not exist — a wrong answer with a
 * cost attached. This is answering a background sweeper on a timer, where "no accounts
 * need attention" is both true and free. Throwing would fill the log with an error
 * every tick, which is how a real failure later goes unnoticed.
 *
 * ─── Replacing it ───────────────────────────────────────────────────────────
 *
 * Implement `PremiumStatusPort` against whichever entitlement system is chosen, put it
 * in its own module, and rebind `PREMIUM_PORT` in settings.module.ts. Keep both
 * contracts: `statusFor` never throws and returns `{ active: false }` when it cannot
 * reach its backend — guessing `true` during an outage hands out usernames the account
 * is not entitled to keep — and `listRecentlyExpired` may over-report but must never
 * under-report, because a missed account keeps a username it is no longer owed and
 * nothing else will notice.
 */
@Injectable()
export class NullPremiumProvider implements PremiumStatusPort {
  async statusFor(_userId: string): Promise<PremiumStatus> {
    return { active: false, expiresAt: null };
  }

  async listRecentlyExpired(_since: Date): Promise<readonly string[]> {
    return [];
  }
}
