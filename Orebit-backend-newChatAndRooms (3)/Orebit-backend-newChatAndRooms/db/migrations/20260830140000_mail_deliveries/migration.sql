-- Outbound mail, and what the relay said about it — scope gap M10.
--
-- Everything recorded here was already computed on every send and thrown into a
-- log line. Persisting it is what makes "the user says the code never arrived"
-- answerable after log retention has rolled over, and it is the table the admin
-- panel's delivered / failed / bounce-rate view reads.

-- CreateEnum
CREATE TYPE "identity"."MailDeliveryStatus" AS ENUM ('SENT', 'REJECTED', 'FAILED', 'SKIPPED');

-- CreateTable
--
-- No user_id: registration codes go out before a User row exists, so a nullable
-- foreign key would imply a join that is never useful. The recipient address is
-- what an investigation actually searches by.
CREATE TABLE "identity"."mail_deliveries" (
    "id" UUID NOT NULL,
    "recipient" TEXT NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "subject" VARCHAR(256) NOT NULL,
    "status" "identity"."MailDeliveryStatus" NOT NULL,
    "transport" VARCHAR(16),
    "message_id" TEXT,
    "response" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_deliveries_pkey" PRIMARY KEY ("id")
);

-- "did this address get anything, and when" — the support query.
CREATE INDEX "mail_deliveries_recipient_created_at_idx"
  ON "identity"."mail_deliveries" ("recipient", "created_at");

-- "what is failing right now" — the operational one.
CREATE INDEX "mail_deliveries_status_created_at_idx"
  ON "identity"."mail_deliveries" ("status", "created_at");
