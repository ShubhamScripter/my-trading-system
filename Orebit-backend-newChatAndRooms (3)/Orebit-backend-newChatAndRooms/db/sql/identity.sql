-- identity — DDL Prisma cannot express.
--
-- Applied by db/migrate.ts after every migration, in lexicographic filename
-- order. Everything here MUST be idempotent: it runs on every deploy, not once.
--
-- These are PARTIAL unique indexes, and that is the whole reason they live here
-- rather than as `@unique` in the schema. A plain unique constraint keeps a
-- soft-deleted account's email and username reserved forever, which means
-- deleting an account permanently burns its email address and a user can never
-- move an address back to themselves. Scoping uniqueness to live rows fixes both
-- while still making a duplicate impossible among accounts that exist.

-- One live account per email address.
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email_active
  ON identity.users (email_lower)
  WHERE deleted_at IS NULL;

-- One live account per username. This index is also the authority username
-- allocation relies on: auth.service.ts inserts and catches the violation rather
-- than checking availability first, because a check-then-insert loses the race
-- against a concurrent signup choosing the same name.
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username_active
  ON identity.users (username_lower)
  WHERE deleted_at IS NULL;

-- One live account per public code. Same insert-and-catch pattern.
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_public_code_active
  ON identity.users (public_code_key)
  WHERE deleted_at IS NULL;

-- Referral codes are matched by `check-referral`, so this index is doing two
-- jobs: it keeps them unique and it makes the lookup a single index probe.
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_referral_code_active
  ON identity.users (referral_code)
  WHERE deleted_at IS NULL;

-- One live link per provider identity. Partial so that unlinking (a soft delete)
-- does not permanently bar the owner from re-linking the same provider account.
CREATE UNIQUE INDEX IF NOT EXISTS ix_oauth_links_provider_subject_active
  ON identity.oauth_links (provider, subject)
  WHERE deleted_at IS NULL;

-- One live link per provider per account — the other direction of the same rule.
--
-- The index above answers "this Google account belongs to one Orebit account". This
-- one answers "this Orebit account holds one Google account", which is a product
-- decision rather than a consequence of the first: nothing in the data model made a
-- second Google link impossible, and the settings screen renders one row per
-- provider. Partial for the same reason as every index in this file — unlinking is a
-- soft delete, and a plain constraint would bar the owner from ever re-linking.
--
-- Like the one above, this is the authority rather than a check: the Settings link
-- path inserts and catches 23505, because a read-then-write loses the race against a
-- second tab finishing its own ceremony.
CREATE UNIQUE INDEX IF NOT EXISTS ix_oauth_links_user_provider_active
  ON identity.oauth_links (user_id, provider)
  WHERE deleted_at IS NULL;

-- Finding the live attempt for an address — used by `start` to supersede a
-- previous unfinished attempt. Without this, that lookup is a scan over every
-- abandoned attempt ever made.
CREATE INDEX IF NOT EXISTS ix_registrations_resumable
  ON identity.registrations (email_lower, created_at DESC)
  WHERE deleted_at IS NULL AND completed_at IS NULL;

-- THE lookup for every registration step after `start`: the client presents a
-- continuation secret, and this index turns "which registration is this" into a
-- single index probe.
--
-- UNIQUE because two live registrations must never share a secret — that would
-- make the identifying value ambiguous, which is precisely the property the whole
-- mechanism depends on. Partial on live rows only, so the nulls written at
-- completion and expiry do not accumulate in the index and a spent secret can
-- never be matched again.
CREATE UNIQUE INDEX IF NOT EXISTS ix_registrations_continuation
  ON identity.registrations (continuation_secret_hash)
  WHERE continuation_secret_hash IS NOT NULL
    AND deleted_at IS NULL
    AND completed_at IS NULL;

-- A new code supersedes the old one. Retire any historical duplicates before
-- creating the constraint, keeping the newest row as the only candidate that can
-- still be verified. This makes application-level supersession durable under
-- simultaneous resend requests as well.
WITH ranked_live_challenges AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, purpose
           ORDER BY created_at DESC, id DESC
         ) AS position
  FROM identity.verification_challenges
  WHERE consumed_at IS NULL
)
UPDATE identity.verification_challenges AS challenge
SET consumed_at = now()
FROM ranked_live_challenges AS ranked
WHERE challenge.id = ranked.id
  AND ranked.position > 1;

