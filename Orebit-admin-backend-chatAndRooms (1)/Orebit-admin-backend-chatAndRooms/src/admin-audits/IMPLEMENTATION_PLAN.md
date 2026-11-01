# Global Admin Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` task by task. Checkboxes are the execution record.

**Goal:** Build the sole append-only Admin audit store for Wallet Core and Native Deposit, usable atomically from both repositories without table DML or an admin-source import.

**Architecture:** One admin-owned migration creates `admin.admin_audit_events`, three database group roles, immutable triggers, and `admin.append_admin_audit_event_v1`. Admin consumers use strict action-specific TypeScript builders through `AdminAuditPort`; orebit workers call the same parameterized SQL function directly. A reader-only path provides SUPER_ADMIN keyset history.

**Tech Stack:** PostgreSQL with pgcrypto, TypeScript 5.7, Node.js 22 test runner with `tsx`, NestJS 11, `pg` 8, Zod 3.

**Spec:** `admin-backend/src/admin-audits/DESIGN.md`

## Global constraints

- Create or modify files only under `admin-backend/src/admin-audits`.
- The sole migration path is `migrations/202609030001_global_admin_audit_events/migration.sql`.
- Canonical migration order is Admin audit, Price Conversion, Ledger, Wallet Core, then Deposit.
- No other migration, schema mirror, consumer-local table, or direct table writer is permitted.
- Do not edit or mount through `src/app.module.ts`, `src/openapi.ts`, `db/schema.prisma`, `db/migrate.ts`, Wallet Core, Deposit, Ledger, or Price Conversion.
- Do not implement product RBAC. Consumer authorization and 2FA stay in the consumers.
- Writer roles execute the SQL function only; reader roles select the table only.
- The semantic hash excludes request/session/IP/device while the first successful transport evidence remains stored.
- Payloads use the exact per-domain/action schemas from the spec; no arbitrary JSON input or generic secret denylist.
- Do not stage, commit, push, checkout, merge, reset, or clean. Every task ends with a no-commit checkpoint.

## Canonical migration order

1. `202609030001_global_admin_audit_events`
   followed by `20260906000001_reconciliation_inactive_null` for inactive complete warning recovery.
2. Price Conversion through `20260901000013_reference_mutation_guard`
3. Ledger through current endpoint `202609030001_treasury_exchange_pool`, followed by planned `202609030005_wallet_core_balances`
4. `20260903000000_wallet_core_expand`
5. `20260903000001_wallet_core_contract`
6. `202609030006_native_deposit`

This is the logical cross-schema order even though per-schema timestamps differ. Admin-backend applies Admin audit once; orebit-backend contains no mirror.

## File map

| File | Responsibility |
| --- | --- |
| `migrations/202609030001_global_admin_audit_events/migration.sql` | Sole table, role, privilege, immutable-trigger, action validation, semantic hash, and append-function authority. |
| `admin-audit.types.ts` | Canonical actors, per-family inputs, port/result, row, and history types. |
| `admin-audit.payloads.ts` | Wallet/Deposit action builders and runtime allowlist/value validation. |
| `admin-audit.cursor.ts` | Strict canonical `(createdAt,id)` cursor. |
| `production-role-memberships.sql` | Exact writer memberships for `orebit_admin_runtime`, `orebit_wallet_core_user_runtime`, and `orebit_deposit_user_runtime`, plus reader-only history membership. |
| `docker-compose.test.yml` | Dedicated `postgres:17.6-alpine` cluster `orebit-admin-audit-postgres-test` on `127.0.0.1:55434`. |
| `provision-test-database.mjs` | Docker identity inspection plus URL/server reset guard. |
| `admin-audit.database.ts` | Dedicated `ADMIN_AUDIT_READER_DATABASE_URL` pool scoped to `schema=admin` and verified reader-only privileges. |
| `admin-audit.repository.ts` | SQL-function writer only; no database dependency. |
| `admin-audit.history-repository.ts` | Parameterized reader-only history queries. |
| `admin-audit.writer.service.ts` | Raw domain input to safe builder to SQL-function writer. |
| `admin-audit.history.service.ts` | Thin history facade. |
| `admin-audit.dto.ts` | Strict history query DTO. |
| `admin-audit.routes.ts` | GET-only SUPER_ADMIN history route. |
| `admin-audit.writer.module.ts` | Controller-free/pool-free writer module exporting only `ADMIN_AUDIT_PORT`. |
| `admin-audit.history.module.ts` | Separate unmounted history controller/read-pool module. |
| `index.ts` | Canonical consumer exports only. |
| `admin-audit.contracts.spec.ts` | Actor, builder, action parity, and public-interface tests. |
| `admin-audit.validation-parity.spec.ts` | TypeScript text/null/size/scalar boundary and PostgreSQL-parity tests. |
| `admin-audit.sql-contract.spec.ts` | Exact runtime SQL/TypeScript action and scalar descriptor parity, canonical migration order, and cross-repository sole-ownership tests. |
| `admin-audit.postgres.spec.ts` | Dedicated-cluster safety, migration, roles/memberships, function, replay, transaction, and immutability tests. |
| `admin-audit.history.spec.ts` | Filter and exact tie/cursor tests. |
| `admin-audit.http.spec.ts` | DTO, guard, route, and unmounted-module tests. |

## External consumer contract (read-only prerequisite here)

The Wallet Core workstream owns the sole orebit-side `orebit-backend/src/wallet/core/admin-audit-sql.ts`. Deposit imports it rather than creating another caller. Its frozen contract is:

```ts
export interface WalletCoreAdminAuditClient {
  appendWithTransaction(
    tx: AdminAuditSqlTransaction,
    input: WalletCoreAdminAuditInput | DepositAdminAuditInput,
  ): Promise<AdminAuditAppendResult>;
}
```

It accepts raw closed domain input, internally selects the corresponding safe builder, and invokes `admin.append_admin_audit_event_v1` with 17 bound arguments. It does not import admin-backend source, own a migration, or access the table. This plan verifies its action/key parity in the final cross-repository scan but does not edit it.

---

### Task 1: Put destructive-test safety before the canonical migration test

**Files:**

- Create: `admin-backend/src/admin-audits/admin-audit.postgres.spec.ts`
- Create: `admin-backend/src/admin-audits/docker-compose.test.yml`
- Create: `admin-backend/src/admin-audits/provision-test-database.mjs`

**Interfaces:**

- Consumes: `ADMIN_AUDIT_TEST_DATABASE_URL`, `DATABASE_URL`, `DATABASE_DIRECT_URL`, `NODE_ENV`, `ADMIN_AUDIT_TEST_ALLOW_RESET`.
- Produces: dedicated Docker cluster and `assertSafeAdminAuditTestDatabase()` that returns a connected `pg.Pool` only after Docker, URL, and server identity checks.

- [ ] **Step 1: Write the reset guard tests without issuing destructive SQL**

Use injected env/connector inputs so every refusal path runs without a database:

```ts
it('rejects every unsafe reset target before connecting', async () => {
  const base = {
    NODE_ENV: 'test',
    ADMIN_AUDIT_TEST_ALLOW_RESET: 'true',
    ADMIN_AUDIT_TEST_DATABASE_URL:
      'postgresql://orebit_admin_audit_test_owner:local_audit_test_only@127.0.0.1:55434/orebit_admin_audit_test?schema=admin',
    DATABASE_URL: 'postgresql://admin:test@127.0.0.1:5432/orebit_admin?schema=admin',
    DATABASE_DIRECT_URL: 'postgresql://admin:test@127.0.0.1:5432/orebit_admin?schema=admin',
  };
  for (const env of [
    { ...base, NODE_ENV: 'production' },
    { ...base, ADMIN_AUDIT_TEST_ALLOW_RESET: 'false' },
    { ...base, DATABASE_URL: '' },
    { ...base, DATABASE_DIRECT_URL: '' },
    { ...base, ADMIN_AUDIT_TEST_DATABASE_URL:
      'postgresql://audit_test:test@db.internal:5432/orebit_admin_audit_test?schema=admin' },
    { ...base, ADMIN_AUDIT_TEST_DATABASE_URL:
      'postgresql://audit_test:test@localhost:55434/orebit_admin_audit_test?schema=admin' },
    { ...base, ADMIN_AUDIT_TEST_DATABASE_URL:
      'postgresql://audit_test:test@127.0.0.1:5432/orebit_admin_audit_test?schema=admin' },
    { ...base, ADMIN_AUDIT_TEST_DATABASE_URL: base.DATABASE_URL },
    { ...base, ADMIN_AUDIT_TEST_DATABASE_URL:
      'postgresql://audit_test:test@127.0.0.1:5432/not_the_test_database?schema=admin' },
  ]) {
    let connected = false;
    await assert.rejects(() => assertSafeAdminAuditTestDatabase(env, async () => {
      connected = true;
      throw new Error('must not connect');
    }));
    assert.equal(connected, false);
  }
});
```

Also test canonical endpoint equality: different usernames, passwords, or query-parameter order do not make the same host/port/database tuple safe. Reject Docker inspection with another container name, a non-loopback published address, or a host port other than 55434 before connecting.

- [ ] **Step 2: Implement URL validation and post-connect verification**

