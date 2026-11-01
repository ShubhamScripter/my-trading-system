-- Slice E (admin authority), FR-002 and FR-172.
--
--  1. Chat roles are given in the admin panel only: the ASSIGN_ROLES permission leaves the contract, so it is removed
--     from the stored settings (and from the scheduled / rollback copies, which are parsed with the same contract), and
--     staff requests still waiting for it are rejected with a note.
--  2. Six more restriction kinds, one for each staff permission that had none: RESTRICT_PIN, RESTRICT_DELETE_MESSAGES,
--     RESTRICT_HISTORY, RESTRICT_STAFF_ROOM, RESTRICT_IMAGES, RESTRICT_VIDEOS.
--
-- Rollback: restore the previous kind check (below) after deleting rows of the six new kinds; the removed permission is
-- not restored (it only ever held a value the panel set).

-- 1. ASSIGN_ROLES out of every stored settings document. jsonb::text puts one space after ':' and ','; the first
--    pattern takes the entry with its leading comma, the second one an entry that comes first or stands alone.
CREATE FUNCTION pg_temp.strip_assign_roles(doc JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
    SELECT regexp_replace(
        regexp_replace(doc::text, ',\s*"ASSIGN_ROLES"\s*:\s*"[A-Z]+"', '', 'g'),
        '"ASSIGN_ROLES"\s*:\s*"[A-Z]+"\s*,?', '', 'g'
    )::jsonb
$$;

UPDATE "chat"."settings" SET "document" = pg_temp.strip_assign_roles("document")
 WHERE "document"::text LIKE '%"ASSIGN_ROLES"%';
UPDATE "chat"."settings_changes"
   SET "patch" = pg_temp.strip_assign_roles("patch"),
       "before" = CASE WHEN "before" IS NULL THEN NULL ELSE pg_temp.strip_assign_roles("before") END
 WHERE "patch"::text LIKE '%"ASSIGN_ROLES"%' OR "before"::text LIKE '%"ASSIGN_ROLES"%';

UPDATE "chat"."staff_requests"
   SET "status" = 'REJECTED', "resolved_at" = now(),
       "resolution_note" = 'Chat roles are now given in the admin panel only'
 WHERE "permission" = 'ASSIGN_ROLES' AND "status" = 'PENDING';

-- 2. The six new restriction kinds.
ALTER TABLE "chat"."user_restrictions" DROP CONSTRAINT "user_restrictions_kind_check";
ALTER TABLE "chat"."user_restrictions" ADD CONSTRAINT "user_restrictions_kind_check" CHECK ("kind" IN (
    'MUTE', 'RESTRICT_MEDIA', 'RESTRICT_EMOJI', 'RESTRICT_GIF', 'RESTRICT_COMMANDS', 'RESTRICT_ADS',
    'RESTRICT_DM', 'RESTRICT_GIFTS', 'RESTRICT_RECEIVE_GIFTS', 'RESTRICT_RAIN', 'RESTRICT_RAIN_RECEIVE',
    'RESTRICT_PIN', 'RESTRICT_DELETE_MESSAGES', 'RESTRICT_HISTORY', 'RESTRICT_STAFF_ROOM', 'RESTRICT_IMAGES',
    'RESTRICT_VIDEOS'));
