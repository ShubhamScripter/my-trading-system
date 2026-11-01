-- Chat Modules 8-9 hardening (handoff FR-090, FR-126, FR-128, FR-131, FR-171, FR-177, FR-197, FR-203, FR-229, FR-235).
--  - dm_messages: a client message id is unique per conversation and sender (was: per sender across all
--    conversations, so a reused id silently dropped a message in another conversation).
--  - dm_conversations(last_message_at): the inbox sort.
--  - user_chat_preferences.typing_receipts_enabled: the one switch for "typing..." and read receipts (V2-43).
--  - dm_groups.closed_at: a group whose last member left is closed (kept, not deleted).
--  - dm_groups.admin_manageable: the permissions the owner lets group admins change (V2-49).
--  - dm_group_bans.banned_by_role: rank of who banned, so only someone above can lift it.
--  - one OWNER per group, one pending invite per person and group, one pending transfer per group (database rules,
--    so parallel requests cannot create two).
--
-- Rollback: drop the added columns and indexes; recreate dm_messages_sender_id_client_message_id_key
-- ON chat.dm_messages (sender_id, client_message_id).

DROP INDEX IF EXISTS "chat"."dm_messages_sender_id_client_message_id_key";
CREATE UNIQUE INDEX "dm_messages_conversation_id_sender_id_client_message_id_key"
    ON "chat"."dm_messages" ("conversation_id", "sender_id", "client_message_id");

CREATE INDEX "dm_conversations_last_message_at_idx"
    ON "chat"."dm_conversations" ("last_message_at" DESC);

ALTER TABLE "chat"."user_chat_preferences"
    ADD COLUMN "typing_receipts_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "chat"."dm_groups"
    ADD COLUMN "closed_at"        TIMESTAMPTZ,
    ADD COLUMN "admin_manageable" JSONB NOT NULL DEFAULT '[]';

-- Old bans have no recorded rank: treat them as the highest, so nobody below can lift them by accident.
ALTER TABLE "chat"."dm_group_bans"
    ADD COLUMN "banned_by_role" TEXT NOT NULL DEFAULT 'OWNER';
ALTER TABLE "chat"."dm_group_bans" ADD CONSTRAINT "dm_group_bans_banned_by_role_check"
    CHECK ("banned_by_role" IN ('OWNER', 'ADMIN', 'SUB_ADMIN', 'MEMBER'));

-- A second OWNER row can never exist; a member who leaves or is removed gives up the role in the same statement.
UPDATE "chat"."dm_members" SET "role" = 'MEMBER' WHERE "role" <> 'MEMBER' AND "state" <> 'ACTIVE';
CREATE UNIQUE INDEX "dm_members_one_owner_per_group_key"
    ON "chat"."dm_members" ("conversation_id") WHERE "role" = 'OWNER';

-- Two pending invites for the same person and group collapse to the newest before the rule is added.
UPDATE "chat"."dm_group_invites" i SET "status" = 'REVOKED', "responded_at" = now()
WHERE i."status" = 'PENDING' AND EXISTS (
    SELECT 1 FROM "chat"."dm_group_invites" n
    WHERE n."conversation_id" = i."conversation_id" AND n."invitee_id" = i."invitee_id"
      AND n."status" = 'PENDING' AND (n."created_at", n."id") > (i."created_at", i."id"));
CREATE UNIQUE INDEX "dm_group_invites_one_pending_key"
    ON "chat"."dm_group_invites" ("conversation_id", "invitee_id") WHERE "status" = 'PENDING';

UPDATE "chat"."dm_ownership_transfers" t SET "status" = 'CANCELLED'
WHERE t."status" = 'PENDING' AND EXISTS (
    SELECT 1 FROM "chat"."dm_ownership_transfers" n
    WHERE n."conversation_id" = t."conversation_id" AND n."status" = 'PENDING'
      AND (n."created_at", n."id") > (t."created_at", t."id"));
CREATE UNIQUE INDEX "dm_ownership_transfers_one_pending_key"
    ON "chat"."dm_ownership_transfers" ("conversation_id") WHERE "status" = 'PENDING';
