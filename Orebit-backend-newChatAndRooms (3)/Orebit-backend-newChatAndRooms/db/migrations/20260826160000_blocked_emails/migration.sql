-- The email blocklist: one row is one rule, read on signup and on signin.
--
-- A table rather than a constant in code because the rules change on an
-- operator's timescale, not a deploy's.
CREATE TYPE "identity"."BlockedEmailKind" AS ENUM ('EMAIL', 'DOMAIN');

CREATE TABLE "identity"."blocked_emails" (
  "id"         UUID NOT NULL,
  "kind"       "identity"."BlockedEmailKind" NOT NULL,
  "value"      TEXT NOT NULL,
  "reason"     VARCHAR(200),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID,

  CONSTRAINT "blocked_emails_pkey" PRIMARY KEY ("id")
);

-- Unique on `value` alone rather than on (kind, value). The two value spaces
-- cannot collide — an EMAIL value contains '@' and a DOMAIN value never does —
-- so one index serves the lookup, which is a single `value IN (…)` covering the
-- address and each of its parent domains in one round trip.
CREATE UNIQUE INDEX "ux_blocked_emails_value"
  ON "identity"."blocked_emails" ("value");
