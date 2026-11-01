import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../db/client';
import { decodeKycHistoryCursor, encodeKycHistoryCursor } from './kyc-history.cursor';

/**
 * ═══ READS OF THE PERMANENT KYC ATTEMPT HISTORY ════════════════════════════
 *
 * `identity.kyc_verifications` belongs to ../Orebit-backend and is, formally, the
 * permanent record of every KYC attempt an account has ever made: started, failed,
 * abandoned, expired and approved, including the successes a later renewal replaced.
 * Nothing deletes from it and nothing rewrites an older attempt to represent a newer
 * one. This module reads it and does nothing else.
 *
 * ─── THERE IS NO WRITER HERE, AND THERE MUST NEVER BE ─────────────────────
 *
 * Not an UPDATE, not an INSERT, not a DELETE, on any table. What an account has proved
 * is the provider's word arriving over a signed webhook in the consumer service, and no
 * admin surface may edit it, manufacture it, or move a verification through its state
 * machine by hand. A test asserts this file contains no mutating statement.
 *
 * Raw schema-qualified SQL, for `KycPolicyDbOperation`'s reason: these tables are not
 * modelled in this repository's `db/schema.prisma`, whose datasource is
 * `schemas = ["admin"]`. A column renamed over there breaks this reader and no type
 * system in either repository will say so — `tests/kyc/kyc.drift.spec.ts` is the check.
 *
 * ═══ CURRENT STATE IS NOT HISTORY ══════════════════════════════════════════
 *
 * `kyc_level_states` holds what an account holds NOW — one row per level, replaced in
 * place by each new success. It is joined here for exactly one derived fact,
 * `is_active_credential`: whether this historical attempt is the one currently in
 * force. The attempt rows themselves are never filtered or altered by it, so a
 * superseded verification stays fully visible.
 */

/**
 * The columns an admin may see.
 *
 * ═══ AN ALLOW-LIST, NOT A `SELECT *` ═══════════════════════════════════════
 *
 * `kyc_verifications` has thirty-one columns and eight of them are sealed PII —
 * `document_number_*` and `full_name_*`, AES-256-GCM envelopes whose key ring is shared
 * with TOTP. They are absent here and therefore unreachable from this surface; reading
 * them back is a separate feature with its own elevation, audit and retention decision,
 * and it is deliberately not this one.
 *
 * `document_type` and `document_subtype` ARE exposed: the consumer's schema leaves them
 * unsealed precisely because neither identifies a person on its own, while a number
 * without its type is ambiguous between a passport and a national id.
 *
 * `created_at` is rendered as microsecond text for the keyset cursor — see
 * `kyc-history.cursor.ts`.
 */
const ATTEMPT_COLUMNS = Prisma.sql`
  v."id", v."user_id", v."level", v."status", v."provider_status",
  v."session_id", v."workflow_id", v."workflow_source",
  v."verified_country", v."aml_status", v."aml_total_hits",
  v."document_type", v."document_subtype",
  v."started_at", v."completed_at", v."expires_at",
  v."renewal_of_id", v."reconciled_at", v."updated_at",
  to_char(v."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "created_at",
  (s."active_verification_id" = v."id") AS "is_active_credential"
`;

export interface KycHistoryAttemptRow {
  readonly id: string;
  readonly user_id: string;
  readonly level: string;
  readonly status: string;
  readonly provider_status: string | null;
  readonly session_id: string | null;
  readonly workflow_id: string | null;
  readonly workflow_source: string | null;
  readonly verified_country: string | null;
  readonly aml_status: string | null;
  readonly aml_total_hits: number | null;
  readonly document_type: string | null;
  readonly document_subtype: string | null;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly expires_at: Date | null;
  readonly renewal_of_id: string | null;
  readonly reconciled_at: Date | null;
  readonly updated_at: Date;
  readonly created_at: string;
  readonly is_active_credential: boolean | null;
}

/** One device the PROVIDER observed during an attempt. Detail view only. */
export interface KycHistoryDeviceRow {
  readonly sequence: number;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly device_fingerprint: string | null;
  readonly browser_family: string | null;
  readonly os_family: string | null;
  readonly platform: string | null;
  readonly is_vpn_or_tor: boolean | null;
  readonly is_data_center: boolean | null;
}

/**
 * One inbound provider delivery, SUMMARISED.
 *
 * `payload` is deliberately absent. It is the verified webhook body, and Didit's v3
 * decision can carry a name, a date of birth and AML hit detail about third parties —
 * the consumer's schema says so on the column. An operator needs to know that an event
 * arrived, what kind it was and whether it was applied; none of that requires the body.
 *
 * `signature_variant` is the NAME of the header that authenticated the delivery
 * (`raw` or `canonical`), never a signature and never a secret. It is worth seeing: a
 * fleet silently drifting onto the canonical fallback is telling you about a proxy.
 */
export interface KycHistoryEventRow {
  readonly event_id: string;
  readonly event_type: string | null;
  readonly received_at: Date;
  readonly processed_at: Date | null;
  readonly processing_status: string;
  readonly error: string | null;
  readonly signature_variant: string | null;
}

