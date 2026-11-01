import { WalletConfigurationInvalid } from './wallet-core.errors.js';
import { decodeWalletQueryCursor, encodeWalletQueryCursor,
  isCanonicalWalletHistoryTimestamp, walletQueryFingerprint } from './wallet-core.cursor.js';
import type { WalletCoreDatabase } from './wallet-core.database.js';
import type { WalletHistoryActor, WalletHistoryItem, WalletHistoryPage,
  WalletHistoryQuery, WalletProviderState } from './wallet-core.types.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_STATES = new Set<WalletProviderState>([
  'ACTIVATED', 'DISABLED', 'MAINTENANCE', 'UNAVAILABLE',
]);
const TIMESTAMP = `to_char(%s AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const EVENT_TYPES = new Set(['CHAIN.STATUS_CHANGED', 'CURRENCY.STATUS_CHANGED',
  'PROVIDER_MAINTENANCE.ENTERED', 'PROVIDER_MAINTENANCE.RECOVERED',
  'PROVIDER_MAINTENANCE.PINNED', 'PROVIDER_MAINTENANCE.UNPINNED']);
const STATUSES = new Set(['DRAFT', 'SCHEDULED', 'LIVE', 'ARCHIVED', 'REJECTED',
  'ACTIVE', 'CLEARED', 'SUCCESS', 'PARTIAL', 'FAILED', 'RUNNING', 'COMPLETED', 'SKIPPED']);
const RFC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface HistoryRow extends Record<string, unknown> {
  readonly id: unknown; readonly created_at: unknown; readonly category: unknown;
  readonly actor_kind: unknown; readonly actor_ref: unknown; readonly event_type: unknown;
  readonly subject_type: unknown; readonly subject_id: unknown; readonly from_state: unknown;
  readonly to_state: unknown; readonly reason_code: unknown; readonly before_pin: unknown;
  readonly after_pin: unknown; readonly revision: unknown; readonly record_status: unknown;
  readonly reason: unknown; readonly changelog_id: unknown; readonly config_actor_id: unknown;
  readonly effective_at: unknown; readonly applied_at: unknown; readonly alert_id: unknown;
  readonly alert_category: unknown; readonly currency_id: unknown; readonly scheduled_for: unknown;
  readonly completed_at: unknown; readonly currency_count: unknown; readonly warning_count: unknown;
  readonly safe_error_code: unknown; readonly policy_revision: unknown; readonly deadline: unknown;
  readonly processed_count: unknown; readonly skipped_count: unknown; readonly failed_count: unknown;
  readonly job_name: unknown; readonly attempt_count: unknown; readonly lease_expires_at: unknown;
  readonly finished_at: unknown;
}

const timestamp = (column: string): string => TIMESTAMP.replace('%s', column);
const requiredText = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error('WALLET_HISTORY_ROW_INVALID');
  return value;
};
const optionalText = (value: unknown): string | null =>
  value === null ? null : requiredText(value);
const optionalUuid = (value: unknown): string | null => {
  const result = optionalText(value);
  if (result !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result)) {
    throw new Error('WALLET_HISTORY_ROW_INVALID');
  }
  return result;
};
const instant = (value: unknown): string => {
  const result = requiredText(value);
  if (!isCanonicalWalletHistoryTimestamp(result)) throw new Error('WALLET_HISTORY_ROW_INVALID');
  return result;
};
const optionalInstant = (value: unknown): string | null => value === null ? null : instant(value);
const count = (value: unknown): number => {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('WALLET_HISTORY_ROW_INVALID');
  return result;
};
const decimalInteger = (value: unknown): string => {
  const result = requiredText(value);
  if (!/^(0|[1-9]\d*)$/.test(result)) throw new Error('WALLET_HISTORY_ROW_INVALID');
  return result;
};
const providerState = (value: unknown): WalletProviderState => {
  const result = requiredText(value) as WalletProviderState;
  if (!PROVIDER_STATES.has(result)) throw new Error('WALLET_HISTORY_ROW_INVALID');
  return result;
};
const nullableBoolean = (value: unknown): boolean | null => {
  if (value === null || typeof value === 'boolean') return value;
  throw new Error('WALLET_HISTORY_ROW_INVALID');
};
const actor = (row: HistoryRow): WalletHistoryActor => {
  if (row.actor_kind === null && row.actor_ref === null) return null;
  const reference = requiredText(row.actor_ref);
  if (row.actor_kind === 'ADMIN') return { kind: 'ADMIN', adminId: reference };
  if (row.actor_kind === 'SYSTEM') return { kind: 'SYSTEM', runId: reference };
  throw new Error('WALLET_HISTORY_ROW_INVALID');
};

function base(row: HistoryRow) {
  const id = requiredText(row.id);
  if (!UUID_V7.test(id)) throw new Error('WALLET_HISTORY_ROW_INVALID');
  return { id, createdAt: instant(row.created_at), actor: actor(row) } as const;
}

/** Converts each unioned event row into one closed, safe Admin history variant. */
function mapHistoryRow(row: HistoryRow): WalletHistoryItem {
  const common = base(row);
  switch (row.category) {
    case 'CONFIGURATION': {
      if (common.actor?.kind !== 'ADMIN') throw new Error('WALLET_HISTORY_ROW_INVALID');
      const status = requiredText(row.record_status);
      if (!['DRAFT', 'SCHEDULED', 'LIVE', 'ARCHIVED', 'REJECTED'].includes(status)) {
        throw new Error('WALLET_HISTORY_ROW_INVALID');
      }
      return { ...common, category: 'CONFIGURATION', configuration: {
        id: common.id, revision: decimalInteger(row.revision), status: status as never,
        reason: requiredText(row.reason), changelogId: optionalUuid(row.changelog_id),
        actorId: requiredText(row.config_actor_id), effectiveAt: optionalInstant(row.effective_at),
        appliedAt: optionalInstant(row.applied_at), createdAt: common.createdAt,
      } };
    }
    case 'STATE': {
      if (common.actor === null) throw new Error('WALLET_HISTORY_ROW_INVALID');
      const eventType = requiredText(row.event_type);
      const subjectType = requiredText(row.subject_type);
      if ((eventType !== 'CHAIN.STATUS_CHANGED' || subjectType !== 'CHAIN')
        && (eventType !== 'CURRENCY.STATUS_CHANGED'
          || !['CURRENCY', 'CURRENCY_CHAIN'].includes(subjectType))) {
        throw new Error('WALLET_HISTORY_ROW_INVALID');
      }
      return { ...common, category: 'STATE', eventType, subject: {
        type: subjectType, id: requiredText(row.subject_id),
      }, fromState: optionalText(row.from_state), toState: requiredText(row.to_state),
      reasonCode: optionalText(row.reason_code) } as WalletHistoryItem;
    }
    case 'PROVIDER': {
      if (common.actor === null) throw new Error('WALLET_HISTORY_ROW_INVALID');
      const eventType = requiredText(row.event_type);
      const subjectType = requiredText(row.subject_type);
      if (subjectType !== 'CHAIN' && subjectType !== 'CURRENCY_CHAIN') {
        throw new Error('WALLET_HISTORY_ROW_INVALID');
      }
      const subject = { type: subjectType, id: requiredText(row.subject_id) } as const;
      if (eventType === 'PROVIDER_MAINTENANCE.ENTERED'
        || eventType === 'PROVIDER_MAINTENANCE.RECOVERED') {
        if (row.before_pin !== null || row.after_pin !== null) throw new Error('WALLET_HISTORY_ROW_INVALID');
        return { ...common, category: 'PROVIDER', eventType, subject,
          fromState: providerState(row.from_state), toState: providerState(row.to_state),
          beforeMaintenancePinned: null, afterMaintenancePinned: null };
      }
      if (eventType === 'PROVIDER_MAINTENANCE.PINNED'
        || eventType === 'PROVIDER_MAINTENANCE.UNPINNED') {
        if (row.from_state !== null || row.to_state !== null) throw new Error('WALLET_HISTORY_ROW_INVALID');
        const beforeMaintenancePinned = nullableBoolean(row.before_pin);
        const afterMaintenancePinned = nullableBoolean(row.after_pin);
        if (beforeMaintenancePinned === null || afterMaintenancePinned === null) {
          throw new Error('WALLET_HISTORY_ROW_INVALID');
        }
        return { ...common, category: 'PROVIDER', eventType, subject, fromState: null, toState: null,
          beforeMaintenancePinned, afterMaintenancePinned };
      }
      throw new Error('WALLET_HISTORY_ROW_INVALID');
    }
    case 'ALERT': {
      if (common.actor !== null) throw new Error('WALLET_HISTORY_ROW_INVALID');
      const alertCategory = requiredText(row.alert_category);
      const status = requiredText(row.record_status);
      if (!['SHORTFALL', 'PARTIAL_DATA', 'STAKING_TOTAL_MISMATCH', 'CATALOGUE_REFRESH_FAILED',
        'PRICE_MAINTENANCE', 'DELISTING_PENDING', 'DELISTING_ACCOUNT_REVIEW', 'PROVIDER_MAINTENANCE']
        .includes(alertCategory) || (status !== 'ACTIVE' && status !== 'CLEARED')) {
        throw new Error('WALLET_HISTORY_ROW_INVALID');
      }
      return { ...common, category: 'ALERT', alertId: requiredText(row.alert_id),
        alertCategory: alertCategory as never, status, currencyId: optionalText(row.currency_id) };
    }
    case 'RECONCILIATION': {
      if (common.actor !== null) throw new Error('WALLET_HISTORY_ROW_INVALID');
      const status = requiredText(row.record_status);
      if (!['SUCCESS', 'PARTIAL', 'FAILED'].includes(status)) throw new Error('WALLET_HISTORY_ROW_INVALID');
      return { ...common, category: 'RECONCILIATION', runId: common.id, status: status as never,
        scheduledFor: instant(row.scheduled_for), completedAt: optionalInstant(row.completed_at),
        currencyCount: count(row.currency_count), warningCount: count(row.warning_count),
        safeErrorCode: optionalText(row.safe_error_code) };
    }
    case 'FORFEITURE': {
      if (common.actor !== null) throw new Error('WALLET_HISTORY_ROW_INVALID');
      const status = requiredText(row.record_status);
      if (!['RUNNING', 'PARTIAL', 'FAILED', 'COMPLETED'].includes(status)) {
        throw new Error('WALLET_HISTORY_ROW_INVALID');
      }
      return { ...common, category: 'FORFEITURE', executionId: common.id,
        currencyId: requiredText(row.currency_id), policyRevision: decimalInteger(row.policy_revision),
        status: status as never, deadline: instant(row.deadline),
        processedCount: count(row.processed_count), skippedCount: count(row.skipped_count),
        failedCount: count(row.failed_count), safeErrorCode: optionalText(row.safe_error_code) };
    }
    case 'JOB': {
      if (common.actor !== null) throw new Error('WALLET_HISTORY_ROW_INVALID');
      const status = requiredText(row.record_status);
      if (!['RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED'].includes(status)) {
        throw new Error('WALLET_HISTORY_ROW_INVALID');
      }
      return { ...common, category: 'JOB', jobName: requiredText(row.job_name),
        scheduledFor: instant(row.scheduled_for), status: status as never,
        attemptCount: count(row.attempt_count), processedCount: count(row.processed_count),
        failedCount: count(row.failed_count), safeErrorCode: optionalText(row.safe_error_code),
        leaseExpiresAt: optionalInstant(row.lease_expires_at),
        finishedAt: optionalInstant(row.finished_at) };
    }
    default: throw new Error('WALLET_HISTORY_ROW_INVALID');
  }
}

/** Serves the complete Wallet business and runtime timeline with stable keyset pagination. */
export class WalletCoreHistoryRepository {
  constructor(private readonly database: WalletCoreDatabase) {}

  async history(input: WalletHistoryQuery): Promise<WalletHistoryPage> {
    const limit = input.limit ?? 50; const sortDirection = input.sortDirection ?? 'desc';
    const queryShape = { ...input, sortDirection };
    const queryFingerprint = walletQueryFingerprint(Object.fromEntries(
      ['eventType', 'currencyId', 'actorId', 'status', 'from', 'to', 'sortDirection']
        .map((key) => [key, queryShape[key as keyof typeof queryShape]])));
    const cursor = input.cursor === undefined ? null : decodeWalletQueryCursor(input.cursor,
      'HISTORY', queryFingerprint, 2);
    const validUtc = (value: string | undefined) => value === undefined
      || (/Z$/.test(value) && Number.isFinite(Date.parse(value)));
    if (Object.keys(input).some((key) => !['eventType', 'currencyId', 'actorId', 'status',
      'from', 'to', 'sortDirection', 'cursor', 'limit'].includes(key))
      || !Number.isInteger(limit) || limit < 1 || limit > 100
      || (input.eventType !== undefined && !EVENT_TYPES.has(input.eventType))
      || (input.currencyId !== undefined && !RFC_UUID.test(input.currencyId))
      || (input.actorId !== undefined && !RFC_UUID.test(input.actorId))
      || (input.status !== undefined && !STATUSES.has(input.status))
      || !validUtc(input.from) || !validUtc(input.to)
      || (input.from !== undefined && input.to !== undefined
        && Date.parse(input.from) >= Date.parse(input.to))
      || !['asc', 'desc'].includes(sortDirection)
      || (input.cursor !== undefined && (cursor === null
        || !isCanonicalWalletHistoryTimestamp(cursor[0]) || !UUID_V7.test(cursor[1]!)))) {
      throw new WalletConfigurationInvalid('Invalid Wallet history query.');
    }
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await client.query<HistoryRow>(this.sql(sortDirection), [
        cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1, input.eventType ?? null,
        input.currencyId ?? null, input.actorId ?? null, input.status ?? null,
        input.from ?? null, input.to ?? null,
      ]);
      const mapped = result.rows.map(mapHistoryRow);
      const items = mapped.slice(0, limit);
      const last = items.at(-1);
      return { items, nextCursor: mapped.length > limit && last
        ? encodeWalletQueryCursor('HISTORY', queryFingerprint, [last.createdAt, last.id]) : null };
    });
  }

  private sql(sortDirection: 'asc' | 'desc'): string {
    const wallet = this.database.schemas.wallet;
    const direction = sortDirection === 'asc' ? 'ASC' : 'DESC';
    const comparison = sortDirection === 'asc' ? '>' : '<';
    const emptyTail = [
      ...Array<string>(12).fill('NULL::text'),
      'NULL::integer', 'NULL::integer',
      'NULL::text', 'NULL::text', 'NULL::text',
      'NULL::integer', 'NULL::integer', 'NULL::integer',
      'NULL::text', 'NULL::integer', 'NULL::text', 'NULL::text',
    ].join(',');
    return `WITH history AS (
      SELECT c.id id,c.created_at sort_at,'CONFIGURATION'::text category,
        'ADMIN'::text actor_kind,c.actor_id::text actor_ref,
        NULL::text event_type,NULL::text subject_type,NULL::text subject_id,NULL::text from_state,
        NULL::text to_state,NULL::text reason_code,NULL::boolean before_pin,NULL::boolean after_pin,
        c.revision::text revision,c.status::text record_status,c.reason,c.changelog_id::text,
        c.actor_id::text config_actor_id,${timestamp('c.effective_at')} effective_at,
        ${timestamp('c.applied_at')} applied_at,NULL::text alert_id,NULL::text alert_category,
        NULL::text currency_id,NULL::text scheduled_for,NULL::text completed_at,
        NULL::integer currency_count,NULL::integer warning_count,NULL::text safe_error_code,
        NULL::text policy_revision,NULL::text deadline,NULL::integer processed_count,
        NULL::integer skipped_count,NULL::integer failed_count,NULL::text job_name,
        NULL::integer attempt_count,NULL::text lease_expires_at,NULL::text finished_at
      FROM (SELECT * FROM ${wallet}.configuration_changes
        WHERE $4::text IS NULL AND $5::uuid IS NULL
          AND ($6::uuid IS NULL OR actor_id=$6) AND ($7::text IS NULL OR status::text=$7)
          AND ($8::timestamptz IS NULL OR created_at>=$8)
          AND ($9::timestamptz IS NULL OR created_at<$9)
          AND ($1::timestamptz IS NULL OR (created_at,id)${comparison}($1::timestamptz,$2::uuid))
        ORDER BY created_at ${direction},id ${direction} LIMIT $3) c
      UNION ALL
      SELECT e.id,e.created_at,'STATE',CASE WHEN e.actor_id IS NULL THEN 'SYSTEM' ELSE 'ADMIN' END,
        COALESCE(e.actor_id,e.run_id)::text,e.event_type,e.subject_type,e.subject_id::text,
        e.payload#>>'{before,desiredState}',e.payload#>>'{after,desiredState}',
        e.payload#>>'{metadata,reasonCode}',NULL::boolean,NULL::boolean,${emptyTail}
      FROM (SELECT * FROM ${wallet}.state_events
        WHERE event_type IN ('CHAIN.STATUS_CHANGED','CURRENCY.STATUS_CHANGED')
          AND ($4::text IS NULL OR event_type=$4)
          AND ($5::uuid IS NULL OR (subject_type='CURRENCY' AND subject_id=$5)
            OR (subject_type='CURRENCY_CHAIN' AND EXISTS (SELECT 1 FROM ${wallet}.currencies binding
              WHERE binding.id=subject_id AND binding.currency_id=$5)))
          AND ($6::uuid IS NULL OR COALESCE(actor_id,run_id)=$6) AND $7::text IS NULL
          AND ($8::timestamptz IS NULL OR created_at>=$8)
          AND ($9::timestamptz IS NULL OR created_at<$9)
          AND ($1::timestamptz IS NULL OR (created_at,id)${comparison}($1::timestamptz,$2::uuid))
        ORDER BY created_at ${direction},id ${direction} LIMIT $3) e
      UNION ALL
      SELECT e.id,e.created_at,'PROVIDER',CASE WHEN e.actor_id IS NULL THEN 'SYSTEM' ELSE 'ADMIN' END,
        COALESCE(e.actor_id,e.run_id)::text,e.event_type,e.subject_type,e.subject_id::text,
        CASE WHEN e.event_type IN ('PROVIDER_MAINTENANCE.ENTERED','PROVIDER_MAINTENANCE.RECOVERED')
          THEN e.payload#>>'{before,providerState}' END,
        CASE WHEN e.event_type IN ('PROVIDER_MAINTENANCE.ENTERED','PROVIDER_MAINTENANCE.RECOVERED')
          THEN e.payload#>>'{after,providerState}' END,NULL::text,
        CASE WHEN e.event_type IN ('PROVIDER_MAINTENANCE.PINNED','PROVIDER_MAINTENANCE.UNPINNED')
          THEN (e.payload#>>'{before,maintenancePinned}')::boolean END,
        CASE WHEN e.event_type IN ('PROVIDER_MAINTENANCE.PINNED','PROVIDER_MAINTENANCE.UNPINNED')
          THEN (e.payload#>>'{after,maintenancePinned}')::boolean END,${emptyTail}
      FROM (SELECT * FROM ${wallet}.state_events WHERE event_type IN
        ('PROVIDER_MAINTENANCE.ENTERED','PROVIDER_MAINTENANCE.RECOVERED',
         'PROVIDER_MAINTENANCE.PINNED','PROVIDER_MAINTENANCE.UNPINNED')
          AND ($4::text IS NULL OR event_type=$4)
          AND ($5::uuid IS NULL OR (subject_type='CURRENCY_CHAIN' AND EXISTS
            (SELECT 1 FROM ${wallet}.currencies binding WHERE binding.id=subject_id
              AND binding.currency_id=$5)))
          AND ($6::uuid IS NULL OR COALESCE(actor_id,run_id)=$6) AND $7::text IS NULL
          AND ($8::timestamptz IS NULL OR created_at>=$8)
          AND ($9::timestamptz IS NULL OR created_at<$9)
          AND ($1::timestamptz IS NULL OR (created_at,id)${comparison}($1::timestamptz,$2::uuid))
        ORDER BY created_at ${direction},id ${direction} LIMIT $3) e
      UNION ALL
      SELECT ae.id,ae.created_at,'ALERT',NULL::text,NULL::text,
        NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::boolean,NULL::boolean,
        NULL::text,ae.status::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
        ae.alert_id::text,ae.category::text,a.currency_id::text,NULL::text,NULL::text,
        NULL::integer,NULL::integer,NULL::text,NULL::text,NULL::text,NULL::integer,
        NULL::integer,NULL::integer,NULL::text,NULL::integer,NULL::text,NULL::text
      FROM (SELECT ae.* FROM ${wallet}.wallet_alert_events ae
        JOIN ${wallet}.wallet_alerts source_alert ON source_alert.id=ae.alert_id
        WHERE $4::text IS NULL AND ($5::uuid IS NULL OR source_alert.currency_id=$5)
          AND $6::uuid IS NULL AND ($7::text IS NULL OR ae.status::text=$7)
          AND ($8::timestamptz IS NULL OR ae.created_at>=$8)
          AND ($9::timestamptz IS NULL OR ae.created_at<$9)
          AND ($1::timestamptz IS NULL OR (ae.created_at,ae.id)${comparison}
            ($1::timestamptz,$2::uuid))
        ORDER BY ae.created_at ${direction},ae.id ${direction} LIMIT $3) ae
      JOIN ${wallet}.wallet_alerts a ON a.id=ae.alert_id
      UNION ALL
      SELECT r.id,r.scheduled_for,'RECONCILIATION',NULL::text,NULL::text,
        NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::boolean,NULL::boolean,
        NULL::text,r.status::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
        NULL::text,NULL::text,NULL::text,${timestamp('r.scheduled_for')},${timestamp('r.completed_at')},
        r.currency_count,r.warning_count,r.safe_error_code,NULL::text,NULL::text,NULL::integer,
        NULL::integer,NULL::integer,NULL::text,NULL::integer,NULL::text,NULL::text
      FROM (SELECT * FROM ${wallet}.wallet_reconciliation_runs WHERE status IS NOT NULL
        AND $4::text IS NULL
        AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM ${wallet}.wallet_reconciliation_items item
          WHERE item.run_id=wallet_reconciliation_runs.id AND item.currency_id=$5))
        AND $6::uuid IS NULL AND ($7::text IS NULL OR status::text=$7)
        AND ($8::timestamptz IS NULL OR scheduled_for>=$8)
        AND ($9::timestamptz IS NULL OR scheduled_for<$9)
        AND ($1::timestamptz IS NULL OR (scheduled_for,id)${comparison}($1::timestamptz,$2::uuid))
        ORDER BY scheduled_for ${direction},id ${direction} LIMIT $3) r
      UNION ALL
      SELECT d.id,d.created_at,'FORFEITURE',NULL::text,NULL::text,
        NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::boolean,NULL::boolean,
        NULL::text,d.status::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
        NULL::text,NULL::text,d.currency_id::text,NULL::text,NULL::text,NULL::integer,NULL::integer,
        d.safe_error_code,d.policy_revision::text,${timestamp('d.deadline')},d.processed_count,
        d.skipped_count,d.failed_count,NULL::text,NULL::integer,NULL::text,NULL::text
      FROM (SELECT * FROM ${wallet}.delisting_executions
        WHERE $4::text IS NULL AND ($5::uuid IS NULL OR currency_id=$5)
          AND $6::uuid IS NULL AND ($7::text IS NULL OR status::text=$7)
          AND ($8::timestamptz IS NULL OR created_at>=$8)
          AND ($9::timestamptz IS NULL OR created_at<$9)
          AND ($1::timestamptz IS NULL OR (created_at,id)${comparison}($1::timestamptz,$2::uuid))
        ORDER BY created_at ${direction},id ${direction} LIMIT $3) d
      UNION ALL
      SELECT j.id,j.started_at,'JOB',NULL::text,NULL::text,
        NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::boolean,NULL::boolean,
        NULL::text,j.status::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
        NULL::text,NULL::text,NULL::text,${timestamp('j.scheduled_for')},NULL::text,NULL::integer,
        NULL::integer,j.safe_error_code::text,NULL::text,NULL::text,j.processed_count,NULL::integer,
        j.failed_count,j.job_name,j.attempt_count,${timestamp('j.lease_expires_at')},
        ${timestamp('j.finished_at')}
      FROM (SELECT * FROM ${wallet}.cronjob_runs
        WHERE $4::text IS NULL AND $5::uuid IS NULL AND $6::uuid IS NULL
          AND ($7::text IS NULL OR status::text=$7)
          AND ($8::timestamptz IS NULL OR started_at>=$8)
          AND ($9::timestamptz IS NULL OR started_at<$9)
          AND ($1::timestamptz IS NULL OR (started_at,id)${comparison}($1::timestamptz,$2::uuid))
        ORDER BY started_at ${direction},id ${direction} LIMIT $3) j
    ) SELECT id::text,${timestamp('sort_at')} created_at,category,actor_kind,actor_ref,event_type,
      subject_type,subject_id,from_state,to_state,reason_code,before_pin,after_pin,revision,
      record_status,reason,changelog_id,config_actor_id,effective_at,applied_at,alert_id,alert_category,
      currency_id,scheduled_for,completed_at,currency_count,warning_count,safe_error_code,
      policy_revision,deadline,processed_count,skipped_count,failed_count,job_name,attempt_count,
      lease_expires_at,finished_at FROM history
    WHERE ($1::timestamptz IS NULL OR (history.sort_at,history.id)
      ${comparison} ($1::timestamptz,$2::uuid))
    ORDER BY history.sort_at ${direction},history.id ${direction} LIMIT $3`;
  }
}
