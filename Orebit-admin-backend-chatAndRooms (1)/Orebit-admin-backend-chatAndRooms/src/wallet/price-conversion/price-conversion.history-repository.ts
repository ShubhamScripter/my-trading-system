import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyCursorContext,
} from './price-conversion.cursor.js';
import { type PriceConversionPool, type PriceConversionSchema } from './price-conversion.database.js';
import { isoOrNull, requiredCursorTimestamp, requiredIso,
  stringOrNull } from './price-conversion.row-values.js';
import type {
  AuditHistoryItem,
  ConfigChangeHistoryItem,
  FetchRunHistoryItem,
  PriceConversionHistoryItem,
  PriceConversionHistoryPage,
  PriceConversionHistoryQuery,
  ProviderCode,
  ResolutionHistoryItem,
  ViewResolutionHistoryItem,
} from './price-conversion.types.js';

interface HistoryRow {
  readonly id: string;
  readonly createdAt: unknown;
  readonly cursorCreatedAt: unknown;
  readonly kind: PriceConversionHistoryItem['kind'];
  readonly payload: Record<string, unknown>;
}

/** Reads append-only operational and audit history with a query-bound opaque cursor. */
export class PriceConversionHistoryRepository {
  private readonly schema: PriceConversionSchema;

  constructor(private readonly database: PriceConversionPool) {
    this.schema = database.priceConversionSchema ?? 'price_conversion';
  }

