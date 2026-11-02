-- A reason code is unique within its report type, not across both independent lists.
-- Rollback requires deleting any duplicate USER reason codes first; reports keep their report_type.
ALTER TABLE "chat"."chat_message_reports" ADD COLUMN "report_type" TEXT NOT NULL DEFAULT 'MESSAGE';
-- The prior schema tracked report_type only on the reason list. Backfill each existing report from its reason row
-- before adding the composite foreign key (USER reasons may have no MESSAGE counterpart).
UPDATE "chat"."chat_message_reports" r
SET "report_type" = rr."report_type"
FROM "chat"."report_reasons" rr
WHERE rr."code" = r."reason";
ALTER TABLE "chat"."chat_message_reports" DROP CONSTRAINT "chat_message_reports_reason_fkey";
ALTER TABLE "chat"."report_reasons" DROP CONSTRAINT "report_reasons_pkey";
ALTER TABLE "chat"."report_reasons" ADD CONSTRAINT "report_reasons_pkey" PRIMARY KEY ("code", "report_type");
ALTER TABLE "chat"."chat_message_reports" ADD CONSTRAINT "chat_message_reports_reason_report_type_fkey"
    FOREIGN KEY ("reason", "report_type") REFERENCES "chat"."report_reasons"("code", "report_type")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rollback SQL (after removing duplicate codes across types):
-- ALTER TABLE "chat"."chat_message_reports" DROP CONSTRAINT "chat_message_reports_reason_report_type_fkey";
-- ALTER TABLE "chat"."report_reasons" DROP CONSTRAINT "report_reasons_pkey";
-- ALTER TABLE "chat"."report_reasons" ADD CONSTRAINT "report_reasons_pkey" PRIMARY KEY ("code");
-- ALTER TABLE "chat"."chat_message_reports" ADD CONSTRAINT "chat_message_reports_reason_fkey"
--   FOREIGN KEY ("reason") REFERENCES "chat"."report_reasons"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
-- ALTER TABLE "chat"."chat_message_reports" DROP COLUMN "report_type";
