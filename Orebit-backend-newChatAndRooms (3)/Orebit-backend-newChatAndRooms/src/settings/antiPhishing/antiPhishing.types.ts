/**
 * Domain types for the anti-phishing code.
 *
 * ─── What this sub-module is, and why it sits under src/settings/ ───────────
 *
 * Product policy layered over mechanisms that already exist — the emailed code
 * (`TwoFactorService.consumeCredentialOtp`), the AES-GCM envelope
 * (`src/utils/sealed-secret.ts`), the security freeze (`RecentSecurityChangePolicy`),
 * the rate limiter, the mail queue — and it owns none of them. The same relationship
 * `password/password.types.ts` and `paymentPin/payment-pin.types.ts` describe.
 *
 * ═══ WHAT THIS IS, STATED SO IT CANNOT BE MISREAD ═══════════════════════════
 *
 * A string the account's owner picks, which this service prints in the emails it sends
 * them. Its only job is to let a READER decide whether a message is genuine. It
 * authenticates the MAIL TO THE USER, never the user to Orebit.
 *
 * Consequences, all of them load-bearing:
 *
 *   * It appears in no `SignInMethod`, no `DisablePath`, no `ELEVATION_ACTIONS`, and no
 *     `MfaMethod`. Nothing in this codebase accepts it as proof of identity, and
 *     nothing may be built that does.
 *   * It cannot substitute for an emailed code, a password, a passkey or TOTP, and it
 *     cannot authorise a security change. Every operation on it requires the emailed
 *     code, and the code itself authorises nothing.
 *   * Changing it does NOT revoke sessions. `PaymentPinService.disable` gives the
 *     argument and it applies here verbatim: a sweep exists because a disabled factor
 *     MAY HAVE BEEN how a session was established, and no session was ever established
 *     with this. See `AntiPhishingService.finish`.
 *   * An attacker who learns it gains nothing they can do to the account. What they
 *     gain is the ability to write convincing mail — which is why it is sealed at rest
 *     and never logged, and why `anti-phishing:v1` binds an envelope to one account.
 *
 * ─── Why a folder rather than more files in src/settings/ ───────────────────
 *
 * It has its own policy — three operations distinguished by what the caller can
 * produce, an envelope rather than a hash, a read path on every outbound email, and no
 * session sweep — and none of that folds into `DisablePath` or `PaymentPinOperation`.
 *
 * ─── What lives OUTSIDE this folder, and why ────────────────────────────────
 *
 * `src/utils/sealed-secret.ts`             AES-256-GCM. A mechanism, shared with TOTP's
 *                                          key ring; this folder supplies the AAD.
 * `auth/persistence/user.dboperation.ts`   the four columns. `users` is another
 *                                          module's table, and this folder must not
 *                                          become a second access layer for it — the
 *                                          rule `settings.module.ts` states.
 * `src/2fa/2fa.service.ts`                 the emailed code.
 * `src/mail/`                              rendering and delivery. This folder decides
 *                                          the VALUE; `ANTI_PHISHING_KINDS` decides
 *                                          which messages carry it.
 */

// ─── the format rule ────────────────────────────────────────────────────────

/**
 * Length bounds, and the one place they are written down.
 *
 * Feature-local rather than in `auth/auth.constants.ts`, following `PIN_LENGTH` in
 * payment-pin.types.ts: nothing outside this folder has an opinion about the shape of
 * this value.
 *
 * Six at the bottom because a two- or three-character code is guessable by a forger
 * who never sees the user's mail at all, which would make the check worthless. Thirty
 * at the top because the value is rendered into a subject-adjacent block in an email
 * and has to stay readable at a glance — the property the whole feature depends on.
 *
 * These are a starting position, not a product requirement anybody stated. See the plan.
 */
export const ANTI_PHISHING = {
  MIN_LENGTH: 6,
  MAX_LENGTH: 30,
} as const;

/**
 * ═══ WHY THE CHARACTER SET IS THIS NARROW ═══════════════════════════════════
 *
 * `[A-Za-z0-9]` only. No spaces, no punctuation, no non-ASCII.
 *
 * This is a value a human COMPARES BY EYE against something in an email, under the
 * assumption that a mismatch means fraud. Every class of character that can render
 * ambiguously attacks that assumption directly:
 *
 *   * homoglyphs — Cyrillic `а` beside Latin `a` are one glyph in most mail clients, so
 *     a forger who substitutes one produces a code that LOOKS right;
 *   * bidirectional overrides and zero-width characters — invisible, and they let two
 *     different stored values display identically;
 *   * leading, trailing and doubled whitespace — invisible in HTML, which collapses
 *     runs of it, so `AB  CD` and `AB CD` are the same picture and different secrets.
 *
 * A code whose displayed form does not uniquely determine its stored form cannot do the
 * job it exists for. Restricting the alphabet is what makes "these match" mean
 * something.
 *
 * The cost is real and is recorded in the plan: a user whose mail is in Cyrillic,
 * Arabic or Devanagari cannot write their recognition string in their own script. That
 * is a product decision, not a technical limit — the seal, the storage and the
 * rendering are all encoding-agnostic, so widening it later is this constant plus a
 * confusable-normalisation policy, not a migration.
 *
 * Case is PRESERVED and compared exactly. `AbCd` and `abcd` are different codes,
 * because case is part of what the user recognises.
 */
