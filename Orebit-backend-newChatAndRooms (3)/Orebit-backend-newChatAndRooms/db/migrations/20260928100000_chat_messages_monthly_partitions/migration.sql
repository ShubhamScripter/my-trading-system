-- Chat: split chat.room_messages into monthly partitions (NEW-1), give history an index that reads one page at a
-- time, make the pinned and skin indexes partial and store message text as typed.
--
-- Rollback: create a plain chat.room_messages_plain with the same columns, INSERT ... SELECT from chat.room_messages,
-- drop chat.room_messages (and its partitions), rename the plain table back, re-create the old indexes and links.
-- Nothing is deleted by this migration; every row is copied.

-- ─── 1. Detach the only table that links to messages ─────────────────────────────────────────────────────────────
ALTER TABLE "chat"."chat_message_reports" DROP CONSTRAINT IF EXISTS "chat_message_reports_message_id_fkey";

-- ─── 2. Move the old table out of the way ────────────────────────────────────────────────────────────────────────
ALTER TABLE "chat"."room_messages" RENAME TO "room_messages_old";
ALTER TABLE "chat"."room_messages_old" RENAME CONSTRAINT "room_messages_pkey" TO "room_messages_old_pkey";
ALTER TABLE "chat"."room_messages_old" DROP CONSTRAINT IF EXISTS "room_messages_room_id_fkey";
ALTER TABLE "chat"."room_messages_old" DROP CONSTRAINT IF EXISTS "room_messages_cosmetic_id_fkey";
DROP INDEX IF EXISTS "chat"."room_messages_room_id_retracted_at_created_at_idx";
DROP INDEX IF EXISTS "chat"."room_messages_room_id_pinned_at_idx";
DROP INDEX IF EXISTS "chat"."room_messages_user_id_idx";
DROP INDEX IF EXISTS "chat"."room_messages_cosmetic_id_idx";

