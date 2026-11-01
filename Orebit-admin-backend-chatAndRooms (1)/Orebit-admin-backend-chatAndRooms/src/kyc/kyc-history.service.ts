import { Injectable, Logger } from '@nestjs/common';
import { AUTH_EVENT, AuthEventDbOperation } from '../../auth/auth.dboperation';
import type { ClientContext, Principal } from '../../auth/auth.types';
import { ERR } from '../contracts';
import { ProblemException } from '../http';
import {
  KycHistoryDbOperation,
  type KycHistoryAttemptRow,
  type KycHistoryDeviceRow,
  type KycHistoryEventRow,
} from './kyc-history.dboperation';
import type {
  KycHistoryAttemptPayload,
  KycHistoryAttemptQuery,
  KycHistoryAttemptView,
  KycHistoryDeviceView,
  KycHistoryEventView,
  KycHistoryPayload,
  KycHistoryQuery,
} from './kyc-history.dto';

/**
 * ═══ READING WHAT AN ACCOUNT HAS EVER ATTEMPTED ════════════════════════════
 *
 * Read-only, in the strong sense: this service has no method that writes anything, and
 * `KycHistoryDbOperation` has no mutating statement. It cannot approve a case, cannot
 * move a verification through its state machine, cannot start a Didit session, cannot
 * touch a level state and cannot trigger a renewal.
 *
 * That last one is worth stating plainly because it is the easiest to breach by
 * accident: NOTHING here calls the renewal evaluator, reads the global periods, or
 * derives a validity deadline. Querying history cannot change what an account holds,
 * whatever X and Y are set to — including when both are null and renewal is off.
 *
 * ─── Reads ARE audited ────────────────────────────────────────────────────
 *
 * KYC history is sensitive personal data, so who looked is itself worth recording. The
 * filter is captured rather than the results: "this admin listed L2 declines for
 * September" is the fact a later review needs, and copying the returned rows into the
 * audit table would duplicate the very data the audit is about.
 */
@Injectable()
export class KycHistoryService {
  private readonly logger = new Logger('KycHistory');

  constructor(
    private readonly history: KycHistoryDbOperation,
    private readonly events: AuthEventDbOperation,
  ) {}

  /** One page of attempts, newest first. */
  async list(
    query: KycHistoryQuery,
    actor: Principal,
    client: ClientContext,
  ): Promise<KycHistoryPayload> {
    const page = await this.history.list({
      ...(query.userId === undefined ? {} : { userId: query.userId }),
      ...(query.level === undefined ? {} : { level: query.level }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit,
    });

    await this.recordRead(actor, client, {
      scope: 'list',
      userId: query.userId ?? null,
      level: query.level ?? null,
      status: query.status ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      returned: page.items.length,
    });

    return { items: page.items.map(toAttemptView), nextCursor: page.nextCursor };
  }

  /**
   * One attempt, with the devices observed during it and the deliveries that settled it.
   *
   * Three reads rather than one join: the devices and the events fan out per attempt, so
   * joining them into the list query would multiply a fifty-row page by both. Here the
   * target is a single row and the fan-out is bounded.
   */
  async attempt(
    query: KycHistoryAttemptQuery,
    actor: Principal,
    client: ClientContext,
  ): Promise<KycHistoryAttemptPayload> {
    const attempt = await this.history.findAttempt(query.verificationId);

    // 404 rather than an empty shape: an id that does not exist and one an operator
    // mistyped are the same thing to them, and an empty payload reads as "this attempt
    // had no devices" rather than "there is no such attempt".
    if (attempt === null) throw new ProblemException({ type: ERR.NOT_FOUND });

    const [devices, providerEvents] = await Promise.all([
      this.history.devicesFor(attempt.id),
      this.history.eventsFor(attempt.session_id),
    ]);

    await this.recordRead(actor, client, {
      scope: 'attempt',
      verificationId: attempt.id,
      userId: attempt.user_id,
      level: attempt.level,
    });

    return {
      attempt: toAttemptView(attempt),
      devices: devices.map(toDeviceView),
      providerEvents: providerEvents.map(toEventView),
    };
  }

  /** Who looked, and at what. Never at what came back. */
  private async recordRead(
    actor: Principal,
    client: ClientContext,
    // Scalars only, matching what `AuthEventDbOperation.record` stores. Deliberately not
    // widened to `unknown`: the column holds a flat map, and a nested object here would
    // be the first step towards stuffing returned rows into an audit row.
    metadata: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    this.logger.log({ actorAdminId: actor.adminId, ...metadata }, 'kyc history read');

    await this.events.record({
      eventType: AUTH_EVENT.KYC_HISTORY_VIEWED,
      adminId: actor.adminId,
      client,
      metadata,
    });
  }
}

/** ISO strings at the boundary — the domain hands out `Date`, the wire takes text. */
function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toAttemptView(row: KycHistoryAttemptRow): KycHistoryAttemptView {
  return {
    verificationId: row.id,
    userId: row.user_id,
    // Straight from the persisted column. Never from provider metadata, never from
    // `vendor_data`, never from the workflow name, and never from a query parameter —
    // the same invariant the webhook path holds.
    level: row.level,
    status: row.status,
    providerStatus: row.provider_status,
    sessionId: row.session_id,
    workflowId: row.workflow_id,
    workflowSource: row.workflow_source,
    verifiedCountry: row.verified_country,
    amlStatus: row.aml_status,
    amlTotalHits: row.aml_total_hits,
    documentType: row.document_type,
    documentSubtype: row.document_subtype,
    startedAt: row.started_at.toISOString(),
    completedAt: iso(row.completed_at),
    // Renamed on the way out. The column is `expires_at`, and the rename is the whole
    // point: it is the hosted session's window, not the account's validity deadline.
    providerSessionExpiresAt: iso(row.expires_at),
    renewalOfId: row.renewal_of_id,
    reconciledAt: iso(row.reconciled_at),
    // Already microsecond text from the SQL, for the cursor. Handed through unchanged
    // so the value a client sees is the value the keyset compares.
    createdAt: row.created_at,
    updatedAt: row.updated_at.toISOString(),
    // The LEFT JOIN yields null when the account holds no credential at that level at
    // all, which is not the same as "this one is not it" only in origin — both mean the
    // attempt is not currently in force.
    isActiveCredential: row.is_active_credential === true,
  };
}

function toDeviceView(row: KycHistoryDeviceRow): KycHistoryDeviceView {
  return {
    sequence: row.sequence,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    deviceFingerprint: row.device_fingerprint,
    browserFamily: row.browser_family,
    osFamily: row.os_family,
    platform: row.platform,
    isVpnOrTor: row.is_vpn_or_tor,
    isDataCenter: row.is_data_center,
  };
}

function toEventView(row: KycHistoryEventRow): KycHistoryEventView {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    receivedAt: row.received_at.toISOString(),
    processedAt: iso(row.processed_at),
    processingStatus: row.processing_status,
    error: row.error,
    signatureVariant: row.signature_variant,
  };
}