The guard must enforce, in order:

```ts
const TEST_DATABASE = 'orebit_admin_audit_test';
const TEST_CONTAINER = 'orebit-admin-audit-postgres-test';
const TEST_CLUSTER = 'orebit_admin_audit_test';
const TEST_HOST = '127.0.0.1';
const TEST_HOST_PORT = 55_434;

type ServerIdentity = {
  currentDatabase: string;
  clusterName: string;
  serverAddress: string;
  serverPort: number;
};
```

Create this exact dedicated service:

```yaml
name: orebit-admin-audit-test
services:
  postgres:
    image: postgres:17.6-alpine
    container_name: orebit-admin-audit-postgres-test
    command: ["postgres", "-c", "cluster_name=orebit_admin_audit_test"]
    environment:
      POSTGRES_DB: orebit_admin_audit_test
      POSTGRES_USER: orebit_admin_audit_test_owner
      POSTGRES_PASSWORD: local_audit_test_only
    ports:
      - "127.0.0.1:55434:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U orebit_admin_audit_test_owner -d orebit_admin_audit_test"]
      interval: 2s
      timeout: 2s
      retries: 30
```

The provisioner runs `docker inspect orebit-admin-audit-postgres-test` and verifies that exact running container and binding before a database connection.

Require test mode, exact reset flag, all three URLs present/parseable, test host `127.0.0.1`, host port 55434, schema `admin`, and exact decoded database. Reject either runtime URL when its normalized loopback host/port is 55434, regardless of its database or credentials; also reject an equal host/port/database tuple. After connecting, run this query before reset:

```sql
SELECT current_database() AS "currentDatabase",
       current_setting('cluster_name') AS "clusterName",
       inet_server_addr()::text AS "serverAddress",
       inet_server_port() AS "serverPort"
```

Require the exact test database/cluster name, non-null server address, and internal server port 5432. Return the pool only after all checks pass and print the observed container/database/cluster/server identity.

- [ ] **Step 3: Run the guard tests**

```powershell
docker compose -f src/admin-audits/docker-compose.test.yml up -d --wait
$env:ADMIN_AUDIT_TEST_DATABASE_URL='postgresql://orebit_admin_audit_test_owner:local_audit_test_only@127.0.0.1:55434/orebit_admin_audit_test?schema=admin'
node --env-file=.env --import tsx --test --test-concurrency=1 src/admin-audits/admin-audit.postgres.spec.ts
```

Expected: guard-only tests PASS without resetting a database.

- [ ] **Step 4: Checkpoint (no commit)**

Review the guard paths and prove every rejection occurs before `DROP SCHEMA`. Do not stage or commit.

### Task 2: Create the sole table, roles, immutable guards, and SQL append API

**Files:**

- Modify: `admin-backend/src/admin-audits/admin-audit.postgres.spec.ts`
- Create: `admin-backend/src/admin-audits/migrations/202609030001_global_admin_audit_events/migration.sql`
- Create: `admin-backend/src/admin-audits/production-role-memberships.sql`

**Interfaces:**

- Consumes: the safe pool from Task 1 and the action matrix in the spec.
- Produces: `admin.admin_audit_events`, `admin.append_admin_audit_event_v1`, `orebit_admin_audit_owner`, `orebit_admin_audit_writer`, and `orebit_admin_audit_reader`.

- [ ] **Step 1: Add failing migration and privilege tests**

After `assertSafeAdminAuditTestDatabase` returns, reset only the isolated `admin` schema, read the one exact migration, and assert:

```ts
await pool.query('DROP SCHEMA IF EXISTS admin CASCADE');
await pool.query(await readFile(new URL(
  './migrations/202609030001_global_admin_audit_events/migration.sql', import.meta.url,
), 'utf8'));

const tables = await pool.query(`SELECT tablename FROM pg_tables
  WHERE schemaname = 'admin' ORDER BY tablename`);
assert.deepEqual(tables.rows, [{ tablename: 'admin_audit_events' }]);

const fn = await pool.query(`SELECT p.prosecdef,
  p.proconfig, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'admin' AND p.proname = 'append_admin_audit_event_v1'`);
assert.equal(fn.rows[0].prosecdef, true);
assert.deepEqual(fn.rows[0].proconfig, ['search_path=pg_catalog, admin']);
assert.equal(fn.rows[0].owner, 'orebit_admin_audit_owner');
```

With disposable role switching, prove writer can execute the function but cannot SELECT/INSERT/UPDATE/DELETE/TRUNCATE the table; reader can SELECT but cannot execute the function or mutate; PUBLIC can do neither. As owner, direct UPDATE, DELETE, and TRUNCATE must still raise SQLSTATE `55000`.

Add SQL-boundary cases rejecting a UUIDv4 audit id, blank/129-character subject id, nonnumeric `SETTINGS_REVISION` subject, non-UUID `CURRENCY` subject, and non-UUIDv7 CHAIN/DEPOSIT/job subjects. Prove a valid legacy RFC UUID currency subject remains accepted.

- [ ] **Step 2: Run and verify the missing-migration failure**

```powershell
$env:NODE_ENV='test'
$env:ADMIN_AUDIT_TEST_ALLOW_RESET='true'
$env:ADMIN_AUDIT_TEST_DATABASE_URL='postgresql://orebit_admin_audit_test_owner:local_audit_test_only@127.0.0.1:55434/orebit_admin_audit_test?schema=admin'
docker compose -f src/admin-audits/docker-compose.test.yml up -d --wait
node --env-file=.env --import tsx --test --test-concurrency=1 src/admin-audits/admin-audit.postgres.spec.ts
```

Expected: FAIL because the canonical migration does not exist.

- [ ] **Step 3: Implement roles and the single table**

Begin one transactional migration, ensure pgcrypto, and create/verify the exact NOLOGIN group roles:

```sql
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $roles$
BEGIN
  IF to_regrole('orebit_admin_audit_owner') IS NULL THEN
    CREATE ROLE orebit_admin_audit_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF to_regrole('orebit_admin_audit_writer') IS NULL THEN
    CREATE ROLE orebit_admin_audit_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF to_regrole('orebit_admin_audit_reader') IS NULL THEN
    CREATE ROLE orebit_admin_audit_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END;
$roles$;
ALTER ROLE orebit_admin_audit_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE orebit_admin_audit_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE orebit_admin_audit_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
```

Create `admin.admin_audit_events` with the exact columns/checks in the design: UUIDv7 id; unique event key; database hash; two domains; ADMIN/SYSTEM actor constraint; first transport columns; subject/reason; flat JSON object columns; database timestamp; 65,536-byte limits. Add descending created, domain/action, actor, run, and subject indexes.

Create separate row and statement trigger functions that always raise `55000`, attach them to UPDATE/DELETE and TRUNCATE, and revoke PUBLIC table access.

- [ ] **Step 4: Implement the action-closed SECURITY DEFINER function**

Use the exact 17-argument signature from the spec and fixed search path:

