-- Chat: the numbers the admin dashboard reads without touching the message table, users who keep hitting the
-- chat limits, versioned / scheduled / reversible admin settings changes, and the test-only
-- stand-in facts for the Premium, KYC, Site-Owner, Casino, VIP and level providers (NEW-2).
--
-- Rollback: drop the four tables. Nothing else depends on them.

-- ─── 1. Runtime stats: one row, written once a minute by the chat server ─────────────────────────────────────────
CREATE TABLE "chat"."runtime_stats" (
    "id"                   SMALLINT NOT NULL DEFAULT 1,
    "online_users"         INTEGER NOT NULL DEFAULT 0,
    "sockets"              INTEGER NOT NULL DEFAULT 0,
    "messages_last_minute" INTEGER NOT NULL DEFAULT 0,
    "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "runtime_stats_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "runtime_stats_single_row" CHECK ("id" = 1)
);
INSERT INTO "chat"."runtime_stats" ("id") VALUES (1) ON CONFLICT DO NOTHING;

-- ─── 2. Frequent limit hitters ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat"."frequent_hitters" (
    "user_id"       UUID NOT NULL,
    "last_ip"       TEXT,
    "hits"          INTEGER NOT NULL DEFAULT 0,
    "last_hit_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    "blocked_until" TIMESTAMPTZ,

    CONSTRAINT "frequent_hitters_pkey" PRIMARY KEY ("user_id")
);
CREATE INDEX "frequent_hitters_last_hit_at_idx" ON "chat"."frequent_hitters" ("last_hit_at" DESC);

-- ─── 3. Settings changes: applied now or scheduled, with the value before for rollback ──────────────────────────
CREATE TABLE "chat"."settings_changes" (
    "id"           UUID NOT NULL,
    "target"       TEXT NOT NULL,
    "room_id"      UUID,
    "actor_id"     UUID,
    "patch"        JSONB NOT NULL,
    "before"       JSONB,
    "effective_at" TIMESTAMPTZ NOT NULL,
    "status"       TEXT NOT NULL,
    "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_at"   TIMESTAMPTZ,

    CONSTRAINT "settings_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settings_changes_target_check" CHECK ("target" IN ('SETTINGS', 'ROOM')),
    CONSTRAINT "settings_changes_status_check" CHECK ("status" IN ('SCHEDULED', 'APPLIED', 'CANCELLED')),
    CONSTRAINT "settings_changes_room_check" CHECK (("target" = 'ROOM') = ("room_id" IS NOT NULL))
);
CREATE INDEX "settings_changes_due_idx" ON "chat"."settings_changes" ("effective_at") WHERE "status" = 'SCHEDULED';
CREATE INDEX "settings_changes_created_at_id_idx" ON "chat"."settings_changes" ("created_at" DESC, "id" DESC);

-- ─── 4. Test-only stand-in facts (refused in production; see chat.test-providers.ts) ─────────────────────────────
CREATE TABLE "chat"."test_entitlements" (
    "user_id"          UUID NOT NULL,
    "premium_plan_ids" TEXT[] NOT NULL DEFAULT '{}',
    "kyc_level"        INTEGER,
    "is_site_owner"    BOOLEAN NOT NULL DEFAULT false,
    "is_vip"           BOOLEAN NOT NULL DEFAULT false,
    "level"            INTEGER,
    "on_casino"        BOOLEAN NOT NULL DEFAULT false,
    "wager_usd"        DECIMAL(28,8) NOT NULL DEFAULT 0,
    "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "test_entitlements_pkey" PRIMARY KEY ("user_id")
);
ALTER TABLE "chat"."test_entitlements" ADD CONSTRAINT "test_entitlements_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
