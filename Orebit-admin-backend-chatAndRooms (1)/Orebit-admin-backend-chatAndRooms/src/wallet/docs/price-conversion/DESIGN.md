# OREBiT Price Conversion Design

## Boundary

This folder is a self-contained, unmounted wallet subsystem. Strict isolation means no root
module, router, package, environment, or database file is changed. Both repositories share one
PostgreSQL schema named price_conversion and keep byte-identical Prisma/migration copies. No
commits are made.

## Provider roles and schedules

The fixed providers are COINGECKO, ALCHEMY, and COINMARKETCAP. Admin assigns exactly one enabled
PRIMARY provider. COMPARISON and FALLBACK may be unassigned when their providers are disabled;
that state is exposed as `DEGRADED` and valuation-dependent money blocking is enforced by the user
worker. Role assignment is atomic and versioned.

- Provider cadence is the saved `refreshIntervalSeconds` (1..2,147,483,647). Effective PRIMARY and
  COMPARISON cadence must match; the third provider remains independent. Historical/default examples
  use 60/60/300 seconds, but deployment scheduling must honor the saved values rather than promise
  those examples for every configuration.
- CoinGecko sends every configured CoinGecko ID in one simple-price request.
- Alchemy splits by-symbol requests into batches of at most 25 symbols.
- CoinMarketCap sends one batched quotes request for the Wallet-owned active reference set.
- Request and transaction paths never call providers.
- A dedicated worker invokes refreshDue(now). PostgreSQL advisory locks plus a unique
  provider/scheduled_for run prevent duplicate work across replicas.

Each request is server-side with a fixed official hostname, timeout, response-size cap, and API
key from the local ignored .env. Tests mock HTTP; live keys are not required for deterministic
tests.

## Resolution

For every currency:

1. If configured PRIMARY and COMPARISON have fresh successful snapshots and their exact difference
   is within divergence_threshold_bps, PRIMARY is effective.
2. If PRIMARY fails, is stale, or differs above the threshold, the latest fresh FALLBACK snapshot
   becomes temporary effective PRIMARY.
3. User responses and downstream features receive only the effective price.
4. The effective provider, price, snapshot ID, observation time, configured roles, difference
   inputs, and selection reason are persisted.
5. Normal providers continue refreshing. One healthy primary/comparison cycle restores configured
   PRIMARY.
6. When no fresh effective snapshot exists, retain the last price for stale display only and reject
   valuation-dependent money operations with PRICE_UNAVAILABLE.

Difference decisions use exact scaled integers and cross multiplication; provider prices are never
converted through JavaScript Number. Prices with more than 18 fractional digits are rejected, not
rounded.

## Shared data

PostgreSQL schema price_conversion contains (the user worker's canonical 00000--00013
schema and migrations are copied byte-for-byte only after their hashes are frozen):

- price_providers: fixed provider code, enabled flag, sensitive role, revision. A disabled
  provider makes the bootstrap status `DEGRADED`; it is never silently substituted by a
  request-scoped override.
- price_settings: singleton revision, divergence threshold and operational health. Provider rows own
  configurable refresh intervals; schedules are not fixed to 60/300 seconds.
- currencies: Wallet Core owns identity, policy, Binance reference, pricing_status, and provider
  references. Price Conversion reads those rows and may update only its auto_disabled health facet.
- currency_provider_refs: Wallet-owned external identifiers read by provider refresh; Price
  Conversion never inserts, updates, deactivates, or deletes them.
- price_snapshots: append-only successful provider observation, exact numeric(38,18), response hash.
- price_resolutions: append-only effective selection and failover/recovery audit.
- price_view_resolutions: append-only per-currency view selection with `AVAILABLE` / `UNAVAILABLE`
  status and the frozen reasons `CONFIGURED_PROVIDER`, `SENSITIVE_FALLBACK_PROVIDER`,
  `ALCHEMY_FALLBACK_SECONDARY`, `VIEW_FAILURE_SECONDARY`, and `SECONDARY_UNAVAILABLE`.
- price_fetch_runs: provider period, status, counts, latency, safe error code, worker instance.

Secrets and full provider payloads are not stored. Foreign keys/list indexes, soft status, unique
provider-period idempotency, and cursor indexes are database-enforced.

## APIs

All routes are defined but intentionally unmounted. The current field-level contract and examples
live in the cross-repository
[Wallet and Price Conversion frontend API handoff](../../../../../orebit-backend/src/wallet/docs/FRONTEND_API_HANDOFF.md)
and its linked Pricing OpenAPI/Postman artifacts.

The decorated `PriceConversionRoutes` class owns transport parsing, request audit context and the
success envelope, then calls `PriceConversionService` directly. All Admin operations require a
bound Bearer and current `SUPER_ADMIN`.

Current Admin surface:

- `GET /v1/admin/wallet/price-conversion` returns settings, role assignments, provider
  health/usage, configuration lifecycle, all-45 `fiatOptions[{code,visible}]`,
  `roleConfigurationStatus` and operational Pricing `securityState`. It accepts independent
  `scheduledCursor` and `scheduledLimit` (1..100, default 50). Latest effective prices are not in
  bootstrap.
