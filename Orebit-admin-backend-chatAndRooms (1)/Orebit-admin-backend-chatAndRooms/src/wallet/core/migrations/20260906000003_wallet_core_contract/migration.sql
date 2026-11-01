BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM price_conversion.currencies currency
    LEFT JOIN wallet_core.currency_settings setting ON setting.currency_id=currency.id
    WHERE setting.currency_id IS NULL) THEN
    RAISE EXCEPTION 'wallet contract requires every currency setting' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM wallet_core.legacy_currency_chain_codes WHERE mapped_binding_id IS NULL) THEN
    RAISE EXCEPTION 'wallet contract requires every legacy chain binding' USING ERRCODE='23514';
  END IF;
END $$;

-- Task8 already renamed pricing_status and cleaned pending currencyUpserts. Only legacy columns remain.
ALTER TABLE price_conversion.currencies
  DROP COLUMN viewable, DROP COLUMN chain_codes, DROP COLUMN binance_symbol,
  DROP COLUMN logo_storage_key, DROP COLUMN geo_countries, DROP COLUMN geo_continents,
  DROP COLUMN kyc_required, DROP COLUMN access_level, DROP COLUMN available_for,
  DROP COLUMN access_audience, DROP COLUMN listing_kind, DROP COLUMN listing_start_at,
  DROP COLUMN show_before_listing, DROP COLUMN delist_at, DROP COLUMN early_access_at,
  DROP COLUMN premium_early_access_ops, DROP COLUMN so_early_access_at, DROP COLUMN so_early_access_ops,
  DROP COLUMN after_delist_mode, DROP COLUMN auto_exchange_to_currency_id, DROP COLUMN auto_exchange_fee_bps,
  DROP COLUMN leave_days, DROP COLUMN after_leave_mode, DROP COLUMN after_leave_auto_exchange_to_currency_id,
  DROP COLUMN after_leave_auto_exchange_fee_bps, DROP COLUMN post_delist_ops,
  DROP COLUMN delist_policy, DROP COLUMN listing_state;

DO $$ DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['orebit_wallet_core_admin_writer','orebit_wallet_core_user_writer',
    'orebit_wallet_core_lifecycle_writer','orebit_price_conversion_writer'] LOOP
    IF to_regrole(role_name) IS NULL THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT',role_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit))
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=to_regrole(role_name)) THEN
      RAISE EXCEPTION 'wallet capability role is not isolated' USING ERRCODE='23514';
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON SCHEMA wallet_core FROM PUBLIC;
REVOKE ALL ON SCHEMA price_conversion FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA wallet_core FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA price_conversion FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA wallet_core FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA price_conversion FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wallet_core FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA price_conversion FROM PUBLIC;
GRANT USAGE ON SCHEMA wallet_core TO orebit_wallet_core_admin_writer,
  orebit_wallet_core_user_writer,orebit_wallet_core_lifecycle_writer,orebit_price_conversion_writer;
GRANT USAGE ON SCHEMA price_conversion TO orebit_wallet_core_admin_writer,
  orebit_wallet_core_user_writer,orebit_wallet_core_lifecycle_writer,orebit_price_conversion_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA wallet_core TO orebit_wallet_core_admin_writer,
  orebit_wallet_core_user_writer,orebit_wallet_core_lifecycle_writer;
GRANT SELECT ON ALL TABLES IN SCHEMA price_conversion TO orebit_wallet_core_admin_writer,
  orebit_price_conversion_writer;
GRANT SELECT ON price_conversion.currencies,price_conversion.currency_provider_refs,
  price_conversion.price_settings,price_conversion.price_providers,price_conversion.price_snapshots,
  price_conversion.price_resolutions,price_conversion.price_view_fiats,
  price_conversion.price_view_snapshots,price_conversion.price_view_resolutions
  TO orebit_wallet_core_user_writer,orebit_wallet_core_lifecycle_writer;

GRANT INSERT,UPDATE ON wallet_core.chains,wallet_core.currencies,wallet_core.currency_settings,
  wallet_core.wallet_settings,wallet_core.configuration_changes,wallet_core.custody_addresses,
  wallet_core.legacy_currency_chain_codes,wallet_core.provider_catalogue_chains,
  wallet_core.provider_catalogue_currencies,wallet_core.admin_preferences TO orebit_wallet_core_admin_writer;
GRANT DELETE ON wallet_core.custody_addresses,wallet_core.provider_catalogue_chains,
  wallet_core.provider_catalogue_currencies TO orebit_wallet_core_admin_writer;
GRANT INSERT(id,symbol,name,decimals,kind,pricing_status,created_at,updated_at)
  ON price_conversion.currencies TO orebit_wallet_core_admin_writer;
