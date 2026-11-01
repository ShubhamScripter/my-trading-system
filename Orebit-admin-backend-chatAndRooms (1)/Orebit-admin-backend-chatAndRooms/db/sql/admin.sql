-- admin — DDL Prisma cannot express.
--
-- Applied by db/migrate.ts after every migration, in lexicographic filename
-- order. Everything here MUST be idempotent: it runs on every deploy, not once.
--
-- These are PARTIAL indexes, and that is the whole reason they live here rather
-- than as `@unique` / `@@index` in schema.prisma. A plain unique constraint keeps
-- a soft-deleted row's value reserved forever, which means removing an admin
-- permanently burns their email address and they can never be re-added. Scoping
-- uniqueness to live rows fixes that while still making a duplicate impossible
-- among accounts that exist.

-- One live admin per email address.
CREATE UNIQUE INDEX IF NOT EXISTS ix_admins_email_active
  ON admin.admins (email_lower)
  WHERE deleted_at IS NULL;

-- One live registration per authenticator credential.
--
-- Partial so that removing a passkey (a soft delete) does not permanently bar the
-- owner from registering that same authenticator again. Registration relies on
-- this index as the authority rather than checking availability first: a
-- check-then-insert loses the race against a concurrent registration of the same
-- credential, and the unique violation is caught and reported as
-- `passkey_already_registered`.
CREATE UNIQUE INDEX IF NOT EXISTS ix_admin_passkeys_credential_active
  ON admin.admin_passkeys (credential_id)
  WHERE deleted_at IS NULL;

-- THE lookup for every login step after `password`: the client presents a step-up
-- secret, and this index turns "which sign-in is this" into a single index probe.
--
-- UNIQUE because two live attempts must never share a secret — that would make
-- the identifying value ambiguous, which is precisely the property the whole
-- mechanism depends on. Partial on live rows only, so the nulls written at
-- completion and expiry do not accumulate in the index and a spent secret can
-- never be matched again.
CREATE UNIQUE INDEX IF NOT EXISTS ix_admin_login_attempts_stepup
  ON admin.admin_login_attempts (step_up_secret_hash)
  WHERE step_up_secret_hash IS NOT NULL
    AND completed_at IS NULL;

-- Finding the live attempt for one admin — used by `password` to supersede a
-- previous unfinished sign-in. Without this, that lookup is a scan over every
-- attempt the account has ever made, and this table is append-only.
CREATE INDEX IF NOT EXISTS ix_admin_login_attempts_live
  ON admin.admin_login_attempts (admin_id, created_at DESC)
  WHERE completed_at IS NULL;

-- Verifying a code reads the one live challenge for (admin, purpose). The partial
-- predicate keeps the index to unspent rows, which is a small fraction of the
-- table given challenges are retained forever.
CREATE INDEX IF NOT EXISTS ix_admin_challenges_live
  ON admin.admin_challenges (admin_id, purpose, created_at DESC)
  WHERE consumed_at IS NULL;

-- One confirmed TOTP factor per admin.
--
-- The database-level half of the downgrade guard. The service already refuses
-- `totp-enroll` when a confirmed factor exists, but that check reads and then
-- writes, so two concurrent enrollments could both pass it. This index is the
-- authority that cannot be raced — the loser gets a unique violation instead of a
-- second confirmed factor.
CREATE UNIQUE INDEX IF NOT EXISTS ix_admin_totp_confirmed_unique
  ON admin.admin_totp_factors (admin_id)
  WHERE confirmed_at IS NOT NULL
    AND deleted_at IS NULL;

-- A session is looked up by id on every refresh; revocation sweeps read by admin.
--
-- This still covers the generation half of the logout-all and administrative-disable
-- sweeps, which revoke by `admin_id` so that a generation whose family row does not
-- yet exist is caught too. It no longer covers the whole of those operations: they
-- now begin by locking the session FAMILIES, which is a different table and a
-- different index — `ix_admin_session_families_live` below.
CREATE INDEX IF NOT EXISTS ix_admin_sessions_live
  ON admin.admin_sessions (admin_id, expires_at DESC)
  WHERE revoked_at IS NULL;

