# Global Admin Audit Design

Status: approved and independently reviewed for Wallet Core and Native Deposit.

## Canonical public names

- Owning module: `admin-backend/src/admin-audits`
- Sole table: `admin.admin_audit_events`
- Sole migration: `admin-backend/src/admin-audits/migrations/202609030001_global_admin_audit_events/migration.sql`
- Cross-repository SQL API: `admin.append_admin_audit_event_v1(...)`
- Database roles: `orebit_admin_audit_owner`, `orebit_admin_audit_writer`, `orebit_admin_audit_reader`
- TypeScript writer: `AdminAuditPort.appendWithTransaction(...)`
- TypeScript inputs: `WalletCoreAdminAuditInput`, `DepositAdminAuditInput`
- TypeScript builders: `buildWalletCoreAdminAuditEvent`, `buildDepositAdminAuditEvent`
- TypeScript history: `AdminAuditHistoryQuery`, `AdminAuditHistoryPage`
- Admin writer composition: `AdminAuditWriterModule`
- Admin history composition: `AdminAuditHistoryModule`
- User-side shared client: `WalletCoreAdminAuditClient.appendWithTransaction(...)`
- Deployment membership file: `admin-backend/src/admin-audits/production-role-memberships.sql`

No other repository creates, mirrors, migrates, or directly writes this table.

## Purpose and scope

The module records immutable administrative facts for Wallet Core and Native Deposit. It owns one replay-safe append contract and one cursor-paginated SUPER_ADMIN history read.

The audit stream is evidence, not authorization. Wallet Core and Deposit enforce their own SUPER_ADMIN/module permission and 2FA elevation rules before calling it. This phase does not add general RBAC, a role hierarchy, permission storage, page-visit logging, exports, retention jobs, the deceptive log-deletion trap, or migration of Price Conversion's existing audit rows.

The module remains unmounted. It does not edit `src/app.module.ts`, `src/openapi.ts`, `db/schema.prisma`, `db/migrate.ts`, Wallet Core, Deposit, Ledger, or Price Conversion. No commit or other git mutation is part of this work.

## Ownership and call paths

```text
admin-backend Wallet/Deposit transaction
  -> imports AdminAuditWriterModule only
  -> AdminAuditPort.appendWithTransaction(tx, raw closed domain input)
  -> port internally selects the typed domain/action builder
  -> SELECT * FROM admin.append_admin_audit_event_v1(...)

orebit-backend Wallet/Deposit worker transaction
  -> SELECT * FROM admin.append_admin_audit_event_v1(...)
     (no import from admin-backend and no table DML privilege)

SUPER_ADMIN history request
  -> AdminAuditHistoryService.history(query)
  -> SELECT explicit columns FROM admin.admin_audit_events
```

Every writer calls the SQL function inside its already-open feature transaction. The function does not begin, commit, or roll back. A feature mutation and its audit fact therefore commit or roll back together.

## One-table storage contract

`admin.admin_audit_events` contains:

| Column | Contract |
| --- | --- |
| `id UUID` | Caller-generated UUIDv7 primary key; the function rejects other UUID versions. |
| `event_key VARCHAR(200)` | Unique stable business-command key, never time-derived. |
| `event_hash CHAR(64)` | Database-computed SHA-256 over semantic fields only. |
| `domain VARCHAR(32)` | `WALLET_CORE` or `DEPOSIT`. |
| `action VARCHAR(96)` | Uppercase dotted action from the allowlist below. |
| `actor_kind VARCHAR(16)` | `ADMIN` or `SYSTEM`. |
| `actor_id UUID` | Required only for ADMIN. |
| `run_id UUID` | Required only for SYSTEM and names the durable cron/bulk run. |
| `session_id`, `request_id`, `ip_address`, `device_id` | Required for ADMIN, null for SYSTEM, retained from the first successful insert. |
| `subject_type VARCHAR(64)`, `subject_id VARCHAR(128)` | Action-specific subject identity. |
| `reason VARCHAR(500)` | Trimmed, nonblank semantic reason. |
| `before_json`, `after_json` | Action-specific safe state objects or null. |
| `metadata_json` | Action-specific safe provenance object. |
| `created_at TIMESTAMPTZ` | Database time, never accepted from a caller. |