-- One unconsumed code per account and purpose. Besides enforcing supersession,
-- this index supports the live-code lookup without retaining expired or consumed
-- challenge history in its working set.
CREATE UNIQUE INDEX IF NOT EXISTS ux_challenges_live
  ON identity.verification_challenges (user_id, purpose)
  WHERE consumed_at IS NULL;

-- `findLive` orders by creation time. This remains useful for historical databases
-- before the unique constraint is applied and for the narrow partial scan.
CREATE INDEX IF NOT EXISTS ix_challenges_live
  ON identity.verification_challenges (user_id, purpose, created_at DESC)
  WHERE consumed_at IS NULL;

-- A session is looked up by id on every refresh; revocation sweeps read by user.
-- This covers the "all live sessions for a user" sweep that logout-all performs.
CREATE INDEX IF NOT EXISTS ix_sessions_live
  ON identity.sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

-- Device-scoped logout and the session list both group a user's live sessions by
-- device, which is a hash rather than a plain column value.
CREATE INDEX IF NOT EXISTS ix_sessions_device_live
  ON identity.sessions (user_id, device_fingerprint)
  WHERE revoked_at IS NULL;

-- Every refresh on a trusted device looks the trust up by (user, token hash), and
-- the lookup must find at most one row.
--
-- PER USER, not per token hash. The hash identifies a BROWSER PROFILE and a trust
-- belongs to an ACCOUNT, so scoping uniqueness to the hash alone meant a shared
-- browser could remember only one person: the second person to tick "remember this
-- device" revoked the first person's trust in order to insert their own. See
-- db/migrations/20260901140000_trusted_device_per_user for what that did to the
-- first user's sessions.
--
-- Partial rather than a plain unique: a revoked device is kept for the audit trail
-- ("this device was trusted, then untrusted on that date"), and a plain constraint
-- would let one revoked row poison the pair forever — re-trusting the same browser
-- would collide with its own history. Scoping to live rows keeps the guarantee that
-- matters (one live trust per account per browser) without that.
CREATE UNIQUE INDEX IF NOT EXISTS ux_trusted_devices_user_token_active
  ON identity.trusted_devices (user_id, token_hash)
  WHERE revoked_at IS NULL;

-- At most one CONFIRMED authenticator per account.
--
-- Partial on two predicates, and both matter. `deleted_at IS NULL` so removing an
-- authenticator does not bar the owner from ever enrolling another; `confirmed_at
-- IS NOT NULL` so an abandoned enrollment — a QR code scanned and a tab closed —
-- does not occupy the slot and refuse the next attempt. The service also checks
-- this before inserting; the index is what makes it true under concurrency.
CREATE UNIQUE INDEX IF NOT EXISTS ux_totp_factors_confirmed_active
  ON identity.totp_factors (user_id)
  WHERE deleted_at IS NULL AND confirmed_at IS NOT NULL;

-- One live registration per authenticator credential.
--
-- Partial rather than a plain unique for the same reason the trusted-device index
-- is: a removed passkey is kept for the audit trail, and a plain constraint would
-- let one soft-deleted row poison the credential id forever — re-registering the
-- same security key would collide with its own history.
CREATE UNIQUE INDEX IF NOT EXISTS ux_passkeys_credential_active
  ON identity.passkeys (credential_id)
  WHERE deleted_at IS NULL;

-- Spending a recovery code matches (user, hash) among unspent rows, and must find
-- at most one. Unique rather than a plain index: two live rows with the same hash
-- would make `spendRecoveryCode`'s compare-and-swap update both and report a count
-- of 2, which the caller reads as a failure.
--
-- `superseded_at IS NULL` joined the predicate when regeneration became a soft
-- delete. Without it a regenerated set could collide with the generation it
-- replaced — the old rows are retained now rather than deleted, so "live" is two
-- conditions rather than one, and the index has to agree with the queries or a
-- perfectly ordinary regenerate would fail on a hash collision with history.
DROP INDEX IF EXISTS identity.ux_recovery_codes_unused;
CREATE UNIQUE INDEX IF NOT EXISTS ux_recovery_codes_unused
  ON identity.recovery_codes (user_id, code_hash)
  WHERE used_at IS NULL AND superseded_at IS NULL;