  /** Returns one mapped history page without mutating any operational table. */
  async history(input: PriceConversionHistoryQuery): Promise<PriceConversionHistoryPage> {
    const decodedCursor = input.cursor === undefined ? null : decodeHistoryCursor(input.cursor);
    if (input.cursor !== undefined && decodedCursor === null) throw new Error('Invalid history cursor');
    const context = historyCursorContext(input);
    if (decodedCursor !== null && decodedCursor[2] !== context) {
      throw new Error('History cursor does not match query');
    }
    const values: unknown[] = [];
    const parameter = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    const eventType = input.eventType === undefined ? null : parameter(input.eventType);
    const currencyId = input.currencyId === undefined ? null : parameter(input.currencyId);
    const providerCode = input.providerCode === undefined ? null : parameter(input.providerCode);
    const status = input.status === undefined ? null : parameter(input.status);
    const from = input.from === undefined ? null : parameter(input.from);
    const to = input.to === undefined ? null : parameter(input.to);
    const direction = input.sortDirection === 'asc' ? 'ASC' : 'DESC';
    const comparator = direction === 'ASC' ? '>' : '<';
    const cursorAt = decodedCursor === null ? null : parameter(decodedCursor[0]);
    const cursorId = decodedCursor === null ? null : parameter(decodedCursor[1]);
    const where = (
      kind: PriceConversionHistoryItem['kind'],
      alias: string,
      branchCurrency: string | null,
      branchProvider: string | null,
      branchStatus: string | null,
    ): string => {
      const predicates = [
        ...(eventType === null ? [] : [`${eventType} = '${kind}'`]),
        ...(currencyId === null ? [] : [branchCurrency === null ? 'FALSE' : `${branchCurrency} = ${currencyId}::uuid`]),
        ...(providerCode === null ? [] : [branchProvider === null ? 'FALSE' : branchProvider]),
        ...(status === null ? [] : [branchStatus === null ? 'FALSE' : `${branchStatus} = ${status}`]),
        ...(from === null ? [] : [`${alias}.created_at >= ${from}::timestamptz`]),
        ...(to === null ? [] : [`${alias}.created_at < ${to}::timestamptz`]),
        ...(cursorAt === null || cursorId === null ? [] : [
          `(${alias}.created_at, ${alias}.id) ${comparator} (${cursorAt}::timestamptz, ${cursorId}::uuid)`,
        ]),
      ];
      return predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
    };
    const resolutionWhere = where('RESOLUTION', 'r', 'r.currency_id',
      providerCode === null ? null : `${providerCode} = p.code::text`, null);
    const viewWhere = where('VIEW_RESOLUTION', 'v', 'v.currency_id',
      providerCode === null ? null : `${providerCode} IN (selected.code::text, configured.code::text, secondary.code::text)`,
      'v.status::text');
    const fetchWhere = where('FETCH_RUN', 'f', null,
      providerCode === null ? null : `${providerCode} = p.code::text`, 'f.status::text');
    const configWhere = where('CONFIG_CHANGE', 'c', null, null, 'c.status::text');
    const auditWhere = where('AUDIT', 'a', null, null, null);
    const limit = parameter(input.limit + 1);
    const result = await this.database.query<HistoryRow>(`WITH events AS (
      (SELECT r.id, r.created_at, 'RESOLUTION'::text AS kind,
        ARRAY_REMOVE(ARRAY[p.code::text], NULL)::text[] AS provider_codes, NULL::text AS status,
        jsonb_build_object(
          'currencyId', r.currency_id, 'reason', r.reason::text, 'priceUsd', r.effective_price_usd::text,
          'observedAt', r.observed_at, 'provider', p.code::text, 'snapshotId', r.effective_snapshot_id,
          'stale', r.stale
        ) AS payload
      FROM ${this.schema}.price_resolutions r
      LEFT JOIN ${this.schema}.price_providers p ON p.id = r.effective_provider_id
      ${resolutionWhere} ORDER BY r.created_at ${direction}, r.id ${direction} LIMIT ${limit})
      UNION ALL
      (SELECT v.id, v.created_at, 'VIEW_RESOLUTION'::text,
        ARRAY_REMOVE(ARRAY[selected.code::text, configured.code::text, secondary.code::text], NULL)::text[],
        v.status::text,
        jsonb_build_object(
          'currencyId', v.currency_id, 'selectedProvider', selected.code::text,
          'configuredProvider', configured.code::text, 'secondaryProvider', secondary.code::text,
          'sensitiveResolutionId', v.sensitive_resolution_id, 'reason', v.reason::text,
          'status', v.status::text, 'safeErrorCode', v.safe_error_code
        )
      FROM ${this.schema}.price_view_resolutions v
      LEFT JOIN ${this.schema}.price_providers selected ON selected.id = v.selected_provider_id
      JOIN ${this.schema}.price_providers configured ON configured.id = v.configured_provider_id
      LEFT JOIN ${this.schema}.price_providers secondary ON secondary.id = v.secondary_provider_id
      ${viewWhere} ORDER BY v.created_at ${direction}, v.id ${direction} LIMIT ${limit})
      UNION ALL
      (SELECT f.id, f.created_at, 'FETCH_RUN'::text,
        ARRAY[p.code::text]::text[], f.status::text,
        jsonb_build_object(
          'provider', p.code::text, 'scheduledFor', f.scheduled_for, 'status', f.status::text,
          'requestedCount', f.requested_count, 'observedCount', f.observed_count,
          'latencyMs', f.latency_ms, 'safeErrorCode', f.safe_error_code,
          'workerInstanceId', f.worker_instance_id, 'startedAt', f.started_at, 'finishedAt', f.finished_at
        )
      FROM ${this.schema}.price_fetch_runs f
      JOIN ${this.schema}.price_providers p ON p.id = f.provider_id
      ${fetchWhere} ORDER BY f.created_at ${direction}, f.id ${direction} LIMIT ${limit})
      UNION ALL
      (SELECT c.id, c.created_at, 'CONFIG_CHANGE'::text, '{}'::text[], c.status::text,
        jsonb_build_object(
          'revision', c.revision, 'status', c.status::text, 'effectiveAt', c.effective_at,
          'changelog', c.changelog, 'actorId', c.actor_id, 'config', c.config, 'appliedAt', c.applied_at
        )
      FROM ${this.schema}.price_config_changes c
      ${configWhere} ORDER BY c.created_at ${direction}, c.id ${direction} LIMIT ${limit})
      UNION ALL
      (SELECT a.id, a.created_at, 'AUDIT'::text, '{}'::text[], NULL::text,
        jsonb_build_object(
          'actorId', a.actor_id, 'sessionId', a.session_id, 'requestId', a.request_id,
          'ipAddress', host(a.ip_address), 'deviceId', a.device_id, 'action', a.action,
          'reason', a.reason, 'before', a.before_json, 'after', a.after_json
        )
      FROM ${this.schema}.price_admin_audit a
      ${auditWhere} ORDER BY a.created_at ${direction}, a.id ${direction} LIMIT ${limit})
    )
    SELECT id, created_at AS "createdAt",
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt",
      kind, payload FROM events
    ORDER BY created_at ${direction}, id ${direction} LIMIT ${limit}`, values);
    const rows = result.rows.slice(0, input.limit);
    return {
      items: rows.map(mapHistoryItem),
      nextCursor: result.rows.length > input.limit
        ? encodeHistoryCursor([requiredCursorTimestamp(rows.at(-1)?.cursorCreatedAt),
          String(rows.at(-1)?.id), context])
        : null,
    };
  }
}

