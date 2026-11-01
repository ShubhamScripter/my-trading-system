-- Slice B (ads money): FR-016, FR-017, FR-106, FR-109, FR-182.
--
--  1. An ad is saved BEFORE it is paid (PENDING_PAYMENT) under the advertiser's idempotency key, then ACTIVE or FAILED;
--     the charge reference and the gift transfer reference are unique.
--  2. Every job table that is claimed has `claimed_at`, so a row left by a crashed worker is taken over (platform/jobs).
--  3. A pinned slot: at most one ACTIVE per room, enforced by the database.
--  4. The refund coin the advertiser picked.
--
-- Rollback: DROP the four indexes and the columns below; narrow chat_ads_status_check to the five old statuses after
-- moving PENDING_PAYMENT / FAILED rows (they hold no money that was taken) to CANCELLED.

-- 1. chat_ads
ALTER TABLE "chat"."chat_ads" DROP CONSTRAINT "chat_ads_status_check";
ALTER TABLE "chat"."chat_ads" ADD CONSTRAINT "chat_ads_status_check" CHECK ("status" IN (
    'PENDING_PAYMENT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'));
ALTER TABLE "chat"."chat_ads"
    ADD COLUMN "idempotency_key"     TEXT,
    ADD COLUMN "request_fingerprint" TEXT,
    ADD COLUMN "claimed_at"          TIMESTAMPTZ,
    ADD COLUMN "failure_reason"      TEXT,
    ADD COLUMN "refund_currency"     TEXT;
CREATE UNIQUE INDEX "chat_ads_creator_key_key" ON "chat"."chat_ads" ("creator_id", "idempotency_key")
    WHERE "idempotency_key" IS NOT NULL;
CREATE UNIQUE INDEX "chat_ads_charge_reference_key" ON "chat"."chat_ads" ("charge_reference")
    WHERE "charge_reference" IS NOT NULL;
CREATE INDEX "chat_ads_pending_payment_idx" ON "chat"."chat_ads" ("created_at") WHERE "status" = 'PENDING_PAYMENT';

-- 2. gifts and revert jobs
ALTER TABLE "chat"."gift_transfers"
    ADD COLUMN "processing_at" TIMESTAMPTZ,
    ADD COLUMN "claimed_at"    TIMESTAMPTZ;
CREATE UNIQUE INDEX "gift_transfers_transfer_reference_key" ON "chat"."gift_transfers" ("transfer_reference")
    WHERE "transfer_reference" IS NOT NULL;
-- A gift already PROCESSING has no start time: the sweeper counts it from now, not from never.
UPDATE "chat"."gift_transfers" SET "processing_at" = now() WHERE "status" = 'PROCESSING' AND "processing_at" IS NULL;

ALTER TABLE "chat"."money_revert_jobs"
    ADD COLUMN "claimed_at" TIMESTAMPTZ,
    ADD COLUMN "progress"   JSONB;

-- 3. one ACTIVE pinned slot per room. Rooms that already show two (the race this closes) keep the newest.
UPDATE "chat"."chat_ad_placements" p SET "status" = 'DONE', "ends_at" = COALESCE(p."ends_at", now())
 WHERE p."status" = 'ACTIVE' AND p."id" <> (
    SELECT q."id" FROM "chat"."chat_ad_placements" q
     WHERE q."room_id" = p."room_id" AND q."status" = 'ACTIVE'
     ORDER BY q."starts_at" DESC NULLS LAST, q."id" DESC LIMIT 1);
CREATE UNIQUE INDEX "chat_ad_placements_room_active_key" ON "chat"."chat_ad_placements" ("room_id")
    WHERE "status" = 'ACTIVE';
