-- Slice: FR-098 (Module 4). One chat-wide spam rule and ban ladder; offences are counted per user across rooms (V2-30).
-- Rollback: add "room_id" back as NOT NULL with the Global room's id, and make the primary key ("user_id", "room_id").

-- A user's offences in several rooms become one row: the latest-ending count wins.
DELETE FROM "chat"."moderation_offences" a
USING "chat"."moderation_offences" b
WHERE a."user_id" = b."user_id"
  AND (a."expires_at", a."room_id") < (b."expires_at", b."room_id");

ALTER TABLE "chat"."moderation_offences" DROP CONSTRAINT "moderation_offences_pkey";
ALTER TABLE "chat"."moderation_offences" DROP COLUMN "room_id";
ALTER TABLE "chat"."moderation_offences" ADD CONSTRAINT "moderation_offences_pkey" PRIMARY KEY ("user_id");

-- The per-room spam rule and ladder are gone from a room's settings; the chat-wide ones are in the settings document.
UPDATE "chat"."rooms"
SET "config" = "config" - 'spamProtection' - 'autoBanSequence'
WHERE "config" ?| ARRAY['spamProtection', 'autoBanSequence'];
