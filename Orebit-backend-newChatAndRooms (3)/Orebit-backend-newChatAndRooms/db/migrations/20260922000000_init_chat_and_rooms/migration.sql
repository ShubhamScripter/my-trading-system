-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "chat";

-- CreateEnum
CREATE TYPE "identity"."UserRole" AS ENUM ('USER', 'MERCHANT', 'SO', 'ADMIN', 'MODERATOR', 'SUPPORT');

-- CreateEnum
CREATE TYPE "chat"."RoomType" AS ENUM ('GLOBAL', 'COUNTRY', 'REGION', 'LANGUAGE', 'PREMIUM', 'VIP', 'KYC', 'CASINO', 'SO', 'STAFF');

-- CreateEnum
CREATE TYPE "chat"."MessageType" AS ENUM ('TEXT', 'MEDIA', 'SYSTEM_ALERT', 'ADMIN_ALERT');

-- CreateEnum
CREATE TYPE "chat"."ReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'INAPPROPRIATE', 'SCAM', 'HATE_SPEECH', 'OTHER');

-- CreateEnum
CREATE TYPE "chat"."ReportStatus" AS ENUM ('PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED');

-- CreateEnum
-- Premium tiers: an optional, independent second dial on top of the existing
-- `is_premium` boolean. `is_premium` keeps gating every plain "premium room"
-- exactly as it always has; a tier is a SEPARATE, optional attribute a room's
-- access rule may additionally require a MINIMUM level of, via
-- `require_min_premium_tier` below. Null on either side means "no tier
-- involved" — an account with no tier assigned, or a room that does not care
-- about tier. Ordered low to high here for readability; the ranking a
-- "minimum tier" comparison actually uses is kept explicit in application code
-- (ChatUtility.premiumTierRank) rather than relied on implicitly from Postgres
-- enum declaration order.
CREATE TYPE "identity"."PremiumTier" AS ENUM ('BASIC', 'MEDIUM', 'TOP');

-- CreateTable: identity.user_memberships
CREATE TABLE "identity"."user_memberships" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "identity"."UserRole" NOT NULL DEFAULT 'USER',
    "is_premium" BOOLEAN NOT NULL DEFAULT false,
    "premium_tier" "identity"."PremiumTier",
    "is_kyc_completed" BOOLEAN NOT NULL DEFAULT false,
    "country" CHAR(2),
    "wager_total_usd" DECIMAL(18,8) NOT NULL DEFAULT 0.0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable: chat.rooms
CREATE TABLE "chat"."rooms" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "chat"."RoomType" NOT NULL DEFAULT 'GLOBAL',
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable: chat.room_access_rules
CREATE TABLE "chat"."room_access_rules" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "min_level" INTEGER NOT NULL DEFAULT 0,
    "min_wager_usd" DECIMAL(18,8),
    "require_premium" BOOLEAN NOT NULL DEFAULT false,
    "require_kyc" BOOLEAN NOT NULL DEFAULT false,
    "require_merchant" BOOLEAN NOT NULL DEFAULT false,
    "allowed_countries" CHAR(2)[],
    "view_only_countries" CHAR(2)[],
    "is_view_only_for_others" BOOLEAN NOT NULL DEFAULT true,
    "require_min_premium_tier" "identity"."PremiumTier",
    "config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "room_access_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable: chat.message_cosmetics
CREATE TABLE "chat"."message_cosmetics" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "style_config" JSONB NOT NULL,
    "cost" DECIMAL(18,8) NOT NULL DEFAULT 0.0,
    "is_premium" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_cosmetics_pkey" PRIMARY KEY ("id")
);

-- CreateTable: chat.user_chat_preferences
CREATE TABLE "chat"."user_chat_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "hide_identity" BOOLEAN NOT NULL DEFAULT false,
    "default_room_id" UUID,
    "last_opened_room_id" UUID,
    "quiet_mode" BOOLEAN NOT NULL DEFAULT false,
    "active_cosmetic_id" UUID,
    "notifications" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "user_chat_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable: chat.room_messages