Each JSON object is at most 65,536 UTF-8 bytes and contains only action-approved top-level scalar values; arrays and nested objects are rejected. TypeScript measures the raw JSONB-text-equivalent serialization before trimming or UUID normalization, then repeats the check on the normalized copy; SQL measures the JSONB value it receives before normalization. U+0000 is rejected by the builder because PostgreSQL JSONB cannot represent it. The migration installs row and statement triggers that reject UPDATE, DELETE, and TRUNCATE with SQLSTATE `55000`. Direct table DML is unavailable to writer roles.

## Semantic replay identity

The database function normalizes text and computes the hash over this exact JSONB object:

```sql
jsonb_build_object(
  'domain', p_domain,
  'action', p_action,
  'actorKind', p_actor_kind,
  'actorId', p_actor_id,
  'runId', p_run_id,
  'subjectType', p_subject_type,
  'subjectId', btrim(p_subject_id),
  'reason', btrim(p_reason),
  'before', p_before_json,
  'after', p_after_json,
  'metadata', COALESCE(p_metadata_json, '{}'::jsonb)
)
```

`id`, `event_key`, `session_id`, `request_id`, `ip_address`, `device_id`, and `created_at` are excluded. A retry from a new request, session, IP, or device therefore replays if its business meaning is unchanged. The row keeps the first successful transport context and is never updated.

The function first assigns `v_event_key := btrim(p_event_key)`, validates its 1..200-character bound, and uses only `v_event_key` for INSERT conflict targeting and replay SELECT. Event-key case is preserved. Equal stored/computed hashes return the original id and `replayed = true`. A different semantic hash raises `ADMIN_AUDIT_EVENT_KEY_CONFLICT` with SQLSTATE `23505`.

## Domain/action payload contracts

There is no generic audit JSON API and no incomplete denylist. Both TypeScript builders and the SQL function reject every unknown action, subject type, key, non-scalar value, and incorrectly typed value. `before`, `after`, and `metadata` are flat objects whose values are string, boolean, non-negative safe integer, or null as specified below.