```sql
CREATE FUNCTION admin.append_admin_audit_event_v1(
  p_id uuid, p_event_key text, p_domain text, p_action text,
  p_actor_kind text, p_actor_id uuid, p_session_id uuid, p_request_id uuid,
  p_run_id uuid, p_ip_address inet, p_device_id text,
  p_subject_type text, p_subject_id text, p_reason text,
  p_before_json jsonb, p_after_json jsonb, p_metadata_json jsonb
) RETURNS TABLE (audit_event_id uuid, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, admin
AS $function$
DECLARE
  v_hash text;
  v_inserted_id uuid;
  v_existing_id uuid;
  v_existing_hash text;
  v_event_key text := btrim(p_event_key);
  v_before jsonb := COALESCE(p_before_json, '{}'::jsonb);
  v_after jsonb := COALESCE(p_after_json, '{}'::jsonb);
  v_metadata jsonb := COALESCE(p_metadata_json, '{}'::jsonb);
BEGIN
  IF p_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR v_event_key IS NULL OR v_event_key = '' OR length(v_event_key) > 200
    OR p_reason IS NULL OR btrim(p_reason) = '' OR length(btrim(p_reason)) > 500
    OR p_subject_type IS NULL OR p_subject_type !~ '^[A-Z][A-Z0-9_]{0,63}$'
    OR p_subject_id IS NULL OR btrim(p_subject_id) = '' OR length(btrim(p_subject_id)) > 128
    OR jsonb_typeof(v_before) <> 'object' OR jsonb_typeof(v_after) <> 'object'
    OR jsonb_typeof(v_metadata) <> 'object'
    OR octet_length(v_before::text) > 65536 OR octet_length(v_after::text) > 65536
    OR octet_length(v_metadata::text) > 65536
    OR EXISTS (SELECT 1 FROM jsonb_each(v_before) WHERE jsonb_typeof(value) IN ('array','object'))
    OR EXISTS (SELECT 1 FROM jsonb_each(v_after) WHERE jsonb_typeof(value) IN ('array','object'))
    OR EXISTS (SELECT 1 FROM jsonb_each(v_metadata) WHERE jsonb_typeof(value) IN ('array','object'))
    OR NOT (
      (p_actor_kind = 'ADMIN' AND p_actor_id IS NOT NULL AND p_session_id IS NOT NULL
        AND p_request_id IS NOT NULL AND p_run_id IS NULL AND p_ip_address IS NOT NULL
        AND p_device_id IS NOT NULL AND btrim(p_device_id) <> '' AND length(p_device_id) <= 128)
      OR
      (p_actor_kind = 'SYSTEM' AND p_actor_id IS NULL AND p_session_id IS NULL
        AND p_request_id IS NULL AND p_run_id IS NOT NULL AND p_ip_address IS NULL
        AND p_device_id IS NULL)
    )
  THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  CASE
    WHEN p_action IN ('SETTINGS.SAVED','SETTINGS.PUSHED','SETTINGS.SCHEDULED',
      'SETTINGS.SCHEDULE_APPLIED','SETTINGS.SCHEDULE_REJECTED')
      AND p_domain IN ('WALLET_CORE','DEPOSIT')
      AND p_subject_type = 'SETTINGS_REVISION' THEN
      IF v_before - ARRAY['revision','status','effectiveAt'] <> '{}'::jsonb
        OR v_after - ARRAY['revision','status','effectiveAt'] <> '{}'::jsonb
        OR v_metadata - ARRAY['configurationRevision','changelogId','safeErrorCode'] <> '{}'::jsonb
        OR NOT (v_metadata ? 'configurationRevision')
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'WALLET_CORE' AND p_action = 'ADMIN_TIMEZONE.UPDATED'
      AND p_subject_type = 'ADMIN' THEN
      IF v_before - ARRAY['timezone'] <> '{}'::jsonb OR v_after - ARRAY['timezone'] <> '{}'::jsonb
        OR v_metadata - ARRAY['configurationRevision'] <> '{}'::jsonb
        OR NOT (v_metadata ? 'configurationRevision')
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'WALLET_CORE' AND p_action = 'CATALOGUE.REFRESHED'
      AND p_subject_type = 'PROVIDER_CATALOGUE' THEN
      IF v_before - ARRAY['revision','itemCount'] <> '{}'::jsonb
        OR v_after - ARRAY['revision','itemCount'] <> '{}'::jsonb
        OR v_metadata - ARRAY['configurationRevision','source'] <> '{}'::jsonb
        OR NOT (v_metadata ?& ARRAY['configurationRevision','source'])
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'WALLET_CORE'
      AND p_action IN ('CHAIN.CREATED','CHAIN.UPDATED','CHAIN.IMPORTED')
      AND p_subject_type = 'CHAIN' THEN
      IF v_before - ARRAY['name','shortName','blockchainReference','availableFor','logoObjectKey'] <> '{}'::jsonb
        OR v_after - ARRAY['name','shortName','blockchainReference','availableFor','logoObjectKey'] <> '{}'::jsonb
        OR v_metadata - ARRAY['configurationRevision','importCatalogueRevision'] <> '{}'::jsonb
        OR NOT (v_metadata ? 'configurationRevision')
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'WALLET_CORE'
      AND p_action IN ('CURRENCY.CREATED','CURRENCY.UPDATED','CURRENCY.IMPORTED')
      AND p_subject_type = 'CURRENCY' THEN
      IF v_before - ARRAY['symbol','name','kind','pricingStatus','desiredState','logoObjectKey'] <> '{}'::jsonb
        OR v_after - ARRAY['symbol','name','kind','pricingStatus','desiredState','logoObjectKey'] <> '{}'::jsonb
        OR v_metadata - ARRAY['configurationRevision','providerReferenceCount',
          'chainBindingCount','importCatalogueRevision'] <> '{}'::jsonb
        OR NOT (v_metadata ? 'configurationRevision')
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'WALLET_CORE'
      AND p_action IN ('PROVIDER_MAINTENANCE.PINNED','PROVIDER_MAINTENANCE.UNPINNED')
      AND p_subject_type IN ('CHAIN','CURRENCY_CHAIN') THEN
      IF v_before - ARRAY['maintenancePinned','effectiveState'] <> '{}'::jsonb
        OR v_after - ARRAY['maintenancePinned','effectiveState'] <> '{}'::jsonb
        OR v_metadata - ARRAY['configurationRevision'] <> '{}'::jsonb
        OR NOT (v_metadata ? 'configurationRevision')
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'WALLET_CORE' AND p_action = 'CHAIN.STATUS_CHANGED'
      AND p_subject_type = 'CHAIN' THEN
      IF v_before - ARRAY['desiredState','effectiveState','maintenancePinned'] <> '{}'::jsonb
        OR v_after - ARRAY['desiredState','effectiveState','maintenancePinned'] <> '{}'::jsonb
        OR v_metadata - ARRAY['configurationRevision','scheduledChangeId'] <> '{}'::jsonb
        OR NOT (v_metadata ? 'configurationRevision')
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'WALLET_CORE' AND p_action = 'CURRENCY.STATUS_CHANGED'
      AND p_subject_type IN ('CURRENCY','CURRENCY_CHAIN') THEN
      IF v_before - ARRAY['desiredState','effectiveState','showBalance'] <> '{}'::jsonb
        OR v_after - ARRAY['desiredState','effectiveState','showBalance'] <> '{}'::jsonb
        OR v_metadata - ARRAY['configurationRevision','scheduledChangeId'] <> '{}'::jsonb
        OR NOT (v_metadata ? 'configurationRevision')
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'WALLET_CORE' AND (
        (p_action IN ('PROVIDER_MAINTENANCE.ENTERED','PROVIDER_MAINTENANCE.RECOVERED')
          AND p_subject_type IN ('CHAIN','CURRENCY','CURRENCY_CHAIN'))
        OR (p_action IN ('PRICE_MAINTENANCE.ENTERED','PRICE_MAINTENANCE.RECOVERED')
          AND p_subject_type IN ('CHAIN','CURRENCY'))
      ) THEN
      IF v_before - ARRAY['effectiveState','failureStreak','maintenancePinned'] <> '{}'::jsonb
        OR v_after - ARRAY['effectiveState','failureStreak','maintenancePinned'] <> '{}'::jsonb
        OR v_metadata - ARRAY['configurationRevision','providerReference'] <> '{}'::jsonb
        OR NOT (v_metadata ?& ARRAY['configurationRevision','providerReference'])
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'WALLET_CORE' AND p_action = 'RECONCILIATION.COMPLETED'
      AND p_subject_type = 'RECONCILIATION_RUN' THEN
      IF v_before - ARRAY['status','partial'] <> '{}'::jsonb
        OR v_after - ARRAY['status','partial'] <> '{}'::jsonb
        OR v_metadata - ARRAY['currencyCount','warningCount'] <> '{}'::jsonb
        OR NOT (v_metadata ?& ARRAY['currencyCount','warningCount'])
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'WALLET_CORE'
      AND p_action IN ('RECONCILIATION.WARNING_RAISED','RECONCILIATION.WARNING_CLEARED')
      AND p_subject_type = 'CURRENCY' THEN
      IF v_before - ARRAY['active','partial','shortfallPercent'] <> '{}'::jsonb
        OR v_after - ARRAY['active','partial','shortfallPercent'] <> '{}'::jsonb
        OR v_metadata - ARRAY['reconciliationRunId'] <> '{}'::jsonb
        OR NOT (v_metadata ? 'reconciliationRunId')
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'WALLET_CORE' AND p_action = 'DELISTING.FORFEITURE_POSTED'
      AND p_subject_type = 'LEDGER_JOURNAL' THEN
      IF v_before - ARRAY['balance'] <> '{}'::jsonb OR v_after - ARRAY['balance'] <> '{}'::jsonb
        OR v_metadata - ARRAY['currencyId','ownerType','ownerId','amount'] <> '{}'::jsonb
        OR NOT (v_metadata ?& ARRAY['currencyId','ownerType','ownerId','amount'])
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'DEPOSIT'
      AND p_action IN ('DEPOSIT.RELEASED','DEPOSIT.REJECTED','DEPOSIT.CANCELLED',
        'DEPOSIT.MAINTENANCE_CANCELLED')
      AND p_subject_type = 'DEPOSIT' THEN
      IF v_before - ARRAY['status','bucket','visible'] <> '{}'::jsonb
        OR v_after - ARRAY['status','bucket','visible'] <> '{}'::jsonb
        OR v_metadata - ARRAY['currencyId','grossAmount','feeAmount','ledgerJournalId',
          'priceResolutionId','priceSnapshotId','priceBasis'] <> '{}'::jsonb
        OR NOT (v_metadata ?& ARRAY['currencyId','grossAmount'])
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'DEPOSIT' AND p_action = 'DEPOSIT.REVERIFICATION_HELD'
      AND p_subject_type = 'DEPOSIT' THEN
      IF v_before - ARRAY['status','bucket','visible'] <> '{}'::jsonb
        OR v_after - ARRAY['status','bucket','visible'] <> '{}'::jsonb
        OR v_metadata - ARRAY['currencyId','grossAmount','ledgerJournalId','blockerId'] <> '{}'::jsonb
        OR NOT (v_metadata ?& ARRAY['currencyId','grossAmount','ledgerJournalId','blockerId'])
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'DEPOSIT'
      AND p_action IN ('DEPOSIT.CLAWBACK_TO_ZERO_POSTED','DEPOSIT.CLAWBACK_NEGATIVE_POSTED')
      AND p_subject_type = 'DEPOSIT' THEN
      IF v_before - ARRAY['status','bucket','visible'] <> '{}'::jsonb
        OR v_after - ARRAY['status','bucket','visible'] <> '{}'::jsonb
        OR v_metadata - ARRAY['currencyId','ledgerJournalId','clawbackAmount','shortfallAmount'] <> '{}'::jsonb
        OR NOT (v_metadata ?& ARRAY['currencyId','ledgerJournalId','clawbackAmount'])
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'DEPOSIT' AND p_action = 'DEPOSIT.ACCOUNTING_REVERSAL_POSTED'
      AND p_subject_type = 'DEPOSIT' THEN
      IF v_before - ARRAY['status','bucket','visible'] <> '{}'::jsonb
        OR v_after - ARRAY['status','bucket','visible'] <> '{}'::jsonb
        OR v_metadata - ARRAY['currencyId','originalJournalId','reversalJournalId'] <> '{}'::jsonb
        OR NOT (v_metadata ?& ARRAY['currencyId','originalJournalId','reversalJournalId'])
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'DEPOSIT' AND p_action = 'DEPOSIT.STATUS_CHANGED'
      AND p_subject_type = 'DEPOSIT' THEN
      IF v_before - ARRAY['status','bucket','visible'] <> '{}'::jsonb
        OR v_after - ARRAY['status','bucket','visible'] <> '{}'::jsonb
        OR v_metadata - ARRAY['currencyId','ledgerJournalId'] <> '{}'::jsonb
        OR NOT (v_metadata ? 'currencyId')
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'DEPOSIT' AND p_action = 'BLOCKER.WAIVED'
      AND p_subject_type = 'DEPOSIT_BLOCKER' THEN
      IF v_before - ARRAY['status'] <> '{}'::jsonb OR v_after - ARRAY['status'] <> '{}'::jsonb
        OR v_metadata - ARRAY['depositId','blockerKind'] <> '{}'::jsonb
        OR NOT (v_metadata ?& ARRAY['depositId','blockerKind'])
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'DEPOSIT'
      AND p_action IN ('QUARANTINE.RETRIED','QUARANTINE.ASSIGNED',
        'QUARANTINE.CREDIT_REQUESTED','QUARANTINE.RETAINED')
      AND p_subject_type = 'QUARANTINE' THEN
      IF v_before - ARRAY['status','assignedUserId'] <> '{}'::jsonb
        OR v_after - ARRAY['status','assignedUserId'] <> '{}'::jsonb
        OR v_metadata - ARRAY['currencyId','grossAmount','depositId','ledgerJournalId',
          'priceResolutionId','priceSnapshotId','priceBasis'] <> '{}'::jsonb
        OR NOT (v_metadata ?& ARRAY['currencyId','grossAmount'])
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'DEPOSIT' AND p_action IN ('KILL_SWITCH.ACTIVATED','KILL_SWITCH.CLEARED')
      AND p_subject_type = 'FEATURE_STATE' THEN
      IF v_before - ARRAY['killed'] <> '{}'::jsonb OR v_after - ARRAY['killed'] <> '{}'::jsonb
        OR v_metadata - ARRAY['configurationRevision'] <> '{}'::jsonb
        OR NOT (v_metadata ? 'configurationRevision')
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'DEPOSIT'
      AND p_action IN ('BULK_JOB.CREATED','BULK_JOB.STARTED','BULK_JOB.PAUSED',
        'BULK_JOB.RESUMED','BULK_JOB.COMPLETED','BULK_JOB.COMPLETED_WITH_FAILURES',
        'BULK_JOB.FAILED')
      AND p_subject_type = 'BULK_JOB' THEN
      IF v_before - ARRAY['status'] <> '{}'::jsonb OR v_after - ARRAY['status'] <> '{}'::jsonb
        OR v_metadata - ARRAY['actionKind','totalItems','attemptedCount','succeededCount',
          'failedCount','batchNumber','safeErrorCode'] <> '{}'::jsonb
        OR NOT (v_metadata ?& ARRAY['actionKind','totalItems','attemptedCount',
          'succeededCount','failedCount'])
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    WHEN p_domain = 'DEPOSIT'
      AND p_action IN ('BULK_JOB.ITEM_SUCCEEDED','BULK_JOB.ITEM_FAILED')
      AND p_subject_type = 'BULK_JOB_ITEM' THEN
      IF v_before - ARRAY['status'] <> '{}'::jsonb OR v_after - ARRAY['status'] <> '{}'::jsonb
        OR v_metadata - ARRAY['bulkJobId','depositId','attempt','ledgerJournalId','safeErrorCode'] <> '{}'::jsonb
        OR NOT (v_metadata ?& ARRAY['bulkJobId','depositId','attempt'])
      THEN RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023'; END IF;
    ELSE RAISE EXCEPTION 'ADMIN_AUDIT_INPUT_INVALID' USING ERRCODE = '22023';
  END CASE;
  v_hash := encode(public.digest(convert_to(jsonb_build_object(
    'domain', p_domain, 'action', p_action, 'actorKind', p_actor_kind,
    'actorId', p_actor_id, 'runId', p_run_id,
    'subjectType', p_subject_type, 'subjectId', btrim(p_subject_id),
    'reason', btrim(p_reason), 'before', p_before_json, 'after', p_after_json,
    'metadata', COALESCE(p_metadata_json, '{}'::jsonb)
  )::text, 'UTF8'), 'sha256'), 'hex');

  INSERT INTO admin.admin_audit_events (
    id, event_key, event_hash, domain, action, actor_kind, actor_id,
    session_id, request_id, run_id, ip_address, device_id,
    subject_type, subject_id, reason, before_json, after_json, metadata_json
  ) VALUES (
    p_id, v_event_key, v_hash, p_domain, p_action, p_actor_kind, p_actor_id,
    p_session_id, p_request_id, p_run_id, p_ip_address, p_device_id,
    p_subject_type, btrim(p_subject_id), btrim(p_reason), p_before_json,
    p_after_json, COALESCE(p_metadata_json, '{}'::jsonb)
  ) ON CONFLICT (event_key) DO NOTHING RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NOT NULL THEN
    RETURN QUERY SELECT v_inserted_id, false;
    RETURN;
  END IF;
  SELECT id, event_hash INTO v_existing_id, v_existing_hash
    FROM admin.admin_audit_events WHERE event_key = v_event_key;
  IF v_existing_id IS NULL OR v_existing_hash <> v_hash THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_EVENT_KEY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN QUERY SELECT v_existing_id, true;
END;
$function$;
```