export interface KycHistoryFilter {
  readonly userId?: string;
  readonly level?: string;
  readonly status?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface KycHistoryPage {
  readonly items: readonly KycHistoryAttemptRow[];
  readonly nextCursor: string | null;
}

@Injectable()
export class KycHistoryDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of attempts, newest first.
   *
   * ─── The ordering is `(created_at DESC, id DESC)`, always ─────────────────
   *
   * Deterministic under concurrent inserts and under identical timestamps, which is
   * what makes the cursor sound. `kyc_verifications_created_at_id_idx` in the consumer
   * serves the unfiltered case — it was added for exactly this query, because both
   * pre-existing indexes lead on `user_id` and so cannot serve a listing that names no
   * account. Those two serve the filtered cases unchanged.
   *
   * ─── One query, no N+1 ────────────────────────────────────────────────────
   *
   * The active-credential flag is a LEFT JOIN rather than a per-row lookup, and the
   * devices and provider events are NOT joined here at all — they belong to the detail
   * view, and pulling them for a fifty-row page would be a fan-out nobody asked for.
   */
  async list(filter: KycHistoryFilter): Promise<KycHistoryPage> {
    const conditions: Prisma.Sql[] = [];

    if (filter.userId !== undefined) {
      conditions.push(Prisma.sql`v."user_id" = ${filter.userId}::uuid`);
    }
    if (filter.level !== undefined) conditions.push(Prisma.sql`v."level" = ${filter.level}`);
    if (filter.status !== undefined) conditions.push(Prisma.sql`v."status" = ${filter.status}`);
    if (filter.from !== undefined) {
      conditions.push(Prisma.sql`v."created_at" >= ${filter.from}::timestamptz`);
    }
    if (filter.to !== undefined) {
      conditions.push(Prisma.sql`v."created_at" <= ${filter.to}::timestamptz`);
    }

    if (filter.cursor !== undefined) {
      // Throws on anything this service did not issue — see the cursor module. The pair
      // reaches a WHERE clause, so it is validated rather than trusted.
      const [createdAt, id] = decodeKycHistoryCursor(filter.cursor);
      // Row-wise comparison, which is what makes the keyset a single index seek rather
      // than an OR of two ranges the planner has to reason about.
      conditions.push(
        Prisma.sql`(v."created_at", v."id") < (${createdAt}::timestamptz, ${id}::uuid)`,
      );
    }

    const where =
      conditions.length === 0
        ? Prisma.empty
        : Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;

    // One more than asked for, so "is there another page" is answered without a second
    // COUNT over a growing table.
    const take = Math.max(1, Math.min(100, Math.trunc(filter.limit)));

    const rows = await this.prisma.$queryRaw<KycHistoryAttemptRow[]>`
      SELECT ${ATTEMPT_COLUMNS}
        FROM "identity"."kyc_verifications" v
        LEFT JOIN "identity"."kyc_level_states" s
               ON s."user_id" = v."user_id" AND s."level" = v."level"
        ${where}
       ORDER BY v."created_at" DESC, v."id" DESC
       LIMIT ${Prisma.raw(String(take + 1))}`;

    const items = rows.slice(0, take);
    const last = items[items.length - 1];
    // Re-encoded from the last row's own values, so the next page resumes exactly where
    // this one stopped. Null when the extra row did not come back — there is no more.
    const nextCursor =
      rows.length > take && last !== undefined
        ? encodeKycHistoryCursor(last.created_at, last.id)
        : null;

    return { items, nextCursor };
  }

  /** One attempt by id. Null rather than a throw — the caller renders the 404. */
  async findAttempt(verificationId: string): Promise<KycHistoryAttemptRow | null> {
    const rows = await this.prisma.$queryRaw<KycHistoryAttemptRow[]>`
      SELECT ${ATTEMPT_COLUMNS}
        FROM "identity"."kyc_verifications" v
        LEFT JOIN "identity"."kyc_level_states" s
               ON s."user_id" = v."user_id" AND s."level" = v."level"
       WHERE v."id" = ${verificationId}::uuid`;
    return rows[0] ?? null;
  }

  /** The devices the provider observed during one attempt, in payload order. */
  async devicesFor(verificationId: string): Promise<readonly KycHistoryDeviceRow[]> {
    return this.prisma.$queryRaw<KycHistoryDeviceRow[]>`
      SELECT "sequence", host("ip_address") AS "ip_address", "user_agent",
             "device_fingerprint", "browser_family", "os_family", "platform",
             "is_vpn_or_tor", "is_data_center"
        FROM "identity"."kyc_verification_devices"
       WHERE "verification_id" = ${verificationId}::uuid
       ORDER BY "sequence" ASC`;
  }

  /**
   * The provider deliveries for one attempt's session, newest first.
   *
   * Correlated by `session_id`, which is how the consumer places an event in the first
   * place. An attempt whose session id is still null — a creation that never completed —
   * correctly has none.
   *
   * Bounded: Didit retries, so a pathological session can accumulate deliveries, and an
   * unbounded read on a detail view is how one bad row makes a screen hang.
   */
  async eventsFor(sessionId: string | null): Promise<readonly KycHistoryEventRow[]> {
    if (sessionId === null) return [];

    return this.prisma.$queryRaw<KycHistoryEventRow[]>`
      SELECT "event_id", "event_type", "received_at", "processed_at",
             "processing_status", "error", "signature_variant"
        FROM "identity"."kyc_provider_events"
       WHERE "session_id" = ${sessionId}
       ORDER BY "received_at" DESC
       LIMIT 50`;
  }
}
