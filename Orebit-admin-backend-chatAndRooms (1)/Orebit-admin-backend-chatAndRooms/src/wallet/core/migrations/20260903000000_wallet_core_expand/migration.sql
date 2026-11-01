BEGIN;

CREATE SCHEMA wallet_core;

CREATE TYPE wallet_core."WalletAvailability" AS ENUM ('USER', 'MERCHANT', 'BOTH');
CREATE TYPE wallet_core."WalletDesiredState" AS ENUM ('OFF', 'ON', 'MAINTAIN');
CREATE TYPE wallet_core."WalletProviderState" AS ENUM ('ACTIVATED', 'DISABLED', 'MAINTENANCE', 'UNAVAILABLE');
CREATE TYPE wallet_core."WalletAccessLevel" AS ENUM ('ALL', 'KYC_L1', 'KYC_L2');
CREATE TYPE wallet_core."WalletListingKind" AS ENUM ('PERMANENT', 'TIME_LIMITED');
CREATE TYPE wallet_core."WalletPriceReadiness" AS ENUM ('HEALTHY', 'UNAVAILABLE');
CREATE TYPE wallet_core."WalletCatalogueMode" AS ENUM ('ALL', 'RELEVANT');
CREATE TYPE wallet_core."WalletConfigurationStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'LIVE', 'ARCHIVED', 'REJECTED');
CREATE TYPE wallet_core."WalletAddressKind" AS ENUM ('HOT', 'COLD', 'STAKING');
CREATE TYPE wallet_core."WalletReconciliationRunStatus" AS ENUM ('SUCCESS', 'PARTIAL', 'FAILED');
CREATE TYPE wallet_core."WalletReconciliationItemStatus" AS ENUM ('COMPLETE', 'PARTIAL');
CREATE TYPE wallet_core."WalletReconciliationComponentKind" AS ENUM ('HOT', 'COLD', 'STAKING', 'BINANCE');
CREATE TYPE wallet_core."WalletAttemptStage" AS ENUM ('ENCRYPT', 'BALANCE');
CREATE TYPE wallet_core."WalletAttemptOutcome" AS ENUM ('SUCCESS', 'FAILED');
CREATE TYPE wallet_core."WalletReconciliationSafeErrorCode" AS ENUM (
  'ENCRYPTION_FAILED', 'AUTHENTICATION_FAILED', 'UNAUTHORIZED_IP',
  'PROVIDER_MAINTENANCE', 'PROVIDER_DISABLED', 'PROVIDER_NOT_FOUND', 'PROVIDER_REJECTED',
  'TIMEOUT', 'TRANSPORT_ERROR', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE', 'INVALID_DECIMAL',
  'PRICE_UNAVAILABLE'
);
CREATE TYPE wallet_core."WalletStakeSelectedSource" AS ENUM ('REPORTED_TOTAL', 'COMPONENT_SUM');
CREATE TYPE wallet_core."WalletCatalogueRefreshErrorCode" AS ENUM (
  'PROVIDER_REJECTED', 'TIMEOUT', 'TRANSPORT_ERROR', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE',
  'CATALOGUE_LIMIT_EXCEEDED', 'PAGINATION_INCONSISTENT', 'DUPLICATE_PROVIDER_ID',
  'WRONG_CHAIN_ASSOCIATION', 'DATABASE_ERROR', 'AUDIT_ERROR'
);
CREATE TYPE wallet_core."WalletAlertCategory" AS ENUM (
  'SHORTFALL', 'PARTIAL_DATA', 'STAKING_TOTAL_MISMATCH', 'CATALOGUE_REFRESH_FAILED',
  'PROVIDER_MAINTENANCE'
);
CREATE TYPE wallet_core."WalletAlertStatus" AS ENUM ('ACTIVE', 'CLEARED');
CREATE TYPE wallet_core."WalletOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD');
CREATE TYPE wallet_core."WalletCronStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED');
CREATE TYPE wallet_core."WalletCronSafeReasonCode" AS ENUM (
  'CONFIGURATION_REJECTED', 'PROVIDER_OBSERVATION_PARTIAL', 'PROVIDER_OBSERVATION_FAILED',
  'DEPENDENCY_UNAVAILABLE', 'MISSED_SCHEDULE', 'CATCHUP_TRUNCATED', 'UNEXPECTED_ERROR'
);
CREATE TYPE wallet_core."WalletDelistingStatus" AS ENUM ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

CREATE TABLE wallet_core.chains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_chain_id BIGINT NOT NULL UNIQUE CHECK (provider_chain_id > 0),
  short_name VARCHAR(32) NOT NULL UNIQUE
    CHECK (short_name = upper(btrim(short_name)) AND short_name <> ''),
  name VARCHAR(128) NOT NULL CHECK (name = btrim(name) AND name <> ''),
  is_evm BOOLEAN NOT NULL,
  logo_object_key VARCHAR(255),
  available_for wallet_core."WalletAvailability" NOT NULL DEFAULT 'BOTH',
  desired_state wallet_core."WalletDesiredState" NOT NULL DEFAULT 'OFF',
  maintenance_pinned BOOLEAN NOT NULL DEFAULT false,
  provider_state wallet_core."WalletProviderState" NOT NULL DEFAULT 'UNAVAILABLE',
  consecutive_failed_checks INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failed_checks BETWEEN 0 AND 3),
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  provider_updated_at TIMESTAMPTZ,
  policy_revision BIGINT NOT NULL DEFAULT 0 CHECK (policy_revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (logo_object_key IS NULL OR (logo_object_key = btrim(logo_object_key) AND logo_object_key <> ''))
);
CREATE INDEX chains_provider_state_idx ON wallet_core.chains (provider_state, id);

CREATE TABLE wallet_core.currency_settings (
  currency_id UUID PRIMARY KEY REFERENCES price_conversion.currencies(id),
  binance_reference VARCHAR(64),
  logo_object_key VARCHAR(255),
  view_currency_enabled BOOLEAN NOT NULL DEFAULT false,
  geo_global BOOLEAN NOT NULL DEFAULT true,
  geo_countries TEXT[] NOT NULL DEFAULT '{}',
  geo_continents TEXT[] NOT NULL DEFAULT '{}',
  access_level wallet_core."WalletAccessLevel" NOT NULL DEFAULT 'ALL',
  available_for wallet_core."WalletAvailability" NOT NULL DEFAULT 'BOTH',
  listing_kind wallet_core."WalletListingKind" NOT NULL DEFAULT 'PERMANENT',
  listing_start_at TIMESTAMPTZ,
  delist_at TIMESTAMPTZ,
  show_before_listing BOOLEAN NOT NULL DEFAULT false,
  premium_early_access_at TIMESTAMPTZ,
  premium_early_access_ops TEXT[] NOT NULL DEFAULT '{}',
  so_early_access_at TIMESTAMPTZ,
  so_early_access_ops TEXT[] NOT NULL DEFAULT '{}',
  desired_state wallet_core."WalletDesiredState" NOT NULL DEFAULT 'OFF',
  maintain_users BOOLEAN NOT NULL DEFAULT false,
  maintain_so BOOLEAN NOT NULL DEFAULT false,
  show_balance_users BOOLEAN NOT NULL DEFAULT true,
  show_balance_so BOOLEAN NOT NULL DEFAULT true,
  post_delist_ops TEXT[] NOT NULL DEFAULT '{}',
  after_delist_mode VARCHAR(32)
    CHECK (after_delist_mode IS NULL OR after_delist_mode IN ('AUTO_EXCHANGE', 'LEAVE')),
  auto_exchange_to_currency_id UUID REFERENCES price_conversion.currencies(id),
  auto_exchange_fee_bps INTEGER CHECK (auto_exchange_fee_bps BETWEEN 0 AND 10000),
  leave_days INTEGER CHECK (leave_days >= 0),
  after_leave_action VARCHAR(32)
    CHECK (after_leave_action IS NULL OR after_leave_action IN ('LOSS', 'AUTO_EXCHANGE')),
  after_leave_to_currency_id UUID REFERENCES price_conversion.currencies(id),
  after_leave_fee_bps INTEGER CHECK (after_leave_fee_bps BETWEEN 0 AND 10000),
  legacy_access_policy JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(legacy_access_policy) = 'object'),
  legacy_delist_policy JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(legacy_delist_policy) = 'object'),
  price_readiness wallet_core."WalletPriceReadiness" NOT NULL DEFAULT 'UNAVAILABLE',
  price_readiness_changed_at TIMESTAMPTZ,
  policy_revision BIGINT NOT NULL DEFAULT 0 CHECK (policy_revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (binance_reference IS NULL OR (binance_reference = btrim(binance_reference) AND binance_reference <> '')),
  CHECK (logo_object_key IS NULL OR (logo_object_key = btrim(logo_object_key) AND logo_object_key <> '')),
  CHECK (premium_early_access_ops <@ ARRAY['DEPOSIT','WITHDRAW','EXCHANGE','USER_TRANSFER','SEND_API','STAKE','BANKROLL']::text[]),
  CHECK (so_early_access_ops <@ ARRAY['DEPOSIT','WITHDRAW','EXCHANGE','USER_TRANSFER','SEND_API','STAKE','BANKROLL']::text[]),
  CHECK (post_delist_ops <@ ARRAY['WITHDRAW','EXCHANGE']::text[]),
  CHECK (listing_kind = 'PERMANENT' OR delist_at IS NOT NULL),
  CHECK (delist_at IS NULL OR listing_start_at IS NULL OR listing_start_at < delist_at),
  CHECK ((after_delist_mode = 'AUTO_EXCHANGE' AND auto_exchange_to_currency_id IS NOT NULL)
    OR (after_delist_mode IS DISTINCT FROM 'AUTO_EXCHANGE' AND auto_exchange_to_currency_id IS NULL)),
  CHECK ((after_leave_action = 'AUTO_EXCHANGE' AND after_leave_to_currency_id IS NOT NULL)
    OR (after_leave_action IS DISTINCT FROM 'AUTO_EXCHANGE' AND after_leave_to_currency_id IS NULL)),
  CHECK (auto_exchange_to_currency_id IS NOT NULL OR auto_exchange_fee_bps IS NULL),
  CHECK (after_leave_to_currency_id IS NOT NULL OR after_leave_fee_bps IS NULL)
);
CREATE INDEX currency_settings_state_idx
  ON wallet_core.currency_settings (desired_state, price_readiness, currency_id);
