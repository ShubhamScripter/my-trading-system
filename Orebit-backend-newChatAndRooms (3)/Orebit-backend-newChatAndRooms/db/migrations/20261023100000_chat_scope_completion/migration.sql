-- Chat, the last items of the requirement PDFs inside chat's own scope. Additive only.
--  - Chat SETTINGS "ON / OFF / MAINTENANCE: ADS — When Turning to Maintain / Off Choose … After Maintenance": the ads
--    status the chat server last acted on, so each change is acted on once.
--  - "Revert ALL Transfers / Advertisements … [group of users]": reverts by group, checked by the chat server.
--  - Chat MAIN "SO / Merchants: separate chat folder for all merchant chats, sorted separately by apps".
-- (Scheduled room changes already use chat.settings_changes with target ROOM.)
--
-- Rollback: DROP TABLE chat.ads_state, chat.money_revert_jobs;
-- ALTER TABLE chat.dm_conversations DROP COLUMN merchant_app_id.

-- ─── ads: the status the chat server last acted on ───────────────────────────
CREATE TABLE "chat"."ads_state" (
    "id"             SMALLINT NOT NULL DEFAULT 1,
    "applied_status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "ads_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ads_state_single_row" CHECK ("id" = 1),
    CONSTRAINT "ads_state_status_check" CHECK ("applied_status" IN ('ACTIVE', 'MAINTENANCE', 'DISABLED'))
);
INSERT INTO "chat"."ads_state" ("id") VALUES (1) ON CONFLICT DO NOTHING;

-- ─── reverts by group of users ───────────────────────────────────────────────
-- `kind` GIFTS or ADS; `filter` is the admin's revert filter with its group (Premium, KYC or Level). Only the chat
-- server knows who is in a group, so it picks the transfers / ads and reverts them the usual way.
CREATE TABLE "chat"."money_revert_jobs" (
    "id"          UUID NOT NULL,
    "kind"        TEXT NOT NULL,
    "filter"      JSONB NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'PENDING',
    "result"      JSONB,
    "error"       TEXT,
    "created_by"  UUID NOT NULL,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    "started_at"  TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    CONSTRAINT "money_revert_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "money_revert_jobs_kind_check" CHECK ("kind" IN ('GIFTS', 'ADS')),
    CONSTRAINT "money_revert_jobs_status_check" CHECK ("status" IN ('PENDING', 'RUNNING', 'DONE', 'FAILED'))
);
CREATE INDEX "money_revert_jobs_pending_idx" ON "chat"."money_revert_jobs" ("created_at") WHERE "status" = 'PENDING';

-- ─── merchant chats by app ───────────────────────────────────────────────────
-- The merchant app a direct chat with a site owner was opened from; one conversation per user, merchant and app.
ALTER TABLE "chat"."dm_conversations" ADD COLUMN "merchant_app_id" TEXT;
ALTER TABLE "chat"."dm_conversations" ADD CONSTRAINT "dm_conversations_merchant_app_check"
    CHECK ("merchant_app_id" IS NULL OR ("kind" = 'DIRECT' AND "merchant_app_id" ~ '^[A-Za-z0-9_-]{1,64}$'));
CREATE INDEX "dm_conversations_merchant_app_idx" ON "chat"."dm_conversations" ("merchant_app_id")
    WHERE "merchant_app_id" IS NOT NULL;
