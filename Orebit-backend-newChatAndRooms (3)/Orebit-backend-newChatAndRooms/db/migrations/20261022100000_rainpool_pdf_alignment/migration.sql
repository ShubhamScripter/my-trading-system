-- RainPool, part four: the settings document follows the RainPool Settings sheet word for word (contract v4),
-- reverts by filter and by recipient, scheduled ON / OFF / MAINTENANCE, USD rates for development, and
-- "Disable User from Receiving Rains". Additive, except the config document, which is replaced by the v4 default
-- when it is still an older shape (amounts moved from crypto to USD, so an old document cannot be carried over).
--
-- Rollback: DROP TABLE rain.scheduled_changes, rain.dev_prices; drop the added columns; restore the CHECK
-- constraints below to their previous lists.

-- ─── config: the v4 document ─────────────────────────────────────────────────
UPDATE "rain"."config"
SET "document" = '{
  "status": { "overall": "ON", "system": "OFF", "user": "OFF", "note": null },
  "system": {
    "currencies": [],
    "amountUsd": { "min": "1", "max": "10" },
    "interval": { "min": { "value": 5, "unit": "MINUTES" }, "max": { "value": 15, "unit": "MINUTES" } },
    "recipients": { "mode": "SPECIFIC", "count": 1000, "percent": 100 },
    "threshold": 1000,
    "allocation": { "normalPercent": 50, "plans": [{ "planId": "*", "percent": 50 }] },
    "roomId": null
  },
  "user": {
    "currencies": { "all": false, "codes": [] },
    "minAmount": { "mode": "USD", "usd": "0.1", "perCurrency": [] },
    "maxAmount": { "mode": "USD", "usd": "1000", "perCurrency": [] },
    "recipients": { "modes": ["SPECIFIC"], "min": 1, "max": 20 },
    "allocation": { "normalPercent": 100, "plans": [] },
    "channels": { "all": false, "roomIds": [] },
    "feePercent": 2,
    "autoRepeat": {
      "enabled": false, "minCount": 2, "maxCount": 5,
      "minGap": { "value": 60, "unit": "SECONDS" }, "maxGap": { "value": 1, "unit": "HOURS" }
    }
  },
  "rewards": {
    "perRainDone": {
      "exp": { "mode": "FIXED", "amount": 0, "everyUsd": "1" },
      "stars": { "mode": "FIXED", "amount": 0, "everyUsd": "1" }
    },
    "perRainReceived": {
      "exp": { "mode": "FIXED", "amount": 0, "everyUsd": "1" },
      "stars": { "mode": "FIXED", "amount": 0, "everyUsd": "1" }
    }
  },
  "security": {
    "commonIp": { "enabled": true },
    "newIpSameCountry": { "enabled": false, "amountAboveUsd": null, "require": "ONE" },
    "newCountry": { "enabled": false, "amountAboveUsd": null, "questionnaire": false, "kycCheck": false },
    "vpnProxy": { "enabled": false, "amountAboveUsd": null, "questionnaire": "OFF", "kycCheck": "OFF" },
    "questions": [],
    "kycMinLevel": 1
  }
}'::jsonb,
    "version" = "version" + 1,
    "updated_at" = now()
WHERE "id" = 1 AND NOT ("document" ? 'status');

-- ─── schedule: the next pot in USD, for the count-up ─────────────────────────
ALTER TABLE "rain"."schedule" ADD COLUMN "next_pot_usd_minor" BIGINT;

-- ─── runs ────────────────────────────────────────────────────────────────────
-- PARTIALLY_REVERSED: some recipients' shares were taken back ("specific users / group of users").
ALTER TABLE "rain"."runs" DROP CONSTRAINT "runs_status_check";
ALTER TABLE "rain"."runs" ADD CONSTRAINT "runs_status_check" CHECK ("status" IN (
    'PENDING_VERIFICATION', 'PENDING_REVIEW', 'COMPLETED', 'PARTIALLY_REVERSED', 'REVERSED', 'REJECTED', 'EXPIRED'));