CREATE INDEX currency_settings_listing_due_idx
  ON wallet_core.currency_settings (listing_start_at, currency_id)
  WHERE listing_start_at IS NOT NULL;
CREATE INDEX currency_settings_delist_due_idx
  ON wallet_core.currency_settings (delist_at, currency_id)
  WHERE delist_at IS NOT NULL;

CREATE TABLE wallet_core.currencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  chain_id UUID NOT NULL REFERENCES wallet_core.chains(id),
  provider_coin_id BIGINT NOT NULL CHECK (provider_coin_id > 0),
  is_token BOOLEAN NOT NULL,
  is_native BOOLEAN NOT NULL,
  token_contract_address VARCHAR(256),
  blockchain_precision INTEGER NOT NULL CHECK (blockchain_precision BETWEEN 0 AND 18),
  desired_state wallet_core."WalletDesiredState" NOT NULL DEFAULT 'OFF',
  maintenance_pinned BOOLEAN NOT NULL DEFAULT false,
  provider_state wallet_core."WalletProviderState" NOT NULL DEFAULT 'UNAVAILABLE',
  consecutive_failed_checks INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failed_checks BETWEEN 0 AND 3),
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  provider_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, currency_id),
  UNIQUE (currency_id, chain_id),
  UNIQUE (chain_id, provider_coin_id),
  CHECK (is_native = NOT is_token),
  CHECK ((is_token AND token_contract_address IS NOT NULL)
    OR (NOT is_token AND token_contract_address IS NULL)),
  CHECK (token_contract_address IS NULL OR
    (token_contract_address = btrim(token_contract_address) AND token_contract_address <> ''))
);
CREATE UNIQUE INDEX currencies_one_native_per_chain
  ON wallet_core.currencies (chain_id) WHERE is_native;
CREATE INDEX currencies_currency_idx ON wallet_core.currencies (currency_id, id);
CREATE INDEX currencies_provider_state_idx ON wallet_core.currencies (provider_state, id);
CREATE INDEX currencies_binding_read_idx ON wallet_core.currencies (currency_id, chain_id, id);

CREATE TABLE wallet_core.legacy_currency_chain_codes (
  currency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  chain_code VARCHAR(64) NOT NULL CHECK (chain_code = btrim(chain_code) AND chain_code <> ''),
  blockchain_precision INTEGER NOT NULL CHECK (blockchain_precision BETWEEN 0 AND 18),
  mapped_binding_id UUID,
  PRIMARY KEY (currency_id, chain_code),
  FOREIGN KEY (mapped_binding_id, currency_id)
    REFERENCES wallet_core.currencies(id, currency_id)
);
CREATE INDEX legacy_currency_chain_codes_unmapped_idx
  ON wallet_core.legacy_currency_chain_codes (currency_id, chain_code)
  WHERE mapped_binding_id IS NULL;

CREATE TABLE wallet_core.provider_catalogue_chains (
  provider_chain_id BIGINT PRIMARY KEY CHECK (provider_chain_id > 0),
  name VARCHAR(128) NOT NULL CHECK (name = btrim(name) AND name <> ''),
  short_name VARCHAR(32) NOT NULL CHECK (short_name = btrim(short_name) AND short_name <> ''),
  is_evm BOOLEAN NOT NULL,
  provider_state wallet_core."WalletProviderState" NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  refreshed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX provider_catalogue_chains_revision_idx
  ON wallet_core.provider_catalogue_chains (revision DESC, provider_chain_id);

CREATE TABLE wallet_core.provider_catalogue_currencies (
  provider_chain_id BIGINT NOT NULL,
  provider_coin_id BIGINT NOT NULL CHECK (provider_coin_id > 0),
  currency_name VARCHAR(128) NOT NULL CHECK (currency_name = btrim(currency_name) AND currency_name <> ''),
  token_address VARCHAR(256),
  is_base_currency BOOLEAN NOT NULL,
  is_stake BOOLEAN NOT NULL,
  blockchain_precision INTEGER NOT NULL CHECK (blockchain_precision BETWEEN 0 AND 18),
  provider_state wallet_core."WalletProviderState" NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  refreshed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider_chain_id, provider_coin_id),
  FOREIGN KEY (provider_chain_id) REFERENCES wallet_core.provider_catalogue_chains(provider_chain_id),
  CHECK ((is_base_currency AND token_address IS NULL)
    OR (NOT is_base_currency AND token_address IS NOT NULL)),
  CHECK (token_address IS NULL OR (token_address = btrim(token_address) AND token_address <> ''))
);
CREATE INDEX provider_catalogue_currencies_revision_idx
  ON wallet_core.provider_catalogue_currencies (revision DESC, provider_chain_id, provider_coin_id);

