-- The stored activity timestamp the inactivity deadline is measured from.
--
-- ═══ WHY THE BACKFILL DOES NOT INVERT THE IDLE WINDOW ═════════════════════════
--
-- The obvious backfill is `expires_at - INTERVAL '35 minutes'` — undo the formula
-- that wrote the deadline and recover the activity instant behind it. It is wrong,
-- because there is no such formula. At least four have written `expires_at`, and
-- which one wrote a given row is not recoverable FROM the row:
--
--   now() + 12h          per rotation, before the ceiling landed. This file's
--                        neighbour, 20260901150000_session_reauthenticate_at, says
--                        so in its own header.
--   created_at + 2h      the idle window for most of the first week of September.
--   created_at + 30m     at least one row.
--   created_at + 35m     the window in force immediately before this migration.
--
-- Inverting 35 minutes against a two-hour row invents an activity instant 1h25m
-- after the real one, and against any freshly created row it invents one in the
-- FUTURE — which would permanently disable the `last_active_at <= now() - interval`
-- predicate in `SessionDbOperation.touch` (a future timestamp is never that old) and
-- report a fiction to the panel.
--
-- ═══ SO THE ANCHOR IS EACH ROW'S OWN DEADLINE ═════════════════════════════════
--
-- For a LIVE session, `last_active_at` is set to whatever reproduces the deadline
-- the row already has: `expires_at - 30m`. That makes this migration
-- deadline-neutral by construction, for every regime above, without knowing which
-- one applied. No session gains life from the deploy.
--
-- `LEAST(..., now())` keeps the value out of the future, which is what protects the
-- write predicate and the reported value: a future timestamp is never "at least the
-- write interval old", so it would freeze that session's deadline until its ceiling.
-- Rows whose deadline sits further out than now + 30m — every two-hour-regime row —
-- are recorded as active at the deploy instant instead. That is the 2h → 30m policy
-- correction landing, not a fudge.
--
-- ─── There is deliberately NO floor at `created_at` ────────────────────────
--
-- An earlier draft wrapped this in `GREATEST("created_at", ...)` to stop a row
-- recording activity from before it existed. That was wrong twice over.
--
-- It broke the neutrality this whole expression exists for. A rotation child inherits
-- its parent's `expires_at`, so a child born after four idle minutes has a deadline
-- 26 minutes out, the floor wins, and the child is handed a fresh 30 — a session
-- REVIVED by the migration. That is the common shape, not an edge case: a refresh
-- every fifteen minutes means most live children sit inside 30 minutes of their own
-- birth.
--
-- And it forbade the truth. A child's activity instant SHOULD predate the child row,
-- because a refresh is not activity — that is the entire reason `rotate` copies this
-- column instead of defaulting it. A `last_active_at` earlier than `created_at` is
-- not corrupt data; it is a session that has been refreshed since its last real
-- request, stated correctly.
--
-- For a DEAD session (revoked, or past either clock) the value is `created_at`: a
-- real event rather than a synthetic instant. `readLiveness` refuses those rows on
-- the other three columns before this one influences anything, so it is only ever
-- REPORTED — and the creation instant is the only activity the old schema evidenced.
--
-- `expires_at` is deliberately NOT rewritten. Live rows keep the deadline the
-- backfill just reproduced, and their first eligible request converges them onto the
-- thirty-minute rule.
ALTER TABLE "admin"."admin_sessions" ADD COLUMN "last_active_at" TIMESTAMPTZ;

UPDATE "admin"."admin_sessions"
SET "last_active_at" = CASE
      WHEN "revoked_at" IS NULL
       AND "expires_at" > now()
       AND "reauthenticate_at" > now()
      THEN LEAST("expires_at" - INTERVAL '30 minutes', now())
      ELSE "created_at"
    END;

-- Set NOT NULL only after the backfill, so a row the UPDATE somehow missed fails the
-- deploy loudly here rather than reaching the application as a null activity instant
-- — which `touch`'s predicate would read as "never due for a write", quietly freezing
-- that session's deadline until its ceiling.
ALTER TABLE "admin"."admin_sessions" ALTER COLUMN "last_active_at" SET NOT NULL;
