-- Chat: one room contract that both backends read, chat-wide settings with per-country exceptions and named
-- regions, one access rule per room, KYC level, premium plans, excluded site
-- owners, and room configs cleaned of settings for features that are not built.
--
-- Scope follows the requirement PDFs (Chat MAIN / Chat SETTINGS): VIP rooms, the minimum level to chat and the
-- per-room visibility control are kept and enforced; the VIP room type stays and CONTINENT is added.
--
-- Rollback: rebuild chat."RoomType" without CONTINENT, restore the dropped rule columns from the room configs, drop
-- chat.settings, chat.regions and chat.room_excluded_users, drop the unique rule index. Room configs are rewritten by
-- this migration; keep a copy (SELECT id, config FROM chat.rooms) before running it in any shared environment.

-- ─── 1. Room types: CONTINENT added, VIP kept ─────────────────────────────────────────────────────────────────────
ALTER TYPE "chat"."RoomType" RENAME TO "RoomType_old";
CREATE TYPE "chat"."RoomType" AS ENUM
    ('GLOBAL', 'COUNTRY', 'CONTINENT', 'REGION', 'LANGUAGE', 'PREMIUM', 'VIP', 'KYC', 'CASINO', 'SO', 'STAFF');
ALTER TABLE "chat"."rooms" ALTER COLUMN "type" DROP DEFAULT;
ALTER TABLE "chat"."rooms" ALTER COLUMN "type" TYPE "chat"."RoomType" USING "type"::text::"chat"."RoomType";
ALTER TABLE "chat"."rooms" ALTER COLUMN "type" SET DEFAULT 'GLOBAL';
DROP TYPE "chat"."RoomType_old";

-- The seeded continent rooms were stored as REGION.
UPDATE "chat"."rooms" SET "type" = 'CONTINENT'
WHERE "type" = 'REGION' AND "slug" IN ('asia-hub', 'europe-lounge', 'americas-hub');

-- A room made VIP-only through its config is a VIP room.
UPDATE "chat"."rooms" SET "type" = 'VIP'
WHERE "type" = 'PREMIUM'
  AND ("config"->>'requireVip' = 'true' OR "config"->'accessSettings'->>'requireVip' = 'true');

ALTER TABLE "chat"."rooms" ALTER COLUMN "created_at" SET DEFAULT now();

-- ─── 2. One access rule per room ──────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  removed RECORD;
BEGIN
  FOR removed IN
    DELETE FROM "chat"."room_access_rules" a
    USING "chat"."room_access_rules" b
    WHERE a."room_id" = b."room_id" AND a."id" > b."id"
    RETURNING a."id", a."room_id"
  LOOP
    RAISE NOTICE 'chat: removed duplicate access rule % of room %', removed."id", removed."room_id";
  END LOOP;
END;
$$;

DROP INDEX IF EXISTS "chat"."room_access_rules_room_id_idx";
CREATE UNIQUE INDEX "room_access_rules_room_id_key" ON "chat"."room_access_rules" ("room_id");

-- ─── 3. Access rule columns ───────────────────────────────────────────────────────────────────────────────────────
-- What an ineligible viewer gets: read-only, nothing (room hidden), or only promotions (no user messages).
CREATE TYPE "chat"."IneligibleMode" AS ENUM ('VIEW_ONLY', 'HIDE', 'PROMO_ONLY');

ALTER TABLE "chat"."room_access_rules"
    ADD COLUMN "require_vip"          BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "min_kyc_level"        INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "allowed_plan_ids"     TEXT[]  NOT NULL DEFAULT '{}',
    ADD COLUMN "ineligible_mode"      "chat"."IneligibleMode" NOT NULL DEFAULT 'VIEW_ONLY',
    ADD COLUMN "visibility_groups"    TEXT[]  NOT NULL DEFAULT '{}',
    ADD COLUMN "visibility_min_level" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "region_id"            UUID;

-- VIP: from the rule's own config, the room config, or the admin form's accessSettings copy.
UPDATE "chat"."room_access_rules" ar
SET "require_vip" = true
FROM "chat"."rooms" r
WHERE r."id" = ar."room_id"
  AND (ar."config"->>'requireVip' = 'true'
       OR r."config"->>'requireVip' = 'true'
       OR r."config"->'accessSettings'->>'requireVip' = 'true');