-- The LIVE TIP of a family: the one generation currently governing a login.
--
-- `SessionDbOperation.touch` resolves it in the statement — `family_id = ? AND
-- rotated_at IS NULL AND revoked_at IS NULL` — because activity belongs to the login
-- rather than to whichever refresh generation served the request. Without this index
-- that statement scans the family's whole chain, which the twelve-hour ceiling and
-- fifteen-minute rotation bound at roughly fifty rows: small, but paid on a large
-- share of authenticated requests.
--
-- ─── DELIBERATELY NOT UNIQUE ────────────────────────────────────────────────
--
-- At most one row per family can satisfy this predicate, and that property is what
-- licenses `touch`'s WHERE clause. It is guaranteed by `rotate`: the CAS demands
-- `rotated_at IS NULL` on the parent under the family's row lock, so a rotation can
-- only ever consume the current tip and produce exactly one new one. Inside that one
-- transaction the parent leaves the predicate before the child enters it, so a
-- UNIQUE index here would never be transiently violated either.
--
-- It is still not unique, for a reason that is about data rather than logic:
-- generations written before the family table existed have never been PROVEN
-- single-tip in production, and a unique index would turn any such pair into a hard
-- failure at migrate time on a table that authenticates every request. The invariant
-- is asserted instead — against a real database, after rotation chains and both
-- revocation sweeps — in tests/auth/persistence/session.activity.concurrency.spec.ts.
-- Promote this to UNIQUE once the production check below returns nothing:
--
--   SELECT family_id, count(*) FROM admin.admin_sessions
--    WHERE rotated_at IS NULL AND revoked_at IS NULL
--    GROUP BY family_id HAVING count(*) > 1;
CREATE INDEX IF NOT EXISTS ix_admin_sessions_tip
  ON admin.admin_sessions (family_id)
  WHERE rotated_at IS NULL
    AND revoked_at IS NULL;

-- Every LIVE session family for one admin, in the order logout-all locks them.
--
-- Partial and covering, and both halves are load-bearing.
--
--   partial    The predicate makes the index exactly the live set. Families are
--              kept forever, so an index over the whole table would be mostly rows
--              that no revocation sweep can ever act on.
--   trailing   `id` supplies the ORDER BY that the multi-row `FOR UPDATE` locks in.
--   `id`       With it the plan has no Sort node, so lock ACQUISITION order is
--              unambiguously ascending `id` — which is what rules out a deadlock
--              between two logout-all sweeps racing on one admin. Postgres only
--              guarantees the ORDER of returned rows, not of lock acquisition, so
--              removing the Sort is how the ordering is actually made to hold.
--
-- Dropping this index is therefore not a performance regression, it is a
-- correctness one. `db/migrate.ts` asserts its presence for that reason.
CREATE INDEX IF NOT EXISTS ix_admin_session_families_live
  ON admin.admin_session_families (admin_id, id)
  WHERE revoked_at IS NULL;

-- The super admin's review queue: `GET /admins/login-reviews?status=PENDING`.
--
-- Named for the credential because that is what a review is ABOUT, while the columns
-- live on `admins` — see the migration for why the review state sits there rather
-- than beside the strike counters.
--
-- Partial, and that is the whole value of it. Pending reviews are a handful of rows
-- against a table of every admin who has ever existed, so a full index on a column
-- that is null almost everywhere would be mostly nulls and mostly useless. The
-- predicate makes the index exactly the queue.
--
-- `login_disabled_at DESC, id DESC` is the keyset the route pages on, so the ORDER BY
-- and the cursor comparison are both served without a sort.
CREATE INDEX IF NOT EXISTS ix_admin_credentials_pending_review
  ON admin.admins (login_disabled_at DESC, id DESC)
  WHERE login_review_status = 'PENDING';
