-- Slice F1 (penalties): FR-088, FR-092.
--
--  1. A ban keeps the role its issuer had WHEN it was given (`moderator_role`), so demoting the issuer later never
--     lowers the rank of the ban. Existing bans take the issuer's role now, the best that is known.
--  2. A ban keeps its own audit note (`admin_note`), so the admin ban list reads it from the row instead of searching the
--     whole moderation log with a time window (which could also pick another ban's note). Existing admin bans take the
--     note of the action that names them by id.
--  3. A user named in a room's restriction list is stored by id: names and login codes already stored are resolved
--     now; one that matches nobody stays as it is and matches nobody.
--
-- Rollback: DROP COLUMN moderator_role, admin_note on chat.user_bans (the room configs keep the ids).

ALTER TABLE "chat"."user_bans" ADD COLUMN "moderator_role" TEXT, ADD COLUMN "admin_note" TEXT;

UPDATE "chat"."user_bans" b SET "moderator_role" = sr."role"::text
  FROM "chat"."staff_roles" sr WHERE sr."user_id" = b."moderator_id";

-- A temporary index makes the one-time note copy a lookup instead of a scan per ban.
CREATE INDEX "tmp_moderation_actions_ban_id_idx" ON "chat"."moderation_actions" ((("new_value"->>'banId')))
  WHERE "new_value" ? 'banId';
UPDATE "chat"."user_bans" b SET "admin_note" = (
    SELECT m."note" FROM "chat"."moderation_actions" m
     WHERE m."new_value"->>'banId' = b."id"::text AND m."note" IS NOT NULL
     ORDER BY m."created_at" DESC LIMIT 1)
 WHERE b."admin_id" IS NOT NULL;
DROP INDEX "chat"."tmp_moderation_actions_ban_id_idx";

UPDATE "chat"."rooms" r SET "config" = jsonb_set(r."config", '{userRestrictions}', (
    SELECT COALESCE(jsonb_agg(
      CASE WHEN e->>'targetType' = 'USER'
                AND e->>'targetValue' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN jsonb_set(e, '{targetValue}', to_jsonb(COALESCE(
                  (SELECT u."id"::text FROM "identity"."users" u
                    WHERE u."username_lower" = lower(trim(e->>'targetValue'))
                       OR u."public_code_key" = upper(trim(e->>'targetValue')) LIMIT 1),
                  e->>'targetValue')))
           ELSE e END), '[]'::jsonb)
      FROM jsonb_array_elements(r."config"->'userRestrictions') e))
 WHERE jsonb_typeof(r."config"->'userRestrictions') = 'array' AND jsonb_array_length(r."config"->'userRestrictions') > 0;
