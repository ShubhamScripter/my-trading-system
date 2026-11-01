-- Slice F2 (penalties), FR-237: a removed mute, block, room-access entry, group ban or chat role is not erased.
--
-- Each row gets `removed_at` and `removed_by`; a removal marks the row, every read ignores removed rows, and a new row can
-- follow a removed one (the old key is now a UNIQUE index over the live rows only, so the history stays). Soft-deleted
-- rows do not count toward the mute and block caps (V2-34). A surrogate `id` becomes the primary key.
--
-- Rollback: delete the removed rows, drop the live-key indexes and the new columns, restore each old primary key.

ALTER TABLE "chat"."user_mutes" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN "removed_at" TIMESTAMPTZ, ADD COLUMN "removed_by" UUID;
ALTER TABLE "chat"."user_mutes" DROP CONSTRAINT "user_mutes_pkey";
ALTER TABLE "chat"."user_mutes" ADD CONSTRAINT "user_mutes_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX "user_mutes_live_key" ON "chat"."user_mutes" ("user_id", "target_id") WHERE "removed_at" IS NULL;

ALTER TABLE "chat"."user_blocks" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN "removed_at" TIMESTAMPTZ, ADD COLUMN "removed_by" UUID;
ALTER TABLE "chat"."user_blocks" DROP CONSTRAINT "user_blocks_pkey";
ALTER TABLE "chat"."user_blocks" ADD CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX "user_blocks_live_key" ON "chat"."user_blocks" ("user_id", "target_id") WHERE "removed_at" IS NULL;

ALTER TABLE "chat"."room_excluded_users" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN "removed_at" TIMESTAMPTZ, ADD COLUMN "removed_by" UUID;
ALTER TABLE "chat"."room_excluded_users" DROP CONSTRAINT "room_excluded_users_pkey";
ALTER TABLE "chat"."room_excluded_users" ADD CONSTRAINT "room_excluded_users_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX "room_excluded_users_live_key" ON "chat"."room_excluded_users" ("room_id", "user_id") WHERE "removed_at" IS NULL;

ALTER TABLE "chat"."room_included_users" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN "removed_at" TIMESTAMPTZ, ADD COLUMN "removed_by" UUID;
ALTER TABLE "chat"."room_included_users" DROP CONSTRAINT "room_included_users_pkey";
ALTER TABLE "chat"."room_included_users" ADD CONSTRAINT "room_included_users_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX "room_included_users_live_key" ON "chat"."room_included_users" ("room_id", "user_id") WHERE "removed_at" IS NULL;

ALTER TABLE "chat"."dm_group_bans" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN "removed_at" TIMESTAMPTZ, ADD COLUMN "removed_by" UUID;
ALTER TABLE "chat"."dm_group_bans" DROP CONSTRAINT "dm_group_bans_pkey";
ALTER TABLE "chat"."dm_group_bans" ADD CONSTRAINT "dm_group_bans_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX "dm_group_bans_live_key" ON "chat"."dm_group_bans" ("conversation_id", "user_id") WHERE "removed_at" IS NULL;

ALTER TABLE "chat"."staff_roles" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN "removed_at" TIMESTAMPTZ, ADD COLUMN "removed_by" UUID;
ALTER TABLE "chat"."staff_roles" DROP CONSTRAINT "staff_roles_pkey";
ALTER TABLE "chat"."staff_roles" ADD CONSTRAINT "staff_roles_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX "staff_roles_live_key" ON "chat"."staff_roles" ("user_id") WHERE "removed_at" IS NULL;

