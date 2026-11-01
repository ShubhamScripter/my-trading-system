-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "admin";

-- CreateEnum
CREATE TYPE "admin"."AdminRole" AS ENUM ('SUPER_ADMIN', 'ADMIN');

-- CreateEnum
CREATE TYPE "admin"."AdminStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "admin"."AdminCredentialKind" AS ENUM ('PASSWORD');

-- CreateEnum
CREATE TYPE "admin"."AdminLoginState" AS ENUM ('PASSWORD_VERIFIED', 'EMAIL_VERIFIED', 'COMPLETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "admin"."AdminMfaMethod" AS ENUM ('TOTP', 'PASSKEY');

-- CreateEnum
CREATE TYPE "admin"."AdminChallengePurpose" AS ENUM ('LOGIN_EMAIL_OTP', 'PASSWORD_RESET');

-- CreateTable
CREATE TABLE "admin"."admins" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "email_lower" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "admin"."AdminRole" NOT NULL DEFAULT 'ADMIN',
    "status" "admin"."AdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "email_verified_at" TIMESTAMPTZ,
    "mfa_enrolled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin"."admin_credentials" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "kind" "admin"."AdminCredentialKind" NOT NULL DEFAULT 'PASSWORD',
    "password_hash" TEXT NOT NULL,
    "password_algo" TEXT NOT NULL DEFAULT 'argon2id',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "admin_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin"."admin_totp_factors" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "secret_ciphertext" BYTEA NOT NULL,
    "secret_iv" BYTEA NOT NULL,
    "secret_tag" BYTEA NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Authenticator',
    "confirmed_at" TIMESTAMPTZ,
    "last_used_step" BIGINT,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "admin_totp_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin"."admin_passkeys" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aaguid" TEXT,
    "label" TEXT NOT NULL DEFAULT 'Passkey',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "admin_passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin"."admin_login_attempts" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "state" "admin"."AdminLoginState" NOT NULL DEFAULT 'PASSWORD_VERIFIED',
    "step_up_secret_hash" TEXT,
    "mfa_attempts" INTEGER NOT NULL DEFAULT 0,
    "otp_sent_count" INTEGER NOT NULL DEFAULT 1,
    "last_otp_sent_at" TIMESTAMPTZ,
    "mfa_method" "admin"."AdminMfaMethod",
    "ip_address" INET NOT NULL,
    "user_agent" VARCHAR(256),
    "completed_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "admin_login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin"."admin_challenges" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "purpose" "admin"."AdminChallengePurpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ,
    "ip_address" INET NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin"."admin_sessions" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "parent_id" UUID,
    "mfa_method" "admin"."AdminMfaMethod" NOT NULL,
    "device_fingerprint" TEXT NOT NULL,
    "ip_class" TEXT NOT NULL,
    "user_agent" VARCHAR(256),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "rotated_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "revoked_reason" VARCHAR(32),

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admins_status_created_at_idx" ON "admin"."admins"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_credentials_admin_id_kind_key" ON "admin"."admin_credentials"("admin_id", "kind");

-- CreateIndex
CREATE INDEX "admin_totp_factors_admin_id_confirmed_at_idx" ON "admin"."admin_totp_factors"("admin_id", "confirmed_at");

-- CreateIndex
CREATE INDEX "admin_passkeys_admin_id_idx" ON "admin"."admin_passkeys"("admin_id");

-- CreateIndex
CREATE INDEX "admin_login_attempts_admin_id_created_at_idx" ON "admin"."admin_login_attempts"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_challenges_admin_id_purpose_consumed_at_idx" ON "admin"."admin_challenges"("admin_id", "purpose", "consumed_at");

-- CreateIndex
CREATE INDEX "admin_sessions_admin_id_revoked_at_idx" ON "admin"."admin_sessions"("admin_id", "revoked_at");

-- CreateIndex
CREATE INDEX "admin_sessions_family_id_idx" ON "admin"."admin_sessions"("family_id");

-- AddForeignKey
ALTER TABLE "admin"."admin_credentials" ADD CONSTRAINT "admin_credentials_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin"."admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin"."admin_totp_factors" ADD CONSTRAINT "admin_totp_factors_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin"."admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin"."admin_passkeys" ADD CONSTRAINT "admin_passkeys_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin"."admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin"."admin_login_attempts" ADD CONSTRAINT "admin_login_attempts_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin"."admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin"."admin_challenges" ADD CONSTRAINT "admin_challenges_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin"."admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin"."admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin"."admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

