-- The CONTRACT half of the session-family change. See db/contract/README.md, and
-- the deployment note in db/migrations/20260908210000_admin_session_families.
--
-- Apply ONLY once every old application instance has drained. Before that, old
-- code still inserts generations without a family row, and this constraint turns
-- every such sign-in into a foreign-key violation.
--
-- ─── A property worth knowing about, once this exists ────────────────────────
--
-- Every INSERT into `admin_sessions` will take an implicit `FOR KEY SHARE` lock on
-- the referenced family row, and `FOR KEY SHARE` CONFLICTS with `FOR UPDATE`. So a
-- future `rotate` that forgot its explicit family lock would still block behind a
-- revoke that holds one. That is a genuine second line of defence.
--
-- It is NOT a substitute for the explicit lock, and the difference is easy to get
-- wrong: revoking a family is `UPDATE ... SET revoked_at`, which touches no key
-- column and therefore takes only `FOR NO KEY UPDATE` — and that does NOT conflict
-- with the inserter's `FOR KEY SHARE`. The explicit `FOR UPDATE` in
-- auth/persistence/session.dboperation.ts is what makes the revoke side conflict.
-- Both halves are load-bearing; neither implies the other.
--
-- The validation scan takes a ShareRowExclusiveLock on both tables. On a table of
-- this size that is milliseconds, so the `NOT VALID` + `VALIDATE CONSTRAINT` idiom
-- is not used here — it would add a second step to buy nothing.
ALTER TABLE "admin"."admin_sessions"
  ADD CONSTRAINT "admin_sessions_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "admin"."admin_session_families"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