CREATE TABLE wallet_core.wallet_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  provider_catalogue_revision BIGINT NOT NULL DEFAULT 0 CHECK (provider_catalogue_revision >= 0),
  global_desired_state wallet_core."WalletDesiredState" NOT NULL DEFAULT 'ON',
  catalogue_mode wallet_core."WalletCatalogueMode" NOT NULL DEFAULT 'ALL',
  include_treasury BOOLEAN NOT NULL DEFAULT true,
  include_collection BOOLEAN NOT NULL DEFAULT false,
  reconciliation_alert_percent NUMERIC NOT NULL DEFAULT 5.000
    CHECK (reconciliation_alert_percent BETWEEN 0.000 AND 50.000)
    CHECK (scale(reconciliation_alert_percent) <= 3),
  default_view_currency_id UUID REFERENCES price_conversion.currencies(id),
  default_crypto_currency_id UUID REFERENCES price_conversion.currencies(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_core.configuration_changes (
  id UUID PRIMARY KEY,
  revision BIGINT NOT NULL UNIQUE CHECK (revision >= 0),
  status wallet_core."WalletConfigurationStatus" NOT NULL,
  draft_guard_key SMALLINT GENERATED ALWAYS AS (
    CASE WHEN status='DRAFT' THEN 1 ELSE NULL END
  ) STORED,
  live_guard_key SMALLINT GENERATED ALWAYS AS (
    CASE WHEN status='LIVE' THEN 1 ELSE NULL END
  ) STORED,
  effective_at TIMESTAMPTZ,
  reason VARCHAR(500) NOT NULL CHECK (reason = btrim(reason) AND reason <> ''),
  changelog VARCHAR(2000),
  actor_id UUID NOT NULL,
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT configuration_changes_one_draft UNIQUE (draft_guard_key)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT configuration_changes_one_live UNIQUE (live_guard_key)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((status = 'DRAFT' AND effective_at IS NULL AND applied_at IS NULL)
    OR (status = 'SCHEDULED' AND effective_at IS NOT NULL AND applied_at IS NULL)
    OR (status = 'LIVE' AND applied_at IS NOT NULL)
    OR status = 'ARCHIVED'
    OR (status = 'REJECTED' AND applied_at IS NULL))
);
CREATE INDEX configuration_changes_draft_lookup_idx
  ON wallet_core.configuration_changes (status, id) WHERE status = 'DRAFT';
CREATE INDEX configuration_changes_cursor_idx
  ON wallet_core.configuration_changes (created_at DESC, id DESC);
CREATE INDEX configuration_changes_schedule_idx
  ON wallet_core.configuration_changes (status, effective_at) WHERE status = 'SCHEDULED';

CREATE TABLE wallet_core.user_preferences (
  user_id UUID PRIMARY KEY,
  preferred_view_currency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  preferred_cryptocurrency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (preferred_view_currency_id <> preferred_cryptocurrency_id)
);
CREATE INDEX user_preferences_view_idx ON wallet_core.user_preferences (preferred_view_currency_id);
CREATE INDEX user_preferences_crypto_idx ON wallet_core.user_preferences (preferred_cryptocurrency_id);

CREATE TABLE wallet_core.admin_preferences (
  admin_id UUID PRIMARY KEY,
  timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata'
    CHECK (timezone = btrim(timezone) AND timezone <> ''),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_core.state_events (
  id UUID PRIMARY KEY,
  event_type VARCHAR(96) NOT NULL CHECK (event_type = btrim(event_type) AND event_type <> ''),
  subject_type VARCHAR(32) NOT NULL CHECK (subject_type = btrim(subject_type) AND subject_type <> ''),
  subject_id UUID NOT NULL,
  run_id UUID,
  actor_id UUID,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((run_id IS NULL) <> (actor_id IS NULL))
);
CREATE INDEX state_events_subject_cursor_idx
  ON wallet_core.state_events (subject_type, subject_id, created_at DESC, id DESC);
CREATE INDEX state_events_run_idx ON wallet_core.state_events (run_id) WHERE run_id IS NOT NULL;

CREATE TABLE wallet_core.custody_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency_chain_id UUID NOT NULL REFERENCES wallet_core.currencies(id),
  kind wallet_core."WalletAddressKind" NOT NULL,
  wallet_address VARCHAR(512) NOT NULL,
  address_identity VARCHAR(512) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (currency_chain_id, kind, address_identity)
);
CREATE INDEX custody_addresses_binding_kind_idx
  ON wallet_core.custody_addresses (currency_chain_id, kind, address_identity, id);

CREATE TABLE wallet_core.wallet_reconciliation_runs (
  id UUID PRIMARY KEY,
  status wallet_core."WalletReconciliationRunStatus" NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  valuation_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_reconciliation_alert_percent NUMERIC NOT NULL
    CHECK (applied_reconciliation_alert_percent BETWEEN 0.000 AND 50.000)
    CHECK (scale(applied_reconciliation_alert_percent) <= 3),
  applied_configuration_revision BIGINT NOT NULL CHECK (applied_configuration_revision >= 0),
  comparison_rule VARCHAR(64) NOT NULL
    CHECK (comparison_rule = 'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD'),
  currency_count INTEGER NOT NULL DEFAULT 0 CHECK (currency_count >= 0),
  warning_count INTEGER NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  safe_error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX wallet_reconciliation_runs_period_idx
  ON wallet_core.wallet_reconciliation_runs (scheduled_for);
CREATE INDEX wallet_reconciliation_runs_cursor_idx
  ON wallet_core.wallet_reconciliation_runs (created_at DESC, id DESC);

CREATE TABLE wallet_core.wallet_reconciliation_items (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES wallet_core.wallet_reconciliation_runs(id),
  currency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  status wallet_core."WalletReconciliationItemStatus" NOT NULL,
  hot_cold_balance NUMERIC(38,18) NOT NULL CHECK (hot_cold_balance >= 0),
  staking_balance NUMERIC(38,18) NOT NULL CHECK (staking_balance >= 0),
  binance_balance NUMERIC(38,18) NOT NULL CHECK (binance_balance >= 0),
  total_custody_balance NUMERIC(38,18) NOT NULL CHECK (total_custody_balance >= 0),
  required_backing NUMERIC(38,18) NOT NULL CHECK (required_backing >= 0),
  user_merchant_balance NUMERIC(38,18) NOT NULL CHECK (user_merchant_balance >= 0),
  treasury_balance NUMERIC(38,18) NOT NULL CHECK (treasury_balance >= 0),
  collection_balance NUMERIC(38,18) NOT NULL CHECK (collection_balance >= 0),
  partial_reasons TEXT[] NOT NULL DEFAULT '{}',
  shortfall_suppressed BOOLEAN NOT NULL,
  shortfall_percent NUMERIC(38,18) CHECK (shortfall_percent >= 0),
  applied_reconciliation_alert_percent NUMERIC NOT NULL
    CHECK (applied_reconciliation_alert_percent BETWEEN 0.000 AND 50.000)
    CHECK (scale(applied_reconciliation_alert_percent) <= 3),
  applied_configuration_revision BIGINT NOT NULL CHECK (applied_configuration_revision >= 0),
  comparison_rule VARCHAR(64) NOT NULL
    CHECK (comparison_rule = 'SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD'),
  price_resolution_id UUID REFERENCES price_conversion.price_resolutions(id),
  price_snapshot_id UUID REFERENCES price_conversion.price_snapshots(id),
  price_provider price_conversion."PriceProviderCode"
    REFERENCES price_conversion.price_providers(code),
  price_usd NUMERIC(38,18) CHECK (price_usd > 0),
  price_observed_at TIMESTAMPTZ,
  price_resolution_reason price_conversion."PriceResolutionReason",
  price_used_fallback BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, currency_id),
  CHECK (total_custody_balance = hot_cold_balance + staking_balance + binance_balance),
  CHECK ((status = 'COMPLETE' AND cardinality(partial_reasons) = 0)
    OR (status = 'PARTIAL' AND cardinality(partial_reasons) > 0)),
  CHECK (partial_reasons <@ ARRAY[
    'ENCRYPTION_FAILED','AUTHENTICATION_FAILED','UNAUTHORIZED_IP','PROVIDER_MAINTENANCE',
    'PROVIDER_DISABLED','PROVIDER_NOT_FOUND','PROVIDER_REJECTED','TIMEOUT','TRANSPORT_ERROR',
    'RESPONSE_TOO_LARGE','INVALID_RESPONSE','INVALID_DECIMAL','PRICE_UNAVAILABLE'
  ]::TEXT[]),
  CHECK (num_nonnulls(price_resolution_id,price_snapshot_id,price_provider,
    price_usd,price_observed_at,price_resolution_reason,price_used_fallback) IN (0,7)),
  CHECK ((price_resolution_id IS NULL AND status = 'PARTIAL'
      AND 'PRICE_UNAVAILABLE' = ANY(partial_reasons))
    OR (price_resolution_id IS NOT NULL
      AND NOT ('PRICE_UNAVAILABLE' = ANY(partial_reasons)))),
  CHECK ((shortfall_suppressed AND status = 'PARTIAL' AND shortfall_percent IS NULL)
    OR (NOT shortfall_suppressed AND (
      (required_backing = 0 AND shortfall_percent IS NULL)
      OR (required_backing > 0 AND shortfall_percent IS NOT NULL))))
);
CREATE INDEX wallet_reconciliation_items_currency_cursor_idx
  ON wallet_core.wallet_reconciliation_items (currency_id, created_at DESC, id DESC);

CREATE TABLE wallet_core.wallet_reconciliation_components (
  id UUID PRIMARY KEY,
  run_item_id UUID NOT NULL REFERENCES wallet_core.wallet_reconciliation_items(id),
  kind wallet_core."WalletReconciliationComponentKind" NOT NULL,
  currency_chain_id UUID REFERENCES wallet_core.currencies(id),
  custody_address_id UUID REFERENCES wallet_core.custody_addresses(id),
  binance_reference VARCHAR(64),
  attempts_used INTEGER NOT NULL CHECK (attempts_used BETWEEN 1 AND 3),
  accepted_raw_decimal VARCHAR(160),
  selected_balance NUMERIC(38,18) CHECK (selected_balance >= 0),
  safe_error_code wallet_core."WalletReconciliationSafeErrorCode",
  total_admin_stake_balance NUMERIC(38,18) CHECK (total_admin_stake_balance >= 0),
  total_admin_manual_stake_balance NUMERIC(38,18) CHECK (total_admin_manual_stake_balance >= 0),
  total_balance NUMERIC(38,18) CHECK (total_balance >= 0),
  stake_selected_source wallet_core."WalletStakeSelectedSource",
  stake_total_mismatch BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'BINANCE' AND currency_chain_id IS NULL AND custody_address_id IS NULL
      AND binance_reference IS NOT NULL)
    OR (kind <> 'BINANCE' AND currency_chain_id IS NOT NULL AND custody_address_id IS NOT NULL
      AND binance_reference IS NULL)),
  CHECK ((selected_balance IS NOT NULL AND accepted_raw_decimal IS NOT NULL AND safe_error_code IS NULL)
    OR (selected_balance IS NULL AND accepted_raw_decimal IS NULL AND safe_error_code IS NOT NULL)),
  CHECK ((kind = 'STAKING' AND (
      (selected_balance IS NOT NULL AND total_admin_stake_balance IS NOT NULL
        AND total_admin_manual_stake_balance IS NOT NULL AND total_balance IS NOT NULL
        AND stake_selected_source IS NOT NULL)
      OR (selected_balance IS NULL AND total_admin_stake_balance IS NULL
        AND total_admin_manual_stake_balance IS NULL AND total_balance IS NULL
        AND stake_selected_source IS NULL AND NOT stake_total_mismatch)))
    OR (kind <> 'STAKING' AND total_admin_stake_balance IS NULL
      AND total_admin_manual_stake_balance IS NULL AND total_balance IS NULL
      AND stake_selected_source IS NULL AND NOT stake_total_mismatch))
);
CREATE INDEX wallet_reconciliation_components_item_idx
  ON wallet_core.wallet_reconciliation_components (run_item_id, kind, id);
CREATE UNIQUE INDEX wallet_reconciliation_components_binance_once
  ON wallet_core.wallet_reconciliation_components (run_item_id) WHERE kind = 'BINANCE';

CREATE TABLE wallet_core.wallet_reconciliation_attempts (
  id UUID PRIMARY KEY,
  component_id UUID NOT NULL REFERENCES wallet_core.wallet_reconciliation_components(id),
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal BETWEEN 1 AND 3),
  configured_delay_ms INTEGER NOT NULL CHECK (configured_delay_ms IN (0, 1000, 3000)),
  last_completed_stage wallet_core."WalletAttemptStage",
  outcome wallet_core."WalletAttemptOutcome" NOT NULL,
  safe_error_code wallet_core."WalletReconciliationSafeErrorCode",
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (component_id, attempt_ordinal),
  CHECK ((attempt_ordinal = 1 AND configured_delay_ms = 0)
    OR (attempt_ordinal = 2 AND configured_delay_ms = 1000)
    OR (attempt_ordinal = 3 AND configured_delay_ms = 3000)),
  CHECK ((outcome = 'SUCCESS' AND last_completed_stage = 'BALANCE' AND safe_error_code IS NULL)
    OR (outcome = 'FAILED' AND safe_error_code IS NOT NULL))
);
CREATE INDEX wallet_reconciliation_attempts_component_idx
  ON wallet_core.wallet_reconciliation_attempts (component_id, attempt_ordinal);

CREATE TABLE wallet_core.wallet_alerts (
  id UUID PRIMARY KEY,
  dedupe_key VARCHAR(200) NOT NULL UNIQUE CHECK (dedupe_key = btrim(dedupe_key) AND dedupe_key <> ''),
  category wallet_core."WalletAlertCategory" NOT NULL,
  status wallet_core."WalletAlertStatus" NOT NULL,
  currency_id UUID REFERENCES price_conversion.currencies(id),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  opened_at TIMESTAMPTZ NOT NULL,
  cleared_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (updated_at >= opened_at),
  CHECK ((status = 'ACTIVE' AND cleared_at IS NULL)
    OR (status = 'CLEARED' AND cleared_at >= opened_at AND updated_at >= cleared_at)),
  CHECK ((category = 'CATALOGUE_REFRESH_FAILED' AND currency_id IS NULL)
    OR category = 'PROVIDER_MAINTENANCE'
    OR (category NOT IN ('CATALOGUE_REFRESH_FAILED','PROVIDER_MAINTENANCE')
      AND currency_id IS NOT NULL))
);
CREATE INDEX wallet_alerts_status_idx ON wallet_core.wallet_alerts (status, category, currency_id);