| Domain/action | Subject | Allowed `before` / `after` keys | Required metadata; optional keys end in `?` |
| --- | --- | --- | --- |
| `WALLET_CORE` `SETTINGS.SAVED`, `SETTINGS.PUSHED`, `SETTINGS.SCHEDULED`, `SETTINGS.SCHEDULE_APPLIED`, `SETTINGS.SCHEDULE_REJECTED` | `SETTINGS_REVISION` | `revision`, `status`, `effectiveAt` | `configurationRevision`; `changelogId?`, `safeErrorCode?` |
| `WALLET_CORE` `LOGO.UPLOADED` | `LOGO_ASSET` | before: `stored`; after: `stored`, `mediaType`, `width`, `height`, `bytes` | `sourceFormat` |
| `WALLET_CORE` `ADMIN_TIMEZONE.UPDATED` | `ADMIN` | `timezone` | `configurationRevision` |
| `WALLET_CORE` `CHAIN.CREATED`, `CHAIN.UPDATED`, `CHAIN.IMPORTED` | `CHAIN` | `name`, `shortName`, `blockchainReference`, `availableFor`, `logoObjectKey` | `configurationRevision`; `importCatalogueRevision?` |
| `WALLET_CORE` `CURRENCY.CREATED`, `CURRENCY.UPDATED`, `CURRENCY.IMPORTED` | `CURRENCY` | `symbol`, `name`, `kind`, `pricingStatus`, `desiredState`, `logoObjectKey` | `configurationRevision`; `providerReferenceCount?`, `chainBindingCount?`, `importCatalogueRevision?` |
| `WALLET_CORE` `CATALOGUE.REFRESHED` | `PROVIDER_CATALOGUE` | `revision`, `itemCount` | `configurationRevision`, `source` |
| `WALLET_CORE` `PROVIDER_MAINTENANCE.PINNED`, `PROVIDER_MAINTENANCE.UNPINNED` | `CHAIN` or `CURRENCY_CHAIN` | `maintenancePinned`, `effectiveState` | `configurationRevision` |
| `WALLET_CORE` `CHAIN.STATUS_CHANGED` | `CHAIN` | `desiredState`, `effectiveState`, `maintenancePinned` | `configurationRevision`; `scheduledChangeId?` |
| `WALLET_CORE` `CURRENCY.STATUS_CHANGED` | `CURRENCY` or `CURRENCY_CHAIN` | `desiredState`, `effectiveState`, `showBalance` | `configurationRevision`; `scheduledChangeId?` |
| `WALLET_CORE` `PROVIDER_MAINTENANCE.ENTERED`, `PROVIDER_MAINTENANCE.RECOVERED` | `CHAIN`, `CURRENCY`, or `CURRENCY_CHAIN` | `effectiveState`, `failureStreak`, `maintenancePinned` | `configurationRevision`, `providerReference` |
| `WALLET_CORE` `PRICE_MAINTENANCE.ENTERED`, `PRICE_MAINTENANCE.RECOVERED` | `CHAIN` or `CURRENCY` | `effectiveState`, `failureStreak`, `maintenancePinned` | `configurationRevision`, `providerReference` |
| `WALLET_CORE` `RECONCILIATION.COMPLETED` | `RECONCILIATION_RUN` | `status`, `partial` | `currencyCount`, `warningCount` |
| `WALLET_CORE` `RECONCILIATION.WARNING_RAISED`, `RECONCILIATION.WARNING_CLEARED` | `CURRENCY` | `active`, `partial`, `shortfallPercent` (null only when the same state has `partial: true`) | `reconciliationRunId` |
| `WALLET_CORE` `DELISTING.FORFEITURE_POSTED` | `LEDGER_JOURNAL` | `balance` | `currencyId`, `ownerType`, `ownerId`, `amount` |
| `DEPOSIT` `SETTINGS.SAVED`, `SETTINGS.PUSHED`, `SETTINGS.SCHEDULED`, `SETTINGS.SCHEDULE_APPLIED`, `SETTINGS.SCHEDULE_REJECTED` | `SETTINGS_REVISION` | `revision`, `status`, `effectiveAt` | `configurationRevision`; `changelogId?`, `safeErrorCode?` |
| `DEPOSIT` `DEPOSIT.RELEASED`, `DEPOSIT.REJECTED`, `DEPOSIT.CANCELLED`, `DEPOSIT.MAINTENANCE_CANCELLED` | `DEPOSIT` | `status`, `bucket`, `visible` | `currencyId`, `grossAmount`; `feeAmount?`, `ledgerJournalId?`, `priceResolutionId?`, `priceSnapshotId?`, `priceBasis?` |
| `DEPOSIT` `DEPOSIT.REVERIFICATION_HELD` | `DEPOSIT` | `status`, `bucket`, `visible` | `currencyId`, `grossAmount`, `ledgerJournalId`, `blockerId` |
| `DEPOSIT` `DEPOSIT.CLAWBACK_TO_ZERO_POSTED`, `DEPOSIT.CLAWBACK_NEGATIVE_POSTED` | `DEPOSIT` | `status`, `bucket`, `visible` | `currencyId`, `ledgerJournalId`, `clawbackAmount`; `shortfallAmount?` |
| `DEPOSIT` `DEPOSIT.ACCOUNTING_REVERSAL_POSTED` | `DEPOSIT` | `status`, `bucket`, `visible` | `currencyId`, `originalJournalId`, `reversalJournalId` |
| `DEPOSIT` `DEPOSIT.STATUS_CHANGED` | `DEPOSIT` | `status`, `bucket`, `visible` | `currencyId`; `ledgerJournalId?` |
| `DEPOSIT` `BLOCKER.WAIVED` | `DEPOSIT_BLOCKER` | `status` | `depositId`, `blockerKind` |
| `DEPOSIT` `QUARANTINE.RETRIED`, `QUARANTINE.ASSIGNED`, `QUARANTINE.CREDIT_REQUESTED`, `QUARANTINE.RETAINED` | `QUARANTINE` | `status`, `assignedUserId` | `currencyId`, `grossAmount`; `depositId?`, `ledgerJournalId?`, `priceResolutionId?`, `priceSnapshotId?`, `priceBasis?` |
| `DEPOSIT` `KILL_SWITCH.ACTIVATED`, `KILL_SWITCH.CLEARED` | `FEATURE_STATE` | `killed` | `configurationRevision` |
| `DEPOSIT` `BULK_JOB.CREATED`, `BULK_JOB.STARTED`, `BULK_JOB.PAUSED`, `BULK_JOB.RESUMED`, `BULK_JOB.COMPLETED`, `BULK_JOB.COMPLETED_WITH_FAILURES`, `BULK_JOB.FAILED` | `BULK_JOB` | `status` | `actionKind`, `totalItems`, `attemptedCount`, `succeededCount`, `failedCount`; `batchNumber?`, `safeErrorCode?` |
| `DEPOSIT` `BULK_JOB.ITEM_SUCCEEDED`, `BULK_JOB.ITEM_FAILED` | `BULK_JOB_ITEM` | `status` | `bulkJobId`, `depositId`, `attempt`; `ledgerJournalId?`, `safeErrorCode?` |

