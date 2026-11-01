-- Chat Module 10 (Chat MAIN):
--  - "SO / Merchants: a separate chat folder for all merchant chats": a MERCHANT folder in the personal-chat inbox.
--  - "Support Chat: a support chat room that works exactly the same way as support tickets work, just in chat format":
--    chat.support_tickets (PENDING, OPEN, CLOSED) and their messages.
--
-- Rollback: DROP TABLE chat.support_messages, chat.support_tickets; restore dm_members_folder_check to
-- ('PRIMARY', 'GENERAL', 'GROUPS') after moving MERCHANT rows to GENERAL.

ALTER TABLE "chat"."dm_members" DROP CONSTRAINT "dm_members_folder_check";
ALTER TABLE "chat"."dm_members" ADD CONSTRAINT "dm_members_folder_check"
    CHECK ("folder" IN ('PRIMARY', 'GENERAL', 'GROUPS', 'MERCHANT'));

CREATE TABLE "chat"."support_tickets" (
    "id"               UUID NOT NULL,
    "user_id"          UUID NOT NULL,
    "subject"          TEXT NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'PENDING',
    "closed_by_user"   UUID,
    "closed_by_admin"  UUID,
    "closed_at"        TIMESTAMPTZ,
    "last_message_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_tickets_status_check" CHECK ("status" IN ('PENDING', 'OPEN', 'CLOSED')),
    CONSTRAINT "support_tickets_subject_check" CHECK (length("subject") BETWEEN 1 AND 120),
    CONSTRAINT "support_tickets_closed_check"
        CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL))
);
CREATE INDEX "support_tickets_user_id_last_message_at_idx"
    ON "chat"."support_tickets" ("user_id", "last_message_at" DESC);
CREATE INDEX "support_tickets_status_last_message_at_idx"
    ON "chat"."support_tickets" ("status", "last_message_at" DESC);
ALTER TABLE "chat"."support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "chat"."support_messages" (
    "id"               UUID NOT NULL,
    "ticket_id"        UUID NOT NULL,
    "sender_user_id"   UUID,
    "sender_admin_id"  UUID,
    "content"          TEXT NOT NULL,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "support_messages_sender_check"
        CHECK (("sender_user_id" IS NULL) <> ("sender_admin_id" IS NULL)),
    CONSTRAINT "support_messages_content_check" CHECK (length("content") BETWEEN 1 AND 4000)
);
CREATE INDEX "support_messages_ticket_id_created_at_id_idx"
    ON "chat"."support_messages" ("ticket_id", "created_at", "id");
ALTER TABLE "chat"."support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey"
    FOREIGN KEY ("ticket_id") REFERENCES "chat"."support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."support_messages" ADD CONSTRAINT "support_messages_sender_user_id_fkey"
    FOREIGN KEY ("sender_user_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
