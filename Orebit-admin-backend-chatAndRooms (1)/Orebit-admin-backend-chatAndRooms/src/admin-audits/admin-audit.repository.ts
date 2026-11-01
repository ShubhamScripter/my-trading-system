import { Injectable } from '@nestjs/common';

import type {
  buildDepositAdminAuditEvent,
  buildWalletCoreAdminAuditEvent,
} from './admin-audit.payloads.js';
import type {
  AdminAuditAppendResult,
  AdminAuditTransaction,
  AdminAuditJson,
} from './admin-audit.types.js';
import { uuidv7 } from '../utils/public.utils.js';

type PreparedAdminAuditEvent =
  | ReturnType<typeof buildWalletCoreAdminAuditEvent>
  | ReturnType<typeof buildDepositAdminAuditEvent>;

const APPEND_SQL = `SELECT audit_event_id AS id, replayed
FROM admin.append_admin_audit_event_v1(
  $1::uuid, $2, $3, $4, $5, $6::uuid, $7::uuid, $8::uuid,
  $9::uuid, $10::inet, $11, $12, $13, $14,
  $15::jsonb, $16::jsonb, $17::jsonb
)`;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const json = (
  value: Readonly<Record<string, AdminAuditJson>> | null,
): string | null => value === null ? null : JSON.stringify(value);

@Injectable()
export class AdminAuditRepository {
  async appendPreparedWithTransaction(
    tx: AdminAuditTransaction,
    event: PreparedAdminAuditEvent,
  ): Promise<AdminAuditAppendResult> {
    const admin = event.actor.kind === 'ADMIN' ? event.actor : null;
    const system = event.actor.kind === 'SYSTEM' ? event.actor : null;
    const { rows } = await tx.query<{ id: unknown; replayed: unknown }>(APPEND_SQL, [
      uuidv7(),
      event.eventKey,
      event.domain,
      event.action,
      event.actor.kind,
      admin?.actorId ?? null,
      admin?.sessionId ?? null,
      admin?.requestId ?? null,
      system?.runId ?? null,
      admin?.ipAddress ?? null,
      admin?.deviceId ?? null,
      event.subject.type,
      event.subject.id,
      event.reason,
      json(event.before),
      json(event.after),
      JSON.stringify(event.metadata),
    ]);
    const row = rows[0];
    if (
      rows.length !== 1
      || typeof row?.id !== 'string'
      || !UUID_V7.test(row.id)
      || typeof row.replayed !== 'boolean'
    ) throw new Error('ADMIN_AUDIT_APPEND_RESULT_INVALID');
    return { id: row.id.toLowerCase(), replayed: row.replayed };
  }
}
