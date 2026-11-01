import { z } from 'zod';
import { loginIdSchema, otpSchema, webauthnResponseSchema } from '../../auth/auth.dto';
import type { EnrolledFactor, FactorKind, TotpEnrollment } from './2fa.types';

/**
 * ═══ EVERY SECOND-FACTOR ACTION, AS ONE REQUEST BODY ═══════════════════════
 *
 * One discriminated union on `action`, the convention every multi-step flow in
 * this service uses. Reading is a plain `GET /2fa`, so the union covers only the
 * writes.
 *
 * ─── `loginId` on four variants, and nothing else identifying ───────────────
 *
 * The four SIGN-IN actions carry `loginId` — the same handle `POST /auth/login`
 * minted and returned, naming the same attempt row. The other eight are reached
 * with a bearer token and must NOT carry it; `.strict()` enforces that, so an
 * action's credential requirement is declared twice — here and in
 * `TWO_FACTOR_REQUIRES` — and the two cannot silently drift.
 *
 * `loginId` is the identifier for the OVERALL sign-in. It is not the WebAuthn
 * challenge (server-side, in Redis, single-use per ceremony), not the WebAuthn
 * credential id (`response.id`, which names a passkey), not the emailed OTP
 * challenge, and not the session. Four different things; one of them is in this
 * file, and only one.
 *
 * No `adminId`, no `sessionId`, no `mode`. The caller is resolved from the
 * `loginId` or the bearer token depending on the action, the passkey mode is read
 * from the stored challenge, and the elevation ticket travels in a header rather
 * than the body so mutation payloads stay about their own subject.
 *
 * Notably absent: `password`. Re-proving a second factor replaced it — an admin
 * changing their factor set presents an elevation ticket like any other write,
 * which is one rule for the whole product instead of a special case here.
 *
 * Every variant is `.strict()`, so an unrecognised field is a 400 rather than
 * something silently ignored.
 */

const factorIdSchema = z.string().uuid('must be a factor id');
const labelSchema = z.string().trim().min(1).max(64);
const kindSchema = z.enum(['TOTP', 'PASSKEY']);

// ─── sign-in: `loginId`, EMAIL_VERIFIED ─────────────────────────────────────
//
// These four moved verbatim off `POST /auth/login`. They carry the same `loginId`
// that route returned, so one value spans the whole ceremony across both routes.

/** Generate a secret and return the QR payload. Carries no secret — the server
 *  generates it; a client-supplied seed is a seed an attacker chose. */
const totpEnrollSchema = z
  .object({ action: z.literal('totp-enroll'), loginId: loginIdSchema })
  .strict();

/** A code from the authenticator. Confirms a fresh enrollment or authenticates an
 *  existing factor — the server decides which by looking for a pending row. */
const totpVerifySchema = z
  .object({ action: z.literal('totp-verify'), loginId: loginIdSchema, code: otpSchema })
  .strict();

/** Ask for WebAuthn options. No `mode`: the server derives register-versus-
 *  authenticate from the confirmed passkey count and stores its decision. */
const passkeyChallengeSchema = z
  .object({ action: z.literal('passkey-challenge'), loginId: loginIdSchema })
  .strict();

/**
 * The browser's response. Also no `mode` — read back from the stored challenge.
 *
 * Two identifiers ride in this body and they are NOT the same thing: `loginId`
 * names the sign-in attempt, and `response.id` is the WebAuthn credential id
 * naming which passkey signed. The latter is matched against
 * `AdminPasskey.credentialId` and checked for ownership by the resolved admin.
 */
const passkeyVerifySchema = z
  .object({
    action: z.literal('passkey-verify'),
    loginId: loginIdSchema,
    response: webauthnResponseSchema,
  })
  .strict();

// ─── re-auth: a live session, earning a ticket ──────────────────────────────

/** Ask for an assertion challenge. Requires a bearer token and nothing else —
 *  requiring elevation to obtain elevation is a deadlock, not a defence. */
const reauthChallengeSchema = z.object({ action: z.literal('reauth-challenge') }).strict();

/**
 * Prove a factor, receive a single-use ticket.
 *
 * Accepts EITHER a passkey assertion or a TOTP code, and the asymmetry is
 * deliberate. A passkey signs a fresh challenge every time, so it supports genuine
 * per-action re-auth. A TOTP step can be claimed exactly once — `claimTotpStep` —
 * so codes cap at one write per 30 seconds. TOTP is here so an admin who has not
 * yet enrolled a passkey can still reach `passkey-add-challenge`, not as an equal
 * path.
 *
 * Exactly one of the two must be present; the controller enforces that, because a
 * `.refine()` here would yield a ZodEffects and `z.discriminatedUnion` will not
 * accept one as a member.
 */
const reauthVerifySchema = z
  .object({
    action: z.literal('reauth-verify'),
    response: webauthnResponseSchema.optional(),
    code: otpSchema.optional(),
    /**
     * WHICH write this proof is for — e.g. `'rename'`, or a future
     * `'admin.settings.publish'`.
     *
     * The ticket is bound to it, and the route that spends it names the same value
     * independently, so a ticket proved for one action is refused by another. Without
     * this a single tap authorises any mutating route for the next sixty seconds,
     * which is a time window rather than a per-action proof.
     *
     * Free-form on purpose. The closed set lives on the routes, as
     * `@RequiresElevation(...)` metadata, and duplicating it here would be a second
     * list to keep in step — a mismatch is already refused at spend time, which is
     * the check that matters. Bounded in length so it cannot be used to stuff the
     * cache.
     *
     * Optional so an existing client keeps working during migration; it then binds
     * to `'*'`, which the management actions below accept and no
     * `@RequiresElevation` route ever will. Make it required once the panel sends it.
     */
    intent: z.string().min(1).max(64).optional(),
  })
  .strict();