Settings revisions use an action-specific lifecycle contract in both domains. `SETTINGS.SAVED`
is exactly `null -> DRAFT`; `SETTINGS.PUSHED` is `DRAFT -> LIVE`; `SETTINGS.SCHEDULED` is
`DRAFT -> SCHEDULED`; `SETTINGS.SCHEDULE_APPLIED` is `SCHEDULED -> LIVE`; and
`SETTINGS.SCHEDULE_REJECTED` is `SCHEDULED -> REJECTED`. The TypeScript action union, detached
runtime descriptor, and SQL contract all enforce the same transitions; recognizing `REJECTED`
as a settings scalar never permits it for another settings action.

The closed matrix contains exactly 25 Wallet Core domain/actions and 30 Deposit domain/actions. The five shared settings action strings remain distinct pairs because domain is part of semantic identity.

Runtime value rules are also closed:

- every `*Id` except `changelogId` and `scheduledChangeId` is a UUID; those two optional ids are UUIDs when present;
- `revision`, `configurationRevision`, `importCatalogueRevision`, `failureStreak`, `providerReferenceCount`, `chainBindingCount`, `itemCount`, `currencyCount`, `warningCount`, `batchNumber`, `totalItems`, `attemptedCount`, `succeededCount`, `failedCount`, and `attempt` are non-negative safe integers;
- `amount`, `balance`, `grossAmount`, `feeAmount`, `clawbackAmount`, `shortfallAmount`, and non-null `shortfallPercent` values are unsigned decimal strings with at most 18 fractional places;
- Wallet states are `ON`, `OFF`, `MAINTAIN`, or `UPCOMING`; `maintenancePinned`, `showBalance`, `active`, `partial`, and `visible` are booleans;
- settings `status` scalars are `DRAFT`, `SCHEDULED`, `LIVE`, `ARCHIVED`, or `REJECTED`, subject to the exact action transition matrix above; Deposit `status` is `PENDING`, `HELD`, `SUCCESS`, `FAILED`, `REJECTED`, `CANCELLED`, `QUARANTINED`, or `RETRY_PENDING`;
- blocker `status` is `PENDING`, `RESOLVED`, or `WAIVED`; quarantine `status` is `OPEN`, `RETRY_PENDING`, `ASSIGNED`, `RETAINED`, or `SETTLED`; bulk-job `status` is `PENDING`, `RUNNING`, `PAUSED`, `COMPLETED`, `COMPLETED_WITH_FAILURES`, or `FAILED`; bulk-item `status` is `PENDING`, `RUNNING`, `SUCCEEDED`, or `FAILED`;
- `ownerType` is `USER` or `MERCHANT`; Deposit bucket is `AVAILABLE`, `HOLD`, `OREBIT_TREASURY`, or `OREBIT_COLLECTION`; price basis is `WEBHOOK_TIME` or `ADMIN_CREDIT_TIME`;
- currency `kind` is `CRYPTO` or `FIAT`; `pricingStatus` is `ACTIVE` or `DISABLED`; `availableFor` is `USER`, `MERCHANT`, or `BOTH`; reconciliation `status` is `SUCCESS`, `PARTIAL`, or `FAILED`;
- bulk `actionKind` is `RELEASE`, `REJECT`, `MAINTENANCE_RELEASE`, `MAINTENANCE_CANCEL`, `REVERIFICATION_HOLD`, `CLAWBACK_TO_ZERO`, `CLAWBACK_NEGATIVE`, `WAIT_FOR_SETTLEMENT`, or `SCHEDULED_STATE_TRANSITION`;
- `effectiveAt` is null or a canonical UTC timestamp; `assignedUserId` is null or a UUID;
- `LOGO.UPLOADED` is ADMIN-only with fixed reason `wallet-logo-upload`; its ASCII-trimmed subject id is an exact lowercase 64-hex `.webp` opaque object key, before is exactly `{stored:false}`, after is exactly `{stored:true,mediaType:'image/webp',width,height,bytes}`, width and height are equal positive safe integers at most 500, bytes is 1..1,048,576, and `sourceFormat` is `PNG`, `JPEG`, `WEBP`, or `AVIF`;
- logo audit payloads contain no raw image, digest, filesystem path, or URL; the caller derives its stable event key from the object key and the canonical writer retains the existing replay and first-transport behavior;
- reconciliation warning `shortfallPercent` may be null only in `before` or `after` state for `RECONCILIATION.WARNING_RAISED`/`WARNING_CLEARED` when that same object has `partial: true`; a decimal string remains valid for either partial value, including stake-total mismatch warnings;
- when `priceBasis` is present, `priceResolutionId` and `priceSnapshotId` are both required; neither price id may appear without `priceBasis`;
- `providerReference` and `blockerKind` are nonblank strings of at most 160 and 64 characters respectively;
- names, symbols, blockchain references, logo object keys, timezones, catalogue source, and safe error codes are bounded nonblank strings using their consumer database limits; `source` is `BLOCKCHAIN`, and `safeErrorCode` is at most 64 characters;
- `SETTINGS_REVISION` subject ids are unsigned integer strings; `PROVIDER_CATALOGUE` uses subject id `BLOCKCHAIN`; `LOGO_ASSET` uses the exact opaque key described above; `CURRENCY` and `CURRENCY_CHAIN` accept lowercase-normalized RFC UUIDs, with the former identifying a whole coin and the latter its binding; all other UUID-backed subjects require UUIDv7 and every subject id is 1..128 characters after trimming;
- `CURRENCY_CHAIN` is allowed only for `CURRENCY.STATUS_CHANGED` and provider-maintenance pin/unpin/enter/recover; currency create/update/import, price maintenance, reconciliation, and every Deposit action remain closed to it; provider pin/unpin reject whole `CURRENCY` subjects.
- a required metadata key cannot be null; optional keys are omitted rather than populated with undefined.