- `GET /v1/admin/wallet/price-conversion/prices` pages latest effective prices with
  currency/provider/status filters and allowlisted sort. Latest selection happens before filters,
  so an older matching row is never resurrected.
- `PATCH /v1/admin/wallet/price-conversion` is the elevated optimistic-revision action for
  `SAVE_DRAFT`, `PUSH` or `SCHEDULE`. Its single-use `x-elevation-ticket` is minted for
  `wallet.price-conversion.configure`. Current provider entries require
  `enabled`, nullable `role`, `viewEnabled` and `refreshIntervalSeconds`; the request also supports
  `visibleFiatCodes` and divergence threshold. Currency, Wallet-policy, catalogue and Binance
  fields are rejected. `PUSH` with `draftId` consumes that draft and cannot include replacement
  settings. An explicit PUSH preserves an unrelated active draft.
- `GET /v1/admin/wallet/price-conversion/history` pages resolution, view-resolution, fetch-run,
  configuration-change and audit variants. Its opaque cursor is bound to every filter and timestamp
  direction; clients never decode or reuse it with another query.

Current stored configuration includes
`settings.{divergenceThresholdBps,visibleFiatCodes}` and providers keyed by code with
`enabled`, nullable `sensitiveRole`, `viewEnabled` and `refreshIntervalSeconds`. The canonical
revision-zero LIVE seed is immutable and contains providers only. A later pre-WP11 draft can also
contain `settings.divergenceThresholdBps`; both legacy forms omit `visibleFiatCodes` and provider
cadence. They are read-only history. When a valid old draft is consumed, the backend fills omitted
new fields from authoritative current rows and writes a new complete snapshot. Current PATCH
validation is not widened to accept either raw legacy object.

The Admin `settings.revision` is the governance token. Drafts/schedules advance that token; the
live price revision changes only on PUSH or scheduled application. A live change marks operational
pricing `securityState` DEGRADED until refreshed evidence restores it.

User surface:

- `GET /v1/wallet/price-conversion?currencyIds=...` returns a complete saved SENSITIVE or VIEW
  batch with provider/snapshot/observation evidence and never calls a live provider. `fiatCode` is
  case-insensitive and must normalize to one of the supported 45 codes.

Backend features import PriceConversionService directly and call getEffectivePrices(currencyIds).
The method performs one PostgreSQL query and no external HTTP.

## Environment

Each folder contains ignored .env plus .env.example with:

- PRICE_DATABASE_URL
- PRICE_DATABASE_DIRECT_URL
- COINGECKO_API_KEY
- COINGECKO_API_TIER
- ALCHEMY_PRICE_API_KEY
- COINMARKETCAP_API_KEY
- PRICE_WORKER_INSTANCE_ID

No real key is committed or logged.

Legacy usage-warning and hard-stop notification enum values remain only so historical rows stay
readable. No cap setting, warning emitter, or hard-stop control exists in the admin contract.

The admin module owns one validated `pg.Pool`; Nest opens it during module initialisation and closes
it during application shutdown. `PRICE_DATABASE_URL` must be PostgreSQL and name the
`price_conversion` schema.

Expected price configuration conflicts and final-state validation failures are handled by the
module-scoped RFC 9457 filter, including `actualRevision` on 409 responses; no central error
catalogue change is required before mounting.

## Future composition-root work

Strict isolation intentionally leaves one integration step for the composition-root owner:

1. Import `PriceConversionModule` from `AppModule` only when the routes are approved for exposure.

Before that step, apply the reviewed Pricing/Audit migrations and restricted-role grants and supply
`PRICE_DATABASE_URL`. Provider API keys and worker identity belong to the User Pricing worker
environment, not this Admin module. After mounting, verify all four current Admin Pricing
operations through the real composition root: global Bearer authentication, current
`SUPER_ADMIN`, action-bound elevation for PATCH, existing CSRF behavior, pool shutdown, and
fail-closed database-role access. Test-only composition does not satisfy this production gate.

## Test database safety

Database tests accept only `PRICE_TEST_DATABASE_URL` for the explicitly authorized
`orebit_price_test` database and `price_conversion_test` schema. They also require
`PRICE_TEST_ALLOW_RESET=true`. The provisioner drops/rebuilds only `price_conversion_test` from
schema-rewritten mirrored migrations, records its isolated migration history, and never reads or
touches the shared `price_conversion` schema or a runtime `PRICE_DATABASE_URL` /
`PRICE_DATABASE_DIRECT_URL` for cleanup.

## Ledger

The ledger stays in src/ledger. Add postWithTransaction(tx,input); existing post(input) remains a
standalone wrapper. An outer transaction rollback must roll back the journal and postings.

