-- Slice: FR-271 (Module 4), owner decision V2-104. Every ban, restriction and warning has two reasons: an internal one
-- that staff and admins must write and that never reaches the user, and an optional one the user sees (the notice and
-- their own list). Rollback: rename "internal_reason" back to "reason", drop "user_reason", re-add "admin_note" to bans.

-- Bans: the old reason becomes the internal one (the internal audit note, when a ban has one, is that same text and wins).
UPDATE "chat"."user_bans" SET "reason" = "admin_note" WHERE "admin_note" IS NOT NULL;
ALTER TABLE "chat"."user_bans" DROP COLUMN "admin_note";
ALTER TABLE "chat"."user_bans" RENAME COLUMN "reason" TO "internal_reason";
ALTER TABLE "chat"."user_bans" ADD COLUMN "user_reason" TEXT;

-- Warnings, group warnings, restrictions: the old reason is copied to the internal one (a rename keeps every row).
ALTER TABLE "chat"."chat_warnings" RENAME COLUMN "reason" TO "internal_reason";
ALTER TABLE "chat"."chat_warnings" ADD COLUMN "user_reason" TEXT;
ALTER TABLE "chat"."group_warnings" RENAME COLUMN "reason" TO "internal_reason";
ALTER TABLE "chat"."group_warnings" ADD COLUMN "user_reason" TEXT;
ALTER TABLE "chat"."user_restrictions" RENAME COLUMN "reason" TO "internal_reason";
ALTER TABLE "chat"."user_restrictions" ADD COLUMN "user_reason" TEXT;

ALTER TABLE "chat"."group_warnings" ADD CONSTRAINT "group_warnings_user_reason_check"
    CHECK ("user_reason" IS NULL OR length("user_reason") BETWEEN 1 AND 500);
ALTER TABLE "chat"."user_restrictions" ADD CONSTRAINT "user_restrictions_user_reason_check"
    CHECK ("user_reason" IS NULL OR length("user_reason") BETWEEN 1 AND 500);
ALTER TABLE "chat"."chat_warnings" ADD CONSTRAINT "chat_warnings_user_reason_check"
    CHECK ("user_reason" IS NULL OR length("user_reason") BETWEEN 1 AND 500);
ALTER TABLE "chat"."user_bans" ADD CONSTRAINT "user_bans_user_reason_check"
    CHECK ("user_reason" IS NULL OR length("user_reason") BETWEEN 1 AND 500);

-- Restrictions kept in a room's settings: "reason" is the internal reason now.
UPDATE "chat"."rooms" r
SET "config" = jsonb_set(
    r."config",
    '{userRestrictions}',
    (SELECT COALESCE(jsonb_agg((e - 'reason') || jsonb_build_object('internalReason', e -> 'reason')), '[]'::jsonb)
       FROM jsonb_array_elements(r."config" -> 'userRestrictions') e)
)
WHERE jsonb_typeof(r."config" -> 'userRestrictions') = 'array'
  AND jsonb_array_length(r."config" -> 'userRestrictions') > 0
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(r."config" -> 'userRestrictions') e WHERE e ? 'reason');
