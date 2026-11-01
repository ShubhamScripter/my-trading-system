import { z } from 'zod';

/**
 * `POST /auth/link` — attach a verified provider identity to the calling account.
 *
 * ─── Why this is its own route and not a field on login ────────────────────
 *
 * It used to be an optional `linkToken` on `POST /auth/login`. That made writing a
 * permanent credential a side effect of presenting one factor: whoever could read
 * a mailbox could sign in with an emailed code, attach their own Google account,
 * and still be in after the victim changed their password, revoked every session
 * and secured the mailbox. See the header of login.dto.ts.
 *
 * So it is authenticated, and it is elevated. The caller must hold a session AND a
 * single-use ticket proved for `account.oauth.link` — which means a second,
 * deliberate act naming this specific write, rather than a field that rides along
 * with something else the user was already doing.
 *
 * ─── Two ROUTES, not two actions on one route ──────────────────────────────
 *
 * `POST /auth/link/preview` reads the parked identity without consuming it, so a
 * client can show "attach ada@gmail.com to this account?" before asking for a proof.
 * Bearer only — it changes nothing.
 *
 * `POST /auth/link` performs the write, and is the one `ElevationGuard` covers.
 *
 * ─── Why they were split ───────────────────────────────────────────────────
 *
 * They used to be one route with an `action` discriminator, and this file used to
 * claim `preview` "needs no ticket, because it changes nothing". That was not what
 * the code did. `ElevationGuard` sat on the single handler, and a Nest guard runs
 * BEFORE the body is parsed — so it spent the ticket without knowing which action
 * had been asked for. `ElevationService.spend` reads the ticket with GETDEL, so the
 * spend is real and single-use: calling `preview` destroyed the ticket and the
 * `confirm` that followed failed with `reauth_required`.
 *
 * The route comment defended this as "a client asks for one proof and uses it for the
 * confirm that follows" — which is precisely what the mechanism forbids. A working
 * client had to obtain two tickets, or skip `preview` altogether.
 *
 * Splitting them is what lets the ROUTE define the action, which is the property that
 * matters: the guard's `@RequiresElevation` names one write, and the handler under it
 * can only perform that write. Reading the action from the body would put the choice
 * back in the caller's hands, one layer below where the credential is checked.
 *
 * The `action` field is gone from both bodies. A client still sending it now gets a
 * validation error rather than a silently different outcome — see `.strict()`.
 */

/** An opaque handle to a verified provider identity parked server-side. Bounded
 *  like the OAuth `state`, which it is a sibling of. */
const linkTokenSchema = z.string().min(1).max(512);

/**
 * Both routes take exactly this, and `.strict()` is load-bearing.
 *
 * Without it a client still sending `action: 'preview'` to `POST /auth/link` would
 * have the field silently dropped and get a CONFIRM — a linked provider it did not
 * ask for, having believed it was previewing. A loud validation error is the only
 * honest answer to a field that used to select behaviour and no longer does.
 */
export const linkRequestSchema = z.object({ linkToken: linkTokenSchema }).strict();

export type LinkRequest = z.infer<typeof linkRequestSchema>;

/**
 * What the parked identity looks like before it is attached.
 *
 * `provider` and `email` and nothing else. The subject id is deliberately withheld:
 * it identifies the account at the provider, the caller has no use for it, and a
 * client that echoed it into a UI would be the first place it leaked.
 */
export interface LinkPreviewPayload {
  readonly outcome: 'preview';
  readonly provider: string;
  readonly email: string | null;
  /** Whether the provider asserted the address was verified. Shown because
   *  "attach an unverified address" is a decision worth making knowingly. */
  readonly emailVerifiedByProvider: boolean;
}

export type LinkPayload = LinkPreviewPayload | { readonly outcome: 'linked' };
