# Admin Price Conversion Implementation Plan

Goal: Build an isolated admin API over the shared price_conversion schema with the fewest
frontend-friendly endpoints.

Spec: DESIGN.md

Global constraints: edit only this folder; no commits; strict TDD; no provider HTTP; mutating API
requires existing elevation guard semantics; routes remain unmounted under strict isolation. Do not
copy schema/migrations until the user worker freezes the canonical 00000--00013 hashes. The only
destructive database target is `orebit_price_test.price_conversion_test` after the database gate.

## Task 1: Non-DB modular refactor and focused RED tests

1. Split the 684-line database operation into bootstrap repository, configuration writer, history
   repository, and pure provider/configuration policy while retaining a small store facade.
2. Split the oversized specification into DTO/service, Nest/security, PostgreSQL behaviour, and
   cross-worker suites; add a line-limit check excluding generated/package locks/migrations/.test-dist.
3. Add and observe failing unit tests for the pure policy and updated canonical view contract before
   implementing each non-DB change.
4. Add concise JSDoc explaining exported security, cursor, audit, transaction, history, provider,
   module, filter, service, controller, and database responsibilities.

## Task 2: Canonical 00007--00013 contract alignment

1. Update types and existing history contracts for crypto-only sensitive divergence and read-only
   per-currency view selection. Preserve the exact `AVAILABLE` / `UNAVAILABLE` statuses and five
   frozen view reasons without adding an endpoint, plus `DEGRADED` provider disable state.
2. Prove that fiat divergence controls and every request-scoped provider/view override are rejected
   or absent from the public DTO contract.
3. Preserve optimistic revision, audit context, draft/PUSH/SCHEDULE handling, 409 actual revision,
   cursor history ordering, and transactional rollback.

## Task 3: Freeze-gated schema mirror and PostgreSQL verification

1. Mirror final frozen `schema.prisma` (`eebf24d4...7e68`) and every migration `00000--00013`
   byte-for-byte after observing checksum RED. Canonical 00012 binds resolutions to the live
   revision and adds durable view-fetch buckets. The final append is
   `20260901000013_reference_mutation_guard/migration.sql` (`cb7c1bb3...cefd`), which preserves
   the active-CRYPTO reference invariant across reference updates and deletes.
2. Run Prisma validation/generation and the authorised disposable database suite only against
   `orebit_price_test.price_conversion_test` with reset opt-in.
3. Verify all four focused suites, parent Node 16/CommonJS compatibility, migration equality,
   strict scope, and the line-limit test. Leave endpoints unmounted and all work uncommitted.

## Task 4: Final admin read/write trust boundaries

1. Read bootstrap state on one checked-out repeatable-read, read-only PostgreSQL transaction and
   prove rollback/release plus coherence during a concurrent PUSH.
2. Parse stored draft JSON with the canonical PATCH catalogue/provider constraints before apply;
   map PostgreSQL `23503`, `23505`, and `23514` to the stable local 400 problem.
3. Execute the 500-line authored code/test (`.ts` / `.cts` / `.mjs`) limit in the default suite and
   run Prisma validate/status after the isolated reset guard.
4. Verify the frozen scheduled omitted-field policy, strict lifecycle bypass rejection, atomic
   canonical mirror, and final PostgreSQL collision/malformed-draft cases through migration 00010.
