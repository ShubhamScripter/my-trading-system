-- Chat: the "messages where I was tagged" feed reads its own table; a retried send is recognised by its client
-- id; every upload is recorded with its uploader; "last online" is kept by chat; preference
-- fields that nothing reads are removed.
--
-- Chat MAIN / Chat SETTINGS: the last opened room is saved "in their LS or Cookies" — in the browser — so the server
-- no longer keeps it; the server only computes the admin's default room (see ChatAccessService.effectiveRoom).
--
-- Rollback: drop chat.message_mentions, chat.client_message_ids and chat.media_uploads (media rows are a legal record,
-- export them first); drop last_seen_at; re-add default_room_id, last_opened_room_id, quiet_mode and
-- notifications to chat.user_chat_preferences with their old defaults.

-- ─── 1. Mentions ──────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat"."message_mentions" (
    "mentioned_user_id" UUID NOT NULL,
    -- The message's own created_at, so the row links to the partitioned messages table.
    "created_at"        TIMESTAMPTZ NOT NULL,
    "message_id"        UUID NOT NULL,
    "room_id"           UUID NOT NULL,

    CONSTRAINT "message_mentions_pkey" PRIMARY KEY ("mentioned_user_id", "created_at", "message_id")
);
ALTER TABLE "chat"."message_mentions" ADD CONSTRAINT "message_mentions_message_fkey"
    FOREIGN KEY ("message_id", "created_at") REFERENCES "chat"."room_messages"("id", "created_at")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."message_mentions" ADD CONSTRAINT "message_mentions_mentioned_user_id_fkey"
    FOREIGN KEY ("mentioned_user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing tags, from the usernames stored in message metadata, matched exactly against live accounts.
INSERT INTO "chat"."message_mentions" ("mentioned_user_id", "created_at", "message_id", "room_id")
SELECT DISTINCT u."id", m."created_at", m."id", m."room_id"
FROM "chat"."room_messages" m
CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(m."metadata"->'mentions') = 'array' THEN m."metadata"->'mentions' ELSE '[]'::jsonb END
) AS tagged(username)
JOIN "identity"."users" u ON u."username_lower" = lower(tagged.username) AND u."deleted_at" IS NULL
ON CONFLICT DO NOTHING;

-- Messages keep the tagged usernames under their new name.
UPDATE "chat"."room_messages"
SET "metadata" = ("metadata" - 'mentions') || jsonb_build_object('taggedUsernames', "metadata"->'mentions')
WHERE "metadata" ? 'mentions';

-- Per-message anonymity is removed; the profile-level setting stamps metadata.anonymous at send time.
UPDATE "chat"."room_messages"
SET "metadata" = ("metadata" - 'isAnonymous' - 'hideIdentity') || '{"anonymous": true}'::jsonb
WHERE "metadata"->>'isAnonymous' = 'true' OR "metadata"->>'hideIdentity' = 'true';

-- ─── 2. Send retries ──────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat"."client_message_ids" (
    "user_id"            UUID NOT NULL,
    "client_message_id"  UUID NOT NULL,
    "message_id"         UUID NOT NULL,
    "message_created_at" TIMESTAMPTZ NOT NULL,
    "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "client_message_ids_pkey" PRIMARY KEY ("user_id", "client_message_id")
);
CREATE INDEX "client_message_ids_created_at_idx" ON "chat"."client_message_ids" ("created_at");
ALTER TABLE "chat"."client_message_ids" ADD CONSTRAINT "client_message_ids_message_fkey"
    FOREIGN KEY ("message_id", "message_created_at") REFERENCES "chat"."room_messages"("id", "created_at")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 3. Uploads ───────────────────────────────────────────────────────────────────────────────────────────────────
-- uploader_id has no link to identity.users on purpose: the record of who uploaded what, and when, survives the
-- uploader's account erasure (legal hold).
CREATE TABLE "chat"."media_uploads" (
    "id"              UUID NOT NULL,
    "uploader_id"     UUID NOT NULL,
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    "mime_type"       TEXT NOT NULL,
    "size_bytes"      INTEGER NOT NULL,
    "sha256"          TEXT NOT NULL,
    "storage_key"     TEXT NOT NULL,
    "flagged_at"      TIMESTAMPTZ,
    "flagged_by"      UUID,
    "deleted_at"      TIMESTAMPTZ,
    "deleted_by"      UUID,
    "delete_note"     TEXT,
    -- Set by the chat server once the file of a deleted row is gone from disk; the row itself stays.
    "file_removed_at" TIMESTAMPTZ,

    CONSTRAINT "media_uploads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "media_uploads_uploader_id_created_at_idx" ON "chat"."media_uploads" ("uploader_id", "created_at");
CREATE INDEX "media_uploads_pending_removal_idx"
    ON "chat"."media_uploads" ("deleted_at") WHERE "deleted_at" IS NOT NULL AND "file_removed_at" IS NULL;

-- ─── 4. Preferences: last online kept, unread fields removed ─────────────────────────────────────────────────────
ALTER TABLE "chat"."user_chat_preferences" ADD COLUMN "last_seen_at" TIMESTAMPTZ;
ALTER TABLE "chat"."user_chat_preferences"
    DROP COLUMN "default_room_id",
    DROP COLUMN "last_opened_room_id",
    DROP COLUMN "quiet_mode",
    DROP COLUMN "notifications";