The `CASE` above is illustrative pseudocode only. The canonical migration stores one machine-readable JSON contract inside the append function and consumes it for domain/action, subject, actor, before/after keys, required/optional metadata, action-specific constraints, and scalar family validation; there is no second action or scalar matrix. In both domains the settings transitions are exactly SAVED `null -> DRAFT`, PUSHED `DRAFT -> LIVE`, SCHEDULED `DRAFT -> SCHEDULED`, SCHEDULE_APPLIED `SCHEDULED -> LIVE`, and SCHEDULE_REJECTED `SCHEDULED -> REJECTED`. Wallet `LOGO.UPLOADED` is ADMIN-only, uses `LOGO_ASSET` plus an ASCII-trimmed exact lowercase 64-hex `.webp` object key, fixed reason `wallet-logo-upload`, exact false-to-true stored state, fixed `image/webp`, equal positive dimensions at most 500, bytes 1..1,048,576, and source format `PNG|JPEG|WEBP|AVIF`; no image, hash, path, or URL field is allowed. Integer, decimal, UUID, boolean, nullable, text-bound, timestamp, and enum limits are fields in that runtime contract. Other subject identity remains selected by subject type: unsigned integer for `SETTINGS_REVISION`, literal `BLOCKCHAIN` for `PROVIDER_CATALOGUE`, RFC UUID for `CURRENCY`, and UUIDv7 for `ADMIN`, `CHAIN`, `RECONCILIATION_RUN`, `LEDGER_JOURNAL`, `DEPOSIT`, `DEPOSIT_BLOCKER`, `QUARANTINE`, `FEATURE_STATE`, `BULK_JOB`, and `BULK_JOB_ITEM`. The function raises SQLSTATE `22023` with `ADMIN_AUDIT_INPUT_INVALID` for every failure. It does not accept a hash or timestamp.

`CURRENCY_CHAIN` uses the same lowercase-normalized RFC UUID identity family as `CURRENCY`, but
identifies a binding rather than a whole coin. It is an allowed subject only for
`CURRENCY.STATUS_CHANGED` and `PROVIDER_MAINTENANCE.ENTERED/RECOVERED`; it remains excluded from
currency create/update/import, provider pin/unpin, price maintenance, and all Deposit actions.

- [ ] **Step 5: Apply exact ownership and grants**

Alter the table and both trigger functions plus append function to owner role. Revoke all table rights from PUBLIC/writer/reader, grant table SELECT only to reader, grant `admin` schema USAGE to owner/writer/reader, and grant the owner only the `public` schema USAGE plus `public.digest(bytea,text)` execution needed for SHA-256. Revoke PUBLIC append-function execution and grant it only to writer. Neither runtime group receives schema CREATE.

