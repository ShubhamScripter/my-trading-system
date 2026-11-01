BEGIN;
ALTER TABLE wallet_core.configuration_changes ADD COLUMN changelog_id UUID;
COMMIT;