Adding an action or payload key requires changing the TypeScript discriminated union and the single machine-readable runtime contract consumed by the SQL append function; parity tests compare the expanded SQL contract with the detached TypeScript descriptor.

Actor selection is also closed:

- ADMIN only: Wallet `SETTINGS.SAVED/PUSHED/SCHEDULED`, `LOGO.UPLOADED`, `ADMIN_TIMEZONE.UPDATED`, `CATALOGUE.REFRESHED`, CHAIN/CURRENCY `CREATED/UPDATED/IMPORTED`, provider-maintenance `PINNED/UNPINNED`; Deposit `SETTINGS.SAVED/PUSHED/SCHEDULED`, `BLOCKER.WAIVED`, `KILL_SWITCH.ACTIVATED/CLEARED`, and `BULK_JOB.CREATED/RESUMED`.
- SYSTEM/runId only: both domains' `SETTINGS.SCHEDULE_APPLIED/SCHEDULE_REJECTED`; Wallet provider/price maintenance enter/recover, reconciliation actions, and forfeiture; Deposit `BULK_JOB.STARTED/PAUSED/COMPLETED/COMPLETED_WITH_FAILURES/FAILED` and both bulk-item actions.
- ADMIN or SYSTEM/runId: Wallet CHAIN/CURRENCY `STATUS_CHANGED`; Deposit release/reject/cancel/maintenance-cancel, reverification, clawbacks, accounting reversal, status change, and quarantine actions.

The builders and the SQL runtime-contract lookup reject an actor kind outside the selected action's set. Actor, session, request, and run identities accept RFC UUID versions 1 through 8 and the builders normalize them to lowercase; this does not weaken the UUIDv7 event-id or designated subject-id rules. A SYSTEM actor always carries its durable run id; an ADMIN actor always carries first-request transport context.

