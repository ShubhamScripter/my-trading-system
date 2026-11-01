import { Injectable } from '@nestjs/common';
import { validateAdminAuditConfiguration, hasUnavailablePricingTarget } from './admin-audit.configuration.js';
import type { AdminAuditJson } from './admin-audit.types.js';

import {
  decodeAdminAuditCursor,
  encodeAdminAuditCursor,
  isCanonicalAdminAuditTimestamp,
} from './admin-audit.cursor.js';
import { AdminAuditDatabase } from './admin-audit.database.js';
import {
  DEPOSIT_ADMIN_AUDIT_ACTIONS,
  WALLET_CORE_ADMIN_AUDIT_ACTIONS,
  type AdminAuditActor,
  type AdminAuditHistoryItem,
  type AdminAuditHistoryPage,
  type AdminAuditHistoryQuery,
} from './admin-audit.types.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set<string>([
  ...WALLET_CORE_ADMIN_AUDIT_ACTIONS,
  ...DEPOSIT_ADMIN_AUDIT_ACTIONS,
]);
const KEYS = new Set([
  'domain', 'action', 'actorId', 'runId', 'subjectType', 'subjectId',
  'from', 'to', 'cursor', 'limit',
]);
const SUBJECT_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;

type NormalizedQuery = AdminAuditHistoryQuery & { readonly limit: number };
type Scalar = string | number | boolean | null;
type State = Readonly<Record<string, AdminAuditJson>>;
type HistoryRow = {
  page_has_more: unknown;
  id: unknown;
  event_key: unknown;
  domain: unknown;
  action: unknown;
  actor_kind: unknown;
  actor_id: unknown;
  session_id: unknown;
  request_id: unknown;
  run_id: unknown;
  ip_address: unknown;
  device_id: unknown;
  subject_type: unknown;
  subject_id: unknown;
  reason: unknown;
  before_json: unknown;
  after_json: unknown;
  metadata_json: unknown;
  created_at: unknown;
};

function invalidQuery(): never {
  throw new Error('INVALID_ADMIN_AUDIT_HISTORY_QUERY');
}

function normalizeUuid(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID_V7.test(value)) return invalidQuery();
  return value.toLowerCase();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : value === undefined ? undefined : invalidQuery();
}

function normalizeQuery(input: unknown): NormalizedQuery {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalidQuery();
  const query = input as Record<string, unknown>;
  if (Object.keys(query).some((key) => !KEYS.has(key))) return invalidQuery();
  const domain = optionalString(query.domain);
  if (domain !== undefined && domain !== 'WALLET_CORE' && domain !== 'DEPOSIT' && domain !== 'PRICE_CONVERSION') {
    return invalidQuery();
  }
  const action = optionalString(query.action);
  if (action !== undefined && !ACTIONS.has(action)) return invalidQuery();
  const subjectType = optionalString(query.subjectType);
  const subjectId = optionalString(query.subjectId);
  if (
    (subjectType === undefined) !== (subjectId === undefined)
    || (subjectType !== undefined && !SUBJECT_TYPE.test(subjectType))
    || (subjectId !== undefined && (
      subjectId.length === 0
      || subjectId.length > 128
      || subjectId.trim() !== subjectId
      || subjectId.includes('\u0000')
    ))
  ) return invalidQuery();
  const from = optionalString(query.from);
  const to = optionalString(query.to);
  if (
    (from !== undefined && !isCanonicalAdminAuditTimestamp(from))
    || (to !== undefined && !isCanonicalAdminAuditTimestamp(to))
    || (from !== undefined && to !== undefined && from >= to)
  ) return invalidQuery();
  const cursor = optionalString(query.cursor);
  if (cursor !== undefined) decodeAdminAuditCursor(cursor);
  const limit = query.limit === undefined ? 50 : query.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
    return invalidQuery();
  }
  return {
    ...(domain === undefined ? {} : { domain }),
    ...(action === undefined ? {} : { action }),
    ...(query.actorId === undefined ? {} : { actorId: normalizeUuid(query.actorId) }),
    ...(query.runId === undefined ? {} : { runId: normalizeUuid(query.runId) }),
    ...(subjectType === undefined ? {} : { subjectType, subjectId }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(cursor === undefined ? {} : { cursor }),
    limit: limit as number,
  };
}

function state(value: unknown, nullable: true, domain?: string, subject?: string, unavailableTarget?: boolean): State | null;
function state(value: unknown, nullable: false, domain?: string, subject?: string): Readonly<Record<string, Scalar>>;
function state(value: unknown, nullable: boolean, domain?: string, subject?: string, unavailableTarget = false): State | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('ADMIN_AUDIT_HISTORY_ROW_INVALID');
  }
  const copy: Record<string, AdminAuditJson> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'config' && nullable && domain && subject) {
      try { copy[key] = unavailableTarget && entry === null ? null : validateAdminAuditConfiguration(entry, domain, subject); }
      catch { throw new Error('ADMIN_AUDIT_HISTORY_ROW_INVALID'); }
    } else {
      if (entry !== null && !['string', 'number', 'boolean'].includes(typeof entry)) throw new Error('ADMIN_AUDIT_HISTORY_ROW_INVALID');
      copy[key] = entry as Scalar;
    }
  }
  return Object.freeze(copy);
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('ADMIN_AUDIT_HISTORY_ROW_INVALID');
  return value;
}

