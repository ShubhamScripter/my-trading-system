-- Chat Modules 8-9, completion (handoff FR-060 / V2-56 / V2-143, FR-201, FR-202, FR-024).
--  1. dm_groups.member_count: kept by a trigger on dm_members, so "how many members" is one column read, never a count
--     over up to 100,000 rows (inbox lists, group lists, group info, the admin panel).
--  2. chat.dm_messages becomes a monthly partitioned table like chat.room_messages: primary key (id, created_at),
--     one partition per UTC month, a DEFAULT partition as a safety net.
--  3. A partitioned table cannot hold a unique index without the partition key, so "one message per client id" moves
--     to chat.dm_message_dedupe (conversation, sender, client id): the primary key decides a retry race, atomically.
--  4. Reports of a DM message carry the message's created_at; the link to dm_messages is by value, not a foreign key,
--     because partitions older than 12 months are detached into the chat_archive schema (V2-56, V2-143) and
--     messages are never deleted.
--  5. chat.archive_old_dm_partitions(keep_months): detaches whole months older than the limit into chat_archive and
--     records the cut-off in chat.archive_state. Nothing is deleted.
--  6. A trigram index for the admin group-name search, when the extension can be created.
--
-- Rollback: create a plain chat.dm_messages_plain, INSERT ... SELECT from chat.dm_messages (and chat_archive.*),
-- drop the partitioned table, rename it back, re-create dm_messages_conversation_id_sender_id_client_message_id_key
-- and the report foreign key; drop dm_message_dedupe, archive_state, the trigger and dm_groups.member_count.

-- ─── 1. Group member counter ─────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "chat"."dm_groups" ADD COLUMN "member_count" INTEGER NOT NULL DEFAULT 0;

UPDATE "chat"."dm_groups" g
SET "member_count" = (
  SELECT count(*)::int FROM "chat"."dm_members" m WHERE m."conversation_id" = g."conversation_id" AND m."state" = 'ACTIVE'
);

CREATE OR REPLACE FUNCTION "chat"."dm_members_count"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" = 'ACTIVE' THEN
      UPDATE "chat"."dm_groups" SET "member_count" = "member_count" + 1 WHERE "conversation_id" = NEW."conversation_id";
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD."state" <> 'ACTIVE' AND NEW."state" = 'ACTIVE' THEN
      UPDATE "chat"."dm_groups" SET "member_count" = "member_count" + 1 WHERE "conversation_id" = NEW."conversation_id";
    ELSIF OLD."state" = 'ACTIVE' AND NEW."state" <> 'ACTIVE' THEN
      UPDATE "chat"."dm_groups" SET "member_count" = "member_count" - 1 WHERE "conversation_id" = NEW."conversation_id";
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."state" = 'ACTIVE' THEN
      UPDATE "chat"."dm_groups" SET "member_count" = "member_count" - 1 WHERE "conversation_id" = OLD."conversation_id";
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "dm_members_count_trigger"
AFTER INSERT OR UPDATE OF "state" OR DELETE ON "chat"."dm_members"
FOR EACH ROW EXECUTE FUNCTION "chat"."dm_members_count"();

-- ─── 2. dm_messages: monthly partitions ──────────────────────────────────────────────────────────────────────────
ALTER TABLE "chat"."chat_message_reports" DROP CONSTRAINT IF EXISTS "chat_message_reports_dm_message_id_fkey";

ALTER TABLE "chat"."dm_messages" RENAME TO "dm_messages_old";
ALTER TABLE "chat"."dm_messages_old" RENAME CONSTRAINT "dm_messages_pkey" TO "dm_messages_old_pkey";
ALTER TABLE "chat"."dm_messages_old" DROP CONSTRAINT IF EXISTS "dm_messages_conversation_id_fkey";
DROP INDEX IF EXISTS "chat"."dm_messages_conversation_id_created_at_id_idx";
DROP INDEX IF EXISTS "chat"."dm_messages_conversation_id_sender_id_client_message_id_key";

-- Same columns, defaults and CHECKs as the old table.
CREATE TABLE "chat"."dm_messages" (LIKE "chat"."dm_messages_old" INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
PARTITION BY RANGE ("created_at");
ALTER TABLE "chat"."dm_messages" ADD CONSTRAINT "dm_messages_pkey" PRIMARY KEY ("id", "created_at");

-- One partition per UTC month, named dm_messages_YYYY_MM. Returns false when it already exists.
CREATE OR REPLACE FUNCTION "chat"."create_dm_message_partition"(month_start DATE) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  part TEXT := 'dm_messages_' || to_char(month_start, 'YYYY_MM');
BEGIN
  IF to_regclass(format('chat.%I', part)) IS NOT NULL THEN
    RETURN false;
  END IF;
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS chat.%I PARTITION OF chat.dm_messages FOR VALUES FROM (%L) TO (%L)',
    part,
    (month_start::timestamp AT TIME ZONE 'UTC'),
    ((month_start + interval '1 month')::timestamp AT TIME ZONE 'UTC')
  );
  RETURN true;
END;
$$;

-- One call makes the missing months of BOTH message tables (public rooms and DMs), from the current database month
-- up to `months_ahead` ahead. Idempotent. Called by the chat server at start and once a day.
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
    IF "chat"."create_dm_message_partition"((first_month + make_interval(months => i))::date) THEN
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END;
$$;