-- KYC: the yes/no gate becomes a minimum KYC level.
UPDATE "chat"."room_access_rules" SET "min_kyc_level" = 1 WHERE "require_kyc" = true;

-- Ineligible behaviour: the admin form's choice, else the old boolean (false meant hidden).
UPDATE "chat"."room_access_rules" ar
SET "ineligible_mode" = CASE
      WHEN r."config"->'accessSettings'->>'ineligibleBehavior' IN ('VIEW_ONLY', 'HIDE', 'PROMO_ONLY')
        THEN (r."config"->'accessSettings'->>'ineligibleBehavior')::"chat"."IneligibleMode"
      WHEN ar."is_view_only_for_others" = false THEN 'HIDE'::"chat"."IneligibleMode"
      ELSE 'VIEW_ONLY'::"chat"."IneligibleMode"
    END
FROM "chat"."rooms" r
WHERE r."id" = ar."room_id";

-- Visibility (Chat SETTINGS "Chat Room Controls: Visibility: ALL / Specific"): the admin form stored one group.
UPDATE "chat"."room_access_rules" ar
SET "visibility_groups" = ARRAY[r."config"->'contentControls'->>'visibility']
FROM "chat"."rooms" r
WHERE r."id" = ar."room_id"
  AND r."config"->'contentControls'->>'visibility' IN ('PREMIUM', 'VIP', 'STAFF', 'KYC', 'SO');

UPDATE "chat"."room_access_rules" SET "allowed_countries" = '{}' WHERE "allowed_countries" IS NULL;
ALTER TABLE "chat"."room_access_rules" ALTER COLUMN "allowed_countries" SET DEFAULT '{}';
ALTER TABLE "chat"."room_access_rules" ALTER COLUMN "allowed_countries" SET NOT NULL;

-- Removed: the yes/no KYC gate (now a level), the invented premium tier ladder (now admin plans), the
-- view-only country list and the merchant flag (neither is in the requirements; the SO room type decides), the old
-- boolean (now ineligible_mode) and the rule's free-form JSON.
ALTER TABLE "chat"."room_access_rules"
    DROP COLUMN "require_kyc",
    DROP COLUMN "require_min_premium_tier",
    DROP COLUMN "view_only_countries",
    DROP COLUMN "require_merchant",
    DROP COLUMN "is_view_only_for_others",
    DROP COLUMN "config";
DROP TYPE "identity"."PremiumTier";

