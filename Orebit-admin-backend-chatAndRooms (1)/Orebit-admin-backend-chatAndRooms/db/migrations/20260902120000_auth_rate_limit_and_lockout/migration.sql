-- Escalating password lockout, super-admin manual review, and the auth audit trail.
--
-- ═══ EVERY COLUMN HERE IS ADDITIVE AND NULLABLE-OR-DEFAULTED ══════════════════
--
-- Deliberately so: this table is read on the critical path of every sign-in, and a
-- rewrite of `admins` under an ACCESS EXCLUSIVE lock is a sign-in outage for its
-- duration. Postgres 11+ adds a column with a non-volatile DEFAULT as a catalogue-only
-- change, so `lockout_strikes INTEGER NOT NULL DEFAULT 0` and `review_version INTEGER
-- NOT NULL DEFAULT 1` are both metadata writes rather than table rewrites.
--
-- There is no backfill. A null `login_review_status` means "no review has ever been
-- opened", which is the correct reading of every row that predates this migration —
-- unlike the session-ceiling migration next door, where a null would have read as
-- "no ceiling at all" and had to be computed.

-- ─── enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "admin"."AdminLoginReviewStatus" AS ENUM ('PENDING', 'RESOLVED', 'REJECTED');

CREATE TYPE "admin"."AdminLoginDisabledReason" AS ENUM (
  'REPEATED_PASSWORD_LOCKOUT',
  'MANUAL_DISABLE'
);

-- ─── admins: the manual-review state ─────────────────────────────────────────
--
-- On `admins` rather than `admin_credentials` because of who reads it. The three
-- paths that must refuse a reviewed account — every login step after the password,
-- the refresh rotation, and the super-admin authorisation gate — all load an admin
-- row and nothing else. Putting the state on the credential would mean a second read
-- in each, for a check none of them may skip.

ALTER TABLE "admin"."admins"
  ADD COLUMN "login_review_status"   "admin"."AdminLoginReviewStatus",
  ADD COLUMN "login_disabled_at"     TIMESTAMPTZ,
  ADD COLUMN "login_disabled_reason" "admin"."AdminLoginDisabledReason",
  ADD COLUMN "review_version"        INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "reviewed_at"           TIMESTAMPTZ,
  ADD COLUMN "reviewed_by"           UUID,
  ADD COLUMN "review_reason"         TEXT;

-- No FOREIGN KEY on `reviewed_by`, and that is deliberate rather than an omission.
-- It points at the super admin who decided, who may later be soft-deleted; a
-- constraint would either block that removal or drag the audit record away with them.

-- ─── admin_credentials: the lockout's memory ─────────────────────────────────
--
-- `failed_attempts` resets to zero as each lock is applied, so without these the
-- policy is flat — ten wrong passwords costs an hour, forever, however many times the
-- same account has been ground at. `lockout_strikes` counts LOCKS, and
-- `lockout_strike_at` is what lets a strike expire so a single bad afternoon a year
-- ago does not send the next one straight to manual review.

ALTER TABLE "admin"."admin_credentials"
  ADD COLUMN "lockout_strikes"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lockout_strike_at" TIMESTAMPTZ;

-- ─── admin_auth_events: the audit trail ──────────────────────────────────────
--
-- Append-only. `admin_id` is NULLABLE because an attempt against an address that is
-- not an admin has nothing to attribute to — and those rows are exactly the ones that
-- show enumeration, so dropping them would hide the pattern the table exists to
-- surface.
--
-- ON DELETE CASCADE matches every other child of `admins`. A HARD delete of an admin
-- is not something this service does (removal is a soft delete), so in practice this
-- cascade fires only if someone reaches for psql.

CREATE TABLE "admin"."admin_auth_events" (
  "id"              UUID         NOT NULL,
  "admin_id"        UUID,
  "event_type"      VARCHAR(64)  NOT NULL,
  "ip_address"      INET         NOT NULL,
  "ip_class"        VARCHAR(64)  NOT NULL,
  "device_key_hash" VARCHAR(64),
  "user_agent"      VARCHAR(256),
  "failure_stage"   VARCHAR(32),
  "request_id"      VARCHAR(64),
  "metadata"        JSONB        DEFAULT '{}',
  "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"      TIMESTAMPTZ,

  CONSTRAINT "admin_auth_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "admin"."admin_auth_events"
  ADD CONSTRAINT "admin_auth_events_admin_id_fkey"
  FOREIGN KEY ("admin_id") REFERENCES "admin"."admins"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The review summary's read: every event for one admin, newest first.
CREATE INDEX "admin_auth_events_admin_id_created_at_idx"
  ON "admin"."admin_auth_events" ("admin_id", "created_at");

-- "how much of this is happening right now, service-wide" — the operational read,
-- which is not scoped to one account and would otherwise be a sequential scan.
CREATE INDEX "admin_auth_events_event_type_created_at_idx"
  ON "admin"."admin_auth_events" ("event_type", "created_at");
