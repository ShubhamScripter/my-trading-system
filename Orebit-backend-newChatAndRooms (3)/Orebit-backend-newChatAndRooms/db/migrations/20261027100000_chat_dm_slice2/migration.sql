-- Chat Modules 8-9, slice 2 (handoff V2-44, V2-46, V2-61, V2-113, V2-114, V2-121, V2-135).
--  - dm_conversations.started_with_follower: when a user starts a new DM, whether the other person follows them. The
--    new-DM limit is counted separately for followers and for non-followers (V2-61).
--  - dm_groups.is_channel: a channel (only admins post) is a group with its own limits; it is public or private (V2-135).
--  - dm_group_invites.expires_at: an invite lives for an admin-set time (V2-121).
--  - index for "invites per inviter in a window".
--
-- Rollback: drop the three columns and the index.

ALTER TABLE "chat"."dm_conversations" ADD COLUMN "started_with_follower" BOOLEAN;

ALTER TABLE "chat"."dm_groups" ADD COLUMN "is_channel" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "chat"."dm_group_invites" ADD COLUMN "expires_at" TIMESTAMPTZ;

CREATE INDEX "dm_group_invites_inviter_id_created_at_idx"
    ON "chat"."dm_group_invites" ("inviter_id", "created_at" DESC);
