-- Chat Module 8: direct messages (Chat MAIN "Personal Chat", Chat DM Settings).
--  - chat.dm_conversations: one row per conversation. A DIRECT conversation has a `direct_key` (the two user ids in
--    order) so two people never get two conversations. GROUP conversations (Module 9) reuse this table.
--  - chat.dm_members: each member's own view of a conversation — folder (Primary / General / Groups), request state,
--    pinned person, nickname, notification setting, read position and group role.
--  - chat.dm_messages: messages are never deleted (Chat SETTINGS "No chat messages will be deleted"): a retract keeps
--    the row for admins, a group admin's delete hides it from members only.
--  - Privacy and notification preferences on chat.user_chat_preferences; NULL = the admin default.
--  - chat.test_entitlements.follows: the test-only stand-in follow list (NEW-2) until a follow module exists.
--  - Reports may name a DM message.
--
-- Rollback: drop chat.dm_messages, chat.dm_members, chat.dm_conversations; drop the added columns.

CREATE TABLE "chat"."dm_conversations" (
    "id"              UUID NOT NULL,
    "kind"            TEXT NOT NULL,
    "direct_key"      TEXT,
    "created_by"      UUID NOT NULL,
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    "last_message_at" TIMESTAMPTZ,

    CONSTRAINT "dm_conversations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dm_conversations_kind_check" CHECK ("kind" IN ('DIRECT', 'GROUP')),
    CONSTRAINT "dm_conversations_direct_key_check" CHECK (("kind" = 'DIRECT') = ("direct_key" IS NOT NULL))
);
CREATE UNIQUE INDEX "dm_conversations_direct_key_key" ON "chat"."dm_conversations" ("direct_key");
CREATE INDEX "dm_conversations_created_by_created_at_idx"
    ON "chat"."dm_conversations" ("created_by", "created_at" DESC);
ALTER TABLE "chat"."dm_conversations" ADD CONSTRAINT "dm_conversations_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "chat"."dm_members" (
    "conversation_id"      UUID NOT NULL,
    "user_id"              UUID NOT NULL,
    "role"                 TEXT NOT NULL DEFAULT 'MEMBER',
    "state"                TEXT NOT NULL DEFAULT 'ACTIVE',
    "folder"               TEXT NOT NULL,
    "folder_chosen"        BOOLEAN NOT NULL DEFAULT false,
    "pinned_at"            TIMESTAMPTZ,
    "nickname"             TEXT,
    "notifications"        TEXT NOT NULL DEFAULT 'DEFAULT',
    "last_read_message_id" UUID,
    "last_read_at"         TIMESTAMPTZ,
    "timeout_until"        TIMESTAMPTZ,
    "joined_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "dm_members_pkey" PRIMARY KEY ("conversation_id", "user_id"),
    CONSTRAINT "dm_members_role_check" CHECK ("role" IN ('OWNER', 'ADMIN', 'SUB_ADMIN', 'MEMBER')),
    CONSTRAINT "dm_members_state_check"
        CHECK ("state" IN ('ACTIVE', 'REQUEST', 'DECLINED', 'LEFT', 'REMOVED', 'BANNED')),
    CONSTRAINT "dm_members_folder_check" CHECK ("folder" IN ('PRIMARY', 'GENERAL', 'GROUPS')),
    CONSTRAINT "dm_members_notifications_check" CHECK ("notifications" IN ('DEFAULT', 'ON', 'OFF')),
    CONSTRAINT "dm_members_nickname_check" CHECK ("nickname" IS NULL OR length("nickname") BETWEEN 1 AND 32)
);
CREATE INDEX "dm_members_user_id_state_folder_idx" ON "chat"."dm_members" ("user_id", "state", "folder");
ALTER TABLE "chat"."dm_members" ADD CONSTRAINT "dm_members_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "chat"."dm_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."dm_members" ADD CONSTRAINT "dm_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "chat"."dm_messages" (
    "id"                UUID NOT NULL,
    "conversation_id"   UUID NOT NULL,
    "sender_id"         UUID NOT NULL,
    "content"           TEXT NOT NULL,
    "type"              TEXT NOT NULL DEFAULT 'TEXT',
    "metadata"          JSONB NOT NULL DEFAULT '{}',
    "client_message_id" UUID,
    "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
    "retracted_at"      TIMESTAMPTZ,
    "retracted_by"      UUID,
    "hidden_at"         TIMESTAMPTZ,
    "hidden_by"         UUID,
    "pinned_at"         TIMESTAMPTZ,
    "pinned_by"         UUID,

    CONSTRAINT "dm_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dm_messages_type_check" CHECK ("type" IN ('TEXT', 'MEDIA', 'GIFT', 'SYSTEM'))
);
CREATE INDEX "dm_messages_conversation_id_created_at_id_idx"
    ON "chat"."dm_messages" ("conversation_id", "created_at" DESC, "id" DESC);
CREATE UNIQUE INDEX "dm_messages_sender_id_client_message_id_key"
    ON "chat"."dm_messages" ("sender_id", "client_message_id");
ALTER TABLE "chat"."dm_messages" ADD CONSTRAINT "dm_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "chat"."dm_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Privacy and notification preferences ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "chat"."user_chat_preferences"
    ADD COLUMN "last_seen_visibility"     TEXT,
    ADD COLUMN "common_groups_visibility" TEXT,
    ADD COLUMN "notify_primary"           BOOLEAN,
    ADD COLUMN "notify_general"           BOOLEAN,
    ADD COLUMN "notify_groups"            BOOLEAN,
    ADD COLUMN "quiet_mode"               TEXT,
    ADD COLUMN "quiet_start"              TEXT,
    ADD COLUMN "quiet_end"                TEXT,
    ADD COLUMN "time_zone"                TEXT;
ALTER TABLE "chat"."user_chat_preferences" ADD CONSTRAINT "user_chat_preferences_visibility_check"
    CHECK (("last_seen_visibility" IS NULL OR "last_seen_visibility" IN ('ALL', 'FRIENDS', 'NOBODY'))
       AND ("common_groups_visibility" IS NULL OR "common_groups_visibility" IN ('ALL', 'FRIENDS', 'NOBODY'))
       AND ("quiet_mode" IS NULL OR "quiet_mode" IN ('AUTO_NIGHT', 'OFF', 'CUSTOM')));

-- ─── Test-only follow list (NEW-2) ────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "chat"."test_entitlements" ADD COLUMN "follows" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

-- ─── Reports may name a DM message ────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "chat"."chat_message_reports" ADD COLUMN "dm_message_id" UUID;
ALTER TABLE "chat"."chat_message_reports" ADD CONSTRAINT "chat_message_reports_dm_message_id_fkey"
    FOREIGN KEY ("dm_message_id") REFERENCES "chat"."dm_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "chat_message_reports_dm_message_reporter_key"
    ON "chat"."chat_message_reports" ("dm_message_id", "reporter_id");
-- A report of a user (no message of either kind) may be repeated only after the previous one was resolved.
DROP INDEX IF EXISTS "chat"."chat_message_reports_user_reporter_pending_key";
CREATE UNIQUE INDEX "chat_message_reports_user_reporter_pending_key"
    ON "chat"."chat_message_reports" ("reported_user_id", "reporter_id")
    WHERE "message_id" IS NULL AND "dm_message_id" IS NULL AND "status" = 'PENDING';
