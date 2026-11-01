-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateEnum
CREATE TYPE "identity"."UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "identity"."CredentialKind" AS ENUM ('PASSWORD');

-- CreateEnum
CREATE TYPE "identity"."RegistrationState" AS ENUM ('OTP_SENT', 'OTP_VERIFIED', 'ACCOUNT_CREATED', 'COMPLETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "identity"."OauthProvider" AS ENUM ('GOOGLE', 'X', 'TELEGRAM', 'APPLE', 'FACEBOOK');

-- CreateEnum
CREATE TYPE "identity"."ChallengePurpose" AS ENUM ('LOGIN_OTP', 'PASSWORD_RESET');

-- CreateTable
CREATE TABLE "identity"."users" (
    "id" UUID NOT NULL,
    "public_code" TEXT NOT NULL,
    "public_code_key" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "username_lower" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_lower" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ,
    "status" "identity"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "country_declared" CHAR(2),
    "country_ip" CHAR(2),
    "referral_code" TEXT NOT NULL,
    "referred_by_code" TEXT,
    "referred_by_user_id" UUID,
    "registered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "identity"."CredentialKind" NOT NULL DEFAULT 'PASSWORD',
    "password_hash" TEXT NOT NULL,
    "password_algo" TEXT NOT NULL DEFAULT 'argon2id',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "parent_id" UUID,
    "device_fingerprint" TEXT NOT NULL,
    "ip_class" TEXT NOT NULL,
    "user_agent" VARCHAR(256),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "rotated_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "revoked_reason" VARCHAR(32),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."registrations" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "email_lower" TEXT NOT NULL,
    "state" "identity"."RegistrationState" NOT NULL DEFAULT 'OTP_SENT',
    "otp_hash" TEXT,
    "otp_expires_at" TIMESTAMPTZ,
    "otp_attempts" INTEGER NOT NULL DEFAULT 0,
    "otp_sent_count" INTEGER NOT NULL DEFAULT 1,
    "last_otp_sent_at" TIMESTAMPTZ,
    "email_verified_at" TIMESTAMPTZ,
    "password_set" BOOLEAN NOT NULL DEFAULT false,
    "referral_code_entered" TEXT,
    "country_suggested" CHAR(2),
    "country" CHAR(2),
    "ip_address" INET NOT NULL,
    "user_id" UUID,
    "completed_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,
    "oauth_provider" "identity"."OauthProvider",
    "oauth_subject" TEXT,
    "oauth_email_verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."oauth_links" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "identity"."OauthProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "email_at_link" TEXT,
    "email_verified_by_provider" BOOLEAN NOT NULL DEFAULT false,
    "linked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "oauth_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."verification_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "identity"."ChallengePurpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ,
    "ip_address" INET NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "users_status_registered_at_idx" ON "identity"."users"("status", "registered_at");

-- CreateIndex
CREATE INDEX "users_referred_by_user_id_idx" ON "identity"."users"("referred_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_user_id_kind_key" ON "identity"."credentials"("user_id", "kind");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "identity"."sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_family_id_idx" ON "identity"."sessions"("family_id");

-- CreateIndex
CREATE INDEX "registrations_email_lower_idx" ON "identity"."registrations"("email_lower");

-- CreateIndex
CREATE INDEX "registrations_state_idx" ON "identity"."registrations"("state");

-- CreateIndex
CREATE INDEX "registrations_oauth_provider_oauth_subject_idx" ON "identity"."registrations"("oauth_provider", "oauth_subject");

-- CreateIndex
CREATE INDEX "oauth_links_user_id_idx" ON "identity"."oauth_links"("user_id");

-- CreateIndex
CREATE INDEX "oauth_links_provider_subject_idx" ON "identity"."oauth_links"("provider", "subject");

-- CreateIndex
CREATE INDEX "verification_challenges_user_id_purpose_consumed_at_idx" ON "identity"."verification_challenges"("user_id", "purpose", "consumed_at");

-- AddForeignKey
ALTER TABLE "identity"."users" ADD CONSTRAINT "users_referred_by_user_id_fkey" FOREIGN KEY ("referred_by_user_id") REFERENCES "identity"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."credentials" ADD CONSTRAINT "credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."registrations" ADD CONSTRAINT "registrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."oauth_links" ADD CONSTRAINT "oauth_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."verification_challenges" ADD CONSTRAINT "verification_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