// ─── management: a live session plus a spent ticket ─────────────────────────

/** Begin — or rotate — an authenticator enrollment. */
const totpAddSchema = z
  .object({ action: z.literal('totp-add'), label: labelSchema.optional() })
  .strict();

/** Confirm it. No ticket: possession of the pending row is the gate, and that row
 *  was created by a request that already spent one. */
const totpConfirmSchema = z
  .object({ action: z.literal('totp-confirm'), code: otpSchema })
  .strict();

/** Registration options for an additional passkey. */
const passkeyAddChallengeSchema = z
  .object({ action: z.literal('passkey-add-challenge') })
  .strict();

/** Store it. No ticket: the single-use challenge is the gate. */
const passkeyAddVerifySchema = z
  .object({
    action: z.literal('passkey-add-verify'),
    response: webauthnResponseSchema,
    label: labelSchema.optional(),
  })
  .strict();

/** Retire a factor. The downgrade guard — is this the LAST one — lives in the
 *  service, because it is a question about the database. */
const removeSchema = z
  .object({ action: z.literal('remove'), kind: kindSchema, factorId: factorIdSchema })
  .strict();

/** Change a display label. Still a write, so still elevated. */
const renameSchema = z
  .object({
    action: z.literal('rename'),
    kind: kindSchema,
    factorId: factorIdSchema,
    label: labelSchema,
  })
  .strict();

export const twoFactorRequestSchema = z.discriminatedUnion('action', [
  totpEnrollSchema,
  totpVerifySchema,
  passkeyChallengeSchema,
  passkeyVerifySchema,
  reauthChallengeSchema,
  reauthVerifySchema,
  totpAddSchema,
  totpConfirmSchema,
  passkeyAddChallengeSchema,
  passkeyAddVerifySchema,
  removeSchema,
  renameSchema,
]);

export type TwoFactorRequest = z.infer<typeof twoFactorRequestSchema>;

// ─── responses ──────────────────────────────────────────────────────────────

export interface FactorPayload {
  readonly id: string;
  readonly kind: FactorKind;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export function toFactorPayload(factor: EnrolledFactor): FactorPayload {
  return {
    id: factor.id,
    kind: factor.kind,
    label: factor.label,
    createdAt: factor.createdAt.toISOString(),
    lastUsedAt: factor.lastUsedAt?.toISOString() ?? null,
  };
}

/** `GET /2fa`. `mfaEnrolled` is computed from CONFIRMED factor counts, not read
 *  from `Admin.mfaEnrolledAt` — that column is a denormalised convenience. */
export interface FactorListPayload {
  readonly mfaEnrolled: boolean;
  readonly factors: readonly FactorPayload[];
}

/**
 * The one response shape every action on `POST /2fa` returns.
 *
 * `outcome` is the discriminator. Only `session` carries tokens and only
 * `totp_enrollment` carries a secret — a client can assert both.
 */
export type TwoFactorPayload =
  | { readonly outcome: 'totp_enrollment'; readonly totp: TotpEnrollmentPayload }
  | {
      readonly outcome: 'passkey_challenge';
      readonly mode: 'register' | 'authenticate';
      readonly options: Record<string, unknown>;
    }
  | { readonly outcome: 'session'; readonly session: SessionLike }
  | { readonly outcome: 'elevated'; readonly ticket: string; readonly expiresInSeconds: number }
  | { readonly outcome: 'factor'; readonly factor: FactorPayload }
  | { readonly outcome: 'removed'; readonly ok: true };

/**
 * The session payload, structurally identical to `auth/dto/response.dto.ts`'s.
 *
 * Referenced through a local alias rather than imported so this module's response
 * contract does not silently change shape when auth's does — if that type gains a
 * field, this is a compile error to look at rather than a wire change nobody
 * reviewed.
 *
 * That mechanism has now earned its keep TWICE, which is the argument for keeping
 * the duplication:
 *
 *   1. dropping `refreshToken` broke this file. The token moved into an httpOnly
 *      cookie and `csrfToken` replaced it — a twelve-hour grant of admin access must
 *      not be readable by script on the page.
 *   2. dropping `accessToken` and `accessExpiresAt` broke it again. Those moved into
 *      the server-side session record — see auth/security/bff.session.ts — because
 *      the browser now presents an opaque handle instead of an `Authorization`
 *      header, so nothing has to be readable at all.
 *
 * NO TOKEN FIELDS. Every remaining field is a timestamp, a CSRF token that authorises
 * nothing, or public account data.
 */
export interface SessionLike {
  readonly refreshExpiresAt: string;
  /** The absolute ceiling from this sign-in. Fixed; `refreshExpiresAt` slides on
   *  activity. */
  readonly reauthenticateAt: string;
  readonly csrfToken: string;
  readonly admin: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly role: string;
    readonly emailVerified: boolean;
    readonly mfaEnrolled: boolean;
    readonly createdAt: string;
  };
}

/** Returned exactly once. `replacing` tells the UI that confirming will RETIRE an
 *  existing authenticator, so it can say so before the phone entry is overwritten. */
export interface TotpEnrollmentPayload extends TotpEnrollment {
  readonly replacing: boolean;
}