## Transaction-usable SQL API

The sole cross-repository write contract is:

```sql
admin.append_admin_audit_event_v1(
  p_id UUID,
  p_event_key TEXT,
  p_domain TEXT,
  p_action TEXT,
  p_actor_kind TEXT,
  p_actor_id UUID,
  p_session_id UUID,
  p_request_id UUID,
  p_run_id UUID,
  p_ip_address INET,
  p_device_id TEXT,
  p_subject_type TEXT,
  p_subject_id TEXT,
  p_reason TEXT,
  p_before_json JSONB,
  p_after_json JSONB,
  p_metadata_json JSONB
) RETURNS TABLE (audit_event_id UUID, replayed BOOLEAN)
```

It is `SECURITY DEFINER`, owned by `orebit_admin_audit_owner`, and has fixed `search_path = pg_catalog, admin`. SHA-256 uses the existing pgcrypto dependency through the schema-qualified `public.digest`. PUBLIC execution is revoked.

The function validates UUIDv7 id, lengths, actor shape, the complete domain/action/subject matrix, flat scalar payloads, required/allowed keys, value types, and JSON byte limits before hashing or inserting. It never accepts SQL text, a table name, a precomputed hash, or a caller timestamp.

An `orebit-backend` worker calls this function with bound parameters through its own `pg` transaction. It neither imports admin TypeScript nor receives INSERT/SELECT/UPDATE/DELETE/TRUNCATE on the table.

## Canonical TypeScript API

```ts
export type AdminAuditActor =
  | {
      readonly kind: 'ADMIN';
      readonly actorId: string;
      readonly sessionId: string;
      readonly requestId: string;
      readonly ipAddress: string;
      readonly deviceId: string;
    }
  | { readonly kind: 'SYSTEM'; readonly runId: string };

interface AdminAuditFamilyInput {
  readonly eventKey: string;
  readonly actor: AdminAuditActor;
  readonly subject: { readonly type: string; readonly id: string };
  readonly reason: string;
  readonly before: Readonly<Record<string, string | number | boolean | null>> | null;
  readonly after: Readonly<Record<string, string | number | boolean | null>> | null;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface AdminAuditTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
}

export type WalletCoreAdminAuditInput =
  | WalletCoreSettingsAuditInput
  | WalletCoreAdminTimezoneAuditInput
  | WalletCoreCatalogueAuditInput
  | WalletCoreChainAuditInput
  | WalletCoreCurrencyAuditInput
  | WalletCoreProviderMaintenanceAuditInput
  | WalletCoreReconciliationAuditInput
  | WalletCoreForfeitureAuditInput;

export type DepositAdminAuditInput =
  | DepositSettingsAuditInput
  | DepositDecisionAuditInput
  | DepositReverificationAuditInput
  | DepositClawbackAuditInput
  | DepositAccountingReversalAuditInput
  | DepositStatusAuditInput
  | DepositBlockerAuditInput
  | DepositQuarantineAuditInput
  | DepositKillSwitchAuditInput
  | DepositBulkJobAuditInput
  | DepositBulkItemAuditInput;

export declare function buildWalletCoreAdminAuditEvent(
  input: WalletCoreAdminAuditInput,
): PreparedAdminAuditEvent;
export declare function buildDepositAdminAuditEvent(
  input: DepositAdminAuditInput,
): PreparedAdminAuditEvent;

export interface AdminAuditPort {
  appendWithTransaction(
    tx: AdminAuditTransaction,
    input: WalletCoreAdminAuditInput | DepositAdminAuditInput,
  ): Promise<AdminAuditAppendResult>;
}
export interface AdminAuditAppendResult {
  readonly id: string;
  readonly replayed: boolean;
}
```

Each union member fixes `domain`, its exact action union, subject type, state type, and metadata type from the table above. `PreparedAdminAuditEvent` is branded and internal to the module; callers cannot hand the repository arbitrary JSON. `AdminAuditPort` selects the domain builder and invokes the SQL function. It performs no permission check.

Admin-backend Wallet Core and Deposit consume the TypeScript port. Cross-repository workers consume only the SQL function.