CREATE TABLE wallet_core.wallet_alert_events (
  id UUID PRIMARY KEY,
  alert_id UUID NOT NULL REFERENCES wallet_core.wallet_alerts(id),
  category wallet_core."WalletAlertCategory" NOT NULL,
  status wallet_core."WalletAlertStatus" NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wallet_alert_events_alert_cursor_idx
  ON wallet_core.wallet_alert_events (alert_id, created_at DESC, id DESC);

CREATE TABLE wallet_core.wallet_notification_outbox (
  id UUID PRIMARY KEY,
  event_type VARCHAR(96) NOT NULL CHECK (event_type = btrim(event_type) AND event_type <> ''),
  dedupe_key VARCHAR(200) NOT NULL UNIQUE CHECK (dedupe_key = btrim(dedupe_key) AND dedupe_key <> ''),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status wallet_core."WalletOutboxStatus" NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  safe_error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  CHECK ((status = 'PENDING' AND attempt_count = 0 AND next_attempt_at IS NULL
      AND safe_error_code IS NULL AND delivered_at IS NULL)
    OR (status = 'PROCESSING' AND attempt_count >= 1 AND next_attempt_at IS NULL
      AND safe_error_code IS NULL AND delivered_at IS NULL)
    OR (status = 'SENT' AND attempt_count >= 1 AND next_attempt_at IS NULL
      AND safe_error_code IS NULL AND delivered_at >= created_at)
    OR (status = 'FAILED' AND attempt_count >= 1 AND next_attempt_at IS NOT NULL
      AND safe_error_code IS NOT NULL AND delivered_at IS NULL)
    OR (status = 'DEAD' AND attempt_count >= 1 AND next_attempt_at IS NULL
      AND safe_error_code IS NOT NULL AND delivered_at IS NULL))
);
CREATE INDEX wallet_notification_outbox_pending_idx
  ON wallet_core.wallet_notification_outbox (status, next_attempt_at, created_at, id);

CREATE TABLE wallet_core.cronjob_runs (
  id UUID PRIMARY KEY,
  job_name VARCHAR(96) NOT NULL CHECK (job_name = btrim(job_name) AND job_name <> ''),
  scheduled_for TIMESTAMPTZ NOT NULL,
  worker_instance_id VARCHAR(128) NOT NULL
    CHECK (worker_instance_id = btrim(worker_instance_id) AND worker_instance_id <> ''),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  status wallet_core."WalletCronStatus" NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  skipped_bucket_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_bucket_count >= 0),
  safe_error_code wallet_core."WalletCronSafeReasonCode",
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (job_name, scheduled_for),
  CHECK ((status IN ('RUNNING','SUCCESS') AND safe_error_code IS NULL)
    OR (status = 'PARTIAL' AND safe_error_code IS NOT NULL AND safe_error_code IN (
      'CONFIGURATION_REJECTED','PROVIDER_OBSERVATION_PARTIAL'))
    OR (status = 'FAILED' AND safe_error_code IS NOT NULL AND safe_error_code IN (
      'PROVIDER_OBSERVATION_FAILED','DEPENDENCY_UNAVAILABLE','UNEXPECTED_ERROR'))
    OR (status = 'SKIPPED' AND safe_error_code IS NOT NULL AND safe_error_code IN (
      'MISSED_SCHEDULE','CATCHUP_TRUNCATED'))),
  CHECK ((status = 'RUNNING' AND finished_at IS NULL)
    OR (status <> 'RUNNING' AND finished_at IS NOT NULL AND finished_at >= started_at)),
  CHECK ((status = 'RUNNING' AND lease_expires_at IS NOT NULL)
    OR (status <> 'RUNNING' AND lease_expires_at IS NULL)),
  CHECK ((safe_error_code = 'CATCHUP_TRUNCATED' AND status = 'SKIPPED'
      AND skipped_bucket_count > 0)
    OR (safe_error_code IS DISTINCT FROM 'CATCHUP_TRUNCATED' AND skipped_bucket_count = 0))
);
CREATE INDEX cronjob_runs_status_idx ON wallet_core.cronjob_runs (job_name, status, scheduled_for);
CREATE UNIQUE INDEX cronjob_runs_one_running_per_job
  ON wallet_core.cronjob_runs (job_name) WHERE status = 'RUNNING';
CREATE INDEX cronjob_runs_reclaim_idx
  ON wallet_core.cronjob_runs (job_name, status, lease_expires_at, scheduled_for, id)
  WHERE status IN ('RUNNING','FAILED');

CREATE TABLE wallet_core.delisting_executions (
  id UUID PRIMARY KEY,
  currency_id UUID NOT NULL REFERENCES price_conversion.currencies(id),
  policy_revision BIGINT NOT NULL CHECK (policy_revision >= 0),
  deadline TIMESTAMPTZ NOT NULL,
  cursor VARCHAR(512),
  cursor_ordinal BIGINT NOT NULL DEFAULT 0 CHECK (cursor_ordinal >= 0),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  status wallet_core."WalletDelistingStatus" NOT NULL,
  safe_error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (currency_id, policy_revision, deadline),
  CHECK ((status IN ('RUNNING','COMPLETED') AND safe_error_code IS NULL)
    OR (status IN ('PARTIAL','FAILED') AND safe_error_code IS NOT NULL))
);
CREATE INDEX delisting_executions_status_idx
  ON wallet_core.delisting_executions (status, deadline, id);

CREATE FUNCTION wallet_core.reject_immutable_history_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
BEGIN
  RAISE EXCEPTION 'wallet core history is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION wallet_core.guard_wallet_notification_outbox_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'wallet notification outbox must start PENDING' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','attempt_count','next_attempt_at','safe_error_code','delivered_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','attempt_count','next_attempt_at','safe_error_code','delivered_at']) THEN
    RAISE EXCEPTION 'wallet notification outbox identity and payload are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status = 'PROCESSING')
    OR (OLD.status = 'PROCESSING' AND NEW.status IN ('SENT','FAILED','DEAD'))
    OR (OLD.status = 'FAILED' AND NEW.status IN ('PROCESSING','DEAD'))
  ) THEN
    RAISE EXCEPTION 'invalid wallet notification outbox status transition'
      USING ERRCODE = '55000';
  END IF;
  IF (NEW.status = 'PROCESSING' AND NEW.attempt_count <> OLD.attempt_count + 1)
    OR (NEW.status <> 'PROCESSING' AND NEW.attempt_count <> OLD.attempt_count) THEN
    RAISE EXCEPTION 'wallet notification outbox attempt count must increment only on claim'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION wallet_core.guard_wallet_alert_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'wallet alert must start ACTIVE' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.currency_id IS DISTINCT FROM OLD.currency_id
    OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION 'wallet alert identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'ACTIVE' THEN
    IF NEW.payload IS NOT DISTINCT FROM OLD.payload OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
      OR NEW.cleared_at IS DISTINCT FROM OLD.cleared_at OR NEW.updated_at <= OLD.updated_at THEN
      RAISE EXCEPTION 'invalid active wallet alert update' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'ACTIVE' AND NEW.status = 'CLEARED' THEN
    IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
      OR NEW.cleared_at IS NULL OR NEW.updated_at <= OLD.updated_at THEN
      RAISE EXCEPTION 'invalid wallet alert clear' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'CLEARED' AND NEW.status = 'ACTIVE' THEN
    IF NEW.cleared_at IS NOT NULL OR NEW.updated_at <= OLD.updated_at THEN
      RAISE EXCEPTION 'invalid wallet alert reopen' USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid wallet alert status transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION wallet_core.validate_wallet_alert_payload() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
DECLARE
  v_keys TEXT[];
  v_valid BOOLEAN := false;
  v_alert_currency_id UUID;
  v_alert_category wallet_core."WalletAlertCategory";
  v_provider_chain_id BIGINT;
  v_provider_coin_id BIGINT;
  v_uuid_pattern CONSTANT TEXT :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  v_decimal_pattern CONSTANT TEXT := '^(0|[1-9][0-9]{0,19})[.][0-9]{18}$';
