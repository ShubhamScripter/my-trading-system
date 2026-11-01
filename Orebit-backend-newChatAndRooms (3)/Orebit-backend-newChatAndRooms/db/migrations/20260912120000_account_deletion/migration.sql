-- Owner-initiated account deletion, with a thirty-day recovery window.
--
-- ─── The enum value, and why it is not DISABLED ─────────────────────────────
--
-- DISABLED already exists and is still unused. This is deliberately not it: DISABLED
-- is something done TO an account, DELETED is something its owner asked for and can
-- undo. Sharing one value would make "may this be reactivated" unanswerable from the
-- row. Every path that already refuses `status <> 'ACTIVE'` refuses this one from the
-- moment it exists, so no read path changes here.
-- `IF NOT EXISTS` and on its own statement, following every other enum change here:
-- Postgres takes one value per `ALTER TYPE`, and re-running a migration must be safe.
ALTER TYPE "identity"."UserStatus" ADD VALUE IF NOT EXISTS 'DELETED';

-- The reactivation code's purpose.
--
-- Its own value rather than reusing LOGIN_OTP, because `ux_challenges_live` is unique
-- on (user_id, purpose) among unconsumed rows and `issue` supersedes the live row for
-- the pair. Sharing would let an ordinary login code reactivate an account, and would
-- silently kill one code while telling the user two were sent.
ALTER TYPE "identity"."ChallengePurpose" ADD VALUE IF NOT EXISTS 'ACCOUNT_REACTIVATION';

-- Both columns are NULL on every existing row and on every live account. They are set
-- together when the owner requests deletion, and cleared together by a reactivation.
--
-- `deleted_at` is NOT set at request time, and that is the load-bearing part of this
-- migration: the partial unique indexes in db/sql/identity.sql are scoped
-- `WHERE deleted_at IS NULL`, so leaving it unset is what keeps the account's email,
-- username and public code RESERVED for the whole window. That reservation is the only
-- reason a reactivation can be guaranteed to succeed. The purge sweep writes
-- `deleted_at` at the deadline, and that single write is what releases the identifiers
-- and makes the deletion terminal.
ALTER TABLE "identity"."users" ADD COLUMN "deletion_requested_at" TIMESTAMPTZ;
ALTER TABLE "identity"."users" ADD COLUMN "purge_at" TIMESTAMPTZ;

-- The purge sweep's only query: "which deleted accounts are due?".
--
-- Prisma declares this unconditionally; db/sql/identity.sql adds the partial index
-- that actually serves the sweep. Both are harmless together — the planner picks the
-- narrower one — and the unconditional one is what keeps `schema.prisma` honest about
-- what exists.
CREATE INDEX "users_purge_at_idx" ON "identity"."users"("purge_at");