- [ ] **Step 6: Add and test exact runtime memberships**

Create `production-role-memberships.sql` with no variables, fallback values, or login creation. It first queries `pg_roles` and raises `ADMIN_AUDIT_RUNTIME_ROLE_INVALID` unless these exact roles are LOGIN, INHERIT, non-superuser, non-createdb, and non-createrole:

```text
orebit_admin_runtime
orebit_wallet_core_user_runtime
orebit_deposit_user_runtime
orebit_admin_audit_history_runtime
```

Then execute the exact GRANT/REVOKE membership block from the design. In the dedicated Docker provisioner only, create these four test login roles with fixed local-only credentials before applying the membership file. Tests assert `pg_has_role` writer membership for the first three, reader-only membership for history, direct table DML denial for all writer logins, function denial for history, and function success for each writer login.

```sql
DO $runtime_roles$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'orebit_admin_runtime',
      'orebit_wallet_core_user_runtime',
      'orebit_deposit_user_runtime',
      'orebit_admin_audit_history_runtime'
    ]) AS expected(name)
    LEFT JOIN pg_roles actual ON actual.rolname = expected.name
    WHERE actual.oid IS NULL OR NOT actual.rolcanlogin OR NOT actual.rolinherit
      OR actual.rolsuper OR actual.rolcreatedb OR actual.rolcreaterole
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_RUNTIME_ROLE_INVALID';
  END IF;
END;
$runtime_roles$;

GRANT orebit_admin_audit_writer TO orebit_admin_runtime;
GRANT orebit_admin_audit_writer TO orebit_wallet_core_user_runtime;
GRANT orebit_admin_audit_writer TO orebit_deposit_user_runtime;
GRANT orebit_admin_audit_reader TO orebit_admin_audit_history_runtime;
REVOKE orebit_admin_audit_reader FROM orebit_admin_runtime;
REVOKE orebit_admin_audit_reader FROM orebit_wallet_core_user_runtime;
REVOKE orebit_admin_audit_reader FROM orebit_deposit_user_runtime;
REVOKE orebit_admin_audit_writer FROM orebit_admin_audit_history_runtime;
```

- [ ] **Step 7: Run the PostgreSQL suite**

Run the Step 2 command. Expected: table/function/role/immutability tests PASS.

- [ ] **Step 8: Checkpoint (no commit)**

Confirm `rg -n "CREATE TABLE admin\\.admin_audit_events|CREATE FUNCTION admin\\.append_admin_audit_event_v1" src/admin-audits --glob "*.sql"` finds both production definitions in the canonical migration only. Do not stage or commit.

### Task 3: Freeze action-specific TypeScript inputs and safe builders

**Files:**

- Create: `admin-backend/src/admin-audits/admin-audit.types.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.payloads.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.contracts.spec.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.validation-parity.spec.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.sql-contract.spec.ts`

**Interfaces:**

- Consumes: the design's action/subject/key/value matrix.
- Produces: `AdminAuditActor`, `WalletCoreAdminAuditInput`, `DepositAdminAuditInput`, `buildWalletCoreAdminAuditEvent`, and `buildDepositAdminAuditEvent`.

- [ ] **Step 1: Write failing builder and parity tests**

Test every action, unknown/extra keys, wrong subject, invalid actor variants, RFC UUIDv4 actor identity, designated UUIDv7 subjects, U+0000 rejection, raw and normalized JSON byte bounds, decimal strings, integers, booleans, enums, dependent reconciliation-warning nullability, and SQL parity:

```ts
it('matches every TypeScript pair with the SQL runtime contract', async () => {
  const sql = await readFile(new URL(
    './migrations/202609030001_global_admin_audit_events/migration.sql', import.meta.url,
  ), 'utf8');
  const contract = parseRuntimeContract(sql);
  assert.deepEqual(expandSqlActions(contract.actions), typescriptActions());
  assert.deepEqual(contract.validators, ADMIN_AUDIT_SCALAR_VALIDATOR_DESCRIPTOR);
});

it('rejects an extra key rather than filtering it', () => {
  assert.throws(() => buildDepositAdminAuditEvent({
    ...depositRejected,
    metadata: { ...depositRejected.metadata, rawPayload: '{}' },
  } as never), /ADMIN_AUDIT_INPUT_INVALID/);
});

it('supports ADMIN transport and SYSTEM run identity', () => {
  assert.equal(buildWalletCoreAdminAuditEvent(adminSettingsSaved).actor.kind, 'ADMIN');
  assert.equal(buildWalletCoreAdminAuditEvent(systemMaintenanceEntered).actor.kind, 'SYSTEM');
});
```

Add a table-driven positive case for every action and mutate each legal input once per field category to prove fail-closed behavior. Keep a detached, deeply frozen action/scalar descriptor for exact SQL parity and prove attempted descriptor mutation cannot alter builder behavior.

Add an exact SQL-contract test that parses the single machine-readable action/scalar descriptor consumed by `admin.append_admin_audit_event_v1` and compares all 56 domain/action pairs, subjects, actors, before/after keys, required/optional metadata, action-specific settings/logo constraints, scalar families, limits, nullable keys, dependent-null rules, and enum members with the detached TypeScript descriptors. The migration must not retain a second action or scalar matrix. For both reconciliation warning actions and both state sections, `shortfallPercent: null` is valid only when the same state has `partial: true`; decimal strings remain valid for `partial: true` and `partial: false`, and all other decimal fields remain non-nullable.

Parse the canonical migration-order sections from both this plan and the design, require identical relative order, and check every currently non-planned prerequisite in both repositories. Scan source `.sql`/`.ts` across both repositories for the audit table, append/immutability functions and triggers, audit roles, and direct table DML/DDL; only the canonical migration, production membership checks, and canonical parameterized function clients are permitted production references.

- [ ] **Step 2: Run and verify missing-builder failure**

```powershell
node --import tsx --test --test-concurrency=1 src/admin-audits/admin-audit.contracts.spec.ts
```

Expected: FAIL because types/builders do not exist.

- [ ] **Step 3: Define the actor and closed family types**

```ts
export type AdminAuditActor =
  | { readonly kind: 'ADMIN'; readonly actorId: string; readonly sessionId: string;
      readonly requestId: string; readonly ipAddress: string; readonly deviceId: string }
  | { readonly kind: 'SYSTEM'; readonly runId: string };

export const WALLET_CORE_ADMIN_AUDIT_ACTIONS = [
  'SETTINGS.SAVED', 'SETTINGS.PUSHED', 'SETTINGS.SCHEDULED',
  'SETTINGS.SCHEDULE_APPLIED', 'SETTINGS.SCHEDULE_REJECTED',
  'LOGO.UPLOADED',
  'ADMIN_TIMEZONE.UPDATED', 'CATALOGUE.REFRESHED',
  'CHAIN.CREATED', 'CHAIN.UPDATED', 'CHAIN.IMPORTED', 'CHAIN.STATUS_CHANGED',
  'CURRENCY.CREATED', 'CURRENCY.UPDATED', 'CURRENCY.IMPORTED', 'CURRENCY.STATUS_CHANGED',
  'PROVIDER_MAINTENANCE.PINNED', 'PROVIDER_MAINTENANCE.UNPINNED',
  'PROVIDER_MAINTENANCE.ENTERED', 'PROVIDER_MAINTENANCE.RECOVERED',
  'PRICE_MAINTENANCE.ENTERED', 'PRICE_MAINTENANCE.RECOVERED',
  'RECONCILIATION.COMPLETED',
  'RECONCILIATION.WARNING_RAISED', 'RECONCILIATION.WARNING_CLEARED',
  'DELISTING.FORFEITURE_POSTED',
] as const;
export const DEPOSIT_ADMIN_AUDIT_ACTIONS = [
  'SETTINGS.SAVED', 'SETTINGS.PUSHED', 'SETTINGS.SCHEDULED',
  'SETTINGS.SCHEDULE_APPLIED', 'SETTINGS.SCHEDULE_REJECTED',
  'DEPOSIT.RELEASED', 'DEPOSIT.REJECTED', 'DEPOSIT.CANCELLED',
  'DEPOSIT.MAINTENANCE_CANCELLED', 'DEPOSIT.REVERIFICATION_HELD',
  'DEPOSIT.CLAWBACK_TO_ZERO_POSTED', 'DEPOSIT.CLAWBACK_NEGATIVE_POSTED',
  'DEPOSIT.ACCOUNTING_REVERSAL_POSTED', 'DEPOSIT.STATUS_CHANGED',
  'BLOCKER.WAIVED', 'QUARANTINE.RETRIED', 'QUARANTINE.ASSIGNED',
  'QUARANTINE.CREDIT_REQUESTED', 'QUARANTINE.RETAINED',
  'KILL_SWITCH.ACTIVATED', 'KILL_SWITCH.CLEARED',
  'BULK_JOB.CREATED', 'BULK_JOB.STARTED', 'BULK_JOB.ITEM_SUCCEEDED',
  'BULK_JOB.ITEM_FAILED', 'BULK_JOB.PAUSED', 'BULK_JOB.RESUMED',
  'BULK_JOB.COMPLETED', 'BULK_JOB.COMPLETED_WITH_FAILURES', 'BULK_JOB.FAILED',
] as const;
```