DO $$
DECLARE
  oldest DATE;
  last_month DATE := (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '3 months')::date;
  m DATE;
BEGIN
  SELECT date_trunc('month', min("created_at") AT TIME ZONE 'UTC')::date INTO oldest FROM "chat"."dm_messages_old";
  m := COALESCE(oldest, date_trunc('month', now() AT TIME ZONE 'UTC')::date);
  WHILE m <= last_month LOOP
    PERFORM "chat"."create_dm_message_partition"(m);
    m := (m + interval '1 month')::date;
  END LOOP;
END;
$$;

CREATE TABLE "chat"."dm_messages_default" PARTITION OF "chat"."dm_messages" DEFAULT;

-- ─── 3. One message per client id (retry de-duplication) ─────────────────────────────────────────────────────────
CREATE TABLE "chat"."dm_message_dedupe" (
    "conversation_id"   UUID NOT NULL,
    "sender_id"         UUID NOT NULL,
    "client_message_id" UUID NOT NULL,
    "message_id"        UUID NOT NULL,
    "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "dm_message_dedupe_pkey" PRIMARY KEY ("conversation_id", "sender_id", "client_message_id")
);
CREATE INDEX "dm_message_dedupe_created_at_idx" ON "chat"."dm_message_dedupe" ("created_at");

INSERT INTO "chat"."dm_message_dedupe" ("conversation_id", "sender_id", "client_message_id", "message_id", "created_at")
SELECT "conversation_id", "sender_id", "client_message_id", "id", "created_at"
FROM "chat"."dm_messages_old" WHERE "client_message_id" IS NOT NULL;

-- ─── 4. Copy the rows and index the parent ───────────────────────────────────────────────────────────────────────
INSERT INTO "chat"."dm_messages"
    ("id", "conversation_id", "sender_id", "content", "type", "metadata", "client_message_id", "created_at",
     "retracted_at", "retracted_by", "hidden_at", "hidden_by", "pinned_at", "pinned_by")
SELECT "id", "conversation_id", "sender_id", "content", "type", "metadata", "client_message_id", "created_at",
       "retracted_at", "retracted_by", "hidden_at", "hidden_by", "pinned_at", "pinned_by"
FROM "chat"."dm_messages_old";

DROP TABLE "chat"."dm_messages_old";

CREATE INDEX "dm_messages_conversation_id_created_at_id_idx"
    ON "chat"."dm_messages" ("conversation_id", "created_at" DESC, "id" DESC);

ALTER TABLE "chat"."dm_messages" ADD CONSTRAINT "dm_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "chat"."dm_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Reports: the message's created_at travels with its id ───────────────────────────────────────────────────────
ALTER TABLE "chat"."chat_message_reports" ADD COLUMN "dm_message_created_at" TIMESTAMPTZ;
UPDATE "chat"."chat_message_reports" r
SET "dm_message_created_at" = m."created_at"
FROM "chat"."dm_messages" m
WHERE m."id" = r."dm_message_id";

-- ─── 5. Archive of old months ────────────────────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS "chat_archive";

CREATE TABLE "chat"."archive_state" (
    "id"                          BOOLEAN NOT NULL DEFAULT true,
    "dm_messages_archived_before" TIMESTAMPTZ,

    CONSTRAINT "archive_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "archive_state_single_row" CHECK ("id")
);

-- Moves every whole month older than `keep_months` out of the live table: DETACH, then SET SCHEMA chat_archive. The
-- rows stay as they were (messages are never deleted); the cut-off is recorded so the API can say "older messages are
-- archived". Returns how many partitions moved. Idempotent.
CREATE OR REPLACE FUNCTION "chat"."archive_old_dm_partitions"(keep_months INT) RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
  cutoff DATE := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => keep_months))::date;
  part RECORD;
  moved INT := 0;
BEGIN
  FOR part IN
    SELECT c.relname AS name
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'chat.dm_messages'::regclass AND c.relname ~ '^dm_messages_[0-9]{4}_[0-9]{2}$'
  LOOP
    IF to_date(substr(part.name, 13), 'YYYY_MM') < cutoff THEN
      EXECUTE format('ALTER TABLE chat.dm_messages DETACH PARTITION chat.%I', part.name);
      EXECUTE format('ALTER TABLE chat.%I SET SCHEMA chat_archive', part.name);
      moved := moved + 1;
    END IF;
  END LOOP;
  IF moved > 0 THEN
    INSERT INTO "chat"."archive_state" ("id", "dm_messages_archived_before")
    VALUES (true, (cutoff::timestamp AT TIME ZONE 'UTC'))
    ON CONFLICT ("id") DO UPDATE SET "dm_messages_archived_before" = GREATEST(
      COALESCE("chat"."archive_state"."dm_messages_archived_before", '-infinity'::timestamptz),
      EXCLUDED."dm_messages_archived_before");
  END IF;
  RETURN moved;
END;
$$;

-- ─── 6. Group-name search ────────────────────────────────────────────────────────────────────────────────────────
-- The admin panel searches group names with ILIKE '%text%'. A trigram index makes that an index scan. Skipped (with a
-- notice) where the extension cannot be created; the search then still works, only slower.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS "dm_groups_name_trgm_idx" ON "chat"."dm_groups" USING gin ("name" gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm is not available, the group-name trigram index was not created: %', SQLERRM;
END;
$$;
