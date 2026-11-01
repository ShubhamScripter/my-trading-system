-- Username change: the table that reserves a released username, and nothing else.
--
-- ─── Why a table and not a column ────────────────────────────────────────────
--
-- `users.username_lower` already carries `ix_users_username_active`, which decides who
-- owns a username RIGHT NOW. It cannot decide who may take one NEXT, because by its own
-- definition the old username is free the instant the change commits. A reservation is
-- a fact about a name nobody currently holds, so it needs a row of its own.
--
-- ─── Why this is `retained_emails` with less in it ───────────────────────────
--
-- Same shape, same liveness rule, one job instead of two. `retained_emails` also
-- carries a single-use recovery token, because an address is the channel every other
-- recovery path mails to and releasing one has to be undoable by whoever still holds
-- the mailbox. A username is an identifier, not a channel — nothing is delivered to it
-- — so there is nothing to recover with and no token to store. The owner's route back
-- is the ordinary change endpoint, which lets them reclaim their own reservation for
-- free.
--
-- ─── The two retention lengths, and why only one row is ever long ────────────
--
-- `expires_at` is written from one question asked at change time: does this account
-- hold a live reservation already? No — first change in a sequence, hold the released
-- username for thirty days. Yes — the account is churning, hold it for five minutes.
--
-- An existing row's `expires_at` is never renewed, so A -> B -> C -> D leaves A
-- reserved on its ORIGINAL deadline, B and C draining in minutes, and D active. The
-- alternative — reserving every previous username for thirty days — would let one user
-- burn an unbounded number of names, which is the failure this rule exists to prevent.
--
-- ─── Why rows are kept after they expire ─────────────────────────────────────
--
-- `created_at` is the change ledger. The free-change allowance is counted from it,
-- inside the same transaction as the change, which is what makes that allowance
-- authoritative in Postgres. It gates money, and a Redis quota that a flush resets
-- would hand out free changes.
CREATE TABLE "identity"."username_reservations" (
  "id"             UUID        NOT NULL,
  "user_id"        UUID        NOT NULL,
  "username"       TEXT        NOT NULL,
  "username_lower" TEXT        NOT NULL,
  "expires_at"     TIMESTAMPTZ NOT NULL,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "username_reservations_pkey" PRIMARY KEY ("id")
);

-- The availability probe every claim path runs — the change endpoint, the live check,
-- and the signup allocator: "is this username reserved for anyone right now".
--
-- Ordinary, NOT unique. One username may legitimately be reserved, expire, be claimed
-- by somebody else, and be released again; a unique index would forbid the second
-- cycle. Liveness is `expires_at > now()`, evaluated per query, so an expired row stops
-- blocking without anything having to delete it.
CREATE INDEX "ix_username_reservations_lookup"
  ON "identity"."username_reservations" ("username_lower", "expires_at");

-- Two questions, one index, both asked inside the change transaction: how many changes
-- has this account made inside the free window, and does it hold a live reservation.
-- DESC because both reads want the newest rows and neither ever pages backwards.
CREATE INDEX "ix_username_reservations_user"
  ON "identity"."username_reservations" ("user_id", "created_at" DESC);

-- CASCADE like every other per-account table: a deleted account must not keep reserving
-- a username that nobody can ever release.
ALTER TABLE "identity"."username_reservations"
  ADD CONSTRAINT "username_reservations_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