BEGIN
  SELECT array_agg(key ORDER BY key) INTO v_keys FROM jsonb_object_keys(NEW.payload) keys(key);
  IF NEW.category = 'CATALOGUE_REFRESH_FAILED' THEN
    v_valid := v_keys = ARRAY['failedAt','safeErrorCode']
      AND jsonb_typeof(NEW.payload->'safeErrorCode') = 'string'
      AND EXISTS (SELECT 1 FROM unnest(enum_range(
        NULL::wallet_core."WalletCatalogueRefreshErrorCode")) code
        WHERE code::text = NEW.payload->>'safeErrorCode')
      AND jsonb_typeof(NEW.payload->'failedAt') = 'string'
      AND NEW.payload->>'failedAt' ~
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{3}([0-9]{3})?)?Z$';
    IF v_valid THEN
      BEGIN
        PERFORM (NEW.payload->>'failedAt')::timestamptz;
      EXCEPTION WHEN datetime_field_overflow THEN v_valid := false;
      END;
    END IF;
    IF NOT v_valid THEN
      RAISE EXCEPTION 'invalid wallet alert payload' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.category = 'PROVIDER_MAINTENANCE' THEN
    IF TG_TABLE_NAME = 'wallet_alerts' THEN
      v_alert_currency_id := NEW.currency_id;
      v_alert_category := NEW.category;
    ELSE
      SELECT alert.currency_id,alert.category INTO v_alert_currency_id,v_alert_category
      FROM wallet_core.wallet_alerts alert WHERE alert.id=NEW.alert_id;
    END IF;
    v_valid := v_alert_category = 'PROVIDER_MAINTENANCE'
      AND v_keys = ARRAY['effectiveState','failureStreak','maintenancePinned','observedAt',
        'providerReference','providerState','subjectId','subjectType']
      AND jsonb_typeof(NEW.payload->'subjectType') = 'string'
      AND NEW.payload->>'subjectType' IN ('CHAIN','CURRENCY_CHAIN')
      AND jsonb_typeof(NEW.payload->'subjectId') = 'string'
      AND NEW.payload->>'subjectId' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND jsonb_typeof(NEW.payload->'providerReference') = 'string'
      AND length(NEW.payload->>'providerReference') <= 64
      AND jsonb_typeof(NEW.payload->'providerState') = 'string'
      AND NEW.payload->>'providerState' IN ('ACTIVATED','DISABLED','MAINTENANCE','UNAVAILABLE')
      AND jsonb_typeof(NEW.payload->'failureStreak') = 'number'
      AND NEW.payload->>'failureStreak' ~ '^[0-3]$'
      AND jsonb_typeof(NEW.payload->'maintenancePinned') = 'boolean'
      AND jsonb_typeof(NEW.payload->'effectiveState') = 'string'
      AND NEW.payload->>'effectiveState' IN ('OFF','ON','MAINTAIN')
      AND jsonb_typeof(NEW.payload->'observedAt') = 'string'
      AND NEW.payload->>'observedAt' ~
        '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{3}([0-9]{3})?)?Z$';
    IF v_valid THEN
      BEGIN
        PERFORM (NEW.payload->>'observedAt')::timestamptz;
        IF NEW.payload->>'subjectType' = 'CHAIN' THEN
          IF NEW.payload->>'providerReference' !~ '^CHAIN:[1-9][0-9]{0,18}$'
            OR v_alert_currency_id IS NOT NULL THEN v_valid := false;
          ELSE
            v_provider_chain_id := split_part(NEW.payload->>'providerReference',':',2)::bigint;
            v_valid := EXISTS (SELECT 1 FROM wallet_core.chains chain
              WHERE chain.id=(NEW.payload->>'subjectId')::uuid
                AND chain.provider_chain_id=v_provider_chain_id);
          END IF;
        ELSIF NEW.payload->>'providerReference'
          !~ '^CURRENCY_CHAIN:[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$'
          OR v_alert_currency_id IS NULL THEN v_valid := false;
        ELSE
          v_provider_chain_id := split_part(NEW.payload->>'providerReference',':',2)::bigint;
          v_provider_coin_id := split_part(NEW.payload->>'providerReference',':',3)::bigint;
          v_valid := EXISTS (SELECT 1 FROM wallet_core.currencies binding
            JOIN wallet_core.chains chain ON chain.id=binding.chain_id
            WHERE binding.id=(NEW.payload->>'subjectId')::uuid
              AND binding.currency_id=v_alert_currency_id
              AND chain.provider_chain_id=v_provider_chain_id
              AND binding.provider_coin_id=v_provider_coin_id);
        END IF;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format
        OR numeric_value_out_of_range OR invalid_text_representation THEN v_valid := false;
      END;
    END IF;
    IF NOT v_valid THEN
      RAISE EXCEPTION 'invalid wallet alert payload' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.category = 'SHORTFALL' THEN
    v_valid := v_keys = ARRAY['currencyId','custodyBalance','itemId','requiredBacking','runId',
        'shortfallPercent','thresholdPercent']
      AND NEW.payload->>'runId' ~ v_uuid_pattern
      AND NEW.payload->>'itemId' ~ v_uuid_pattern
      AND NEW.payload->>'currencyId' ~ v_uuid_pattern
      AND NEW.payload->>'custodyBalance' ~ v_decimal_pattern
      AND NEW.payload->>'requiredBacking' ~ v_decimal_pattern
      AND NEW.payload->>'shortfallPercent' ~ v_decimal_pattern
      AND NEW.payload->>'thresholdPercent' ~ '^(0|[1-4]?[0-9]|50)[.][0-9]{3}$'
      AND (NEW.payload->>'thresholdPercent')::numeric BETWEEN 0 AND 50;
  ELSIF NEW.category = 'PARTIAL_DATA' THEN
    v_valid := v_keys = ARRAY['currencyId','itemId','partialReasons','runId','shortfallSuppressed']
      AND NEW.payload->>'runId' ~ v_uuid_pattern
      AND NEW.payload->>'itemId' ~ v_uuid_pattern
      AND NEW.payload->>'currencyId' ~ v_uuid_pattern
      AND jsonb_typeof(NEW.payload->'partialReasons') = 'array'
      AND jsonb_array_length(NEW.payload->'partialReasons') > 0
      AND jsonb_typeof(NEW.payload->'shortfallSuppressed') = 'boolean'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.payload->'partialReasons') reason
        WHERE jsonb_typeof(reason) <> 'string' OR reason #>> '{}' NOT IN (
          'ENCRYPTION_FAILED','AUTHENTICATION_FAILED','UNAUTHORIZED_IP',
          'PROVIDER_MAINTENANCE','PROVIDER_DISABLED','PROVIDER_NOT_FOUND',
          'PROVIDER_REJECTED','TIMEOUT','TRANSPORT_ERROR','RESPONSE_TOO_LARGE',
          'INVALID_RESPONSE','INVALID_DECIMAL','PRICE_UNAVAILABLE'
        )
      )
      AND (SELECT count(*) = count(DISTINCT reason #>> '{}')
        FROM jsonb_array_elements(NEW.payload->'partialReasons') reason);
  ELSIF NEW.category = 'STAKING_TOTAL_MISMATCH' THEN
    v_valid := v_keys = ARRAY['componentId','componentSum','currencyId','itemId','reportedTotal',
        'runId','selectedSource']
      AND NEW.payload->>'runId' ~ v_uuid_pattern
      AND NEW.payload->>'itemId' ~ v_uuid_pattern
      AND NEW.payload->>'componentId' ~ v_uuid_pattern
      AND NEW.payload->>'currencyId' ~ v_uuid_pattern
      AND NEW.payload->>'reportedTotal' ~ v_decimal_pattern
      AND NEW.payload->>'componentSum' ~ v_decimal_pattern
      AND NEW.payload->>'selectedSource' = 'COMPONENT_SUM'
      AND (NEW.payload->>'reportedTotal')::numeric
        <> (NEW.payload->>'componentSum')::numeric;
  END IF;
  IF NOT v_valid THEN
    RAISE EXCEPTION 'invalid wallet alert payload' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


CREATE FUNCTION wallet_core.guard_delisting_execution_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'RUNNING' THEN
      RAISE EXCEPTION 'delisting execution must start RUNNING' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['cursor','cursor_ordinal','processed_count','skipped_count',
      'failed_count','status','safe_error_code','updated_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['cursor','cursor_ordinal','processed_count','skipped_count',
      'failed_count','status','safe_error_code','updated_at']) THEN
    RAISE EXCEPTION 'delisting execution identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.cursor_ordinal < OLD.cursor_ordinal OR NEW.processed_count < OLD.processed_count
    OR NEW.skipped_count < OLD.skipped_count OR NEW.failed_count < OLD.failed_count THEN
    RAISE EXCEPTION 'delisting execution progress cannot move backward' USING ERRCODE = '55000';
  END IF;
  IF NEW.cursor IS DISTINCT FROM OLD.cursor
    AND NEW.cursor_ordinal <= OLD.cursor_ordinal THEN
    RAISE EXCEPTION 'delisting cursor change requires ordinal progress' USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'delisting execution update time must advance' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'RUNNING' AND NEW.status = 'RUNNING' THEN
    IF NEW.cursor_ordinal = OLD.cursor_ordinal
      AND NEW.processed_count = OLD.processed_count
      AND NEW.skipped_count = OLD.skipped_count
      AND NEW.failed_count = OLD.failed_count THEN
      RAISE EXCEPTION 'running delisting update requires progress' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'RUNNING' AND NEW.status IN ('PARTIAL','FAILED','COMPLETED') THEN
    NULL;
  ELSIF OLD.status IN ('PARTIAL','FAILED') AND NEW.status = 'RUNNING' THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'invalid delisting execution status transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION wallet_core.guard_cronjob_run_lease() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'RUNNING' THEN
      RAISE EXCEPTION 'cronjob run must start RUNNING' USING ERRCODE = '55000';
    END IF;
    NEW.lease_expires_at := v_now + interval '5 minutes';
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.job_name IS DISTINCT FROM OLD.job_name
    OR NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for
    OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'cronjob run identity and start are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.processed_count < OLD.processed_count OR NEW.failed_count < OLD.failed_count
    OR NEW.skipped_bucket_count < OLD.skipped_bucket_count THEN
    RAISE EXCEPTION 'cronjob run counts cannot decrease' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'RUNNING' AND NEW.status = 'RUNNING' THEN
    IF OLD.lease_expires_at > v_now THEN
      IF NEW.worker_instance_id IS DISTINCT FROM OLD.worker_instance_id
        OR NEW.attempt_count <> OLD.attempt_count THEN
        RAISE EXCEPTION 'unexpired cronjob run cannot be stolen' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.worker_instance_id IS NOT DISTINCT FROM OLD.worker_instance_id
      OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'stale cronjob reclaim must change worker and increment attempt'
        USING ERRCODE = '55000';
    END IF;
    NEW.lease_expires_at := v_now + interval '5 minutes';
  ELSIF OLD.status = 'RUNNING'
    AND NEW.status IN ('SUCCESS','PARTIAL','FAILED','SKIPPED') THEN
    IF OLD.lease_expires_at <= v_now
      OR NEW.worker_instance_id IS DISTINCT FROM OLD.worker_instance_id
      OR NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'cronjob completion lease is lost' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'FAILED' AND NEW.status = 'RUNNING' THEN
    IF NEW.worker_instance_id IS NOT DISTINCT FROM OLD.worker_instance_id
      OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'failed cronjob retry must change worker and increment attempt'
        USING ERRCODE = '55000';
    END IF;
    NEW.lease_expires_at := v_now + interval '5 minutes';
  ELSE
    RAISE EXCEPTION 'invalid cronjob run status transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION wallet_core.guard_configuration_change_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'wallet configuration must start DRAFT' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','draft_guard_key','live_guard_key','effective_at','applied_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','draft_guard_key','live_guard_key','effective_at','applied_at']) THEN
    RAISE EXCEPTION 'wallet configuration identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.status = 'DRAFT' AND NEW.status IN ('SCHEDULED','LIVE','ARCHIVED'))
    OR (OLD.status = 'SCHEDULED' AND NEW.status IN ('LIVE','ARCHIVED','REJECTED'))
    OR (OLD.status = 'LIVE' AND NEW.status = 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'invalid wallet configuration status transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'SCHEDULED' THEN
    IF NEW.effective_at IS NULL THEN
      RAISE EXCEPTION 'scheduled wallet configuration requires effective time'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.effective_at IS DISTINCT FROM OLD.effective_at THEN
    RAISE EXCEPTION 'wallet configuration effective time is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'LIVE' THEN
    IF NEW.applied_at IS NULL THEN
      RAISE EXCEPTION 'live wallet configuration requires applied time'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
    RAISE EXCEPTION 'wallet configuration applied time is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION wallet_core.guard_custody_address() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
DECLARE
  v_is_token BOOLEAN;
  v_is_evm BOOLEAN;
  v_trimmed TEXT;
  v_identity TEXT;
  v_lock_group TEXT;
  v_count BIGINT;
BEGIN
  SELECT binding.is_token, chain.is_evm INTO v_is_token, v_is_evm
  FROM wallet_core.currencies binding
  JOIN wallet_core.chains chain ON chain.id = binding.chain_id
  WHERE binding.id = NEW.currency_chain_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'currency-chain binding not found'; END IF;
  v_trimmed := btrim(NEW.wallet_address, E' \t\n\r\f\v');
  IF v_trimmed = '' THEN RAISE EXCEPTION 'wallet address is required'; END IF;
  v_identity := CASE WHEN v_is_evm THEN lower(v_trimmed) ELSE v_trimmed END;
  IF NEW.address_identity <> v_identity THEN
    RAISE EXCEPTION 'wallet address comparison identity mismatch';
  END IF;
  NEW.wallet_address := v_trimmed;
  IF NEW.kind = 'STAKING' AND v_is_token THEN
    RAISE EXCEPTION 'staking address requires a native binding';
  END IF;
  v_lock_group := CASE WHEN NEW.kind IN ('HOT','COLD')
    THEN 'LIQUID' ELSE 'STAKING' END;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.currency_chain_id::text || ':' || v_lock_group, 910001::bigint));
  SELECT count(*) INTO v_count FROM wallet_core.custody_addresses existing
  WHERE existing.currency_chain_id = NEW.currency_chain_id AND existing.kind = NEW.kind
    AND (TG_OP = 'INSERT' OR existing.id <> NEW.id);
  IF v_count >= 10000 THEN RAISE EXCEPTION 'custody address kind limit exceeded'; END IF;
  IF NEW.kind IN ('HOT','COLD') AND EXISTS (
    SELECT 1 FROM wallet_core.custody_addresses existing
    WHERE existing.currency_chain_id = NEW.currency_chain_id
      AND existing.address_identity = NEW.address_identity
      AND existing.kind = CASE WHEN NEW.kind = 'HOT'
        THEN 'COLD'::wallet_core."WalletAddressKind"
        ELSE 'HOT'::wallet_core."WalletAddressKind" END
      AND (TG_OP = 'INSERT' OR existing.id <> NEW.id)
  ) THEN RAISE EXCEPTION 'wallet address cannot be both HOT and COLD'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER custody_addresses_guard
