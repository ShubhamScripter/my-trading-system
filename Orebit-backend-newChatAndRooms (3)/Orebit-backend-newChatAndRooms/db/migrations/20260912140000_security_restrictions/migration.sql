-- AlterTable
ALTER TABLE "identity"."sessions" ADD COLUMN     "country" CHAR(2);

-- CreateTable
CREATE TABLE "identity"."security_restriction_policies" (
    "id" UUID NOT NULL,
    "action" VARCHAR(48) NOT NULL,
    "context" VARCHAR(32) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subFeatures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "duration_seconds" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_admin_id" UUID,
    "reason" VARCHAR(256),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_restriction_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."security_restriction_policy_versions" (
    "id" UUID NOT NULL,
    "action" VARCHAR(48) NOT NULL,
    "context" VARCHAR(32) NOT NULL,
    "version" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subFeatures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "duration_seconds" INTEGER NOT NULL,
    "updated_by_admin_id" UUID,
    "reason" VARCHAR(256),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_restriction_policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."user_feature_restrictions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "feature" VARCHAR(64) NOT NULL,
    "sub_feature" VARCHAR(64),
    "trigger_action" VARCHAR(48) NOT NULL,
    "classification" VARCHAR(32) NOT NULL,
    "policy_context" VARCHAR(32) NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "ip_class_at_trigger" TEXT NOT NULL,
    "device_fingerprint_at_trigger" TEXT,
    "country_at_trigger" CHAR(2),
    "request_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_feature_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ux_security_restriction_policies_target" ON "identity"."security_restriction_policies"("action", "context");

-- CreateIndex
CREATE UNIQUE INDEX "ux_security_restriction_policy_versions_target" ON "identity"."security_restriction_policy_versions"("action", "context", "version");

-- CreateIndex
CREATE INDEX "user_feature_restrictions_user_id_expires_at_idx" ON "identity"."user_feature_restrictions"("user_id", "expires_at");

-- AddForeignKey
ALTER TABLE "identity"."user_feature_restrictions" ADD CONSTRAINT "user_feature_restrictions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

