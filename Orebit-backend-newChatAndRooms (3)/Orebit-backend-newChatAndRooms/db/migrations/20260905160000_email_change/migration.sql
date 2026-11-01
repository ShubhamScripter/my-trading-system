-- Email change: three new OTP purposes, a recipient column, and the retained-address
-- table that carries both the reservation and the recovery ticket.
--
-- ─── Why three purposes rather than one ──────────────────────────────────────
--
-- `ux_challenges_live` is UNIQUE (user_id, purpose) WHERE consumed_at IS NULL, and
-- `ChallengeDbOperation.issue` supersedes any live row for the pair BEFORE inserting.
-- So two codes sharing a purpose is not a constraint violation you would notice — it is
-- the first code silently dying while the caller is told two were sent. An email change
-- mails up to three codes at once (the current address, the address being claimed, and
-- a still-retained previous address), so it needs three slots, which means three
-- purposes.
--
-- This is the same one-line pattern 20260901170000_credential_change_purpose used, and
-- for the same reason. The unique index is deliberately NOT touched: three purposes is
-- exactly enough, because retention (30 days) equals the change window (30 days) and
-- each change retains one address, so at most one previous address is ever live at a
-- change. `EmailChangeService` asserts that invariant rather than trusting it.
--
-- ADD VALUE IF NOT EXISTS, and each on its own statement, because Postgres does not
-- allow several enum additions in one ALTER TYPE.
ALTER TYPE "identity"."ChallengePurpose" ADD VALUE IF NOT EXISTS 'EMAIL_CHANGE_CURRENT';
ALTER TYPE "identity"."ChallengePurpose" ADD VALUE IF NOT EXISTS 'EMAIL_CHANGE_NEW';
ALTER TYPE "identity"."ChallengePurpose" ADD VALUE IF NOT EXISTS 'EMAIL_CHANGE_RETAINED';

-- Where the code was MAILED. Not to be confused with `ip_address` next to it, which is
-- where it was requested FROM.
--
-- Nullable, so no backfill: the three original purposes all mail the account's own
-- address, and a second copy of `users.email` on every row would be noise. Only the
-- email-change purposes set it, because only they mail somewhere the account does not
-- yet own.
--
-- Without this column `verifyChallengeCode` keys on (user_id, purpose) alone, so a code
-- mailed to the CURRENT inbox could be presented as the proof for the NEW address and
-- the ceremony would prove nothing about the address being claimed.
ALTER TABLE "identity"."verification_challenges"
  ADD COLUMN "target_email_lower" TEXT;

-- ─── the retained address ────────────────────────────────────────────────────
--
-- Two jobs on one row. It RESERVES the released address so nobody else can register it
-- while the previous owner might still want it back — the partial index on
-- `users.email_lower` cannot do that, because by its own definition the address is free
-- the instant the change commits. And it carries the single-use token that authorises
-- the recent-change recovery flow.
--
-- It is NOT a sign-in credential. Nothing in the login path reads this table, and
-- nothing should be made to: an address that could request a login code would be a full
-- account takeover for whoever still controls the mailbox a user is most likely changing
-- away from.
CREATE TABLE "identity"."retained_emails" (
  "id"                   UUID        NOT NULL,
  "user_id"              UUID        NOT NULL,
  "email"                TEXT        NOT NULL,
  "email_lower"          TEXT        NOT NULL,
  "expires_at"           TIMESTAMPTZ NOT NULL,
  "recovery_token_hash"  TEXT        NOT NULL,
  "recovery_consumed_at" TIMESTAMPTZ,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "retained_emails_pkey" PRIMARY KEY ("id")
);

-- The availability probe registration and email-change both run: "is this address
-- reserved for anyone right now". Ordinary, NOT unique — one address may legitimately
-- be retained, expire, be registered by somebody else, and be released again, and a
-- unique index would forbid the second cycle. Liveness is `expires_at > now()`,
-- evaluated per query, so an expired row stops blocking without anything having to
-- delete it.
CREATE INDEX "ix_retained_emails_lookup"
  ON "identity"."retained_emails" ("email_lower", "expires_at");

-- This account's own live retention: the status screen, and deciding whether a previous
-- address must also authorise the next change.
CREATE INDEX "ix_retained_emails_user"
  ON "identity"."retained_emails" ("user_id", "expires_at");

-- CASCADE like every other per-account table: a deleted account must not keep reserving
-- an address, and a recovery ticket for an account that no longer exists authorises
-- nothing.
ALTER TABLE "identity"."retained_emails"
  ADD CONSTRAINT "retained_emails_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
