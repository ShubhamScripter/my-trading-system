BEGIN;
CREATE TYPE wallet_core."WalletLogoAssetState" AS ENUM ('STAGING','PENDING','ATTACHED','DELETE_PENDING','DELETED');
CREATE TABLE wallet_core.wallet_logo_assets (
  object_key VARCHAR(69) PRIMARY KEY,
  state wallet_core."WalletLogoAssetState" NOT NULL DEFAULT 'STAGING',
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ(6) NOT NULL,
  uploaded_at TIMESTAMPTZ(6), attached_at TIMESTAMPTZ(6),
  cleanup_token UUID, cleanup_lease_expires_at TIMESTAMPTZ(6),
  delete_attempt_count INTEGER NOT NULL DEFAULT 0, deleted_at TIMESTAMPTZ(6),
  CONSTRAINT wallet_logo_assets_key CHECK (object_key ~ '^[0-9a-f]{64}\.webp$'),
  CONSTRAINT wallet_logo_assets_expiry CHECK (expires_at = created_at + interval '24 hours'),
  CONSTRAINT wallet_logo_assets_delete_count CHECK (delete_attempt_count >= 0)
);
CREATE TABLE wallet_core.wallet_logo_asset_references (
  configuration_change_id UUID NOT NULL REFERENCES wallet_core.configuration_changes(id),
  object_key VARCHAR(69) NOT NULL REFERENCES wallet_core.wallet_logo_assets(object_key),
  attached_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (configuration_change_id,object_key)
);
CREATE INDEX wallet_logo_assets_cleanup_idx ON wallet_core.wallet_logo_assets
  (state,expires_at,object_key) WHERE state IN ('STAGING','PENDING','DELETE_PENDING');
CREATE INDEX wallet_logo_asset_references_key_idx ON wallet_core.wallet_logo_asset_references(object_key);
GRANT SELECT,INSERT,UPDATE ON wallet_core.wallet_logo_assets,wallet_core.wallet_logo_asset_references
  TO orebit_wallet_core_admin_writer;
COMMIT;