export const ANTI_PHISHING_PATTERN = /^[A-Za-z0-9]+$/;

// ─── the three operations ───────────────────────────────────────────────────

/**
 * ═══ THE POLICY TABLE ═══════════════════════════════════════════════════════
 *
 * The split is by what the caller can PRODUCE, following `PasswordOperation`.
 *
 *   `set`      No code exists. Authorised by the emailed code alone.
 *
 *              Weaker than nothing else, because there is nothing to overwrite: a
 *              caller who reaches it already holds a session and the mailbox. The write
 *              refuses if that precondition went stale — see
 *              `UserDbOperation.setAntiPhishingIfAbsent`.
 *
 *   `change`   A code exists and the caller says they know it. Emailed code AND
 *              `currentCode`.
 *
 *   `replace`  A code exists and the caller cannot produce it. Emailed code alone.
 *
 * ─── ⚠ `change` IS NOT A SECURITY BOUNDARY, AND MUST NEVER BE READ AS ONE ───
 *
 * `replace` reaches the identical write with strictly less: no `currentCode`, no
 * factor, nothing. So the `currentCode` comparison in `change` cannot be defeating an
 * attacker — anyone able to call `change` can call `replace` instead, and would.
 *
 * It exists for exactly one reason: a user who believes they know their code should be
 * TOLD they are wrong rather than silently overwriting it, because a code they
 * misremember is one they will fail to recognise in the next email. It is
 * mistake-prevention, and `anti_phishing_code_incorrect` is a 400 rather than a 403 to
 * say so in the wire contract.
 *
 * Why `replace` is offered at all: the value lives in the user's inbox, not in their
 * memory. Someone who has not looked at an Orebit email in six months genuinely cannot
 * produce it, and gating the change on a value only old mail contains would strand them
 * with a code they cannot recognise and cannot replace — the state this feature exists
 * to prevent. `PasswordOperation`'s `forgot` makes the same argument, and it demands a
 * factor because a password guards the account; this guards nothing, so it does not.
 *
 * If that trade is ever revisited, the honest change is to DELETE `change` and keep
 * `replace`, not to strengthen `change` — a check the caller can skip does not become a
 * control by being made harder.
 */
export type AntiPhishingAction = 'set' | 'change' | 'replace';

export const ANTI_PHISHING_ACTIONS = [
  'set',
  'change',
  'replace',
] as const satisfies readonly AntiPhishingAction[];

// ─── what the setting screen is told ────────────────────────────────────────

/**
 * What the anti-phishing setting screen renders.
 *
 * ─── Why this is ONE boolean and not a per-operation availability table ─────
 *
 * `PaymentPinStatus` and `PasswordStatus` publish an entry per operation with a
 * `reason` for each closed one, because on those surfaces availability depends on
 * facts a client cannot see — which factors are enrolled, whether a passkey exists.
 * Here it depends on one fact and the three operations partition it exactly: `set` is
 * open iff no code exists, `change` and `replace` iff one does. A table would be three
 * fields derivable from this one, which is three chances for a client to render a
 * contradiction.
 *
 * ─── What is deliberately ABSENT ────────────────────────────────────────────
 *
 * The code. This shape has no field for it and no endpoint returns it. It is not a
 * secret the API is protecting from its owner — it is printed in their email — but a
 * settings screen that displays it would put it in a page, a browser cache and a
 * screenshot for no benefit the email does not already give, and it would create the
 * one endpoint an attacker with a stolen token would call to learn what to forge.
 *
 * Also absent: `antiPhishingSetAt`. It is stored for the audit trail, not for display.
 */
export interface AntiPhishingStatus {
  /** Whether a code is configured. The four columns being present IS this; there is no
   *  separate flag to disagree with it. */
  readonly configured: boolean;
}

/**
 * Why an operation is closed on this account, as one sentence per cause.
 *
 * Hoisted to constants because the service returns them as refusal details and a user
 * shown two phrasings of one fact is being shown a seam — the drift `UNAVAILABLE` in
 * settings.types.ts and `PAYMENT_PIN_UNAVAILABLE` were both written to stop.
 */
export const ANTI_PHISHING_UNAVAILABLE = {
  ALREADY_SET: 'An anti-phishing code is already set on this account.',
  NOT_SET: 'No anti-phishing code is set on this account.',
} as const;