CREATE TABLE "chat"."room_messages" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "type" "chat"."MessageType" NOT NULL DEFAULT 'TEXT',
    "cosmetic_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retracted_at" TIMESTAMPTZ,
    "retracted_by" UUID,
    "pinned_at" TIMESTAMPTZ,
    "pinned_by" UUID,

    CONSTRAINT "room_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable: chat.user_bans
CREATE TABLE "chat"."user_bans" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "room_id" UUID,
    "moderator_id" UUID,
    "reason" TEXT NOT NULL,
    "banned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_bans_pkey" PRIMARY KEY ("id")
);

-- CreateTable: chat.chat_message_reports
CREATE TABLE "chat"."chat_message_reports" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reported_user_id" UUID NOT NULL,
    "reason" "chat"."ReportReason" NOT NULL DEFAULT 'OTHER',
    "details" TEXT,
    "status" "chat"."ReportStatus" NOT NULL DEFAULT 'PENDING',
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_message_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable: chat.chat_warnings
CREATE TABLE "chat"."chat_warnings" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "room_id" UUID,
    "reason" TEXT NOT NULL,
    "issued_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_warnings_pkey" PRIMARY KEY ("id")
);

-- Unique Indexes
CREATE UNIQUE INDEX "user_memberships_user_id_key" ON "identity"."user_memberships"("user_id");
CREATE UNIQUE INDEX "rooms_slug_key" ON "chat"."rooms"("slug");
CREATE UNIQUE INDEX "user_chat_preferences_user_id_key" ON "chat"."user_chat_preferences"("user_id");

-- Indexes
CREATE INDEX "room_access_rules_room_id_idx" ON "chat"."room_access_rules"("room_id");
CREATE INDEX "room_messages_room_id_retracted_at_created_at_idx" ON "chat"."room_messages"("room_id", "retracted_at", "created_at");
CREATE INDEX "room_messages_room_id_pinned_at_idx" ON "chat"."room_messages"("room_id", "pinned_at");
CREATE INDEX "room_messages_user_id_idx" ON "chat"."room_messages"("user_id");
CREATE INDEX "room_messages_cosmetic_id_idx" ON "chat"."room_messages"("cosmetic_id");
CREATE INDEX "user_bans_user_id_room_id_is_active_expires_at_idx" ON "chat"."user_bans"("user_id", "room_id", "is_active", "expires_at");
CREATE INDEX "chat_message_reports_message_id_idx" ON "chat"."chat_message_reports"("message_id");
CREATE INDEX "chat_message_reports_reporter_id_idx" ON "chat"."chat_message_reports"("reporter_id");
CREATE INDEX "chat_message_reports_reported_user_id_idx" ON "chat"."chat_message_reports"("reported_user_id");
CREATE INDEX "chat_message_reports_status_idx" ON "chat"."chat_message_reports"("status");
CREATE INDEX "chat_warnings_user_id_idx" ON "chat"."chat_warnings"("user_id");

-- Foreign Keys
ALTER TABLE "identity"."user_memberships" ADD CONSTRAINT "user_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat"."room_access_rules" ADD CONSTRAINT "room_access_rules_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "chat"."rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat"."user_chat_preferences" ADD CONSTRAINT "user_chat_preferences_active_cosmetic_id_fkey" FOREIGN KEY ("active_cosmetic_id") REFERENCES "chat"."message_cosmetics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chat"."room_messages" ADD CONSTRAINT "room_messages_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "chat"."rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat"."room_messages" ADD CONSTRAINT "room_messages_cosmetic_id_fkey" FOREIGN KEY ("cosmetic_id") REFERENCES "chat"."message_cosmetics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "chat"."user_bans" ADD CONSTRAINT "user_bans_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "chat"."rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat"."chat_message_reports" ADD CONSTRAINT "chat_message_reports_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat"."room_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
