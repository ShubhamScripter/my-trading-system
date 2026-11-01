-- Chat Module 9: groups (Chat MAIN "Users can create groups", Chat DM Settings).
--  - chat.dm_groups: the group of a GROUP conversation — name, description, logo, public or private, owner, the
--    creator (a type change "will be still counted towards creator's limit"), "members can text", and which role
--    may do each delegable action.
--  - chat.dm_group_invites: invites; a private group is joined only through one.
--  - chat.dm_group_bans: bans from public groups.
--  - chat.dm_ownership_transfers: ownership moves only after the owner's 2FA proof, X times in Y hours.
--
-- Rollback: DROP TABLE chat.dm_ownership_transfers, chat.dm_group_bans, chat.dm_group_invites, chat.dm_groups.

CREATE TABLE "chat"."dm_groups" (
    "conversation_id"  UUID NOT NULL,
    "name"             TEXT NOT NULL,
    "description"      TEXT,
    "logo_url"         TEXT,
    "visibility"       TEXT NOT NULL,
    "owner_id"         UUID NOT NULL,
    "creator_id"       UUID NOT NULL,
    "created_public"   BOOLEAN NOT NULL,
    "members_can_text" BOOLEAN NOT NULL DEFAULT true,
    "permissions"      JSONB NOT NULL DEFAULT '{}',
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "dm_groups_pkey" PRIMARY KEY ("conversation_id"),
    CONSTRAINT "dm_groups_visibility_check" CHECK ("visibility" IN ('PUBLIC', 'PRIVATE')),
    CONSTRAINT "dm_groups_name_check" CHECK (length("name") BETWEEN 1 AND 64),
    CONSTRAINT "dm_groups_description_check" CHECK ("description" IS NULL OR length("description") <= 500)
);
CREATE INDEX "dm_groups_visibility_name_idx" ON "chat"."dm_groups" ("visibility", "name");
CREATE INDEX "dm_groups_creator_id_idx" ON "chat"."dm_groups" ("creator_id");
ALTER TABLE "chat"."dm_groups" ADD CONSTRAINT "dm_groups_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "chat"."dm_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."dm_groups" ADD CONSTRAINT "dm_groups_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "chat"."dm_group_invites" (
    "id"              UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "inviter_id"      UUID NOT NULL,
    "invitee_id"      UUID NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'PENDING',
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    "responded_at"    TIMESTAMPTZ,

    CONSTRAINT "dm_group_invites_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dm_group_invites_status_check" CHECK ("status" IN ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED'))
);
CREATE INDEX "dm_group_invites_invitee_id_status_idx" ON "chat"."dm_group_invites" ("invitee_id", "status");
CREATE INDEX "dm_group_invites_conversation_id_idx" ON "chat"."dm_group_invites" ("conversation_id");
ALTER TABLE "chat"."dm_group_invites" ADD CONSTRAINT "dm_group_invites_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "chat"."dm_groups"("conversation_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."dm_group_invites" ADD CONSTRAINT "dm_group_invites_invitee_id_fkey"
    FOREIGN KEY ("invitee_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "chat"."dm_group_bans" (
    "conversation_id" UUID NOT NULL,
    "user_id"         UUID NOT NULL,
    "banned_by"       UUID NOT NULL,
    "reason"          TEXT,
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "dm_group_bans_pkey" PRIMARY KEY ("conversation_id", "user_id")
);
ALTER TABLE "chat"."dm_group_bans" ADD CONSTRAINT "dm_group_bans_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "chat"."dm_groups"("conversation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "chat"."dm_ownership_transfers" (
    "id"              UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "from_user_id"    UUID NOT NULL,
    "to_user_id"      UUID NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'PENDING',
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    "expires_at"      TIMESTAMPTZ NOT NULL,
    "completed_at"    TIMESTAMPTZ,

    CONSTRAINT "dm_ownership_transfers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dm_ownership_transfers_status_check" CHECK ("status" IN ('PENDING', 'COMPLETED', 'CANCELLED'))
);
CREATE INDEX "dm_ownership_transfers_conversation_id_created_at_idx"
    ON "chat"."dm_ownership_transfers" ("conversation_id", "created_at" DESC);
ALTER TABLE "chat"."dm_ownership_transfers" ADD CONSTRAINT "dm_ownership_transfers_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "chat"."dm_groups"("conversation_id") ON DELETE RESTRICT ON UPDATE CASCADE;