Ledger USD valuation sources become COINGECKO, ALCHEMY, COINMARKETCAP. Binance remains an exchange
quote provider recorded in journal metadata, not the transaction-time USD valuation source. Ledger
records the exact effective price snapshot selected by this service. Ledger batch reads use the
frozen `resolve_money_batch_for_ledger(UUID[])` database function; it is stable, security-definer
scoped to the price schema, and not executable by `PUBLIC`. Canonical 00008 makes it fail closed at
statement time unless the resolution is fresh for the selected provider, the currency is active
and not auto-disabled, the provider is enabled, and price security is healthy. Canonical 00009
uses the matched snapshot observation as the authoritative clock and rejects observations more
than 60 seconds in the future. Canonical 00012 also binds each resolution to the exact settings
revision and current provider-role identities, so neither an immediate push nor a scheduled apply
can reuse a resolution produced under an older configuration.

## QA and security

Tests cover provider batching/schedules, exact decimals, role permutations, optimistic updates,
failover/recovery, all-provider failure, stale blocking, no HTTP on reads, worker idempotency,
cursor pagination, secret redaction, fixed-host SSRF prevention, payload limits, timeouts, and
mirrored migration equality. Canonical 00007 coverage also verifies the per-currency view enum
labels, append-only table guards, and revoked-public ledger batch function. Canonical 00008
coverage verifies wall-clock valuation freshness and immutable, legal-only lifecycle transitions
for configuration changes, fetch runs, and admin notifications. Canonical 00009 additionally
verifies the upper future-timestamp bound on money valuation snapshots. Canonical 00010 couples
fetch retries and notification claims to complete attempt, ownership, timing, error, and terminal
fields so status-only lifecycle bypasses are database-rejected. Canonical 00011 enforces at the
database boundary that sensitive snapshots and resolutions reference CRYPTO currencies only; the
security-definer trigger function is not executable by `PUBLIC`. Canonical 00013 also prevents an
update or delete from removing the last active provider reference of an ACTIVE CRYPTO currency.

Ledger QA/security is rerun independently. Actual correctness/security defects are fixed inside the
ledger folder. Optional improvements are documented separately and are not implemented.


## Implementation boundaries

The database layer is deliberately split into a small facade plus four focused collaborators:
bootstrap reads, configuration writes, append-only history reads, and pure provider/configuration
policy. Policy performs no I/O and is unit-tested independently. Configuration writes own the one
transaction that validates state, records before/after audit context, and advances revision. History
methods are read-only and preserve the validated opaque cursor ordering. This separation is a
security boundary: request handlers never build ad-hoc SQL or bypass elevation/audit logic.

Bootstrap reads and configuration writes share one module-local transaction helper. It preserves
the original BEGIN/body/COMMIT failure even if rollback or release also fails, discards a client
after failed rollback, and supports only the existing default write BEGIN and repeatable-read,
read-only bootstrap BEGIN modes. Revision-conflict and constraint mapping remain outside cleanup,
so the existing results and validation contract are unchanged.

Bootstrap checks out one PostgreSQL client and reads settings, providers, saved prices,
configuration lifecycle, and display fiats inside one `REPEATABLE READ READ ONLY` transaction, so
the response cannot mix revisions during a concurrent PUSH. Stored drafts cross the same strict
settings/providers boundary as an incoming PATCH before they can be applied. Expected PostgreSQL
configuration violations are translated to the module's stable RFC 9457 400 response without
exposing database detail.

Historical Price migrations 00000-00013 remain byte-for-byte unchanged. Wallet Core's expand
migration renames the canonical column from `status` to `pricing_status` and refreshes the two
provider-reference guard functions; standalone Price tests apply the same test-only compatibility
overlay after 00013.

The test suite mirrors those boundaries: DTO/service tests, Nest security/route tests,
PostgreSQL behaviour tests, and a cross-worker contract suite. Each authored code or test file is
kept at 500 lines or fewer; Prisma, SQL, generated output, package locks, migrations, and
`.test-dist` are excluded from that code limit. The gate covers `.ts`, `.cts`, and `.mjs`. The
guarded default database suite provisions only the isolated reset target,
then runs Prisma validation/migration status before tests so dependency overrides are exercised.

Task 8 is complete. Its legacy migration removes an empty `currencyUpserts` key from DRAFT and
SCHEDULED rows while preserving row/status; nonempty/non-array values are rejected without changing
configuration, identity, or history. LIVE, ARCHIVED, and REJECTED rows are untouched. It emits no
audit and only temporarily disables then restores its intended trigger. Admin bootstrap accepts a
strict empty query; its former catalogue cursor/query surface and unused Admin catalogue policy are
deleted, while the history cursor remains.

Verification is Wallet Core 215/215; user Price default 76/76 plus local API 4/4; Admin Price main
76/76 plus scheduled integration 1/1 and local API 7/7; audits 0. Tests seed Wallet-owned fixtures
directly and use rollback-only temporary roles. No root module/route was mounted and no commit was
created. Physical production runtime roles and grants remain Wallet Task 15. Super Admin can pin a
`CHAIN` or individual `CURRENCY_CHAIN`; whole `CURRENCY` pins are rejected. A binding pin prevents
automatic recovery until unpinned, never locks or moves balances, and has implemented
Audit/actions/history.
