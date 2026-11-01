-- `login_attempts` becomes the row for a WHOLE sign-in, not just its second half.
--
-- ─── What was wrong with the old shape ───────────────────────────────────────
--
-- The table was opened only once a first factor had already succeeded and a
-- second was owed. Everything before that point — the password step, and both
-- halves of the passwordless email-code sign-in — was identified by the caller
-- re-sending a public identifier on each request. An email address names an
-- account; it proves nothing about the person asking. So `otp-verify` took the
-- address from the request body, and a caller could point one in-flight sign-in
-- at a different account by editing a field.
--
-- The flow is now opened by `POST /auth/login {step:'start'}` before any
-- credential is presented, and the same opaque handle carries through the first
-- factor and the second. Three columns change to allow that.
--
-- ─── Why every change is additive and nullable ───────────────────────────────
--
-- There is no backfill and no data migration, deliberately. Rows in this table
-- live for minutes: `LOGIN_FLOW.TTL_SECONDS` bounds a fresh flow and the MFA
-- ceremony budget bounds the rest, so whatever is in flight at deploy either
-- completes within the hour or expires on its own. Inventing values for history
-- would be inventing facts about sign-ins that already happened.
--
-- The one thing that MUST NOT change is the hash domain. `token_hash` holds
-- `pepperedHash(handle, 'mfa')` and the tag is mixed into the digest, so
-- renaming the domain to match the handle's new public name (`loginId`) would
-- invalidate every live row for no security gain. It stays `'mfa'`, and both the
-- Prisma model and the DTO say why.

-- `user_id` NOT NULL -> NULL.
--
-- `start` opens the flow anonymously; the column is filled by the step that first
-- resolves an identifier to a real account. From that moment it is the only
-- source of identity for the rest of the flow — no later step reads a user from
-- the request body — which is what makes "a login flow cannot be switched
-- between users" a property of the schema rather than a rule in a service.
--
-- The FK and its ON DELETE CASCADE are untouched: a null simply does not
-- participate, and a row that names a deleted account should still vanish with it.
ALTER TABLE "identity"."login_attempts"
  ALTER COLUMN "user_id" DROP NOT NULL;

-- `token_hash` NOT NULL -> NULL, so the handle can be RETIRED rather than merely
-- marked spent.
--
-- Completion nulls it in the same UPDATE that sets `completed_at`, so there is no
-- interval — however small — in which a finished sign-in still has a matchable
-- handle. That is what makes single use a property of one atomic statement
-- instead of a check every future caller has to remember to perform after
-- resolving the row.
ALTER TABLE "identity"."login_attempts"
  ALTER COLUMN "token_hash" DROP NOT NULL;

-- The identifier the caller attempted, normalised.
--
-- Recorded so `otp-verify` need not ask for it a second time. Kept even when it
-- resolved to no account, on purpose: `otp-request` answers identically for a
-- known and an unknown address, and it can only keep doing that if the follow-up
-- step behaves the same way in both cases. No index — it is read only via a row
-- already resolved by `token_hash`, and indexing it would create exactly the
-- enumeration surface the flow handle exists to avoid.
ALTER TABLE "identity"."login_attempts"
  ADD COLUMN "identifier_lower" TEXT;

-- Two new states ahead of the existing three.
--
-- ADD VALUE ... BEFORE keeps the enum's declaration order matching the order a
-- flow actually moves through, which is what makes the state machine readable in
-- a dump. It is also why this is not a DROP/CREATE TYPE: rewriting the enum would
-- require dropping the column default and every dependent object.
--
--   STARTED          flow open, nobody identified yet
--   OTP_SENT         a passwordless code has been emailed
--   FACTOR_REQUIRED  first factor proven, second owed   (existing)
--   COMPLETED        session issued — terminal          (existing)
--   EXPIRED          unusable — terminal                (existing)
ALTER TYPE "identity"."LoginState" ADD VALUE IF NOT EXISTS 'STARTED' BEFORE 'FACTOR_REQUIRED';
ALTER TYPE "identity"."LoginState" ADD VALUE IF NOT EXISTS 'OTP_SENT' BEFORE 'FACTOR_REQUIRED';

-- The column default moves to 'STARTED' in the NEXT migration, not here.
--
-- Postgres refuses to use a new enum value in the same transaction that added it
-- ("unsafe use of new value"), and Prisma runs each migration file inside one
-- transaction. Ending this one early with a bare COMMIT does work and is the
-- usual trick; it is avoided because it leaves the rest of the file running
-- outside Prisma's transaction, so a failure after that point is half-applied
-- with the migration recorded as failed. A second file is the same two steps with
-- an honest boundary between them.
--
-- The live-handle index is widened in db/sql/identity.sql, which `npm run
-- db:migrate` applies immediately after these files. It is stated there rather
-- than here because that file is the authority for every partial index Prisma
-- cannot express, and `db:verify` asserts against it — splitting one index across
-- two places is how the two drift.
