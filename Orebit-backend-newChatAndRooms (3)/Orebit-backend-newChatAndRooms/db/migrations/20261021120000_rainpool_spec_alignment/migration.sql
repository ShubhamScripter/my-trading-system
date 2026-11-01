-- RainPool, part three: aligned with the RainPool settings sheet. Additive only.

-- ─── schedule: the next system rain is chosen when it is scheduled ───────────
-- "On the UI side the randomly selected amount will show filling with time (count up) till the
-- rain time": the currency and pot are picked with the time, so the app can show them growing.
ALTER TABLE "rain"."schedule" ADD COLUMN "next_currency" TEXT;
ALTER TABLE "rain"."schedule" ADD COLUMN "next_pot_minor" BIGINT;
-- When the countdown started, so the count-up runs from 0 to the pot over the same span.
ALTER TABLE "rain"."schedule" ADD COLUMN "scheduled_at" TIMESTAMPTZ;
ALTER TABLE "rain"."schedule" ADD CONSTRAINT "schedule_next_pot_check" CHECK ("next_pot_minor" IS NULL OR "next_pot_minor" > 0);

-- ─── jobs: the reversal policies of the sheet ────────────────────────────────
-- payer_refund: REFUND = what is taken back goes to the person who rained (never the fee);
-- NONE = "do nothing" for them, it goes to the platform. shortfall: ZERO = "refund till 0";
-- NEGATIVE = take the whole share, the balance may go below zero. `refund_fee` is no longer read.
ALTER TABLE "rain"."jobs" ADD COLUMN "payer_refund" TEXT NOT NULL DEFAULT 'REFUND';
ALTER TABLE "rain"."jobs" ADD COLUMN "shortfall" TEXT NOT NULL DEFAULT 'ZERO';
ALTER TABLE "rain"."jobs" ADD CONSTRAINT "jobs_payer_refund_check" CHECK ("payer_refund" IN ('REFUND', 'NONE'));
ALTER TABLE "rain"."jobs" ADD CONSTRAINT "jobs_shortfall_check" CHECK ("shortfall" IN ('ZERO', 'NEGATIVE'));

-- ─── runs ────────────────────────────────────────────────────────────────────
-- When a verification lapses. Set when it is asked for, and again when an admin asks for the
-- questionnaire or a KYC check during a manual review.
ALTER TABLE "rain"."runs" ADD COLUMN "verify_expires_at" TIMESTAMPTZ;
-- What a reversal actually moved: reclaimed, missing (refund till 0), who was credited.
ALTER TABLE "rain"."runs" ADD COLUMN "reverse_detail" JSONB;