`AdminAuditWriterModule` provides `AdminAuditRepository`, `AdminAuditWriterService`, and the `ADMIN_AUDIT_PORT` alias and exports only `ADMIN_AUDIT_PORT`. It has no controller, history service/repository, or database pool, so importing it into Admin Wallet Core or Deposit cannot expose history or open another connection.

`AdminAuditHistoryModule` separately provides `AdminAuditDatabase`, `AdminAuditHistoryRepository`, `AdminAuditHistoryService`, `AdminAuditRoutes`, and `AdminAuditSuperAdminGuard`. It exports nothing and remains absent from the root module until separate mounting approval.

The sole orebit-side caller lives at `orebit-backend/src/wallet/core/admin-audit-sql.ts` and is shared by Wallet Core and Deposit:

```ts
export interface WalletCoreAdminAuditClient {
  appendWithTransaction(
    tx: AdminAuditSqlTransaction,
    input: WalletCoreAdminAuditInput | DepositAdminAuditInput,
  ): Promise<AdminAuditAppendResult>;
}
```

Deposit imports this client and its structural input/actor/result types from Wallet Core, not from admin-backend. The client accepts the same raw closed unions, selects the corresponding local safe builder, and calls the SQL function. A cross-repository parity test compares its action/key schema with the canonical migration; it does not own DDL.

## Least-privilege database roles

The sole migration creates or verifies three NOLOGIN group roles:

- `orebit_admin_audit_owner`: owns the table, append function, and immutability trigger function; it is never a runtime login.
- `orebit_admin_audit_writer`: receives schema USAGE and EXECUTE on `admin.append_admin_audit_event_v1`; it receives no table privilege.
- `orebit_admin_audit_reader`: receives schema USAGE and SELECT on `admin.admin_audit_events`; it receives no function execution or write privilege.

The migration applies this exact privilege shape after object creation:

```sql
REVOKE ALL ON admin.admin_audit_events FROM PUBLIC;
REVOKE ALL ON admin.admin_audit_events FROM orebit_admin_audit_writer;
REVOKE ALL ON admin.admin_audit_events FROM orebit_admin_audit_reader;
GRANT USAGE ON SCHEMA admin
  TO orebit_admin_audit_owner, orebit_admin_audit_writer, orebit_admin_audit_reader;
GRANT SELECT ON admin.admin_audit_events TO orebit_admin_audit_reader;
GRANT USAGE ON SCHEMA public TO orebit_admin_audit_owner;
GRANT EXECUTE ON FUNCTION public.digest(bytea, text) TO orebit_admin_audit_owner;

REVOKE ALL ON FUNCTION admin.append_admin_audit_event_v1(
  uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin.append_admin_audit_event_v1(
  uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb
) TO orebit_admin_audit_writer;
```

`production-role-memberships.sql` uses no variables or substitute names. It requires four pre-provisioned LOGIN/INHERIT runtime roles and applies this exact membership:

```sql
GRANT orebit_admin_audit_writer TO orebit_admin_runtime;
GRANT orebit_admin_audit_writer TO orebit_wallet_core_user_runtime;
GRANT orebit_admin_audit_writer TO orebit_deposit_user_runtime;
GRANT orebit_admin_audit_reader TO orebit_admin_audit_history_runtime;
REVOKE orebit_admin_audit_reader FROM orebit_admin_runtime;
REVOKE orebit_admin_audit_reader FROM orebit_wallet_core_user_runtime;
REVOKE orebit_admin_audit_reader FROM orebit_deposit_user_runtime;
REVOKE orebit_admin_audit_writer FROM orebit_admin_audit_history_runtime;
```

The file first aborts unless all four exact runtime roles exist with `rolcanlogin = true`, `rolinherit = true`, `rolsuper = false`, `rolcreatedb = false`, and `rolcreaterole = false`. It creates no login and contains no credential. `ADMIN_AUDIT_READER_DATABASE_URL` must authenticate as `orebit_admin_audit_history_runtime`; startup verifies reader membership/SELECT plus absence of table mutation and append-function execution. No runtime role gets schema CREATE. These database roles are infrastructure isolation, not product RBAC.

## History query and cursor

```ts
export interface AdminAuditHistoryQuery {
  readonly domain?: 'WALLET_CORE' | 'DEPOSIT';
  readonly action?: string;
  readonly actorId?: string;
  readonly runId?: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface AdminAuditHistoryPage {
  readonly items: readonly AdminAuditHistoryItem[];
  readonly nextCursor: string | null;
}
```

