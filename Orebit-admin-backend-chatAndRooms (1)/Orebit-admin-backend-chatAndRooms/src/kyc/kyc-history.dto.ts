import { z } from 'zod';
import { decodeKycHistoryCursor } from './kyc-history.cursor';
import { KYC_POLICY_LEVELS } from './kyc.types';

/**
 * ═══ THE READ-ONLY KYC HISTORY CONTRACT ════════════════════════════════════
 *
 * Every filter below is one the founder requirement names — user, level, status, date
 * range — and nothing more. Filtering complexity on a compliance surface is not free:
 * each predicate is a way to slice a population, and one nobody asked for is one nobody
 * has thought about the disclosure consequences of.
 */

const UUID = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'must be a uuid')
  .transform((value) => value.toLowerCase());

/**
 * The verification statuses the consumer's state machine can hold.
 *
 * Copied rather than imported — there is no shared package between the services, and
 * `tests/kyc/kyc.drift.spec.ts` is what keeps the copy honest. A status this list is
 * missing would make a legitimate row unfilterable; one it invents would silently
 * return nothing.
 */
export const KYC_VERIFICATION_STATUSES = [
  'CREATED',
  'IN_PROGRESS',
  'AWAITING_USER',
  'IN_REVIEW',
  'APPROVED',
  'DECLINED',
  'ABANDONED',
  'EXPIRED',
] as const;

/** ISO-8601. Compared against `created_at`, so it bounds when the attempt STARTED. */
const instant = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(new Date(value).valueOf()), 'must be an ISO-8601 instant');

const cursor = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    try {
      decodeKycHistoryCursor(value);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid cursor.');

export const kycHistoryQuerySchema = z
  .object({
    userId: UUID.optional(),
    level: z.enum(KYC_POLICY_LEVELS as unknown as [string, ...string[]]).optional(),
    status: z.enum(KYC_VERIFICATION_STATUSES).optional(),
    from: instant.optional(),
    to: instant.optional(),
    cursor: cursor.optional(),
    /** `z.coerce` because every query value arrives as text. */
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.from !== undefined && query.to !== undefined) {
      if (new Date(query.from).valueOf() > new Date(query.to).valueOf()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['from'],
          message: 'must not be after `to`',
        });
      }
    }
  });

export type KycHistoryQuery = z.infer<typeof kycHistoryQuerySchema>;

/** The detail view targets one attempt. A query parameter, not a path segment —
 *  `tests/app.routes.spec.ts` asserts this service takes no path parameters anywhere. */
export const kycHistoryAttemptQuerySchema = z
  .object({ verificationId: UUID })
  .strict();

export type KycHistoryAttemptQuery = z.infer<typeof kycHistoryAttemptQuerySchema>;

// ─── payloads ───────────────────────────────────────────────────────────────

/**
 * One historical attempt.
 *
 * ═══ THE TWO EXPIRIES ARE NAMED APART, DELIBERATELY ════════════════════════
 *
 * `providerSessionExpiresAt` is when Didit's hosted page stopped being completable —
 * seven days from creation. It is **not** the account's KYC validity deadline, which is
 * derived per level from the global renewal period and lives on the user-facing
 * `GET /kyc/status`. Conflating them is the mistake this field's name exists to prevent:
 * an operator reading a seven-day window as a validity deadline would conclude every
 * verified user expires in a week.
 *
 * There is no renewal deadline on this payload at all, and that is correct — a deadline
 * belongs to a LEVEL, not to an attempt, and history is a record of attempts.
 */
export interface KycHistoryAttemptView {
  readonly verificationId: string;
  readonly userId: string;
  /** From the persisted row, never from provider metadata or a query parameter. */
  readonly level: string;
  /** This service's own state machine. `IN_REVIEW` is non-terminal and means a human
   *  is deciding — it is never reinterpreted here. */
  readonly status: string;
  /** Didit's word, verbatim and unnormalised. */
  readonly providerStatus: string | null;
  readonly sessionId: string | null;
  readonly workflowId: string | null;
  /** Which configuration key supplied the workflow — how an operator tells months later
   *  whether an attempt ran the initial or the renewal flow. */
  readonly workflowSource: string | null;
  readonly verifiedCountry: string | null;
  readonly amlStatus: string | null;
  readonly amlTotalHits: number | null;
  readonly documentType: string | null;
  readonly documentSubtype: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  /** The PROVIDER SESSION window. See the note above. */
  readonly providerSessionExpiresAt: string | null;
  /** The attempt this one renewed, if any — the chain through `kyc_verifications`. */
  readonly renewalOfId: string | null;
  readonly reconciledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Whether this attempt is the credential CURRENTLY in force for its level.
   *
   * The one fact joined from current state, and the question an investigator asks
   * first: of an account's eleven attempts, which one is live? False for every
   * superseded success — which remains fully visible, because history is history.
   */
  readonly isActiveCredential: boolean;
}

/** A device the provider observed. Detail view only — forensic, not operational. */
export interface KycHistoryDeviceView {
  readonly sequence: number;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceFingerprint: string | null;
  readonly browserFamily: string | null;
  readonly osFamily: string | null;
  readonly platform: string | null;
  readonly isVpnOrTor: boolean | null;
  readonly isDataCenter: boolean | null;
}

/** One inbound delivery, summarised. The verified body is never included. */
export interface KycHistoryEventView {
  readonly eventId: string;
  readonly eventType: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  /** `PENDING` | `PROCESSED` | `IGNORED` | `FAILED`. `IGNORED` is a success — a
   *  duplicate, or an event that would have walked a terminal status backwards. */
  readonly processingStatus: string;
  readonly error: string | null;
  /** Which signature header authenticated the delivery: `raw` or `canonical`. The
   *  variant NAME, never a signature. */
  readonly signatureVariant: string | null;
}

export interface KycHistoryPayload {
  readonly items: readonly KycHistoryAttemptView[];
  /** Opaque. Send it back as `cursor` for the next page; null means this is the last. */
  readonly nextCursor: string | null;
}

export interface KycHistoryAttemptPayload {
  readonly attempt: KycHistoryAttemptView;
  readonly devices: readonly KycHistoryDeviceView[];
  readonly providerEvents: readonly KycHistoryEventView[];
}
