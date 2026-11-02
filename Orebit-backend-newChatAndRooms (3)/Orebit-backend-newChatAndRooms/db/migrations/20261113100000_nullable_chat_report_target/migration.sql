-- System-authored messages (such as admin-created ads) have no identity.users target.
-- The report still points at the original public message for review or retraction.
ALTER TABLE "chat"."chat_message_reports"
  ALTER COLUMN "reported_user_id" DROP NOT NULL;
