-- Slice: FR-250 (Module 4). Each report type has its own list of reasons: 'MESSAGE' (Chat Messages or Requests) and
-- 'USER' (User Profile). Existing reasons stay on the message list; the admin adds the user-profile ones.
-- Rollback: drop the column.
ALTER TABLE "chat"."report_reasons" ADD COLUMN "report_type" TEXT NOT NULL DEFAULT 'MESSAGE';
ALTER TABLE "chat"."report_reasons" ADD CONSTRAINT "report_reasons_report_type_check" CHECK ("report_type" IN ('MESSAGE', 'USER'));
