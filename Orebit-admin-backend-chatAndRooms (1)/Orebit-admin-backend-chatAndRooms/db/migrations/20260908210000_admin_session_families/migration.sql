-- The stable session family: one row per authenticated browser login.
--
-- ═══ WHAT THIS TABLE IS FOR ═══════════════════════════════════════════════════
--
-- It is a LOCK TARGET before it is a record. A "family" was previously a
-- convention — the set of `admin_sessions` rows sharing a `family_id`, which was
-- itself just the id of the first generation — and a convention cannot be locked.
--
-- That is the revocation race this migration exists to close. `rotate` inserts the
-- child generation inside a transaction, so under READ COMMITTED a concurrent
-- logout's `UPDATE ... WHERE family_id = ?` can neither SEE that row nor BLOCK on
-- it: the row is not in the statement's snapshot, and Postgres has no predicate
-- locking below SERIALIZABLE. EvalPlanQual re-checks the rows the scan already
-- found; it does not re-run the scan. So logout revoked the parent, reported
-- success, and the freshly-created child stayed usable for the rest of the family
-- ceiling — up to twelve hours of authenticated access after "log me out".
--
-- With this row present, refresh and revocation both take `SELECT ... FOR UPDATE`
-- on it FIRST, so one always waits for the other and observes its committed effect.
--
-- ═══ THE INVARIANT THIS FILE ESTABLISHES ══════════════════════════════════════
--
--   admin_session_families.revoked_at IS NOT NULL
--       ⟹  every admin_sessions row in that family has revoked_at IS NOT NULL
--
-- Every writer preserves it (both updates happen in one transaction, under the
-- family's row lock). The two assertions at the bottom prove the BACKFILL
-- established it, rather than leaving a table that merely looks migrated.
--
-- ═══ DEPLOYMENT ═══════════════════════════════════════════════════════════════
--
-- This is the EXPAND half. It deliberately does NOT add the
-- `admin_sessions.family_id` foreign key: until every old application instance has
-- drained, old code is still running `createFirstGeneration`, which inserts a
-- generation without a family row — and the instant the FK exists that becomes a
-- foreign-key violation on every sign-in. The CONTRACT half lives in
-- db/contract/, to be applied once old writers are gone. Nothing about the
-- locking depends on the constraint; it needs the family ROW to exist, not the FK.

CREATE TABLE "admin"."admin_session_families" (
    "id"             UUID        NOT NULL,
    "admin_id"       UUID        NOT NULL,
    "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "revoked_at"     TIMESTAMPTZ,
    "revoked_reason" VARCHAR(32),

    CONSTRAINT "admin_session_families_pkey" PRIMARY KEY ("id")
);

-- ─── The backfill ────────────────────────────────────────────────────────────
--
-- One row per distinct `family_id`, in a single pass. `family_id` is NOT NULL on
-- every generation, so this covers the table exactly and the FK added later is
-- valid by construction.
--
-- The `ORDER BY (id = family_id) DESC, created_at ASC` inside each `array_agg`
-- prefers the ROOT generation and falls through to the oldest surviving row when
-- no root remains. That is one expression doing the job of a join plus a fallback
-- branch, and it cannot pick a row from the wrong family because the GROUP BY has
-- already partitioned by `family_id`.
--
-- ─── Why `bool_or` and not `bool_and` ────────────────────────────────────────
--
-- A family is marked revoked when ANY generation in it is revoked, not only when
-- all of them are. Both spellings establish the invariant (the sweep below closes
-- the gap either way), but they differ on the rows that matter here.
--
-- A MIXED family — some generations revoked, some live — is not a state any
-- correct sequence of operations can produce. Normal rotation stamps `rotated_at`
-- and never `revoked_at`, and every revoke path revokes the whole family at once.
-- So a mixed family is a fingerprint of the race described above: a logout that
-- was reported as successful while a child generation survived it.
--
-- `bool_and` would read those survivors as evidence the family is still live and
-- preserve them. `bool_or` finishes the logout that was already requested. That is
-- the correct reading of the operator's intent, and it is why the sweep below is
-- part of this migration rather than a separate clean-up someone might skip.
INSERT INTO "admin"."admin_session_families"
       ("id", "admin_id", "created_at", "revoked_at", "revoked_reason")
SELECT "family_id",
       (array_agg("admin_id"   ORDER BY ("id" = "family_id") DESC, "created_at" ASC))[1],
       (array_agg("created_at" ORDER BY ("id" = "family_id") DESC, "created_at" ASC))[1],
       CASE WHEN bool_or("revoked_at" IS NOT NULL) THEN max("revoked_at") END,
       CASE WHEN bool_or("revoked_at" IS NOT NULL)
            THEN (array_agg("revoked_reason" ORDER BY "revoked_at" DESC NULLS LAST))[1] END
  FROM "admin"."admin_sessions"
 GROUP BY "family_id";

-- ─── The remediation sweep ───────────────────────────────────────────────────
--
-- Revoke the survivors identified above, stamping them with the family's own
-- revocation instant and reason so the row reads as what it always should have
-- been: part of a revocation that already happened.
--
-- This SIGNS OUT any session that previously escaped a logout. That is the point.
-- Those sessions are ones whose owner already asked to be logged out — or whose
-- account was disabled, or put under manual review — and the only reason they are
-- still usable is the defect. Leaving them live to avoid an interruption would be
-- choosing to honour the bug.
UPDATE "admin"."admin_sessions" s
   SET "revoked_at"     = f."revoked_at",
       "revoked_reason" = f."revoked_reason"
  FROM "admin"."admin_session_families" f
 WHERE s."family_id" = f."id"
   AND f."revoked_at" IS NOT NULL
   AND s."revoked_at" IS NULL;

-- ─── Assertions ──────────────────────────────────────────────────────────────
--
-- Fail the deploy rather than ship a database that looks migrated. A silently
-- wrong backfill here is a silently wrong revocation boundary, which is the one
-- thing this table exists to get right.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "admin"."admin_sessions" s
      JOIN "admin"."admin_session_families" f ON f."id" = s."family_id"
     WHERE f."revoked_at" IS NOT NULL
       AND s."revoked_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'admin_session_families backfill left a live generation in a revoked family';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM "admin"."admin_sessions" s
     WHERE NOT EXISTS (
       SELECT 1 FROM "admin"."admin_session_families" f WHERE f."id" = s."family_id")
  ) THEN
    RAISE EXCEPTION 'admin_session_families backfill left an orphaned generation';
  END IF;
END $$;

-- Named as Prisma would name it (`<table>_<column>_fkey`), so a future
-- `prisma migrate diff` against this hand-written file does not report drift.
ALTER TABLE "admin"."admin_session_families"
  ADD CONSTRAINT "admin_session_families_admin_id_fkey"
  FOREIGN KEY ("admin_id") REFERENCES "admin"."admins"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
