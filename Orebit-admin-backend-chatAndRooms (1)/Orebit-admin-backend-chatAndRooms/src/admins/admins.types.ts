/**
 * The administrative action set, and which elevation each demands.
 *
 * ═══ WHY THIS TABLE EXISTS SEPARATELY FROM THE ROUTES ══════════════════════
 *
 * The same shape as `TWO_FACTOR_REQUIRES` (src/2fa/2fa.types.ts), for the same
 * reason: "what does this action require" is a security property, and a security
 * property spread across switch cases is one a reviewer has to reconstruct. Here it
 * is a table they can read.
 *
 * `tests/admins/admins.spec.ts` asserts against it directly, so the table and the
 * behaviour cannot drift.
 */

export const ADMIN_ACTIONS = [
  'reset-factors',
  'disable',
  'enable',
  'resolve-login-review',
] as const;

export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/**
 * The elevation action each administrative write must have been proved for.
 *
 * These strings are the contract with the client: it sends one as `intent` to
 * `POST /2fa {action:'reauth-verify'}`, and the value must match what is spent
 * here. Namespaced `admin.*` so they cannot collide with the twelve bare factor
 * actions on `POST /2fa`.
 *
 * ONE PER ACTION, deliberately not one shared `admin.write`. A shared value would
 * make a proof given to re-enable an account sufficient to disable a different one,
 * which is the per-action property finding B3 exists to establish.
 */
export const ADMIN_ELEVATION: Readonly<Record<AdminAction, string>> = {
  'reset-factors': 'admin.factors.reset',
  disable: 'admin.status.disable',
  enable: 'admin.status.enable',
  'resolve-login-review': 'admin.login-review.resolve',
};

/**
 * Whether an action may target the caller's own account.
 *
 * ─── Why `reset-factors` may not ───────────────────────────────────────────
 *
 * Self-service already exists for it: `POST /2fa` with `totp-add` / `remove` is how
 * an admin manages their own factors, and it is bounded by `assertNotLastFactor` so
 * they cannot strand themselves. This route bypasses that check by design — it
 * exists precisely to empty a factor set — so pointing it at yourself is a way to
 * lock yourself out that the self-service path deliberately refuses.
 *
 * ─── Why `disable` may not ─────────────────────────────────────────────────
 *
 * A SUPER_ADMIN disabling their own account is one request away from nobody being
 * able to administer the platform. There is no route that grants SUPER_ADMIN, so
 * recovering from it means the database write this module exists to eliminate.
 *
 * ─── Why `resolve-login-review` may not ────────────────────────────────────
 *
 * Because self-targeting it would defeat the entire mechanism. A review exists to put
 * a HUMAN OTHER THAN THE ACCOUNT HOLDER between a repeatedly-locked account and being
 * signable-into again. A super admin who could resolve their own review would be
 * re-enabling the account the system just took out of service, on their own authority,
 * which is the review not happening.
 *
 * The case is not hypothetical the way `enable`'s is. A super admin CAN reach this
 * route while under review — the review revokes their sessions, but an unexpired
 * fifteen-minute access token minted moments before the second lock still
 * authenticates. `AdminsService.authorise` refuses it twice over (this table, and the
 * actor's own `status`), and both are deliberate: one is the rule, the other is the
 * backstop for a stale token.
 *
 * `enable` is exempt because it cannot lock anyone out — and a disabled admin has
 * no session to call it with anyway, so the case is unreachable in practice. Listed
 * for completeness rather than because it is load-bearing.
 */
export const ADMIN_SELF_TARGET_ALLOWED: Readonly<Record<AdminAction, boolean>> = {
  'reset-factors': false,
  disable: false,
  enable: true,
  'resolve-login-review': false,
};
