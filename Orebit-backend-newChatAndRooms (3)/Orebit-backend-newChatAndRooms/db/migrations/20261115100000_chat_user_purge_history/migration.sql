-- Keep chat history when a user account is permanently purged. Chat records retain
-- the original UUID as an audit identifier, while reads render a deleted-user label.
-- Identity ownership is enforced by the account lifecycle before purge; a foreign key
-- here would either block erasure or cascade-delete user-visible chat history.
DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT con.conname, rel.relname AS table_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace rel_ns ON rel_ns.oid = rel.relnamespace
    JOIN pg_class ref ON ref.oid = con.confrelid
    JOIN pg_namespace ref_ns ON ref_ns.oid = ref.relnamespace
    WHERE con.contype = 'f'
      AND rel_ns.nspname = 'chat'
      AND ref_ns.nspname = 'identity'
      AND ref.relname = 'users'
      AND con.conparentid = 0
  LOOP
    EXECUTE format('ALTER TABLE chat.%I DROP CONSTRAINT %I', fk.table_name, fk.conname);
  END LOOP;
END $$;