GRANT UPDATE(symbol,name,decimals,kind,pricing_status,updated_at) ON price_conversion.currencies
  TO orebit_wallet_core_admin_writer;
GRANT INSERT,UPDATE,DELETE ON price_conversion.currency_provider_refs TO orebit_wallet_core_admin_writer;
GRANT INSERT,UPDATE ON wallet_core.user_preferences TO orebit_wallet_core_user_writer;

GRANT INSERT ON wallet_core.state_events,wallet_core.wallet_alert_events,
  wallet_core.wallet_reconciliation_runs,wallet_core.wallet_reconciliation_items,
  wallet_core.wallet_reconciliation_components,wallet_core.wallet_reconciliation_attempts
  TO orebit_wallet_core_lifecycle_writer;
GRANT INSERT,UPDATE ON wallet_core.delisting_executions,wallet_core.cronjob_runs,
  wallet_core.wallet_alerts,wallet_core.wallet_notification_outbox TO orebit_wallet_core_lifecycle_writer;
GRANT UPDATE(price_readiness,price_readiness_changed_at,updated_at) ON wallet_core.currency_settings
  TO orebit_wallet_core_lifecycle_writer;
GRANT INSERT ON wallet_core.state_events,wallet_core.wallet_alert_events TO orebit_wallet_core_admin_writer;
GRANT INSERT,UPDATE ON wallet_core.cronjob_runs,wallet_core.wallet_alerts,
  wallet_core.wallet_notification_outbox TO orebit_wallet_core_admin_writer;

GRANT UPDATE(auto_disabled) ON price_conversion.currencies TO orebit_price_conversion_writer;
GRANT INSERT ON price_conversion.price_snapshots,price_conversion.price_resolutions,
  price_conversion.price_view_snapshots,price_conversion.price_view_resolutions,
  price_conversion.price_admin_audit
  TO orebit_price_conversion_writer;
GRANT INSERT,UPDATE ON price_conversion.price_providers,price_conversion.price_settings,
  price_conversion.price_fetch_runs,price_conversion.price_view_fetch_buckets,
  price_conversion.price_provider_health,price_conversion.price_view_provider_health,
  price_conversion.price_provider_call_stats,
  price_conversion.price_view_fiats,price_conversion.price_admin_notifications,
  price_conversion.price_notification_dlq,price_conversion.price_config_changes
  TO orebit_price_conversion_writer;

CREATE FUNCTION wallet_core.timestamp_price_auto_disable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.auto_disabled IS DISTINCT FROM OLD.auto_disabled THEN NEW.updated_at := clock_timestamp(); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER currencies_auto_disable_timestamp BEFORE UPDATE OF auto_disabled ON price_conversion.currencies
FOR EACH ROW EXECUTE FUNCTION wallet_core.timestamp_price_auto_disable();
REVOKE ALL ON FUNCTION wallet_core.timestamp_price_auto_disable() FROM PUBLIC;

CREATE FUNCTION wallet_core.disable_delisted_pricing(execution_id UUID) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,wallet_core AS $$
DECLARE currency UUID;
BEGIN
  SELECT execution.currency_id INTO currency FROM wallet_core.delisting_executions execution WHERE execution.id=execution_id;
  IF currency IS NULL THEN RAISE EXCEPTION 'delisting execution missing' USING ERRCODE='23514'; END IF;
  -- Shared key with LedgerService: posting/finalization must coordinate across the physical transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended('ledger:currency:'||currency::text,0));
  PERFORM 1 FROM wallet_core.delisting_executions execution
    JOIN wallet_core.currency_settings setting ON setting.currency_id=execution.currency_id
    WHERE execution.id=execution_id AND execution.status='COMPLETED'
      AND execution.policy_revision=setting.policy_revision
      AND setting.after_delist_mode='LEAVE' AND setting.after_leave_action='LOSS'
      AND setting.leave_days IS NOT NULL AND setting.delist_at IS NOT NULL
      AND execution.deadline=setting.delist_at+setting.leave_days*interval '24 hours'
      AND execution.deadline<=clock_timestamp()
    FOR UPDATE OF execution,setting;
  IF NOT FOUND THEN RAISE EXCEPTION 'delisting completion policy mismatch' USING ERRCODE='23514'; END IF;
  UPDATE price_conversion.currencies SET pricing_status='DISABLED',updated_at=clock_timestamp()
    WHERE id=currency AND kind='CRYPTO';
  IF NOT FOUND THEN RAISE EXCEPTION 'delisting requires crypto identity' USING ERRCODE='23514'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION wallet_core.disable_delisted_pricing(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wallet_core.disable_delisted_pricing(UUID) TO orebit_wallet_core_lifecycle_writer;

COMMIT;