-- THE lookup for every step of a sign-in after `start`: the client presents a
-- `loginId`, and this index turns "which sign-in is this" into a single index
-- probe.
--
-- UNIQUE because two live flows must never share a handle — that would make the
-- identifying value ambiguous, which is precisely the property the mechanism
-- depends on.
--
-- The predicate was `state = 'FACTOR_REQUIRED'`, which was correct when the row
-- was opened only after a first factor had already succeeded. The flow now spans
-- STARTED and OTP_SENT as well, and an index that ignored those states would let
-- two live flows collide on one hash without the database objecting.
--
-- Stated as "the hash is present and the flow is not finished" rather than by
-- listing states, so adding a state cannot silently fall outside it. That works
-- because both terminal paths retire the handle: completion nulls `token_hash`
-- in the same statement that sets `completed_at`, and expiry nulls it too — so a
-- spent handle leaves the index entirely rather than lingering in it.
DROP INDEX IF EXISTS identity.ux_login_attempts_token_live;
CREATE UNIQUE INDEX IF NOT EXISTS ux_login_attempts_token_live
  ON identity.login_attempts (token_hash)
  WHERE token_hash IS NOT NULL AND completed_at IS NULL;

-- The account-purge sweep's only query: "which deleted accounts are due?".
--
-- Partial on two predicates, and both matter. `purge_at IS NOT NULL` because every
-- live account has it unset, so the unconditional index Prisma declares is almost
-- entirely dead weight — this one holds only the accounts actually awaiting a purge.
-- `deleted_at IS NULL` because a row that has already been purged keeps its `purge_at`
-- as a record of when it happened, and re-reading those forever would make the index
-- grow without bound while the sweep's working set stayed tiny.
--
-- The two predicates together are also exactly the sweep's precondition, so the index
-- contains the candidate set and nothing else: every row in it either is due now or
-- will be.
CREATE INDEX IF NOT EXISTS ix_users_purge_due
  ON identity.users (purge_at)
  WHERE purge_at IS NOT NULL AND deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- The security-context history indexes.
--
-- These four back the classifier that decides whether a sensitive settings change
-- came from a commonly-used IP and device or from a new context. That decision runs
-- on every one of the eight trigger actions, so its query plans are load-bearing
-- rather than incidental.
--
-- ─── Why they are here and not @@index in schema.prisma ────────────────────
--
-- Only `ix_sessions_country_history` is strictly inexpressible in Prisma (it is
-- partial). The other three could be declared in the model. They live here anyway so
-- that all four are named in EXPECTED_INDEXES and asserted by `npm run db:verify`,
-- which is a deploy-time guarantee a `@@index` does not give — a silently missing
-- index here does not break a query, it makes a security decision scan a table that
-- grows without bound. Keeping the set together also means a reader comparing the
-- three signals reads one block rather than three declarations in two files.
--
-- ─── Why none of them is partial on revoked_at ─────────────────────────────
--
-- `ix_sessions_live` and `ix_sessions_device_live` above are both
-- `WHERE revoked_at IS NULL`, because they serve live-session lookups. These serve the
-- opposite question. History is precisely the revoked and expired rows — a device used
-- daily for a year is almost entirely revoked generations — so a partial index on live
-- rows cannot answer any of this and the planner would fall back to a sequential scan
-- over every session the account has ever had.
--
-- ─── Why created_at is the trailing column ─────────────────────────────────
--
-- "Commonly used" counts DISTINCT CALENDAR DAYS, not sessions and not rows. Rows are
-- the wrong denominator because `rotate` inserts a new generation roughly every
-- fourteen minutes of active use, so a row count measures session duration — 45
-- minutes on a brand-new device would read as "seen many times". Sessions are the
-- wrong denominator too: `touch` pushes `expires_at` forward with GREATEST, so a user
-- who opens the app daily never starts a second family and their own laptop would
-- count as one.
--
-- The query is therefore `SELECT DISTINCT created_at::date ... ORDER BY 1 LIMIT n`,
-- which halts after n groups instead of counting the whole history. Leading columns
-- locate the subject, `created_at` supplies both the window predicate and the ordering
-- the early exit depends on.