function mapHistoryItem(row: HistoryRow): PriceConversionHistoryItem {
  const base = { id: row.id, createdAt: requiredIso(row.createdAt) };
  const payload = row.payload;
  if (row.kind === 'RESOLUTION') {
    return {
      ...base,
      kind: 'RESOLUTION',
      currencyId: String(payload.currencyId),
      reason: payload.reason as ResolutionHistoryItem['reason'],
      priceUsd: stringOrNull(payload.priceUsd),
      observedAt: isoOrNull(payload.observedAt),
      provider: payload.provider as ProviderCode | null,
      snapshotId: stringOrNull(payload.snapshotId),
      stale: Boolean(payload.stale),
    };
  }
  if (row.kind === 'FETCH_RUN') {
    return {
      ...base,
      kind: 'FETCH_RUN',
      provider: payload.provider as ProviderCode,
      scheduledFor: requiredIso(payload.scheduledFor),
      status: payload.status as FetchRunHistoryItem['status'],
      requestedCount: Number(payload.requestedCount),
      observedCount: Number(payload.observedCount),
      latencyMs: numberOrNull(payload.latencyMs),
      safeErrorCode: stringOrNull(payload.safeErrorCode),
      workerInstanceId: String(payload.workerInstanceId),
      startedAt: isoOrNull(payload.startedAt),
      finishedAt: isoOrNull(payload.finishedAt),
    };
  }
  if (row.kind === 'VIEW_RESOLUTION') {
    return {
      ...base,
      kind: 'VIEW_RESOLUTION',
      currencyId: String(payload.currencyId),
      selectedProvider: payload.selectedProvider as ProviderCode | null,
      configuredProvider: payload.configuredProvider as ProviderCode,
      secondaryProvider: payload.secondaryProvider as ProviderCode | null,
      sensitiveResolutionId: stringOrNull(payload.sensitiveResolutionId),
      reason: payload.reason as ViewResolutionHistoryItem['reason'],
      status: payload.status as ViewResolutionHistoryItem['status'],
      safeErrorCode: stringOrNull(payload.safeErrorCode),
    };
  }
  if (row.kind === 'CONFIG_CHANGE') {
    return {
      ...base,
      kind: 'CONFIG_CHANGE',
      revision: Number(payload.revision),
      status: payload.status as ConfigChangeHistoryItem['status'],
      effectiveAt: isoOrNull(payload.effectiveAt),
      changelog: String(payload.changelog),
      actorId: stringOrNull(payload.actorId),
      config: payload.config,
      appliedAt: isoOrNull(payload.appliedAt),
    };
  }
  return {
    ...base,
    kind: 'AUDIT',
    actorId: stringOrNull(payload.actorId),
    sessionId: stringOrNull(payload.sessionId),
    requestId: stringOrNull(payload.requestId),
    ipAddress: stringOrNull(payload.ipAddress),
    deviceId: stringOrNull(payload.deviceId),
    action: String(payload.action),
    reason: String(payload.reason),
    before: payload.before,
    after: payload.after,
  } as AuditHistoryItem;
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