Define the eight Wallet family interfaces and eleven Deposit family interfaces named in the design. Each fixes its domain, action union, subject type, exact state object, and exact metadata object. Export only the two family unions, not a generic public JSON input.

- [ ] **Step 4: Implement builders from explicit schema records**

Create one schema record per domain keyed by every exported action. Each entry contains its allowed subject set, before/after key set, required/optional metadata key set, and value validators. At module load, assert the record keys exactly equal the exported action arrays.

Both builders must:

1. select the schema by exact action;
2. validate/trim event key, subject id, and reason;
3. validate the actor union, accept RFC UUID versions 1 through 8 for actor/session/request/run identity, and lowercase them without weakening UUIDv7 event/subject rules;
4. reject U+0000 in every string value before returning an event;
5. require flat plain objects and reject unknown/missing keys;
6. enforce the 65,536-byte cap on raw JSONB-text-equivalent serialization before normalization and again on the normalized copy;
7. enforce the exact scalar rules from the design;
8. copy validated objects into new frozen objects;
9. return an internal branded `PreparedAdminAuditEvent`.

The builders do not redact, hash, assign id/time, authorize, or accept raw request/header objects.

- [ ] **Step 5: Run contracts and typecheck**

```powershell
node --import tsx --test --test-concurrency=1 src/admin-audits/admin-audit.contracts.spec.ts
node --import tsx --test --test-concurrency=1 src/admin-audits/admin-audit.validation-parity.spec.ts
node --import tsx --test --test-concurrency=1 src/admin-audits/admin-audit.sql-contract.spec.ts
npm run typecheck
```

Expected: action cases, mutation cases, SQL parity, and typecheck PASS.

- [ ] **Step 6: Checkpoint (no commit)**

Confirm there is no exported generic `JsonObject` audit input and every action is present in both a typed union and runtime schema. Do not stage or commit.

### Task 4: Implement the typed port over the SQL function and prove replay semantics

**Files:**

- Modify: `admin-backend/src/admin-audits/admin-audit.types.ts`
- Modify: `admin-backend/src/admin-audits/admin-audit.postgres.spec.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.writer.spec.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.repository.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.writer.service.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.writer.module.ts`
- Create: `admin-backend/src/admin-audits/index.ts`

**Interfaces:**

- Consumes: branded prepared events, caller `AdminAuditTransaction`, UUIDv7 helper, SQL function.
- Produces: `AdminAuditPort.appendWithTransaction(...)` and `AdminAuditAppendResult`.

- [ ] **Step 1: Add exact replay, actor, concurrency, and rollback tests**

Call `admin.append_admin_audit_event_v1` with bound parameters and assert:

```ts
test('semantic replay ignores new transport and retains the first context', async () => {
  const first = await appendFunction(pool, adminEvent({
    sessionId: UUIDS.session1, requestId: UUIDS.request1,
    ipAddress: '127.0.0.1', deviceId: 'device-1',
  }));
  const replay = await appendFunction(pool, adminEvent({
    sessionId: UUIDS.session2, requestId: UUIDS.request2,
    ipAddress: '::1', deviceId: 'device-2',
  }));
  assert.deepEqual(replay, { auditEventId: first.auditEventId, replayed: true });
  const row = await ownerQuery(`SELECT session_id, request_id, host(ip_address) AS ip,
    device_id FROM admin.admin_audit_events WHERE id = $1`, [first.auditEventId]);
  assert.deepEqual(row.rows[0], {
    session_id: UUIDS.session1, request_id: UUIDS.request1,
    ip: '127.0.0.1', device_id: 'device-1',
  });
});

test('event key is trimmed once for insert and replay', async () => {
  const first = await appendFunction(pool, { ...adminEvent(), eventKey: '  wallet:command:1  ' });
  const replay = await appendFunction(pool, { ...adminEvent(), eventKey: 'wallet:command:1' });
  assert.deepEqual(replay, { auditEventId: first.auditEventId, replayed: true });
  assert.equal((await ownerQuery(`SELECT event_key FROM admin.admin_audit_events
    WHERE id = $1`, [first.auditEventId])).rows[0].event_key, 'wallet:command:1');
});

test('same key with changed semantic meaning conflicts', async () => {
  for (const change of changedSemanticFields) {
    await assert.rejects(() => appendFunction(pool, change),
      (error: { code?: string; message?: string }) =>
        error.code === '23505' && /ADMIN_AUDIT_EVENT_KEY_CONFLICT/.test(error.message ?? ''));
  }
});

test('function shares rollback and supports SYSTEM run actors', async () => {
  const client = await pool.connect();
  await client.query('BEGIN');
  await appendFunction(client, systemEvent({ runId: UUIDS.run }));
  await client.query('ROLLBACK');
  client.release();
  assert.equal((await ownerQuery(`SELECT count(*)::int AS count
    FROM admin.admin_audit_events WHERE run_id = $1`, [UUIDS.run])).rows[0].count, 0);
});
```

Add a concurrent `Promise.all` of two equal function calls and assert one table row, one returned id, and replay flags `{false,true}` in either order. Change actor id, run id, reason, subject, before, after, and metadata one at a time under the same event key and require conflict. Changing only id plus the four transport fields must replay. Reject blank/over-200 normalized event keys and prove neither insert nor replay SQL refers to raw `p_event_key` after `v_event_key` assignment.

- [ ] **Step 2: Run and verify repository/port failure**

Run the guarded PostgreSQL and contract suites. Expected: new tests fail until the repository/service contracts exist and the SQL hash excludes transport.

- [ ] **Step 3: Add the canonical port contracts**

```ts
export interface AdminAuditTransaction {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ readonly rows: readonly Row[] }>;
}
export interface AdminAuditAppendResult {
  readonly id: string;
  readonly replayed: boolean;
}
export interface AdminAuditPort {
  appendWithTransaction(
    tx: AdminAuditTransaction,
    input: WalletCoreAdminAuditInput | DepositAdminAuditInput,
  ): Promise<AdminAuditAppendResult>;
}
```

- [ ] **Step 4: Implement the internal repository call**

`AdminAuditRepository.appendPreparedWithTransaction(tx, event)` generates one UUIDv7 and invokes only:

```sql
SELECT audit_event_id AS id, replayed
FROM admin.append_admin_audit_event_v1(
  $1::uuid, $2, $3, $4, $5, $6::uuid, $7::uuid, $8::uuid,
  $9::uuid, $10::inet, $11, $12, $13, $14,
  $15::jsonb, $16::jsonb, $17::jsonb
)
```

Map the actor union to ADMIN context columns or SYSTEM `run_id`; serialize only builder-produced frozen payloads. Require exactly one returned row and map it to `AdminAuditAppendResult`. The repository never begins/commits a transaction and never directly inserts/selects the table.

- [ ] **Step 5: Implement the public service and narrow exports**

```ts
export const ADMIN_AUDIT_PORT = Symbol('ADMIN_AUDIT_PORT');

@Injectable()
export class AdminAuditWriterService implements AdminAuditPort {
  constructor(private readonly repository: AdminAuditRepository) {}
  appendWithTransaction(
    tx: AdminAuditTransaction,
    input: WalletCoreAdminAuditInput | DepositAdminAuditInput,
  ): Promise<AdminAuditAppendResult> {
    const event = input.domain === 'WALLET_CORE'
      ? buildWalletCoreAdminAuditEvent(input)
      : buildDepositAdminAuditEvent(input);
    return this.repository.appendPreparedWithTransaction(tx, event);
  }
}
```

Create `AdminAuditWriterModule` with `AdminAuditRepository`, `AdminAuditWriterService`, and `{ provide: ADMIN_AUDIT_PORT, useExisting: AdminAuditWriterService }`; export only `ADMIN_AUDIT_PORT`. It has no imports, controllers, history provider, or database pool. `index.ts` exports the writer module, token, canonical port/result/actor/transaction/domain input types, action constants, and two builders. It does not export repository internals, prepared-event branding, SQL strings, or a table client.

Add a Nest metadata test that imports `AdminAuditWriterModule`, resolves `ADMIN_AUDIT_PORT`, and asserts its metadata has no controllers and no `AdminAuditDatabase`/history provider. This is the module Admin Wallet Core and Deposit may import without mounting history.

- [ ] **Step 6: Run contracts, PostgreSQL, and typecheck**

```powershell
$env:NODE_ENV='test'
$env:ADMIN_AUDIT_TEST_ALLOW_RESET='true'
$env:ADMIN_AUDIT_TEST_DATABASE_URL='postgresql://orebit_admin_audit_test_owner:local_audit_test_only@127.0.0.1:55434/orebit_admin_audit_test?schema=admin'
node --env-file=.env --import tsx --test --test-concurrency=1 src/admin-audits/admin-audit.contracts.spec.ts src/admin-audits/admin-audit.writer.spec.ts src/admin-audits/admin-audit.postgres.spec.ts
npm run typecheck
```

Expected: both actor paths, rollback, semantic replay, semantic conflict, concurrency, public exports, and typecheck PASS.