-- Distinct days this account has been seen on this browser profile.
CREATE INDEX IF NOT EXISTS ix_sessions_device_history
  ON identity.sessions (user_id, device_fingerprint, created_at);

-- Distinct days this account has been seen from this /24 or /48.
--
-- Note `rotate` writes the CURRENT request's ip_class onto each child generation while
-- device_fingerprint falls back to the parent's. So within one login this column is a
-- time series of every network roamed through, which is what makes the day count
-- meaningful here rather than degenerate.
CREATE INDEX IF NOT EXISTS ix_sessions_ip_history
  ON identity.sessions (user_id, ip_class, created_at);

-- Distinct days this account has been seen from this country.
--
-- PARTIAL, and this is the one of the four that Prisma could not declare. `country` is
-- null on every row written before a geo provider is bound and on every lookup that
-- fails afterwards, and the classifier only ever matches a non-null country — an
-- unknown country is never treated as a new one. Indexing the nulls would mean
-- carrying an entry for every session row in the table to answer a query that can
-- never match one of them.
CREATE INDEX IF NOT EXISTS ix_sessions_country_history
  ON identity.sessions (user_id, country, created_at)
  WHERE country IS NOT NULL;

-- The enforcement read: "is this feature withheld from this account right now?"
--
-- Plain rather than partial. The natural predicate is `expires_at > now()`, and now()
-- is not immutable, so Postgres will not accept it in an index. There is no stable
-- substitute — a restriction is live purely as a function of the clock — so the range
-- scan does the filtering and `expires_at DESC` lets the newest deadline, which is the
-- one enforcement takes, be found first.
--
-- Expired rows are retained deliberately (they are this feature's only audit trail),
-- so this index grows with every restriction ever applied rather than with the live
-- set. That is accepted for now; if it ever matters, the answer is a retention sweep
-- on the table, not a partial index this predicate cannot have.
CREATE INDEX IF NOT EXISTS ix_user_feature_restrictions_live
  ON identity.user_feature_restrictions (user_id, feature, expires_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- A restriction must last a positive amount of time.
--
-- THE FIRST CHECK CONSTRAINTS IN THIS REPOSITORY, and they earn it: a zero or negative
-- duration makes `expires_at <= starts_at`, so the row is already expired the moment it
-- is written. The restriction silently does not happen. Nothing throws, nothing logs,
-- and the only symptom is a feature that was supposed to be withheld and was not — a
-- fail-OPEN, which is the one direction this whole subsystem exists to avoid.
--
-- DTO validation is not a substitute. These are settings tables, and the schema already
-- records (see `AdminCaptchaProvider`) that settings rows on this platform get written
-- by hand in psql during incidents — which is exactly when a typo happens and exactly
-- when nobody is looking for one.
--
-- Minimum only. No maximum: the product has not set one, and a ceiling invented here
-- would be a policy decision buried in DDL. The Admin DTO is where it belongs.
--
-- ─── Why the DO blocks ──────────────────────────────────────────────────────
--
-- Everything in this file runs on every deploy and must therefore be idempotent.
-- Postgres has `CREATE INDEX IF NOT EXISTS` but no `ADD CONSTRAINT IF NOT EXISTS`, so
-- the guard has to be written out. This is the smallest form that does it.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_security_restriction_policies_duration_positive'
  ) THEN
    ALTER TABLE identity.security_restriction_policies
      ADD CONSTRAINT ck_security_restriction_policies_duration_positive
      CHECK (duration_seconds > 0);
  END IF;
END $$;

-- The same floor on the history table. Not redundant: history is written by the same
-- transaction but is a separate table, and a row here that claimed a non-positive
-- duration would misreport what was in force at that version — which is the one
-- question this table exists to answer.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_security_restriction_policy_versions_duration_positive'
  ) THEN
    ALTER TABLE identity.security_restriction_policy_versions
      ADD CONSTRAINT ck_security_restriction_policy_versions_duration_positive
      CHECK (duration_seconds > 0);
  END IF;
END $$;
