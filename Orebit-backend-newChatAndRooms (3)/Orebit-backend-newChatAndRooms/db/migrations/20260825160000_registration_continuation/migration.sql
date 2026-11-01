-- Continuation secret for an in-flight registration.
--
-- `IF NOT EXISTS` is load-bearing rather than defensive habit: this column was
-- already created in this database by an earlier migration whose SQL file was
-- subsequently deleted, leaving the column orphaned — present in Postgres, absent
-- from schema.prisma, referenced by nothing. This migration adopts it, so the
-- statement has to be a no-op where it already exists and a create where it does
-- not.
ALTER TABLE "identity"."registrations"
  ADD COLUMN IF NOT EXISTS "continuation_secret_hash" TEXT;

-- The password hash held between the `credentials` and `country` steps must not
-- outlive the registration. Expiry nulls it in application code; this backfill
-- clears any row that expired before that code existed.
UPDATE "identity"."registrations"
   SET "pending_password_hash" = NULL
 WHERE "pending_password_hash" IS NOT NULL
   AND "completed_at" IS NULL
   AND "expires_at" <= now();