-- ─── 3. Message text is stored exactly as typed ────────────────────────────────────────────────────────
-- User text and captions used to be HTML-escaped on write; admin broadcasts and system alerts never were. `&amp;` is
-- replaced last so an escaped `&amp;lt;` becomes the typed `&lt;`, not `<`.
UPDATE "chat"."room_messages_old"
SET "content" = replace(replace(replace(replace(replace("content",
      '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#x27;', ''''), '&amp;', '&')
WHERE "type" IN ('TEXT', 'MEDIA')
  AND "content" ~ '&(amp|lt|gt|quot|#x27);';

-- ─── 4. The partitioned table ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat"."room_messages" (
    "id"           UUID NOT NULL,
    "room_id"      UUID NOT NULL,
    "user_id"      UUID NOT NULL,
    "content"      TEXT NOT NULL,
    "type"         "chat"."MessageType" NOT NULL DEFAULT 'TEXT',
    "cosmetic_id"  UUID,
    "metadata"     JSONB NOT NULL DEFAULT '{}',
    "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    "retracted_at" TIMESTAMPTZ,
    "retracted_by" UUID,
    "pinned_at"    TIMESTAMPTZ,
    "pinned_by"    UUID,

    CONSTRAINT "room_messages_pkey" PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");

-- One partition per UTC calendar month, named room_messages_YYYY_MM. Returns false when it already exists.
CREATE OR REPLACE FUNCTION "chat"."create_message_partition"(month_start DATE) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  part TEXT := 'room_messages_' || to_char(month_start, 'YYYY_MM');
BEGIN
  IF to_regclass(format('chat.%I', part)) IS NOT NULL THEN
    RETURN false;
  END IF;
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS chat.%I PARTITION OF chat.room_messages FOR VALUES FROM (%L) TO (%L)',
    part,
    (month_start::timestamp AT TIME ZONE 'UTC'),
    ((month_start + interval '1 month')::timestamp AT TIME ZONE 'UTC')
  );
  RETURN true;
END;
$$;

-- Creates every missing month from the current database month up to `months_ahead` months ahead. Idempotent: a
-- second call in a row creates nothing and returns 0. Called by the chat server at start and once a day.
CREATE OR REPLACE FUNCTION "chat"."ensure_message_partitions"(months_ahead INT) RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
  first_month DATE := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  created INT := 0;
BEGIN
  FOR i IN 0..months_ahead LOOP
    IF "chat"."create_message_partition"((first_month + make_interval(months => i))::date) THEN
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END;
$$;

-- From the month of the oldest existing row to three months ahead, then the DEFAULT partition as a safety net.
DO $$
DECLARE
  oldest DATE;
  last_month DATE := (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '3 months')::date;
  m DATE;
BEGIN
  SELECT date_trunc('month', min("created_at") AT TIME ZONE 'UTC')::date INTO oldest FROM "chat"."room_messages_old";
  m := COALESCE(oldest, date_trunc('month', now() AT TIME ZONE 'UTC')::date);
  WHILE m <= last_month LOOP
    PERFORM "chat"."create_message_partition"(m);
    m := (m + interval '1 month')::date;
  END LOOP;
END;
$$;

CREATE TABLE "chat"."room_messages_default" PARTITION OF "chat"."room_messages" DEFAULT;

-- ─── 5. Copy the rows ─────────────────────────────────────────────────────────────────────────────────────────────
INSERT INTO "chat"."room_messages"
    ("id", "room_id", "user_id", "content", "type", "cosmetic_id", "metadata", "created_at",
     "retracted_at", "retracted_by", "pinned_at", "pinned_by")
SELECT "id", "room_id", "user_id", "content", "type", "cosmetic_id", "metadata", "created_at",
       "retracted_at", "retracted_by", "pinned_at", "pinned_by"
FROM "chat"."room_messages_old";

DROP TABLE "chat"."room_messages_old";

-- ─── 6. Indexes on the parent (every partition gets them) ────────────────────────────────────────────────────────
-- History reads one page: WHERE room_id = $1 AND (created_at, id) < cursor ORDER BY created_at DESC, id DESC.
CREATE INDEX "room_messages_room_id_created_at_id_idx"
    ON "chat"."room_messages" ("room_id", "created_at" DESC, "id" DESC);
CREATE INDEX "room_messages_user_id_idx" ON "chat"."room_messages" ("user_id");
-- Partial: only pinned messages and messages with a skin get an entry.
CREATE INDEX "room_messages_pinned_idx"
    ON "chat"."room_messages" ("room_id", "pinned_at" DESC) WHERE "pinned_at" IS NOT NULL;
CREATE INDEX "room_messages_skin_idx"
    ON "chat"."room_messages" ("cosmetic_id") WHERE "cosmetic_id" IS NOT NULL;

-- ─── 7. Links ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- Messages are never deleted (Chat SETTINGS: "No chat messages will be deleted, they'll just be archived"), so
-- a room or a skin that has messages cannot be removed underneath them.
ALTER TABLE "chat"."room_messages" ADD CONSTRAINT "room_messages_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "chat"."rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."room_messages" ADD CONSTRAINT "room_messages_cosmetic_id_fkey"
    FOREIGN KEY ("cosmetic_id") REFERENCES "chat"."message_cosmetics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reports carry the message's created_at and link on both columns, as every table that links to a message must.
-- message_id becomes optional here because a report may name a user instead of a message.
ALTER TABLE "chat"."chat_message_reports" ALTER COLUMN "message_id" DROP NOT NULL;
ALTER TABLE "chat"."chat_message_reports" ADD COLUMN "message_created_at" TIMESTAMPTZ;
UPDATE "chat"."chat_message_reports" r
SET "message_created_at" = m."created_at"
FROM "chat"."room_messages" m
WHERE m."id" = r."message_id";
-- A report whose message no longer exists cannot be linked; it keeps its row without the link.
UPDATE "chat"."chat_message_reports" SET "message_id" = NULL
WHERE "message_created_at" IS NULL AND "message_id" IS NOT NULL;

ALTER TABLE "chat"."chat_message_reports" ADD CONSTRAINT "chat_message_reports_message_fkey"
    FOREIGN KEY ("message_id", "message_created_at") REFERENCES "chat"."room_messages"("id", "created_at")
    ON DELETE RESTRICT ON UPDATE CASCADE;
