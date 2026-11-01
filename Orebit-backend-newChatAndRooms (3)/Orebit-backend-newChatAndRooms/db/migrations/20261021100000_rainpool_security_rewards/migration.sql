-- RainPool, part two: security checks before a user rain, EXP/Stars bookkeeping, refund
-- policy on reversals, and an audit trail. Additive only; no existing row changes meaning.

-- ─── runs ────────────────────────────────────────────────────────────────────
-- PENDING_VERIFICATION: a user rain waiting for its 2FA / email code / questionnaire.
-- Nothing is debited and no recipients are chosen until it is confirmed.
-- EXPIRED: a verification that was never confirmed in time. Nothing was moved.
ALTER TABLE "rain"."runs" DROP CONSTRAINT "runs_status_check";
ALTER TABLE "rain"."runs" ADD CONSTRAINT "runs_status_check" CHECK ("status" IN (
    'PENDING_VERIFICATION', 'PENDING_REVIEW', 'COMPLETED', 'REVERSED', 'REJECTED', 'EXPIRED'));

-- The requested recipient count of a rain that has not picked its recipients yet.
ALTER TABLE "rain"."runs" ADD COLUMN "requested_recipients" INTEGER;
-- Auto-repeat asked for with the command, kept so a verified or approved rain can schedule it.
ALTER TABLE "rain"."runs" ADD COLUMN "repeat_count" INTEGER;
ALTER TABLE "rain"."runs" ADD COLUMN "repeat_gap_seconds" INTEGER;
-- What the security policy asked for and when it was satisfied. Never holds a code.
ALTER TABLE "rain"."runs" ADD COLUMN "security" JSONB;
-- EXP/Stars the rain earned, and whether the rewards module confirmed them.
ALTER TABLE "rain"."runs" ADD COLUMN "rewards" JSONB;
ALTER TABLE "rain"."runs" ADD COLUMN "rewards_revoked_at" TIMESTAMPTZ;
-- Whether a reversal also took the platform fee back to the payer.
ALTER TABLE "rain"."runs" ADD COLUMN "fee_refunded" BOOLEAN;

CREATE INDEX "runs_status_created_idx" ON "rain"."runs" ("status", "created_at" DESC);
CREATE INDEX "runs_initiator_idx" ON "rain"."runs" ("initiator_id", "created_at" DESC);
CREATE INDEX "recipients_user_idx" ON "rain"."recipients" ("user_id");

-- ─── jobs ────────────────────────────────────────────────────────────────────
-- Refund policy of a REVERT: true gives the payer the whole pot back (fee included).
ALTER TABLE "rain"."jobs" ADD COLUMN "refund_fee" BOOLEAN NOT NULL DEFAULT true;

-- ─── audit ───────────────────────────────────────────────────────────────────
-- Who changed rain settings or acted on a rain, and what came of it. Append only.
CREATE TABLE "rain"."audit_log" (
    "id"          UUID NOT NULL,
    "actor_type"  TEXT NOT NULL,
    "actor_id"    UUID,
    "action"      TEXT NOT NULL,
    "rain_id"     UUID,
    "reason"      TEXT,
    "detail"      JSONB,
    "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_log_actor_type_check" CHECK ("actor_type" IN ('ADMIN', 'STAFF', 'USER', 'SYSTEM'))
);

CREATE INDEX "audit_log_created_at_idx" ON "rain"."audit_log" ("created_at" DESC);
CREATE INDEX "audit_log_rain_idx" ON "rain"."audit_log" ("rain_id");

-- ─── the emailed rain code ───────────────────────────────────────────────────
-- Its own purpose, so a rain code never supersedes a password reset or a credential
-- change already in the user's inbox (`issue` retires the live row per purpose).
ALTER TYPE "identity"."ChallengePurpose" ADD VALUE IF NOT EXISTS 'RAIN_CONFIRM';