-- ─── 4. Named regions (Chat SETTINGS "Create Custom Region Type Chat Room") ───────────────────────────────────────
CREATE TABLE "chat"."regions" (
    "id"         UUID NOT NULL,
    "name"       TEXT NOT NULL,
    "countries"  CHAR(2)[] NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "regions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "regions_name_key" ON "chat"."regions" ("name");

ALTER TABLE "chat"."room_access_rules" ADD CONSTRAINT "room_access_rules_region_id_fkey"
    FOREIGN KEY ("region_id") REFERENCES "chat"."regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 5. Chat-wide settings: global values plus per-country exceptions ───────────────────────────────────
-- An empty document means "every default"; the defaults live in the chat contract (chat.contract.ts), which both
-- backends validate against.
CREATE TABLE "chat"."settings" (
    "id"         SMALLINT NOT NULL DEFAULT 1,
    "document"   JSONB NOT NULL DEFAULT '{"global":{},"countries":{}}',
    "version"    INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settings_single_row" CHECK ("id" = 1)
);
INSERT INTO "chat"."settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;

-- ─── 6. Site owners an admin has barred from a Site-Owner room ──────────────────────────────────────────
CREATE TABLE "chat"."room_excluded_users" (
    "room_id"    UUID NOT NULL,
    "user_id"    UUID NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "room_excluded_users_pkey" PRIMARY KEY ("room_id", "user_id")
);
ALTER TABLE "chat"."room_excluded_users" ADD CONSTRAINT "room_excluded_users_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "chat"."rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat"."room_excluded_users" ADD CONSTRAINT "room_excluded_users_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 7. Room configs: one shape, safe defaults, nothing for unbuilt features ─────────────────────────────────────
-- Kept keys: status, statusNote, statusUntil, language, rules, contentControls, linksPolicy, bannedWords,
-- spamProtection, autoBanSequence, userRestrictions, casino.onlyUsersOnCasino.
UPDATE "chat"."rooms"
SET "config" = jsonb_strip_nulls(jsonb_build_object(
      'status',          COALESCE("config"->>'status', CASE WHEN "deleted_at" IS NOT NULL THEN 'DISABLED' ELSE 'ACTIVE' END),
      'language',        CASE WHEN length(trim("config"->>'language')) BETWEEN 1 AND 50 THEN trim("config"->>'language') END,
      'rules',           COALESCE("config"->'rulesText', "config"->'rules', '[]'::jsonb),
      'contentControls', jsonb_build_object(
                           'allowText',      COALESCE(("config"->'contentControls'->>'allowText')::boolean, true),
                           'allowEmoji',     COALESCE(("config"->'contentControls'->>'allowEmoji')::boolean, true),
                           'allowGif',       COALESCE(("config"->'contentControls'->>'allowGif')::boolean, true),
                           'allowImage',     COALESCE(("config"->'contentControls'->>'allowImage')::boolean, false),
                           'allowVideo',     COALESCE(("config"->'contentControls'->>'allowVideo')::boolean, false),
                           'autoModeration', COALESCE(("config"->'contentControls'->>'autoModeration')::boolean, true),
                           -- Money commands and ads are not built (Module 5); off everywhere until they are.
                           'allowCommands',  false,
                           'allowAds',       false),
      'linksPolicy',     CASE WHEN "config"->>'linksPolicy' IN ('OREBIT_ONLY', 'NO_LINKS', 'ALL_LINKS') THEN "config"->>'linksPolicy' END,
      'bannedWords',     COALESCE("config"->'bannedWords', '[]'::jsonb),
      'spamProtection',  "config"->'spamProtection',
      'autoBanSequence', "config"->'autoBanSequence',
      'userRestrictions', COALESCE((
                           SELECT jsonb_agg(jsonb_build_object(
                                    'targetType',  entry->>'targetType',
                                    'targetValue', left(entry->>'targetValue', 64),
                                    'restriction', entry->>'restriction',
                                    'reason',      COALESCE(NULLIF(trim(entry->>'reason'), ''), 'Restricted by an admin'),
                                    -- The end is database time; null means permanent.
                                    'expiresAt',   CASE
                                                     WHEN (entry->>'durationHours') ~ '^[0-9]+(\.[0-9]+)?$'
                                                      AND (entry->>'durationHours')::float8 > 0
                                                      AND (entry->>'createdAt') ~ '^\d{4}-\d{2}-\d{2}T'
                                                     THEN to_jsonb((entry->>'createdAt')::timestamptz
                                                          + make_interval(secs => (entry->>'durationHours')::float8 * 3600))
                                                     ELSE 'null'::jsonb
                                                   END))
                           FROM jsonb_array_elements(COALESCE("config"->'userRestrictions', '[]'::jsonb)) entry
                           -- Only the restrictions chat enforces; rain, commands, ads and DMs are not built.
                           -- Targets follow Chat SETTINGS "Restrict a Specific User / Group of Users [Premium, Lvl,
                           -- KYC OR Select Users]".
                           WHERE entry->>'restriction' IN ('MUTE', 'RESTRICT_MEDIA')
                             AND entry->>'targetType' IN ('USER', 'PREMIUM', 'KYC', 'LEVEL')
                             AND length(entry->>'targetValue') > 0
                         ), '[]'::jsonb),
      'casino',          CASE WHEN "type" = 'CASINO' THEN jsonb_build_object(
                           'onlyUsersOnCasino', COALESCE(("config"->'casinoSettings'->>'requireCasinoOpen')::boolean, true))
                         END
    ));

-- A disabled room is OFF, not deleted: 'off' and 'deleted' are separate. The admin used to set deleted_at
-- for OFF; those rooms get their deleted_at back to NULL and keep status DISABLED.
UPDATE "chat"."rooms" SET "deleted_at" = NULL WHERE "deleted_at" IS NOT NULL AND "config"->>'status' = 'DISABLED';