BEFORE INSERT OR UPDATE ON wallet_core.custody_addresses
FOR EACH ROW EXECUTE FUNCTION wallet_core.guard_custody_address();

CREATE FUNCTION wallet_core.validate_reconciliation_price_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
DECLARE
  v_valuation_at TIMESTAMPTZ;
BEGIN
  IF NEW.price_resolution_id IS NULL THEN RETURN NEW; END IF;
  SELECT run.valuation_at INTO v_valuation_at
  FROM wallet_core.wallet_reconciliation_runs run WHERE run.id = NEW.run_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM price_conversion.price_resolutions resolution
    JOIN price_conversion.price_snapshots snapshot
      ON snapshot.id = resolution.effective_snapshot_id
      AND snapshot.currency_id = resolution.currency_id
      AND snapshot.provider_id = resolution.effective_provider_id
      AND snapshot.price_usd = resolution.effective_price_usd
      AND snapshot.observed_at = resolution.observed_at
    JOIN price_conversion.price_providers provider
      ON provider.id = resolution.effective_provider_id
    WHERE resolution.id = NEW.price_resolution_id
      AND resolution.currency_id = NEW.currency_id
      AND resolution.effective_snapshot_id = NEW.price_snapshot_id
      AND snapshot.id = NEW.price_snapshot_id
      AND provider.code = NEW.price_provider
      AND resolution.effective_price_usd = NEW.price_usd
      AND resolution.observed_at = NEW.price_observed_at
      AND resolution.reason = NEW.price_resolution_reason
      AND NOT resolution.stale
      AND resolution.reason IN (
        'PRIMARY_CONFIRMED', 'RECOVERED', 'FALLBACK_PRIMARY_FAILED', 'FALLBACK_DIVERGENCE'
      )
      AND NEW.price_used_fallback = (
        resolution.reason IN ('FALLBACK_PRIMARY_FAILED', 'FALLBACK_DIVERGENCE')
      )
      AND resolution.created_at <= v_valuation_at
      AND resolution.observed_at <= v_valuation_at
  ) THEN
    RAISE EXCEPTION 'reconciliation price evidence mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_reconciliation_items_price_evidence_guard
BEFORE INSERT ON wallet_core.wallet_reconciliation_items
FOR EACH ROW EXECUTE FUNCTION wallet_core.validate_reconciliation_price_evidence();

CREATE FUNCTION wallet_core.validate_reconciliation_component() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
DECLARE
  v_item_currency UUID;
  v_binding_currency UUID;
  v_address_binding UUID;
  v_address_kind TEXT;
  v_binance_reference TEXT;
  v_stake_sum NUMERIC(38,18);
BEGIN
  SELECT item.currency_id INTO v_item_currency
  FROM wallet_core.wallet_reconciliation_items item WHERE item.id = NEW.run_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation item not found'; END IF;

  IF NEW.kind = 'BINANCE' THEN
    SELECT setting.binance_reference INTO v_binance_reference
    FROM wallet_core.currency_settings setting WHERE setting.currency_id = v_item_currency;
    IF NOT FOUND OR NEW.binance_reference IS DISTINCT FROM v_binance_reference THEN
      RAISE EXCEPTION 'reconciliation Binance reference mismatch' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT binding.currency_id INTO v_binding_currency
    FROM wallet_core.currencies binding WHERE binding.id = NEW.currency_chain_id;
    SELECT address.currency_chain_id, address.kind::text
      INTO v_address_binding, v_address_kind
    FROM wallet_core.custody_addresses address WHERE address.id = NEW.custody_address_id;
    IF v_binding_currency IS DISTINCT FROM v_item_currency
      OR v_address_binding IS DISTINCT FROM NEW.currency_chain_id
      OR v_address_kind IS DISTINCT FROM NEW.kind::text THEN
      RAISE EXCEPTION 'custody address ownership mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.kind = 'STAKING' AND NEW.selected_balance IS NOT NULL THEN
    v_stake_sum := NEW.total_admin_stake_balance + NEW.total_admin_manual_stake_balance;
    IF NEW.total_balance = v_stake_sum THEN
      IF NEW.selected_balance <> NEW.total_balance OR NEW.stake_total_mismatch
        OR NEW.stake_selected_source <> 'REPORTED_TOTAL' THEN
        RAISE EXCEPTION 'staking reported total evidence mismatch' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.selected_balance <> v_stake_sum OR NOT NEW.stake_total_mismatch
      OR NEW.stake_selected_source <> 'COMPONENT_SUM' THEN
      RAISE EXCEPTION 'staking component sum evidence mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_reconciliation_components_evidence_guard
BEFORE INSERT ON wallet_core.wallet_reconciliation_components
FOR EACH ROW EXECUTE FUNCTION wallet_core.validate_reconciliation_component();

CREATE FUNCTION wallet_core.validate_reconciliation_attempt_set() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
DECLARE
  v_component_id UUID;
  v_attempts_used INTEGER;
  v_selected_balance NUMERIC(38,18);
  v_count BIGINT;
  v_max_ordinal INTEGER;
  v_success_count BIGINT;
  v_terminal_success_count BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'wallet_reconciliation_components' THEN
    v_component_id := NEW.id;
  ELSE
    v_component_id := NEW.component_id;
  END IF;
  SELECT component.attempts_used, component.selected_balance
    INTO v_attempts_used, v_selected_balance
  FROM wallet_core.wallet_reconciliation_components component
  WHERE component.id = v_component_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), max(attempt_ordinal),
      count(*) FILTER (WHERE outcome = 'SUCCESS'),
      count(*) FILTER (WHERE outcome = 'SUCCESS' AND attempt_ordinal = v_attempts_used)
    INTO v_count, v_max_ordinal, v_success_count, v_terminal_success_count
  FROM wallet_core.wallet_reconciliation_attempts attempt
  WHERE attempt.component_id = v_component_id;
  IF v_count <> v_attempts_used OR v_max_ordinal IS DISTINCT FROM v_attempts_used THEN
    RAISE EXCEPTION 'reconciliation attempt count mismatch' USING ERRCODE = '23514';
  END IF;
  IF (v_selected_balance IS NULL AND v_success_count <> 0)
    OR (v_selected_balance IS NOT NULL
      AND (v_success_count <> 1 OR v_terminal_success_count <> 1)) THEN
    RAISE EXCEPTION 'reconciliation attempt outcome mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER wallet_reconciliation_components_attempt_set_guard
