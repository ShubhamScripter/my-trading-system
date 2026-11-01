-- RainPool: system rain schedule, user rains, admin jobs, and the dev-only balance table.
-- Money in production does not use rain.dev_balances. That table exists so a development
-- flag can exercise the flow while src/ledger is still empty.
--
-- Rollback: DROP SCHEMA rain CASCADE;

CREATE SCHEMA IF NOT EXISTS "rain";

CREATE TABLE "rain"."config" (
    "id"         SMALLINT NOT NULL DEFAULT 1,
    "document"   JSONB NOT NULL,
    "version"    INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "config_single_row" CHECK ("id" = 1)
);

CREATE TABLE "rain"."schedule" (
    "id"           SMALLINT NOT NULL DEFAULT 1,
    "next_rain_at" TIMESTAMPTZ,
    "lock_owner"   TEXT,
    "lock_until"   TIMESTAMPTZ,
    CONSTRAINT "schedule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "schedule_single_row" CHECK ("id" = 1)
);

CREATE TABLE "rain"."runs" (
    "id"                   UUID NOT NULL,
    "kind"                 TEXT NOT NULL,
    "status"               TEXT NOT NULL,
    "room_id"              UUID NOT NULL,
    "initiator_id"         UUID,
    "currency"             TEXT NOT NULL,
    "pot_minor"            BIGINT NOT NULL,
    "fee_minor"            BIGINT NOT NULL,
    "distributable_minor"  BIGINT NOT NULL,
    "recipient_count"      INTEGER NOT NULL,
    "idempotency_key"      TEXT NOT NULL,
    "message_id"           UUID,
    "created_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
    "reversed_at"          TIMESTAMPTZ,
    "reverse_reason"       TEXT,
    "reversed_by"          UUID,
    CONSTRAINT "runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "runs_kind_check" CHECK ("kind" IN ('SYSTEM', 'USER')),
    CONSTRAINT "runs_status_check" CHECK ("status" IN ('PENDING_REVIEW', 'COMPLETED', 'REVERSED', 'REJECTED')),
    CONSTRAINT "runs_amounts_check" CHECK (
        "pot_minor" > 0
        AND "fee_minor" >= 0
        AND "distributable_minor" >= 0
        AND "fee_minor" + "distributable_minor" = "pot_minor"
    ),
    CONSTRAINT "runs_idempotency_key_key" UNIQUE ("idempotency_key")
);
CREATE INDEX "runs_created_at_idx" ON "rain"."runs" ("created_at" DESC);

CREATE TABLE "rain"."recipients" (
    "rain_id"      UUID NOT NULL,
    "user_id"      UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "tier"         TEXT NOT NULL,
    CONSTRAINT "recipients_pkey" PRIMARY KEY ("rain_id", "user_id"),
    CONSTRAINT "recipients_amount_check" CHECK ("amount_minor" > 0),
    CONSTRAINT "recipients_tier_check" CHECK ("tier" IN ('NORMAL', 'PREMIUM')),
    CONSTRAINT "recipients_rain_id_fkey" FOREIGN KEY ("rain_id") REFERENCES "rain"."runs"("id") ON DELETE CASCADE
);

CREATE TABLE "rain"."jobs" (
    "id"          UUID NOT NULL,
    "kind"        TEXT NOT NULL,
    "rain_id"     UUID,
    "actor_id"    UUID,
    "reason"      TEXT,
    "status"      TEXT NOT NULL,
    "error"       TEXT,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    "started_at"  TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "jobs_kind_check" CHECK ("kind" IN ('MANUAL_SYSTEM', 'REVERT', 'APPROVE', 'REJECT')),
    CONSTRAINT "jobs_status_check" CHECK ("status" IN ('PENDING', 'RUNNING', 'DONE', 'FAILED'))
);
CREATE INDEX "jobs_pending_idx" ON "rain"."jobs" ("created_at") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "jobs_one_open_rain_idx" ON "rain"."jobs" ("kind", "rain_id")
    WHERE "status" IN ('PENDING', 'RUNNING') AND "rain_id" IS NOT NULL;

CREATE TABLE "rain"."repeats" (
    "id"               UUID NOT NULL,
    "initiator_id"     UUID NOT NULL,
    "room_id"          UUID NOT NULL,
    "currency"         TEXT NOT NULL,
    "pot_minor"        BIGINT NOT NULL,
    "recipient_count"  INTEGER NOT NULL,
    "remaining"        INTEGER NOT NULL,
    "gap_seconds"      INTEGER NOT NULL,
    "next_run_at"      TIMESTAMPTZ NOT NULL,
    "status"           TEXT NOT NULL,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "repeats_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repeats_status_check" CHECK ("status" IN ('SCHEDULED', 'RUNNING', 'DONE', 'FAILED')),
    CONSTRAINT "repeats_remaining_check" CHECK ("remaining" >= 0)
);
CREATE INDEX "repeats_due_idx" ON "rain"."repeats" ("next_run_at") WHERE "status" = 'SCHEDULED';

CREATE TABLE "rain"."dev_balances" (
    "user_id"       UUID NOT NULL,
    "currency"      TEXT NOT NULL,
    "balance_minor" BIGINT NOT NULL,
    CONSTRAINT "dev_balances_pkey" PRIMARY KEY ("user_id", "currency")
);

CREATE TABLE "rain"."ledger_entries" (
    "id"              UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "user_id"         UUID NOT NULL,
    "currency"        TEXT NOT NULL,
    "delta_minor"     BIGINT NOT NULL,
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_entries_idempotency_key_key" UNIQUE ("idempotency_key"),
    CONSTRAINT "ledger_entries_delta_check" CHECK ("delta_minor" <> 0)
);

INSERT INTO "rain"."config" ("id", "document")
VALUES (
    1,
    '{
      "system": {
        "status": "OFF",
        "currencies": [],
        "minIntervalSeconds": 300,
        "maxIntervalSeconds": 900,
        "recipientMode": "FIXED",
        "recipientCount": 10,
        "recipientPercent": 100,
        "premiumWeight": 1,
        "normalWeight": 1,
        "roomId": null
      },
      "user": {
        "status": "OFF",
        "currencies": [],
        "min": "0.00000001",
        "max": "1",
        "minRecipients": 1,
        "maxRecipients": 20,
        "allowAllRooms": false,
        "allowedRoomIds": [],
        "feeBps": 200,
        "autoRepeat": false,
        "minRepeatCount": 2,
        "maxRepeatCount": 5,
        "minGapSeconds": 60,
        "maxGapSeconds": 3600
      },
      "rewards": { "doneExp": 0, "doneStars": 0, "receivedExp": 0, "receivedStars": 0 },
      "security": { "reviewAbove": null }
    }'::jsonb
)
ON CONFLICT DO NOTHING;

INSERT INTO "rain"."schedule" ("id") VALUES (1) ON CONFLICT DO NOTHING;

-- User rain can be taken away from a user (RESTRICT_RAIN), like gifts.
ALTER TABLE "chat"."user_restrictions" DROP CONSTRAINT "user_restrictions_kind_check";
ALTER TABLE "chat"."user_restrictions" ADD CONSTRAINT "user_restrictions_kind_check" CHECK ("kind" IN (
    'MUTE', 'RESTRICT_MEDIA', 'RESTRICT_EMOJI', 'RESTRICT_GIF', 'RESTRICT_COMMANDS', 'RESTRICT_ADS',
    'RESTRICT_DM', 'RESTRICT_GIFTS', 'RESTRICT_RECEIVE_GIFTS', 'RESTRICT_RAIN'));
