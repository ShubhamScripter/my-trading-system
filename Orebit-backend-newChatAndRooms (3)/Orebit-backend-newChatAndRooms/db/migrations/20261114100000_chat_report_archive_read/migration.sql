-- Archived DM partitions stay immutable to members but remain available for abuse-report review.
CREATE OR REPLACE FUNCTION chat.dm_message_for_report(p_id uuid, p_created_at timestamptz DEFAULT NULL)
RETURNS SETOF chat.dm_messages
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  archive_part text;
  part record;
BEGIN
  IF p_id IS NULL THEN
    RETURN;
  END IF;

  IF p_created_at IS NOT NULL THEN
    archive_part := 'dm_messages_' || to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY_MM');
    IF to_regclass(format('%I.%I', 'chat_archive', archive_part)) IS NOT NULL THEN
      RETURN QUERY EXECUTE format(
        'SELECT * FROM chat_archive.%I WHERE id = $1 AND created_at = $2 LIMIT 1', archive_part
      ) USING p_id, p_created_at;
      RETURN;
    END IF;
    RETURN QUERY SELECT m.* FROM chat.dm_messages m WHERE m.id = p_id AND m.created_at = p_created_at LIMIT 1;
    RETURN;
  END IF;

  RETURN QUERY SELECT m.* FROM chat.dm_messages m WHERE m.id = p_id LIMIT 1;
  IF FOUND THEN
    RETURN;
  END IF;

  FOR part IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'chat_archive' AND tablename ~ '^dm_messages_[0-9]{4}_[0-9]{2}$'
    ORDER BY tablename DESC
  LOOP
    RETURN QUERY EXECUTE format('SELECT * FROM chat_archive.%I WHERE id = $1 LIMIT 1', part.tablename) USING p_id;
    IF FOUND THEN
      RETURN;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION chat.dm_message_is_archived(p_created_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT p_created_at IS NOT NULL AND to_regclass(format(
    '%I.%I', 'chat_archive', 'dm_messages_' || to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY_MM')
  )) IS NOT NULL;
$$;