AFTER INSERT ON wallet_core.wallet_reconciliation_components
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION wallet_core.validate_reconciliation_attempt_set();
CREATE CONSTRAINT TRIGGER wallet_reconciliation_attempts_set_guard
AFTER INSERT ON wallet_core.wallet_reconciliation_attempts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION wallet_core.validate_reconciliation_attempt_set();

CREATE FUNCTION wallet_core.validate_reconciliation_buckets() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
DECLARE
  v_item_id UUID;
  v_status wallet_core."WalletReconciliationItemStatus";
  v_item_hot_cold NUMERIC(38,18);
  v_item_staking NUMERIC(38,18);
  v_item_binance NUMERIC(38,18);
  v_hot_cold NUMERIC;
  v_staking NUMERIC;
  v_binance NUMERIC;
  v_failed BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'wallet_reconciliation_items' THEN
    IF TG_OP = 'DELETE' THEN v_item_id := OLD.id; ELSE v_item_id := NEW.id; END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      v_item_id := OLD.run_item_id;
    ELSE
      v_item_id := NEW.run_item_id;
    END IF;
  END IF;
  SELECT item.status, item.hot_cold_balance, item.staking_balance, item.binance_balance
    INTO v_status, v_item_hot_cold, v_item_staking, v_item_binance
  FROM wallet_core.wallet_reconciliation_items item WHERE item.id = v_item_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT
      COALESCE(sum(selected_balance) FILTER (
        WHERE kind IN ('HOT','COLD') AND selected_balance IS NOT NULL), 0),
      COALESCE(sum(selected_balance) FILTER (
        WHERE kind = 'STAKING' AND selected_balance IS NOT NULL), 0),
      COALESCE(sum(selected_balance) FILTER (
        WHERE kind = 'BINANCE' AND selected_balance IS NOT NULL), 0),
      count(*) FILTER (WHERE selected_balance IS NULL)
    INTO v_hot_cold, v_staking, v_binance, v_failed
  FROM wallet_core.wallet_reconciliation_components component
  WHERE component.run_item_id = v_item_id;
  IF v_item_hot_cold IS DISTINCT FROM v_hot_cold
    OR v_item_staking IS DISTINCT FROM v_staking
    OR v_item_binance IS DISTINCT FROM v_binance THEN
    RAISE EXCEPTION 'reconciliation item bucket evidence mismatch' USING ERRCODE = '23514';
  END IF;
  IF v_status = 'COMPLETE' AND v_failed <> 0 THEN
    RAISE EXCEPTION 'complete reconciliation item contains failed component'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER wallet_reconciliation_items_bucket_guard
AFTER INSERT OR UPDATE OR DELETE ON wallet_core.wallet_reconciliation_items
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION wallet_core.validate_reconciliation_buckets();
CREATE CONSTRAINT TRIGGER wallet_reconciliation_components_bucket_guard
AFTER INSERT OR UPDATE OR DELETE ON wallet_core.wallet_reconciliation_components
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION wallet_core.validate_reconciliation_buckets();

CREATE FUNCTION wallet_core.validate_reconciliation_run_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, wallet_core AS $$
DECLARE
  v_run_id UUID;
  v_status wallet_core."WalletReconciliationRunStatus";
  v_items BIGINT;
  v_partial BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'wallet_reconciliation_runs' THEN
    v_run_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_run_id := OLD.run_id;
  ELSE
    v_run_id := NEW.run_id;
  END IF;
  SELECT run.status INTO v_status FROM wallet_core.wallet_reconciliation_runs run
  WHERE run.id = v_run_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), count(*) FILTER (WHERE item.status = 'PARTIAL')
    INTO v_items, v_partial
  FROM wallet_core.wallet_reconciliation_items item WHERE item.run_id = v_run_id;
  IF (v_status = 'FAILED' AND v_items <> 0)
    OR (v_status = 'SUCCESS' AND (v_items = 0 OR v_partial <> 0))
    OR (v_status = 'PARTIAL' AND (v_items = 0 OR v_partial = 0)) THEN
    RAISE EXCEPTION 'reconciliation run status does not match its items';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER wallet_reconciliation_runs_status_guard
AFTER INSERT OR UPDATE ON wallet_core.wallet_reconciliation_runs
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION wallet_core.validate_reconciliation_run_status();
CREATE CONSTRAINT TRIGGER wallet_reconciliation_items_status_guard
AFTER INSERT OR UPDATE OR DELETE ON wallet_core.wallet_reconciliation_items
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION wallet_core.validate_reconciliation_run_status();

CREATE TRIGGER configuration_changes_guard
BEFORE INSERT OR UPDATE ON wallet_core.configuration_changes
FOR EACH ROW EXECUTE FUNCTION wallet_core.guard_configuration_change_update();
CREATE TRIGGER configuration_changes_no_delete
BEFORE DELETE ON wallet_core.configuration_changes
FOR EACH ROW EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER configuration_changes_no_truncate
BEFORE TRUNCATE ON wallet_core.configuration_changes
FOR EACH STATEMENT EXECUTE FUNCTION wallet_core.reject_immutable_history_change();

CREATE TRIGGER wallet_notification_outbox_insert_update_guard
BEFORE INSERT OR UPDATE ON wallet_core.wallet_notification_outbox
FOR EACH ROW EXECUTE FUNCTION wallet_core.guard_wallet_notification_outbox_update();
CREATE TRIGGER wallet_notification_outbox_no_delete
BEFORE DELETE ON wallet_core.wallet_notification_outbox
FOR EACH ROW EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER wallet_notification_outbox_no_truncate
BEFORE TRUNCATE ON wallet_core.wallet_notification_outbox
FOR EACH STATEMENT EXECUTE FUNCTION wallet_core.reject_immutable_history_change();

CREATE TRIGGER wallet_alerts_insert_update_guard
BEFORE INSERT OR UPDATE ON wallet_core.wallet_alerts
FOR EACH ROW EXECUTE FUNCTION wallet_core.guard_wallet_alert_update();
CREATE TRIGGER wallet_alerts_payload_guard
BEFORE INSERT OR UPDATE ON wallet_core.wallet_alerts
FOR EACH ROW EXECUTE FUNCTION wallet_core.validate_wallet_alert_payload();
CREATE TRIGGER wallet_alerts_no_delete
BEFORE DELETE ON wallet_core.wallet_alerts
FOR EACH ROW EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER wallet_alerts_no_truncate
BEFORE TRUNCATE ON wallet_core.wallet_alerts
FOR EACH STATEMENT EXECUTE FUNCTION wallet_core.reject_immutable_history_change();

CREATE TRIGGER delisting_executions_insert_update_guard
BEFORE INSERT OR UPDATE ON wallet_core.delisting_executions
FOR EACH ROW EXECUTE FUNCTION wallet_core.guard_delisting_execution_update();
CREATE TRIGGER delisting_executions_no_delete
BEFORE DELETE ON wallet_core.delisting_executions
FOR EACH ROW EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER delisting_executions_no_truncate
BEFORE TRUNCATE ON wallet_core.delisting_executions
FOR EACH STATEMENT EXECUTE FUNCTION wallet_core.reject_immutable_history_change();

CREATE TRIGGER cronjob_runs_lease_guard
BEFORE INSERT OR UPDATE ON wallet_core.cronjob_runs
FOR EACH ROW EXECUTE FUNCTION wallet_core.guard_cronjob_run_lease();
CREATE TRIGGER cronjob_runs_no_delete
BEFORE DELETE ON wallet_core.cronjob_runs
FOR EACH ROW EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER cronjob_runs_no_truncate
BEFORE TRUNCATE ON wallet_core.cronjob_runs
FOR EACH STATEMENT EXECUTE FUNCTION wallet_core.reject_immutable_history_change();

CREATE TRIGGER state_events_append_only
BEFORE UPDATE OR DELETE ON wallet_core.state_events
FOR EACH ROW EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER state_events_no_truncate
BEFORE TRUNCATE ON wallet_core.state_events
FOR EACH STATEMENT EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER wallet_alert_events_append_only
BEFORE UPDATE OR DELETE ON wallet_core.wallet_alert_events
FOR EACH ROW EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER wallet_alert_events_payload_guard
BEFORE INSERT ON wallet_core.wallet_alert_events
FOR EACH ROW EXECUTE FUNCTION wallet_core.validate_wallet_alert_payload();
CREATE TRIGGER wallet_alert_events_no_truncate
BEFORE TRUNCATE ON wallet_core.wallet_alert_events
FOR EACH STATEMENT EXECUTE FUNCTION wallet_core.reject_immutable_history_change();

CREATE TRIGGER wallet_reconciliation_runs_append_only
BEFORE UPDATE OR DELETE ON wallet_core.wallet_reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER wallet_reconciliation_runs_no_truncate
BEFORE TRUNCATE ON wallet_core.wallet_reconciliation_runs
FOR EACH STATEMENT EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER wallet_reconciliation_items_append_only
BEFORE UPDATE OR DELETE ON wallet_core.wallet_reconciliation_items
FOR EACH ROW EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER wallet_reconciliation_items_no_truncate
BEFORE TRUNCATE ON wallet_core.wallet_reconciliation_items
FOR EACH STATEMENT EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER wallet_reconciliation_components_append_only
BEFORE UPDATE OR DELETE ON wallet_core.wallet_reconciliation_components
FOR EACH ROW EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER wallet_reconciliation_components_no_truncate
BEFORE TRUNCATE ON wallet_core.wallet_reconciliation_components
FOR EACH STATEMENT EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER wallet_reconciliation_attempts_append_only
BEFORE UPDATE OR DELETE ON wallet_core.wallet_reconciliation_attempts
FOR EACH ROW EXECUTE FUNCTION wallet_core.reject_immutable_history_change();
CREATE TRIGGER wallet_reconciliation_attempts_no_truncate
BEFORE TRUNCATE ON wallet_core.wallet_reconciliation_attempts
FOR EACH STATEMENT EXECUTE FUNCTION wallet_core.reject_immutable_history_change();

