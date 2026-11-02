-- Add integrity checks omitted from the initial Module 5 migration.
-- Rollback: ALTER TABLE "chat"."gift_transfers" DROP CONSTRAINT "gift_transfers_revert_shortfall_check";
--           ALTER TABLE "chat"."chat_ads" DROP CONSTRAINT "chat_ads_kind_check";
--           ALTER TABLE "chat"."room_excluded_users" DROP COLUMN "created_by_admin";
ALTER TABLE "chat"."chat_ads"
    ADD CONSTRAINT "chat_ads_kind_check" CHECK ("kind" IN ('USER', 'INTERNAL', 'COMMERCIAL'));
ALTER TABLE "chat"."gift_transfers"
    ADD CONSTRAINT "gift_transfers_revert_shortfall_check"
    CHECK ("revert_shortfall" IS NULL OR "revert_shortfall" IN ('ZERO', 'NEGATIVE'));
ALTER TABLE "chat"."room_excluded_users" ADD COLUMN "created_by_admin" UUID;
