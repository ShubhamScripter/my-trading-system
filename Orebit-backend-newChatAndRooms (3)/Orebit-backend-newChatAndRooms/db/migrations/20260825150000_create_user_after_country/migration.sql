-- Keep the pre-account registration state distinct from a real User row.
ALTER TYPE "identity"."RegistrationState" ADD VALUE IF NOT EXISTS 'CREDENTIALS_SET';

-- Only an Argon2id hash is retained between the credentials and country steps.
ALTER TABLE "identity"."registrations"
  ADD COLUMN "pending_password_hash" TEXT;