- [ ] **Step 7: Checkpoint (no commit)**

Confirm the TypeScript repository contains the function name but no `INSERT INTO admin.admin_audit_events`, and the semantic hash exists only inside the canonical migration. Do not stage or commit.

### Task 5: Implement reader-only history with exact tie and append behavior

**Files:**

- Modify: `admin-backend/src/admin-audits/admin-audit.types.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.cursor.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.database.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.history-repository.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.history.service.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.history.spec.ts`

**Interfaces:**

- Consumes: reader-role connection and immutable event rows.
- Produces: `AdminAuditHistoryQuery`, `AdminAuditHistoryItem`, `AdminAuditHistoryPage`, strict cursor codec, and `AdminAuditHistoryService.history`.

- [ ] **Step 1: Write failing cursor/tie/append tests**

Insert three owner fixtures at the identical timestamp with ids ending `003`, `002`, and `001`; fetch limit two, then continue:

```ts
it('uses id as the exact tiebreaker at an equal timestamp', async () => {
  await insertTiedFixtures('2026-09-03T12:00:00.000Z', [UUIDS.tie3, UUIDS.tie2, UUIDS.tie1]);
  const first = await repository.history({ domain: 'DEPOSIT', limit: 2 });
  assert.deepEqual(first.items.map((item) => item.id), [UUIDS.tie3, UUIDS.tie2]);
  assert.ok(first.nextCursor);
  const second = await repository.history({
    domain: 'DEPOSIT', limit: 2, cursor: first.nextCursor ?? undefined,
  });
  assert.deepEqual(second.items.map((item) => item.id), [UUIDS.tie1]);
  assert.equal(second.nextCursor, null);
});

it('continuing a cursor ignores a new head append without gaps or repeats', async () => {
  const first = await repository.history({ limit: 2 });
  await appendFunction(pool, newerEvent);
  const second = await repository.history({ limit: 100, cursor: first.nextCursor ?? undefined });
  const traversed = [...first.items, ...second.items].map((item) => item.id);
  assert.equal(new Set(traversed).size, traversed.length);
  assert.equal(traversed.includes(newerEvent.id), false);
  assert.deepEqual(traversed, originalDescendingIds);
});
```

Add malformed base64url, noncanonical JSON/base64url, invalid timestamp, invalid/non-v7 UUID, and tuple-length failures before any query. Test every filter, including ADMIN `actorId`, SYSTEM `runId`, paired subject, action, domain, inclusive `from`, and exclusive `to`.

- [ ] **Step 2: Run and verify missing-history failure**

Run the history spec with the guarded test environment. Expected: FAIL because the cursor, reader pool, and history method do not exist.

- [ ] **Step 3: Define exact history contracts and cursor**

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

Encode canonical JSON `[createdAtIso, uuidv7]` with `Buffer.toString('base64url')`. Decode only nonempty strings up to 512 characters, require an exact two-string tuple, canonical UTC ISO timestamp, UUIDv7, and byte-for-byte canonical re-encoding; otherwise throw `INVALID_ADMIN_AUDIT_CURSOR`.

- [ ] **Step 4: Add a reader-only schema-scoped pool**

`AdminAuditDatabase` validates PostgreSQL `ADMIN_AUDIT_READER_DATABASE_URL` with `schema=admin`, uses `application_name: 'orebit-admin-audit-reader'` and pool max 4, and closes on module destroy. On init it checks `to_regclass('admin.admin_audit_events')`, reader-role membership, SELECT privilege, absence of INSERT/UPDATE/DELETE/TRUNCATE, and absence of EXECUTE on `admin.append_admin_audit_event_v1`. It never accepts a writer-capable connection.

- [ ] **Step 5: Implement parameterized keyset history**

Normalize direct-service queries exactly as the later DTO does. Construct predicates only from fixed fragments and parameter indexes. Select explicit columns from `admin.admin_audit_events`, apply:

```sql
AND (created_at, id) < ($cursor_at::timestamptz, $cursor_id::uuid)
ORDER BY created_at DESC, id DESC
LIMIT $limit_plus_one
```

Fetch `limit + 1`, return at most `limit`, and encode the cursor from the last returned row only when the extra row exists. Map ADMIN and SYSTEM rows back to the actor union and return the first transport evidence unchanged.

- [ ] **Step 6: Run history, PostgreSQL, and type checks**

```powershell
$env:NODE_ENV='test'
$env:ADMIN_AUDIT_TEST_ALLOW_RESET='true'
$env:ADMIN_AUDIT_TEST_DATABASE_URL='postgresql://orebit_admin_audit_test_owner:local_audit_test_only@127.0.0.1:55434/orebit_admin_audit_test?schema=admin'
node --env-file=.env --import tsx --test --test-concurrency=1 src/admin-audits/admin-audit.postgres.spec.ts src/admin-audits/admin-audit.history.spec.ts
npm run typecheck
```

Expected: exact tie order, cursor continuation after append, all filters, malformed cursor rejection, and typecheck PASS.

- [ ] **Step 7: Checkpoint (no commit)**

Confirm history uses the reader pool and SELECT only, while writes still require a caller transaction and the SQL function. Do not stage or commit.

### Task 6: Add the unmounted GET-only SUPER_ADMIN history module

**Files:**

- Create: `admin-backend/src/admin-audits/admin-audit.dto.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.routes.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.http.spec.ts`
- Create: `admin-backend/src/admin-audits/admin-audit.history.module.ts`
- Modify: `admin-backend/src/admin-audits/index.ts`

**Interfaces:**

- Consumes: `AdminAuditHistoryService.history`, existing `parseDto`/`ok`, `requirePrincipal`, `ERR.FORBIDDEN`, `ProblemException`.
- Produces: unmounted `GET /v1/admin/audits` only.

- [ ] **Step 1: Write failing DTO, guard, route, and module tests**

Assert default limit 50, maximum 100, exact domains/actions, paired subject filters, `from < to`, UUID filters, canonical cursor, success envelope, ADMIN rejection, SUPER_ADMIN acceptance, and GET-only route metadata. Assert the unchanged `src/app.module.ts` imports neither `AdminAuditWriterModule` nor `AdminAuditHistoryModule`.

```ts
it('has one read route and no elevation/write decorator', async () => {
  assert.deepEqual(reflectRouteMethods(AdminAuditRoutes), ['GET /v1/admin/audits']);
  const guard = new AdminAuditSuperAdminGuard();
  assert.throws(() => guard.canActivate(contextFor('ADMIN')), /forbidden/i);
  assert.equal(guard.canActivate(contextFor('SUPER_ADMIN')), true);
  const route = new AdminAuditRoutes({
    history: async (query: AdminAuditHistoryQuery) => ({ items: [], nextCursor: null, query }),
  } as never);
  assert.deepEqual(await route.history({ domain: 'DEPOSIT', limit: '25' }), {
    data: { items: [], nextCursor: null, query: { domain: 'DEPOSIT', limit: 25 } },
  });
});
```

- [ ] **Step 2: Run and verify missing-HTTP failure**

```powershell
node --import tsx --test --test-concurrency=1 src/admin-audits/admin-audit.http.spec.ts
```

Expected: FAIL because DTO/route wiring does not exist.

- [ ] **Step 3: Implement the strict Zod query**

Define the exact `AdminAuditHistoryQuery` fields. Domain is the two-value enum; action is one of the union of exported action constants; UUID filters require UUIDv7; subject fields are paired; ISO timestamps are canonical and ordered; cursor calls the strict decoder; limit is coerced to integer 1..100 with default 50. Use `.strict()` so unknown query keys fail.

- [ ] **Step 4: Implement the local direct guard and GET route**

```ts
@Injectable()
export class AdminAuditSuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const principal = requirePrincipal(context.switchToHttp().getRequest<FastifyRequest>());
    if (principal.role !== 'SUPER_ADMIN') {
      throw new ProblemException({ type: ERR.FORBIDDEN });
    }
    return true;
  }
}

@Controller('v1/admin/audits')
export class AdminAuditRoutes {
  constructor(private readonly service: AdminAuditHistoryService) {}
  @Get()
  @UseGuards(AdminAuditSuperAdminGuard)
  async history(@Query() query: unknown): Promise<SuccessEnvelope<AdminAuditHistoryPage>> {
    return ok(await this.service.history(parseDto(adminAuditHistoryQuerySchema, query)));
  }
}
```

Do not add an HTTP writer, `ElevationGuard`, permission store, or role-management endpoint.

- [ ] **Step 5: Complete only the isolated module**

Register `AdminAuditDatabase`, `AdminAuditHistoryRepository`, `AdminAuditHistoryService`, route, and guard inside `AdminAuditHistoryModule`; export nothing from the Nest module. Re-export the module class from `index.ts` for later root mounting, but do not import `AdminAuditWriterModule` because history has no write dependency. Leave root composition and OpenAPI unchanged.

- [ ] **Step 6: Run HTTP and type checks**

```powershell
node --import tsx --test --test-concurrency=1 src/admin-audits/admin-audit.http.spec.ts
npm run typecheck
```

Expected: DTO, route, guard, module, and typecheck PASS.

- [ ] **Step 7: Checkpoint (no commit)**

