-- The absolute lifetime ceiling for a session family.
--
-- ═══ THE BACKFILL IS THE INTERESTING PART ═════════════════════════════════════
--
-- The obvious backfill is `DEFAULT CURRENT_TIMESTAMP + INTERVAL '12 hours'`, and it
-- is wrong in the one way that matters: it hands a fresh twelve hours to precisely
-- the sessions this column exists to bound. Before this change every rotation set
-- `expires_at = now() + 12h`, so a panel left open in a tab could be on day three of
-- a "twelve-hour" session. Anchoring the ceiling on deploy time would reward those
-- families with one more full day, and the bug would have paid out once more on its
-- way out the door.
--
-- So the anchor is the family's own beginning: MIN(created_at) over the family,
-- which is the row the three-factor ceremony wrote, plus twelve hours. That is the
-- instant the session *should* have ended, computed from when it actually started.
--
-- Consequence, stated plainly rather than discovered in production: every family
-- that began more than twelve hours before this migration runs gets a ceiling in the
-- past and is unusable on the next request. Those admins sign in again — password +
-- email OTP + MFA. That is not collateral damage, it is the fix landing; a session
-- that has been alive for three days is the thing being ended.
ALTER TABLE "admin"."admin_sessions" ADD COLUMN "reauthenticate_at" TIMESTAMPTZ;

UPDATE "admin"."admin_sessions" AS s
SET "reauthenticate_at" = f.began_at + INTERVAL '12 hours'
FROM (
  SELECT "family_id", MIN("created_at") AS began_at
  FROM "admin"."admin_sessions"
  GROUP BY "family_id"
) AS f
WHERE s."family_id" = f."family_id";

-- Set NOT NULL only after the backfill, so a family the UPDATE somehow missed fails
-- the deploy loudly here rather than reaching the application as a null ceiling —
-- which every check in session.service.ts would read as "no ceiling at all".
ALTER TABLE "admin"."admin_sessions" ALTER COLUMN "reauthenticate_at" SET NOT NULL;
