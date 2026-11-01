-- `otp_sent_count` counts codes ACTUALLY EMAILED, so it starts at zero and the
-- send increments it. The previous default of 1 pre-counted the first code and
-- then counted it again when it was sent, so a client was told it had three
-- resends remaining when it had four.
ALTER TABLE "admin"."admin_login_attempts" ALTER COLUMN "otp_sent_count" SET DEFAULT 0;
