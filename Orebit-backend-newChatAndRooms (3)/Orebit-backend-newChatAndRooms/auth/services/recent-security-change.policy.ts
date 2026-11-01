import { Injectable } from '@nestjs/common';
import { assertNotInSecurityCooldown } from '../security/security-cooldown';
import { UserDbOperation } from '../persistence/user.dboperation';

/**
 * ═══ THE SECURITY COOLDOWN, AS ONE POLICY EVERY SURFACE CALLS ═══════════════
 *
 * If the account's email address moved recently, the other high-impact security
 * settings are frozen: both second factors, the recovery codes, the Payment PIN and
 * the password. See `SECURITY_COOLDOWN` in auth/auth.constants.ts for what the window
 * defends and why it is twenty-four hours rather than the retention period.
 *
 * ─── Why one injectable rather than a check in each service ─────────────────
 *
 * There are five services that must not perform a protected change during the window,
 * and five copies of `if (changedRecently) throw` is five places for the duration, the
 * error shape and the null handling to drift — silently, because a freeze that is one
 * condition too weak still returns 200 and still looks like it works. One collaborator
 * means the answer is the same whichever surface asked, and one file to read to know
 * what the freeze covers.
 *
 * It holds no state and owns no table. `UserDbOperation` is the only dependency, which
 * is what keeps it injectable into `AuthModule`'s own services and into
 * `SettingsModule`'s and `TwoFactorModule`'s without either importing anything new —
 * both already import `AuthModule`, and `AuthModule` already exports what this needs.
 *
 * ─── Where callers must put the call ────────────────────────────────────────
 *
 * Early: after metering, before any emailed code is consumed, before argon2, before a
 * WebAuthn verification. That is the slot every service in `src/settings/` already
 * reserves for `assertPathAvailable` / `assertMethodAvailable`, and for their stated
 * reason — a refusal the server could have issued for free must not first cost the
 * user their code.
 *
 * ─── What this is NOT the last word on ──────────────────────────────────────
 *
 * Being early means a concurrent email change can commit between this check and the
 * write it protects. `assertNoRecentEmailChangeLocked` closes that window inside the
 * mutation's own transaction, and the two are deliberately both present: this one for
 * an honest, cheap refusal, that one for the race.
 *
 * ─── WHAT IS NOT YET COVERED: the phone number ──────────────────────────────
 *
 * The founder's requirement names four surfaces — 2FA, the Payment PIN, the password
 * and the PHONE NUMBER. Three are enforced. The fourth is not, because there is no
 * phone-number feature in this backend to enforce it on: no column, no table, no
 * service, no route, no migration. Nothing was stubbed out to make the list look
 * complete, and nothing here silently half-covers it.
 *
 * When the phone feature lands, it is covered by adding one call — this policy, at the
 * top of each mutation, before any OTP is sent or spent — to every entry point that:
 *
 *   * adds a phone number,
 *   * changes one,
 *   * removes one,
 *   * completes the verification that makes one ACTIVE (the last one is the easiest to
 *     miss and the one that matters most: a number that becomes active during the
 *     freeze is a recovery channel the attacker owns), or
 *   * mutates one through any recovery or support path.
 *
 * And, for the same reason the four surfaces above are guarded twice, a row-locked
 * `assertNoRecentEmailChangeLocked` inside the transaction that performs the write.
 *
 * ─── What it must NEVER be applied to ───────────────────────────────────────
 *
 * The email RECOVERY flow — `recover-start`, `restore` and `replace`. A change sweeps
 * every session and a released address cannot sign in, so the person who most needs
 * recovery is the one who cannot authenticate at all, and a recovery always runs with
 * a live retention and a fresh `emailChangedAt`. Applying the freeze there would close
 * the flow for every user in exactly the situation it exists for — including the
 * victim of the takeover this cooldown is defending against. See
 * `EmailChangeService.recoverStart` and `verifyRecovery`, neither of which calls this.
 */
@Injectable()
export class RecentSecurityChangePolicy {
  constructor(private readonly users: UserDbOperation) {}

  /**
   * Refuse a protected security change while this account is inside the window.
   *
   * Returns silently when the account is clear, which is the overwhelmingly common
   * case: one indexed read by primary key, and no allocation on the happy path.
   *
   * A missing or soft-deleted account reads as "no cooldown" rather than throwing.
   * That is not a gap — every caller independently resolves and refuses an account
   * that is gone, and inventing a second, differently-worded refusal for it here
   * would put an authentication decision inside a policy that is not about
   * authentication.
   */
  async assertNoRecentEmailChange(userId: string): Promise<void> {
    assertNotInSecurityCooldown(await this.users.findEmailChangedAt(userId));
  }
}
