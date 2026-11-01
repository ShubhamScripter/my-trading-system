-- Scope device trust per (user, browser) instead of per browser.
--
-- ─── The bug ────────────────────────────────────────────────────────────────
--
-- `ux_trusted_devices_token_active` was UNIQUE (token_hash) WHERE revoked_at IS
-- NULL — one live trust per BROWSER COOKIE, across all accounts. But the cookie is
-- one per browser profile and a trust is per account, so a shared browser could
-- only ever remember one person.
--
-- What actually happened on a shared machine: Alice ticks "remember this device"
-- and gets a row. Bob ticks it, and `DeviceDbOperation.trust` — revoking by
-- `token_hash` alone, because the index forced it to — revokes ALICE'S trust in
-- order to insert his own. Alice's sessions keep their `remember_until` and their
-- `trusted_device_id`, both now pointing at a revoked row, so on her next refresh
-- `honourTrust` finds Bob's trust instead, sees a different `user_id`, and silently
-- drops her to the 24-hour idle window. She asked to be remembered for a week, was
-- signed out the next day, and nothing anywhere reported it.
--
-- Failing safe rather than dangerously — Alice never inherits Bob's trust — but
-- still wrong, and invisible.
--
-- ─── The fix ────────────────────────────────────────────────────────────────
--
-- Uniqueness moves to (user_id, token_hash). Two people may each hold a live trust
-- on one browser, which is what the feature always meant, and `trust` can revoke
-- only the caller's own row.
--
-- Still partial on `revoked_at IS NULL`, for the reason the old index was: a
-- revoked trust is kept for the audit trail, and a plain constraint would let one
-- historical row bar its owner from ever re-trusting that browser.

-- Dropped rather than left in place. It is strictly narrower than the replacement,
-- so leaving it would keep enforcing exactly the rule being removed.
DROP INDEX IF EXISTS "identity"."ux_trusted_devices_token_active";

-- The replacement is also declared in db/sql/identity.sql, which is applied after
-- every migration and is where the partial indexes live. Created here as well so a
-- database migrated by this file alone is correct at this point in the sequence
-- rather than only after the SQL pass.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_trusted_devices_user_token_active"
  ON "identity"."trusted_devices" ("user_id", "token_hash")
  WHERE "revoked_at" IS NULL;