INSERT INTO wallet_core.legacy_currency_chain_codes
  (currency_id, chain_code, blockchain_precision)
SELECT currency.id, btrim(chain_code), currency.decimals
FROM price_conversion.currencies currency
CROSS JOIN LATERAL unnest(currency.chain_codes) chain_code
WHERE btrim(chain_code) <> ''
ON CONFLICT (currency_id, chain_code) DO NOTHING;

INSERT INTO wallet_core.currency_settings (
  currency_id, binance_reference, logo_object_key, view_currency_enabled,
  geo_countries, geo_continents, access_level, available_for, listing_kind,
  listing_start_at, delist_at, show_before_listing, premium_early_access_at,
  premium_early_access_ops, so_early_access_at, so_early_access_ops,
  desired_state, post_delist_ops, after_delist_mode, auto_exchange_to_currency_id,
  auto_exchange_fee_bps, leave_days, after_leave_action,
  after_leave_to_currency_id, after_leave_fee_bps, legacy_access_policy,
  legacy_delist_policy
)
SELECT currency.id, currency.binance_symbol, currency.logo_storage_key, currency.viewable,
  currency.geo_countries, currency.geo_continents,
  (CASE WHEN currency.kyc_required AND currency.access_level::text = 'ALL'
    THEN 'KYC_L1' ELSE currency.access_level::text END)::wallet_core."WalletAccessLevel",
  currency.available_for::text::wallet_core."WalletAvailability",
  currency.listing_kind::text::wallet_core."WalletListingKind", currency.listing_start_at,
  currency.delist_at, currency.show_before_listing, currency.early_access_at,
  currency.premium_early_access_ops, currency.so_early_access_at,
  currency.so_early_access_ops,
  CASE currency.listing_state::text WHEN 'LISTED' THEN 'ON'::wallet_core."WalletDesiredState"
    WHEN 'MAINTAIN' THEN 'MAINTAIN'::wallet_core."WalletDesiredState"
    ELSE 'OFF'::wallet_core."WalletDesiredState" END,
  currency.post_delist_ops, currency.after_delist_mode::text,
  currency.auto_exchange_to_currency_id,
  currency.auto_exchange_fee_bps, currency.leave_days,
  currency.after_leave_mode::text, currency.after_leave_auto_exchange_to_currency_id,
  currency.after_leave_auto_exchange_fee_bps, currency.access_audience,
  currency.delist_policy
FROM price_conversion.currencies currency;

DO $precision$
BEGIN
  IF EXISTS (SELECT 1 FROM price_conversion.currencies WHERE decimals < 0 OR decimals > 18) THEN
    RAISE EXCEPTION 'currency precision is not a valid non-negative blockchain precision';
  END IF;
END;
$precision$;
UPDATE price_conversion.currencies SET decimals = 18 WHERE decimals <> 18;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE price_conversion.currencies
  ADD CONSTRAINT currencies_site_precision CHECK (decimals = 18);
ALTER TABLE price_conversion.currencies RENAME COLUMN status TO pricing_status;
CREATE OR REPLACE FUNCTION price_conversion.require_active_crypto_provider_ref() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, price_conversion
AS $$
DECLARE
  current_kind price_conversion."CurrencyKind";
  current_status price_conversion."CurrencyStatus";
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.kind IS NOT DISTINCT FROM OLD.kind
    AND NEW.pricing_status IS NOT DISTINCT FROM OLD.pricing_status THEN
    RETURN NULL;
  END IF;

  SELECT kind, pricing_status INTO current_kind, current_status
  FROM price_conversion.currencies WHERE id = NEW.id;

  IF current_kind = 'CRYPTO' AND current_status = 'ACTIVE'
    AND NOT EXISTS (
      SELECT 1 FROM price_conversion.currency_provider_refs reference
      WHERE reference.currency_id = NEW.id AND reference.active
    ) THEN
    RAISE EXCEPTION 'ACTIVE CRYPTO requires an active provider reference';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION price_conversion.require_active_crypto_provider_ref() FROM PUBLIC;

CREATE OR REPLACE FUNCTION price_conversion.require_active_crypto_ref_after_mutation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, price_conversion
AS $$
DECLARE
  old_currency_id UUID;
  new_currency_id UUID;
  affected_currency_id UUID;
BEGIN
  old_currency_id := OLD.currency_id;
  IF TG_OP = 'UPDATE' THEN
    new_currency_id := NEW.currency_id;
  END IF;

  FOR affected_currency_id IN
    SELECT DISTINCT id FROM unnest(ARRAY[old_currency_id, new_currency_id]) AS ids(id)
    WHERE id IS NOT NULL
  LOOP
    IF EXISTS (
      SELECT 1 FROM price_conversion.currencies c
      WHERE c.id = affected_currency_id AND c.kind = 'CRYPTO'
        AND c.pricing_status = 'ACTIVE'
    ) AND NOT EXISTS (
      SELECT 1 FROM price_conversion.currency_provider_refs r
      WHERE r.currency_id = affected_currency_id AND r.active
    ) THEN
      RAISE EXCEPTION 'ACTIVE CRYPTO requires an active provider reference';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION price_conversion.require_active_crypto_ref_after_mutation() FROM PUBLIC;

CREATE OR REPLACE FUNCTION price_conversion.resolve_money_batch_for_ledger(currency_ids UUID[])
RETURNS TABLE (
  resolution_id UUID,
  currency_id UUID,
  price_usd NUMERIC(38,18),
  provider TEXT,
  snapshot_id UUID,
  observed_at TIMESTAMPTZ,
  kind TEXT,
  stale BOOLEAN,
  disabled BOOLEAN,
  security_state TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, price_conversion
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (r.currency_id) r.*
    FROM price_conversion.price_resolutions r
    WHERE r.currency_id = ANY(currency_ids)
    ORDER BY r.currency_id, r.created_at DESC, r.id DESC
  )
  SELECT
    r.id,
    r.currency_id,
    r.effective_price_usd,
    effective.code::text,
    r.effective_snapshot_id,
    r.observed_at,
    c.kind::text,
    r.stale,
    c.pricing_status = 'DISABLED' OR c.auto_disabled,
    settings.security_state::text
  FROM latest r
  JOIN price_conversion.currencies c
    ON c.id = r.currency_id
    AND c.kind = 'CRYPTO'
    AND c.pricing_status = 'ACTIVE'
    AND NOT c.auto_disabled
  JOIN price_conversion.price_providers effective
    ON effective.id = r.effective_provider_id AND effective.enabled
  JOIN price_conversion.price_providers primary_provider
    ON primary_provider.enabled AND primary_provider.sensitive_role = 'PRIMARY'
  JOIN price_conversion.price_providers comparison_provider
    ON comparison_provider.enabled AND comparison_provider.sensitive_role = 'COMPARISON'
  JOIN price_conversion.price_providers fallback_provider
    ON fallback_provider.enabled AND fallback_provider.sensitive_role = 'FALLBACK'
  JOIN price_conversion.price_snapshots snapshot
    ON snapshot.id = r.effective_snapshot_id
    AND snapshot.currency_id = r.currency_id
    AND snapshot.provider_id = r.effective_provider_id
    AND snapshot.price_usd = r.effective_price_usd
    AND snapshot.observed_at = r.observed_at
  CROSS JOIN price_conversion.price_settings settings
  WHERE NOT r.stale
    AND settings.security_state = 'HEALTHY'
    AND r.config_revision = settings.revision
    AND r.configured_primary_provider_id = primary_provider.id
    AND r.configured_comparison_provider_id = comparison_provider.id
    AND r.configured_fallback_provider_id = fallback_provider.id
    AND (
      (r.reason IN ('PRIMARY_CONFIRMED', 'RECOVERED')
        AND r.effective_provider_id = primary_provider.id)
      OR (r.reason IN ('FALLBACK_PRIMARY_FAILED', 'FALLBACK_DIVERGENCE')
        AND r.effective_provider_id = fallback_provider.id)
    )
    AND snapshot.observed_at >= statement_timestamp()
      - make_interval(secs => effective.freshness_seconds)
    AND snapshot.observed_at <= statement_timestamp() + interval '60 seconds'
  ORDER BY r.currency_id
$$;

REVOKE ALL ON FUNCTION price_conversion.resolve_money_batch_for_ledger(UUID[]) FROM PUBLIC;

-- TASK 8 LEGACY CURRENCY UPSERTS START
ALTER TABLE price_conversion.price_config_changes
  DISABLE TRIGGER price_config_changes_update_guard;

UPDATE price_conversion.price_config_changes
SET config = config - 'currencyUpserts'
WHERE status IN ('DRAFT', 'SCHEDULED')
  AND config ? 'currencyUpserts'
  AND CASE WHEN jsonb_typeof(config->'currencyUpserts') = 'array'
    THEN jsonb_array_length(config->'currencyUpserts') = 0
    ELSE false END;

UPDATE price_conversion.price_config_changes
SET status = 'REJECTED'
WHERE status IN ('DRAFT', 'SCHEDULED')
  AND config ? 'currencyUpserts'
  AND NOT CASE WHEN jsonb_typeof(config->'currencyUpserts') = 'array'
    THEN jsonb_array_length(config->'currencyUpserts') = 0
    ELSE false END;

ALTER TABLE price_conversion.price_config_changes
  ENABLE TRIGGER price_config_changes_update_guard;
-- TASK 8 LEGACY CURRENCY UPSERTS END


INSERT INTO wallet_core.wallet_settings
  (id, default_view_currency_id, default_crypto_currency_id)
VALUES (
  true,
  (SELECT id FROM price_conversion.currencies
    WHERE symbol = 'USD' AND kind = 'FIAT' LIMIT 1),
  (SELECT id FROM price_conversion.currencies
    WHERE symbol = 'BTC' AND kind = 'CRYPTO' LIMIT 1)
);

COMMIT;
