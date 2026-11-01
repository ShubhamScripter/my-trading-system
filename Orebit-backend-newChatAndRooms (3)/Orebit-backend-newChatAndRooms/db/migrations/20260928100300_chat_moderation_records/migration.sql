-- Chat: an append-only record of every moderation action, offence counts in Postgres instead of the evicting
-- cache, bans judged on the database clock with a real "permanent", reports that can name a user
-- and cannot be duplicated, and history protected from deletes, with admin ids kept apart from user ids
--. Every chat time column defaults to the database clock.
--
-- Rollback: drop chat.moderation_actions (disable its trigger first), chat.moderation_offences and
-- chat.report_reasons; re-create chat."ReportReason" and cast chat_message_reports.reason back; move admin_id /
-- retracted_by_admin_id / issued_by_admin_id back into their user columns; set a far-future expires_at on permanent
-- bans; restore ON DELETE CASCADE on the links changed below.

-- ─── 0. Rows that name a user who does not exist cannot take a user link ─────────────────────────────────────────
-- Development data only (no live data exists): bans, warnings and reports against ids that are not accounts —
-- for example a report on a system alert, whose author is the fixed system id — and preferences of removed users.
DELETE FROM "chat"."user_bans" b WHERE NOT EXISTS (SELECT 1 FROM "identity"."users" u WHERE u."id" = b."user_id");
DELETE FROM "chat"."chat_warnings" w WHERE NOT EXISTS (SELECT 1 FROM "identity"."users" u WHERE u."id" = w."user_id");
DELETE FROM "chat"."chat_message_reports" r
WHERE NOT EXISTS (SELECT 1 FROM "identity"."users" u WHERE u."id" = r."reporter_id")
   OR NOT EXISTS (SELECT 1 FROM "identity"."users" u WHERE u."id" = r."reported_user_id");
DELETE FROM "chat"."user_chat_preferences" p
WHERE NOT EXISTS (SELECT 1 FROM "identity"."users" u WHERE u."id" = p."user_id");

-- ─── 1. Moderation actions (append-only) ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat"."moderation_actions" (
    "id"                        UUID NOT NULL,
    "actor_type"                TEXT NOT NULL,
    "actor_id"                  UUID,
    "action"                    TEXT NOT NULL,
    "target_user_id"            UUID,
    "target_room_id"            UUID,
    "target_message_id"         UUID,
    "target_message_created_at" TIMESTAMPTZ,
    "old_value"                 JSONB,
    "new_value"                 JSONB,
    "note"                      TEXT,
    "created_at"                TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "moderation_actions_actor_type_check" CHECK ("actor_type" IN ('ADMIN', 'STAFF', 'SYSTEM'))
);
CREATE INDEX "moderation_actions_target_user_id_created_at_idx"
    ON "chat"."moderation_actions" ("target_user_id", "created_at");
CREATE INDEX "moderation_actions_actor_id_created_at_idx"
    ON "chat"."moderation_actions" ("actor_id", "created_at");
CREATE INDEX "moderation_actions_created_at_idx" ON "chat"."moderation_actions" ("created_at");

CREATE OR REPLACE FUNCTION "chat"."refuse_moderation_action_change"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'chat.moderation_actions is append-only';
END;
$$;
CREATE TRIGGER "moderation_actions_append_only"
    BEFORE UPDATE OR DELETE ON "chat"."moderation_actions"
    FOR EACH ROW EXECUTE FUNCTION "chat"."refuse_moderation_action_change"();

-- ─── 2. Offence counts (the auto-moderation ladder) ───────────────────────────────────────────────────────────────
CREATE TABLE "chat"."moderation_offences" (
    "user_id"    UUID NOT NULL,
    "room_id"    UUID NOT NULL,
    "count"      INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "moderation_offences_pkey" PRIMARY KEY ("user_id", "room_id")
);

-- ─── 3. Bans ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- NULL end = permanent. The old admin path stored "0 hours" as ten years; those become permanent.
ALTER TABLE "chat"."user_bans" ALTER COLUMN "expires_at" DROP NOT NULL;
UPDATE "chat"."user_bans" SET "expires_at" = NULL WHERE "expires_at" > "banned_at" + interval '9 years';
ALTER TABLE "chat"."user_bans" ALTER COLUMN "banned_at" SET DEFAULT now();
ALTER TABLE "chat"."user_bans"
    ADD COLUMN "admin_id"  UUID,
    ADD COLUMN "lifted_by" UUID,
    ADD COLUMN "lifted_at" TIMESTAMPTZ;

-- moderator_id held a platform user (staff) or an admin-backend id depending on who acted. Admin ids move out.
UPDATE "chat"."user_bans" b
SET "admin_id" = b."moderator_id", "moderator_id" = NULL
WHERE b."moderator_id" IS NOT NULL
  AND b."moderator_id" <> '00000000-0000-0000-0000-000000000000'
  AND NOT EXISTS (SELECT 1 FROM "identity"."users" u WHERE u."id" = b."moderator_id");
UPDATE "chat"."user_bans" SET "moderator_id" = NULL WHERE "moderator_id" = '00000000-0000-0000-0000-000000000000';

