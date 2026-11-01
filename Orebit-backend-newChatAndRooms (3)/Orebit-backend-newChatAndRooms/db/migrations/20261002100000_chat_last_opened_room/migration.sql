-- Chat: keep the room each user last opened on the server, so any device reopens it.
-- A deleted room clears the pointer (ON DELETE SET NULL) instead of blocking the delete.
--
-- Rollback: ALTER TABLE "chat"."user_chat_preferences" DROP COLUMN "last_opened_room_id";

ALTER TABLE "chat"."user_chat_preferences" ADD COLUMN "last_opened_room_id" UUID;

ALTER TABLE "chat"."user_chat_preferences" ADD CONSTRAINT "user_chat_preferences_last_opened_room_id_fkey"
    FOREIGN KEY ("last_opened_room_id") REFERENCES "chat"."rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
