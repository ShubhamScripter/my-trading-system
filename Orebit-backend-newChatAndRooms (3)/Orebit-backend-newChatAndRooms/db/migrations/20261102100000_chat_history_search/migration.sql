-- FR-095: the admin's message search follows one user across rooms, newest first, by keyset.
-- (user_id, created_at DESC, id DESC) serves it page by page; the single-column user index it replaces is a prefix of it.
-- On the partitioned table the index is created on every partition.
-- Rollback: DROP INDEX chat.room_messages_user_id_created_at_id_idx; CREATE INDEX room_messages_user_id_idx ON chat.room_messages (user_id).

CREATE INDEX "room_messages_user_id_created_at_id_idx" ON "chat"."room_messages" ("user_id", "created_at" DESC, "id" DESC);
DROP INDEX "chat"."room_messages_user_id_idx";