ALTER TABLE "chat"."user_bans" DROP CONSTRAINT IF EXISTS "user_bans_room_id_fkey";
ALTER TABLE "chat"."user_bans" ADD CONSTRAINT "user_bans_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "chat"."rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."user_bans" ADD CONSTRAINT "user_bans_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."user_bans" ADD CONSTRAINT "user_bans_moderator_id_fkey"
    FOREIGN KEY ("moderator_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 4. Warnings ──────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "chat"."chat_warnings" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "chat"."chat_warnings" ADD COLUMN "issued_by_admin_id" UUID;
UPDATE "chat"."chat_warnings" w
SET "issued_by_admin_id" = w."issued_by", "issued_by" = NULL
WHERE w."issued_by" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "identity"."users" u WHERE u."id" = w."issued_by");
ALTER TABLE "chat"."chat_warnings" ADD CONSTRAINT "chat_warnings_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."chat_warnings" ADD CONSTRAINT "chat_warnings_issued_by_fkey"
    FOREIGN KEY ("issued_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 5. Reports ───────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "chat"."chat_message_reports" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "chat"."chat_message_reports" ADD COLUMN "action" TEXT;
ALTER TABLE "chat"."chat_message_reports" ADD CONSTRAINT "chat_message_reports_action_check"
    CHECK ("action" IS NULL OR "action" IN ('DISMISS', 'WARN', 'BAN', 'RETRACT_MESSAGE'));
-- 'Dismiss' used to be saved as ACTIONED with no record of the action; nothing can recover which it was.

-- The admin edits the reason list: the enum becomes a table.
CREATE TABLE "chat"."report_reasons" (
    "code"       TEXT NOT NULL,
    "label"      TEXT NOT NULL,
    "is_active"  BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "report_reasons_pkey" PRIMARY KEY ("code")
);
INSERT INTO "chat"."report_reasons" ("code", "label", "sort_order") VALUES
    ('SPAM', 'Spam', 10),
    ('HARASSMENT', 'Harassment', 20),
    ('INAPPROPRIATE', 'Inappropriate content', 30),
    ('SCAM', 'Scam or fraud', 40),
    ('HATE_SPEECH', 'Hate speech', 50),
    ('OTHER', 'Other', 60)
ON CONFLICT DO NOTHING;

ALTER TABLE "chat"."chat_message_reports" ALTER COLUMN "reason" DROP DEFAULT;
ALTER TABLE "chat"."chat_message_reports" ALTER COLUMN "reason" TYPE TEXT USING "reason"::text;
DROP TYPE "chat"."ReportReason";
ALTER TABLE "chat"."chat_message_reports" ADD CONSTRAINT "chat_message_reports_reason_fkey"
    FOREIGN KEY ("reason") REFERENCES "chat"."report_reasons"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One report per user per message: keep the earliest of any duplicates, then enforce it.
DELETE FROM "chat"."chat_message_reports" a
USING "chat"."chat_message_reports" b
WHERE a."message_id" IS NOT NULL
  AND a."message_id" = b."message_id"
  AND a."reporter_id" = b."reporter_id"
  AND (a."created_at", a."id") > (b."created_at", b."id");

CREATE UNIQUE INDEX "chat_message_reports_message_reporter_key"
    ON "chat"."chat_message_reports" ("message_id", "reporter_id") WHERE "message_id" IS NOT NULL;
-- A user report (no message) may be repeated only after the previous one was resolved.
CREATE UNIQUE INDEX "chat_message_reports_user_reporter_pending_key"
    ON "chat"."chat_message_reports" ("reported_user_id", "reporter_id")
    WHERE "message_id" IS NULL AND "status" = 'PENDING';

-- Per-reporter limit counts the reporter's recent reports.
DROP INDEX IF EXISTS "chat"."chat_message_reports_reporter_id_idx";
CREATE INDEX "chat_message_reports_reporter_id_created_at_idx"
    ON "chat"."chat_message_reports" ("reporter_id", "created_at");

ALTER TABLE "chat"."chat_message_reports" ADD CONSTRAINT "chat_message_reports_reporter_id_fkey"
    FOREIGN KEY ("reporter_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."chat_message_reports" ADD CONSTRAINT "chat_message_reports_reported_user_id_fkey"
    FOREIGN KEY ("reported_user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 6. Messages: who retracted or pinned, user and admin ids apart ──────────────────────────────────────────────
ALTER TABLE "chat"."room_messages" ADD COLUMN "retracted_by_admin_id" UUID;
UPDATE "chat"."room_messages" m
SET "retracted_by_admin_id" = m."retracted_by", "retracted_by" = NULL
WHERE m."retracted_by" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "identity"."users" u WHERE u."id" = m."retracted_by");
UPDATE "chat"."room_messages" m SET "pinned_by" = NULL
WHERE m."pinned_by" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "identity"."users" u WHERE u."id" = m."pinned_by");

ALTER TABLE "chat"."room_messages" ADD CONSTRAINT "room_messages_retracted_by_fkey"
    FOREIGN KEY ("retracted_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."room_messages" ADD CONSTRAINT "room_messages_pinned_by_fkey"
    FOREIGN KEY ("pinned_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- room_messages.user_id has no user link on purpose: it also holds the fixed system author.

-- ─── 7. Preferences ───────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "chat"."user_chat_preferences" ADD CONSTRAINT "user_chat_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 8. Skins are never hard-deleted; they are deactivated ───────────────────────────────────────────────────────
ALTER TABLE "chat"."message_cosmetics" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
UPDATE "chat"."message_cosmetics" SET "is_active" = false WHERE "style_config"->>'isActive' = 'false';
UPDATE "chat"."message_cosmetics" SET "style_config" = "style_config" - 'isActive';
ALTER TABLE "chat"."message_cosmetics" ALTER COLUMN "created_at" SET DEFAULT now();