function actor(row: HistoryRow): AdminAuditActor {
  if (
    row.actor_kind === 'ADMIN'
    && row.run_id === null
    && [row.actor_id, row.session_id, row.request_id, row.ip_address, row.device_id]
      .every((value) => typeof value === 'string')
  ) {
    return Object.freeze({
      kind: 'ADMIN',
      actorId: row.actor_id as string,
      sessionId: row.session_id as string,
      requestId: row.request_id as string,
      ipAddress: row.ip_address as string,
      deviceId: row.device_id as string,
    });
  }
  if (
    row.actor_kind === 'SYSTEM'
    && typeof row.run_id === 'string'
    && [row.actor_id, row.session_id, row.request_id, row.ip_address, row.device_id]
      .every((value) => value === null)
  ) return Object.freeze({ kind: 'SYSTEM', runId: row.run_id });
  throw new Error('ADMIN_AUDIT_HISTORY_ROW_INVALID');
}

function item(row: HistoryRow): AdminAuditHistoryItem {
  const id = requiredString(row.id);
  const domain = row.domain;
  const createdAt = requiredString(row.created_at);
  if (
    !UUID_V7.test(id)
    || (domain !== 'WALLET_CORE' && domain !== 'DEPOSIT' && domain !== 'PRICE_CONVERSION')
    || !isCanonicalAdminAuditTimestamp(createdAt)
  ) throw new Error('ADMIN_AUDIT_HISTORY_ROW_INVALID');
  return Object.freeze({
    id: id.toLowerCase(),
    eventKey: requiredString(row.event_key),
    domain,
    action: requiredString(row.action),
    actor: actor(row),
    subject: Object.freeze({
      type: requiredString(row.subject_type),
      id: requiredString(row.subject_id),
    }),
    reason: requiredString(row.reason),
    before: state(row.before_json, true, domain, String(row.subject_type), hasUnavailablePricingTarget(domain,row.action,row.before_json,row.after_json,row.metadata_json)),
    after: state(row.after_json, true, domain, String(row.subject_type), hasUnavailablePricingTarget(domain,row.action,row.before_json,row.after_json,row.metadata_json)),
    metadata: state(row.metadata_json, false),
    createdAt,
  });
}

const SELECT_COLUMNS = [
  'id, event_key, domain, action, actor_kind, actor_id, session_id, request_id,',
  'run_id, host(ip_address) AS ip_address, device_id, subject_type, subject_id, reason,',
  'before_json, after_json, metadata_json,',
  "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at",
].join('\n');

@Injectable()
export class AdminAuditHistoryRepository {
  constructor(private readonly database: AdminAuditDatabase) {}

  async history(input: AdminAuditHistoryQuery): Promise<AdminAuditHistoryPage> {
    const query = normalizeQuery(input);
    const predicates: string[] = ['TRUE'];
    const values: unknown[] = [];
    const equal = (column: string, value: unknown, cast = ''): void => {
      if (value === undefined) return;
      values.push(value);
      predicates.push(column + ' = $' + values.length + cast);
    };
    equal('domain', query.domain);
    equal('action', query.action);
    equal('actor_id', query.actorId, '::uuid');
    equal('run_id', query.runId, '::uuid');
    equal('subject_type', query.subjectType);
    equal('subject_id', query.subjectId);
    if (query.from !== undefined) {
      values.push(query.from);
      predicates.push('created_at >= $' + values.length + '::timestamptz');
    }
    if (query.to !== undefined) {
      values.push(query.to);
      predicates.push('created_at < $' + values.length + '::timestamptz');
    }
    if (query.cursor !== undefined) {
      const [createdAt, id] = decodeAdminAuditCursor(query.cursor);
      values.push(createdAt, id);
      predicates.push(
        '(created_at, id) < ($' + (values.length - 1)
        + '::timestamptz, $' + values.length + '::uuid)',
      );
    }
    values.push(query.limit + 1);
    const sql = [
      'WITH candidates AS MATERIALIZED (',
      'SELECT id, created_at, COALESCE(payload_bytes,',
      'COALESCE(octet_length(before_json::text), 0) + COALESCE(octet_length(after_json::text), 0)',
      '+ octet_length(metadata_json::text)) AS bytes',
      'FROM admin.admin_audit_events',
      'WHERE ' + predicates.join('\nAND '),
      'ORDER BY created_at DESC, id DESC',
      'LIMIT $' + values.length,
      '), ranked AS MATERIALIZED (',
      'SELECT id, row_number() OVER (ORDER BY created_at DESC, id DESC) AS position,',
      'sum(bytes) OVER (ORDER BY created_at DESC, id DESC ROWS UNBOUNDED PRECEDING) AS running_bytes',
      'FROM candidates',
      '), selected AS MATERIALIZED (',
      'SELECT id FROM ranked WHERE position < $' + values.length,
      'AND (position = 1 OR running_bytes <= 33554432)',
      ')',
      'SELECT ' + SELECT_COLUMNS + ',',
      '(SELECT count(*) FROM candidates) > (SELECT count(*) FROM selected) AS page_has_more',
      'FROM admin.admin_audit_events WHERE id IN (SELECT id FROM selected)',
      'ORDER BY created_at DESC, id DESC',
    ].join('\n');
    const { rows } = await this.database.query<HistoryRow>(sql, values);
    const hasMore = rows[0]?.page_has_more === true;
    const items = rows.map(item);
    const last = items.at(-1);
    return Object.freeze({
      items: Object.freeze(items),
      nextCursor: hasMore && last
        ? encodeAdminAuditCursor(last.createdAt, last.id)
        : null,
    });
  }
}