Confirm `AdminAuditHistoryModule` exposes one GET route only and remains absent from `src/app.module.ts` and `src/openapi.ts`; independently confirm `AdminAuditWriterModule` has no controller/read pool. Do not stage or commit.

### Task 7: Run the complete boundary and regression proof

**Files:**

- Verify only; create no file.

**Interfaces:**

- Consumes: Tasks 1-6.
- Produces: exact test/privilege/boundary evidence with no commit.

- [ ] **Step 1: Run every isolated suite against the guarded local database**

Run from `admin-backend`. Only `ADMIN_AUDIT_TEST_DATABASE_URL` is connected. The two
runtime URLs are non-listening loopback sentinels used only by the reset guard to prove
separation; no test may connect to or mutate a non-test database.

```powershell
$env:NODE_ENV='test'
$env:ADMIN_AUDIT_TEST_ALLOW_RESET='true'
$env:ADMIN_AUDIT_TEST_DATABASE_URL='postgresql://orebit_admin_audit_test_owner:local_audit_test_only@127.0.0.1:55434/orebit_admin_audit_test?schema=admin'
$env:DATABASE_URL='postgresql://unused:unused@127.0.0.1:1/orebit_admin_runtime_test_sentinel?schema=admin'
$env:DATABASE_DIRECT_URL='postgresql://unused:unused@127.0.0.1:2/orebit_admin_direct_test_sentinel?schema=admin'

$requiredEnvironment = @{
  NODE_ENV = 'test'
  ADMIN_AUDIT_TEST_ALLOW_RESET = 'true'
  ADMIN_AUDIT_TEST_DATABASE_URL = 'postgresql://orebit_admin_audit_test_owner:local_audit_test_only@127.0.0.1:55434/orebit_admin_audit_test?schema=admin'
  DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/orebit_admin_runtime_test_sentinel?schema=admin'
  DATABASE_DIRECT_URL = 'postgresql://unused:unused@127.0.0.1:2/orebit_admin_direct_test_sentinel?schema=admin'
}
foreach ($entry in $requiredEnvironment.GetEnumerator()) {
  if ([Environment]::GetEnvironmentVariable($entry.Key) -ne $entry.Value) {
    throw "Unsafe Admin audit test environment: $($entry.Key)"
  }
}

docker compose -f src/admin-audits/docker-compose.test.yml up -d --wait
$suites = @(
  'src/admin-audits/admin-audit.contracts.spec.ts'
  'src/admin-audits/admin-audit.validation-parity.spec.ts'
  'src/admin-audits/admin-audit.sql-contract.spec.ts'
  'src/admin-audits/admin-audit.writer.spec.ts'
  'src/admin-audits/admin-audit.postgres.spec.ts'
  'src/admin-audits/admin-audit.history.spec.ts'
  'src/admin-audits/admin-audit.http.spec.ts'
)
node --import tsx --test --test-concurrency=1 @suites
if ($LASTEXITCODE -ne 0) { throw 'Admin audit suite failed' }
```

Expected: all seven suites run serially and PASS; no database test is skipped. The reset
guard prints the exact dedicated container/database/cluster/server identity before any
destructive SQL.

- [ ] **Step 2: Run no-write repository checks**

```powershell
$auditSources = @(Get-ChildItem src/admin-audits -File -Filter '*.ts' |
  Select-Object -ExpandProperty FullName)
$scopedTypecheck = @(npx --no-install tsc --noEmit --pretty false --strict `
  --noUncheckedIndexedAccess --noImplicitOverride --noFallthroughCasesInSwitch `
  --target ES2022 --lib ES2022 --module node16 --moduleResolution node16 `
  --experimentalDecorators --emitDecoratorMetadata --esModuleInterop `
  --resolveJsonModule --skipLibCheck --forceConsistentCasingInFileNames `
  --types node @auditSources 2>&1)
$scopedDiagnostics = @($scopedTypecheck |
  Where-Object { $_ -match 'src[\\/]admin-audits[\\/]' })
if ($scopedDiagnostics.Count -ne 0) {
  $scopedDiagnostics | Write-Output
  throw 'Scoped Admin audit TypeScript check failed'
}
npx --no-install eslint src/admin-audits --ext .ts --no-fix
if ($LASTEXITCODE -ne 0) { throw 'Scoped Admin audit ESLint check failed' }

$rootTypecheck = @(npm run typecheck 2>&1)
$rootTypecheckExit = $LASTEXITCODE
$rootTypecheck | Write-Output
if ($rootTypecheckExit -ne 0) {
  if ($rootTypecheck -match 'src[\\/]admin-audits[\\/]') {
    throw 'Root typecheck reported an Admin audit diagnostic'
  }
  Write-Warning 'Root typecheck has unrelated pre-existing diagnostics; record them separately.'
}
```

Expected: the scoped Admin audit no-emit TypeScript check and targeted ESLint PASS without
changing files. Run the root typecheck only as a separate diagnostic: record its nonzero exit
and existing Prisma/Auth/2FA, nested Fastify, or unrelated test diagnostics, but do not claim
that the repository-wide check passed or misreport it as an Admin audit failure.

- [ ] **Step 3: Prove sole ownership and no composition edits**

```powershell
$workspace = (Resolve-Path '..').Path
$canonical = (Resolve-Path 'src/admin-audits/migrations/202609030001_global_admin_audit_events/migration.sql').Path
$definitions = @(rg -l "CREATE TABLE admin\.admin_audit_events|CREATE FUNCTION admin\.append_admin_audit_event_v1" `
  "$workspace/admin-backend" "$workspace/orebit-backend" --glob '*.sql' |
  ForEach-Object { (Resolve-Path $_).Path } | Sort-Object -Unique)
if ($definitions.Count -ne 1 -or $definitions[0] -ne $canonical) {
  throw "Admin audit has a noncanonical SQL definition: $($definitions -join ', ')"
}
# The seven-suite run includes admin-audit.sql-contract.spec.ts, which fail-closes every
# production table/function/role reference while allowing the membership file and readers.
git status --short -- src/admin-audits src/app.module.ts src/openapi.ts db/schema.prisma db/migrate.ts src/wallet
git diff -- src/app.module.ts src/openapi.ts db/schema.prisma db/migrate.ts src/wallet
```

Expected: the definition-only scan and SQL-contract suite prove the production definitions
resolve only to `src/admin-audits/migrations/202609030001_global_admin_audit_events/migration.sql`
while accepting legitimate references in `production-role-memberships.sql`; task changes occur
only under `src/admin-audits`; the final diff command contains no task-created change.

- [ ] **Step 4: Prove public interfaces and absence of incomplete work**

```powershell
$requiredProductionFiles = @(
  'admin-audit.dto.ts', 'admin-audit.routes.ts', 'admin-audit.history.module.ts',
  'admin-audit.writer.module.ts', 'admin-audit.writer.service.ts',
  'admin-audit.repository.ts', 'admin-audit.types.ts', 'admin-audit.payloads.ts', 'index.ts'
) | ForEach-Object { Join-Path 'src/admin-audits' $_ }
$missingProductionFiles = @($requiredProductionFiles |
  Where-Object { -not (Test-Path -LiteralPath $_) })
if ($missingProductionFiles.Count -ne 0) {
  throw "Missing Admin audit production files: $($missingProductionFiles -join ', ')"
}

$requiredPublicNames = @(
  'AdminAuditWriterModule', 'AdminAuditHistoryModule', 'ADMIN_AUDIT_PORT',
  'AdminAuditPort', 'WalletCoreAdminAuditInput', 'DepositAdminAuditInput',
  'AdminAuditAppendResult', 'AdminAuditActor',
  'buildWalletCoreAdminAuditEvent', 'buildDepositAdminAuditEvent'
)
$indexText = Get-Content -Raw src/admin-audits/index.ts
$missingPublicNames = @($requiredPublicNames |
  Where-Object { $indexText -notmatch "\b$([regex]::Escape($_))\b" })
if ($missingPublicNames.Count -ne 0) {
  throw "Missing Admin audit public exports: $($missingPublicNames -join ', ')"
}

$productionTypeScript = @(Get-ChildItem src/admin-audits -File -Filter '*.ts' |
  Where-Object Name -NotMatch '\.spec\.ts$' | Select-Object -ExpandProperty FullName)
$incompleteOrWriteRoutes = @(Select-String -Path $productionTypeScript `
  -Pattern 'TBD|TODO|@Post|@Patch|@Put|@Delete')
if ($incompleteOrWriteRoutes.Count -ne 0) {
  $incompleteOrWriteRoutes | Write-Output
  throw 'Admin audit production boundary contains incomplete work or a write route'
}
```

Expected: every required production file and public type/value name is present; the writer spec's
exact runtime-barrel assertion and the history metadata tests in the seven-suite run PASS; and production TypeScript
has no incomplete marker or write-route decorator. Do not require `WalletCoreAdminAuditClient`
here: that orebit-side adapter is created later by the Wallet Core plan and is not an Admin audit
Task 7 input.

- [ ] **Step 5: Final checkpoint (no commit)**

Report test counts, test database/server identity, role-matrix results, exact migration/function names, and scoped file list. Do not stage, commit, push, checkout, merge, reset, or clean.
