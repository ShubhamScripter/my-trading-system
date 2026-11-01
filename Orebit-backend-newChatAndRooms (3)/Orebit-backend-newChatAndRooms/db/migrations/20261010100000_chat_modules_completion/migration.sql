-- Chat Modules 4–5 completion (Chat SETTINGS):
--  - RESTRICT_RECEIVE_GIFTS: "Restrict a user from receiving Amount through chat".
--  - chat.room_included_users: "Change chat Room access for user (Remove / Add user from specific rooms)" — the Add
--    half; removal is chat.room_excluded_users.
--  - Gifts can be reverted ("Revert ALL Transfers for a Specific Time Frame"): an admin marks them, the chat server
--    asks the transfer module and records the outcome ("If the user doesn't have enough balance, revert will not be
--    conducted").
--  - Ads keep their skin, and ads and gifts keep the EXP and universal currency they earned ("Universal Currency and
--    EXP"), so a revert can take them back ("Reverting will also revert EXP and Stars Earned").
--
-- Rollback: DROP TABLE chat.room_included_users; drop the added columns; restore the two CHECK constraints below to
-- their 20261009 lists.

ALTER TABLE "chat"."user_restrictions" DROP CONSTRAINT "user_restrictions_kind_check";
ALTER TABLE "chat"."user_restrictions" ADD CONSTRAINT "user_restrictions_kind_check" CHECK ("kind" IN (
    'MUTE', 'RESTRICT_MEDIA', 'RESTRICT_EMOJI', 'RESTRICT_GIF', 'RESTRICT_COMMANDS', 'RESTRICT_ADS',
    'RESTRICT_DM', 'RESTRICT_GIFTS', 'RESTRICT_RECEIVE_GIFTS'));

-- ─── Room access: adding a user to a room ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat"."room_included_users" (
    "room_id"          UUID NOT NULL,
    "user_id"          UUID NOT NULL,
    "created_by"       UUID,
    "created_by_admin" UUID,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "room_included_users_pkey" PRIMARY KEY ("room_id", "user_id")
);
CREATE INDEX "room_included_users_user_id_idx" ON "chat"."room_included_users" ("user_id");
ALTER TABLE "chat"."room_included_users" ADD CONSTRAINT "room_included_users_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "chat"."rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat"."room_included_users" ADD CONSTRAINT "room_included_users_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Gift reverts and rewards ─────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "chat"."gift_transfers" DROP CONSTRAINT "gift_transfers_status_check";
ALTER TABLE "chat"."gift_transfers" ADD CONSTRAINT "gift_transfers_status_check" CHECK ("status" IN (
    'PENDING_VERIFICATION', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED',
    'REVERT_PENDING', 'REVERTED', 'REVERT_FAILED'));
ALTER TABLE "chat"."gift_transfers"
    ADD COLUMN "revert_refund_fees"  BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "revert_requested_by" UUID,
    ADD COLUMN "revert_requested_at" TIMESTAMPTZ,
    ADD COLUMN "reverted_at"         TIMESTAMPTZ,
    ADD COLUMN "rewards"             JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "rewards_revoked_at"  TIMESTAMPTZ;
CREATE INDEX "gift_transfers_status_idx" ON "chat"."gift_transfers" ("status");

-- ─── Ad skins and rewards ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "chat"."chat_ads"
    ADD COLUMN "skin_id"            TEXT,
    ADD COLUMN "rewards"            JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "revert_rewards"     BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "rewards_revoked_at" TIMESTAMPTZ;