`limit` defaults to 50 and is bounded to 1..100. Subject type/id must appear together. `from` is inclusive, `to` exclusive, and `from < to`. Filters use fixed SQL fragments and bound values.

The canonical base64url cursor is JSON `[createdAtIso, id]`. Reads use `(created_at, id) < ($cursor_at, $cursor_id)`, `ORDER BY created_at DESC, id DESC`, and `limit + 1`. UUID is the deterministic tiebreaker when timestamps are equal. A cursor at a tied row neither repeats that row nor skips the remaining lower ids.

The sole HTTP surface is `GET /v1/admin/audits`. The existing global authentication guard plus a direct local `principal.role === 'SUPER_ADMIN'` guard protects it. There is no HTTP audit writer and no general RBAC implementation.

## Destructive-test safety contract

Tests use only the dedicated Docker service in `admin-backend/src/admin-audits/docker-compose.test.yml`: container `orebit-admin-audit-postgres-test`, cluster name `orebit_admin_audit_test`, database `orebit_admin_audit_test`, internal port 5432, and host binding `127.0.0.1:55434`. The compose file pins `postgres:17.6-alpine`; no existing/shared Postgres service is accepted.

The PostgreSQL suite may reset only when every check passes before destructive SQL:

1. `NODE_ENV === 'test'`.
2. `ADMIN_AUDIT_TEST_ALLOW_RESET === 'true'`.
3. `ADMIN_AUDIT_TEST_DATABASE_URL`, `DATABASE_URL`, and `DATABASE_DIRECT_URL` are all present and parseable; the test URL is PostgreSQL, has host `127.0.0.1`, port `55434`, schema `admin`, and decoded database `orebit_admin_audit_test`.
4. Neither runtime URL uses host `127.0.0.1`/`localhost`/`::1` with port `55434`, regardless of database or credentials, and the test host/port/database tuple differs from both; string inequality never counts as separation.
5. After connecting, `current_database()` is `orebit_admin_audit_test`, `current_setting('cluster_name')` is `orebit_admin_audit_test`, `inet_server_port()` is 5432, and `inet_server_addr()` is non-null. The observed server identity is recorded in test output.
6. Docker inspection reports the running container name `orebit-admin-audit-postgres-test` and published binding `127.0.0.1:55434`; otherwise provisioning stops before connecting.

The suite aborts before `DROP SCHEMA` if any check fails. Tests use disposable NOLOGIN roles and verify the owner/writer/reader privilege matrix with `SET ROLE`.

## Canonical migration order

Fresh and upgrade-path tests enforce this order across both repositories:

1. `202609030001_global_admin_audit_events`
   followed by `20260906000001_reconciliation_inactive_null` for inactive complete warning recovery.
2. Price Conversion migrations through `20260901000013_reference_mutation_guard`
3. Ledger through current endpoint `202609030001_treasury_exchange_pool`, followed by planned `202609030005_wallet_core_balances`
4. `20260903000000_wallet_core_expand`
5. `20260903000001_wallet_core_contract`
6. `202609030006_native_deposit`

This is the logical cross-schema order even though per-schema migration timestamps do not sort into that order. Admin audit is applied once by admin-backend and is never mirrored into orebit-backend. Wallet Core and Deposit tests may require it as a prerequisite but cannot create or copy it.

## Required verification

- ADMIN and SYSTEM/runId append success;
- rollback proves function participation in the caller transaction;
- same semantic input with changed request/session/IP/device replays and retains the first transport fields;
- same event key with changed actor, reason, subject, before/after, or metadata conflicts;
- two concurrent equal appends create one row and return one id;
- TypeScript-builder and SQL-allowlist parity for every domain/action;
- direct writer-role table DML and reader-role function execution fail;
- UPDATE, DELETE, and TRUNCATE fail even as owner;
- history filters ADMIN actor and SYSTEM run id;
- two rows with the same `created_at` paginate by id without duplication or omission;
- malformed and noncanonical cursors fail before SQL;
- only the one canonical migration owns the table/function/roles.

No root file is edited or module mounted, and no commit is created.
