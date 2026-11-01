-- Chat Module 5: commands and advertising.
--  - chat.user_mutes / chat.user_blocks: /mute and /block (Chat MAIN, Chat SETTINGS "/mute", "/block").
--  - chat.chat_commands: an append-only log of every command run or refused, with ids and amounts only.
--  - chat.chat_ads and chat.chat_ad_placements: chat-message ads and the pinned-ad queue per room. Never deleted:
--    a cancelled or refunded ad keeps its row for billing and audit.
--  - chat.gift_transfers: /send and /gift initiated from chat; the money moves in the transfer module.
--  - Two message types: AD (an ad posted into a room) and GIFT (the chat notice of a completed gift).
--
-- Rollback: DROP the six tables. Postgres cannot drop an enum value: leave AD and GIFT in chat."MessageType"
-- (no row uses them once the tables are gone).

ALTER TYPE "chat"."MessageType" ADD VALUE IF NOT EXISTS 'AD';
ALTER TYPE "chat"."MessageType" ADD VALUE IF NOT EXISTS 'GIFT';

-- ─── Mute and block ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat"."user_mutes" (
    "user_id"    UUID NOT NULL,
    "target_id"  UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "user_mutes_pkey" PRIMARY KEY ("user_id", "target_id"),
    CONSTRAINT "user_mutes_not_self_check" CHECK ("user_id" <> "target_id")
);
CREATE INDEX "user_mutes_target_id_idx" ON "chat"."user_mutes" ("target_id");
ALTER TABLE "chat"."user_mutes" ADD CONSTRAINT "user_mutes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat"."user_mutes" ADD CONSTRAINT "user_mutes_target_id_fkey"
    FOREIGN KEY ("target_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "chat"."user_blocks" (
    "user_id"    UUID NOT NULL,
    "target_id"  UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("user_id", "target_id"),
    CONSTRAINT "user_blocks_not_self_check" CHECK ("user_id" <> "target_id")
);
CREATE INDEX "user_blocks_target_id_idx" ON "chat"."user_blocks" ("target_id");
ALTER TABLE "chat"."user_blocks" ADD CONSTRAINT "user_blocks_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat"."user_blocks" ADD CONSTRAINT "user_blocks_target_id_fkey"
    FOREIGN KEY ("target_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Command log (append-only) ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat"."chat_commands" (
    "id"         UUID NOT NULL,
    "user_id"    UUID NOT NULL,
    "room_id"    UUID,
    "command"    TEXT NOT NULL,
    "args"       JSONB NOT NULL DEFAULT '{}',
    "result"     TEXT NOT NULL,
    "reason"     TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "chat_commands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chat_commands_result_check" CHECK ("result" IN ('EXECUTED', 'REFUSED'))
);
CREATE INDEX "chat_commands_user_id_created_at_idx" ON "chat"."chat_commands" ("user_id", "created_at" DESC);
CREATE INDEX "chat_commands_created_at_idx" ON "chat"."chat_commands" ("created_at" DESC);

-- ─── Ads ──────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat"."chat_ads" (
    "id"               UUID NOT NULL,
    "creator_id"       UUID,
    "creator_admin_id" UUID,
    "content"          TEXT NOT NULL,
    "room_ids"         UUID[] NOT NULL,
    "all_rooms"        BOOLEAN NOT NULL DEFAULT false,
    "pin_minutes"      INTEGER,
    "repeat_count"     INTEGER NOT NULL DEFAULT 0,
    "repeat_gap_min"   INTEGER,
    "posted_count"     INTEGER NOT NULL DEFAULT 0,
    "next_post_at"     TIMESTAMPTZ,
    "hidden_countries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "badge_id"         TEXT,
    "price_usd"        DECIMAL(18,8) NOT NULL DEFAULT 0,
    "breakdown"        JSONB NOT NULL DEFAULT '[]',
    "charge_reference" TEXT,
    "status"           TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    "ended_at"         TIMESTAMPTZ,
    "cancelled_by"     UUID,
    "cancel_note"      TEXT,
    "refund_usd"       DECIMAL(18,8),
    "refunded_at"      TIMESTAMPTZ,

    CONSTRAINT "chat_ads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chat_ads_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'REFUNDED')),
    CONSTRAINT "chat_ads_creator_check" CHECK ("creator_id" IS NOT NULL OR "creator_admin_id" IS NOT NULL)
);
CREATE INDEX "chat_ads_creator_id_created_at_idx" ON "chat"."chat_ads" ("creator_id", "created_at" DESC);
CREATE INDEX "chat_ads_status_next_post_at_idx" ON "chat"."chat_ads" ("status", "next_post_at");
CREATE INDEX "chat_ads_created_at_idx" ON "chat"."chat_ads" ("created_at" DESC);
ALTER TABLE "chat"."chat_ads" ADD CONSTRAINT "chat_ads_creator_id_fkey"
    FOREIGN KEY ("creator_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One row per pinned slot of one ad in one room: QUEUED, then ACTIVE (starts_at / ends_at on the database clock),
-- then DONE; CANCELLED when the ad is cancelled before its turn ends.
CREATE TABLE "chat"."chat_ad_placements" (
    "id"         UUID NOT NULL,
    "ad_id"      UUID NOT NULL,
    "room_id"    UUID NOT NULL,
    "minutes"    INTEGER NOT NULL,
    "status"     TEXT NOT NULL DEFAULT 'QUEUED',
    "starts_at"  TIMESTAMPTZ,
    "ends_at"    TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "chat_ad_placements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chat_ad_placements_status_check" CHECK ("status" IN ('QUEUED', 'ACTIVE', 'DONE', 'CANCELLED')),
    CONSTRAINT "chat_ad_placements_minutes_check" CHECK ("minutes" > 0)
);
CREATE INDEX "chat_ad_placements_room_id_status_created_at_idx"
    ON "chat"."chat_ad_placements" ("room_id", "status", "created_at");
CREATE INDEX "chat_ad_placements_ad_id_idx" ON "chat"."chat_ad_placements" ("ad_id");
ALTER TABLE "chat"."chat_ad_placements" ADD CONSTRAINT "chat_ad_placements_ad_id_fkey"
    FOREIGN KEY ("ad_id") REFERENCES "chat"."chat_ads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."chat_ad_placements" ADD CONSTRAINT "chat_ad_placements_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "chat"."rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Gifts (/send, /gift and the DM gift button) ──────────────────────────────────────────────────────────────────
CREATE TABLE "chat"."gift_transfers" (
    "id"                 UUID NOT NULL,
    "sender_id"          UUID NOT NULL,
    "recipient_id"       UUID NOT NULL,
    "currency"           TEXT NOT NULL,
    "amount"             DECIMAL(36,18) NOT NULL,
    "usd_value"          DECIMAL(18,8),
    "fee_amount"         DECIMAL(36,18),
    "room_id"            UUID,
    "conversation_id"    UUID,
    "verification"       TEXT NOT NULL,
    "status"             TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "transfer_reference" TEXT,
    "failure_reason"     TEXT,
    "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "expires_at"         TIMESTAMPTZ NOT NULL,
    "completed_at"       TIMESTAMPTZ,

    CONSTRAINT "gift_transfers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gift_transfers_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "gift_transfers_not_self_check" CHECK ("sender_id" <> "recipient_id"),
    CONSTRAINT "gift_transfers_verification_check" CHECK ("verification" IN ('PAYMENT_PIN', 'TWO_FA')),
    CONSTRAINT "gift_transfers_status_check"
        CHECK ("status" IN ('PENDING_VERIFICATION', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'))
);
CREATE INDEX "gift_transfers_sender_id_created_at_idx" ON "chat"."gift_transfers" ("sender_id", "created_at" DESC);
CREATE INDEX "gift_transfers_recipient_id_created_at_idx"
    ON "chat"."gift_transfers" ("recipient_id", "created_at" DESC);
ALTER TABLE "chat"."gift_transfers" ADD CONSTRAINT "gift_transfers_sender_id_fkey"
    FOREIGN KEY ("sender_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."gift_transfers" ADD CONSTRAINT "gift_transfers_recipient_id_fkey"
    FOREIGN KEY ("recipient_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