-- What the user typed for "Number of users to Rain": {"mode":"SPECIFIC","count":5} | {"mode":"ALL"} | {"mode":"PERCENT","percent":10}.
ALTER TABLE "rain"."runs" ADD COLUMN "recipient_rule" JSONB;
-- The USD price of one unit and the pot's USD value when the rain was made. Null when no price was known.
ALTER TABLE "rain"."runs" ADD COLUMN "usd_price_minor" BIGINT;
ALTER TABLE "rain"."runs" ADD COLUMN "usd_value_minor" BIGINT;
CREATE INDEX "runs_kind_currency_created_idx" ON "rain"."runs" ("kind", "currency", "created_at" DESC);

-- ─── recipients: each share is taken back at most once ───────────────────────
ALTER TABLE "rain"."recipients" ADD COLUMN "reversed_at" TIMESTAMPTZ;
ALTER TABLE "rain"."recipients" ADD COLUMN "reversed_job_id" UUID;
ALTER TABLE "rain"."recipients" ADD COLUMN "reclaimed_minor" BIGINT;

-- ─── jobs: a revert by filter ────────────────────────────────────────────────
-- `filter` is a RainRevertFilter (rain.contract.ts) for a bulk revert; null with `rain_id` set for one rain.
ALTER TABLE "rain"."jobs" ADD COLUMN "filter" JSONB;
-- How far a bulk revert got: rains matched, reverted, failed.
ALTER TABLE "rain"."jobs" ADD COLUMN "progress" JSONB;

-- ─── repeats ─────────────────────────────────────────────────────────────────
ALTER TABLE "rain"."repeats" ADD COLUMN "recipient_rule" JSONB;
ALTER TABLE "rain"."repeats" DROP CONSTRAINT "repeats_status_check";
ALTER TABLE "rain"."repeats" ADD CONSTRAINT "repeats_status_check" CHECK ("status" IN (
    'SCHEDULED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'));
CREATE INDEX "repeats_initiator_idx" ON "rain"."repeats" ("initiator_id", "created_at" DESC);

-- ─── scheduled ON / OFF / MAINTENANCE ────────────────────────────────────────
-- `patch` is a RainStatusPatch: the statuses (and maintenance text) to set at `apply_at`, on the database clock.
CREATE TABLE "rain"."scheduled_changes" (
    "id"          UUID NOT NULL,
    "apply_at"    TIMESTAMPTZ NOT NULL,
    "patch"       JSONB NOT NULL,
    "state"       TEXT NOT NULL DEFAULT 'PENDING',
    "created_by"  UUID,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_at"  TIMESTAMPTZ,
    "error"       TEXT,
    CONSTRAINT "scheduled_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "scheduled_changes_state_check" CHECK ("state" IN ('PENDING', 'APPLIED', 'CANCELLED', 'FAILED'))
);
CREATE INDEX "scheduled_changes_due_idx" ON "rain"."scheduled_changes" ("apply_at") WHERE "state" = 'PENDING';

-- ─── USD rates for development ───────────────────────────────────────────────
-- Read only while RAIN_DEV_WALLET is on and no price module is bound. Production never reads it.
CREATE TABLE "rain"."dev_prices" (
    "currency"   TEXT NOT NULL,
    "usd_price"  NUMERIC(28, 8) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "dev_prices_pkey" PRIMARY KEY ("currency"),
    CONSTRAINT "dev_prices_positive_check" CHECK ("usd_price" > 0)
);

-- ─── "Disable User from Receiving Rains" ─────────────────────────────────────
-- RESTRICT_RAIN is now "Restrict Raining Ability" only (may not start a user rain).
ALTER TABLE "chat"."user_restrictions" DROP CONSTRAINT "user_restrictions_kind_check";
ALTER TABLE "chat"."user_restrictions" ADD CONSTRAINT "user_restrictions_kind_check" CHECK ("kind" IN (
    'MUTE', 'RESTRICT_MEDIA', 'RESTRICT_EMOJI', 'RESTRICT_GIF', 'RESTRICT_COMMANDS', 'RESTRICT_ADS',
    'RESTRICT_DM', 'RESTRICT_GIFTS', 'RESTRICT_RECEIVE_GIFTS', 'RESTRICT_RAIN', 'RESTRICT_RAIN_RECEIVE'));
