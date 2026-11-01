-- The account's Payment PIN: one row per user, holding one argon2id hash.
--
-- ─── What this table is, and what it deliberately is not ─────────────────────
--
-- A Payment PIN authorises a payment on a session that is already established. It is
-- NOT a sign-in factor, which is why it does not join `totp_factors`, `passkeys` and
-- `recovery_codes` in answering "may this person sign in". The practical consequence
-- is that removing it does not sweep the account's other sessions the way disabling a
-- factor does — no session was ever established with it, so a sweep would invalidate
-- nothing and would be a new policy with none of the reasoning that justifies the
-- existing one.
--
-- ─── Why there is no `enabled` column ────────────────────────────────────────
--
-- Because the row's existence already says it, and two sources of truth for one fact
-- is two things that can disagree. `enabled` would additionally admit a state the
-- product has no meaning for — a stored PIN hash that is switched off — which is a
-- retained secret pretending to be a setting.
--
-- ─── Why `user_id` is a plain UNIQUE and not a partial index ─────────────────
--
-- Every other table here soft-deletes, and their uniqueness therefore lives in
-- db/sql/identity.sql as `... WHERE deleted_at IS NULL`. This one hard-deletes on
-- disable, so there is no live/dead distinction for the predicate to make and the
-- constraint is an ordinary one Prisma can own.
--
-- The hard delete is itself the deviation worth stating. Soft delete exists in this
-- schema for two reasons, and neither reaches this table: `passkeys` and `users`
-- retain rows so a removal does not permanently reserve an external identifier (a
-- credential ID, an email address), and this table has none; `recovery_codes` retains
-- rows so the record of which code was spent survives, and a single hash replaced in
-- place has no comparable history. What a soft delete would preserve here is the
-- argon2 hash of a secret the user explicitly asked us to destroy.
--
-- ─── Why the hash is argon2id rather than sha256+pepper ──────────────────────
--
-- Not enforceable in DDL, but it is the reason this column is wide and it belongs
-- with the table. `peppered_hash` (sha256) is correct for the OTP and recovery-code
-- columns elsewhere: those secrets are high-entropy, short-lived, and minted by the
-- server. Six digits is a keyspace of one million, chosen by the user and held for
-- months — a dump plus sha256 recovers every PIN in the table in under a second. It
-- is a low-entropy user-chosen secret, the same shape as a password, so it is hashed
-- the way the password is. See auth/services/credential.service.ts.
CREATE TABLE "identity"."payment_pins" (
  "id"         UUID         NOT NULL,
  "user_id"    UUID         NOT NULL,
  "pin_hash"   TEXT         NOT NULL,
  "created_at" TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ  NOT NULL,

  CONSTRAINT "payment_pins_pkey" PRIMARY KEY ("id")
);

-- One Payment PIN per account, enforced by the database rather than by a read-then-
-- write in the service. `create` relies on this: two concurrent enables both find no
-- row, both insert, and the loser gets 23505 rather than a second PIN silently
-- replacing the first.
CREATE UNIQUE INDEX "payment_pins_user_id_key"
  ON "identity"."payment_pins" ("user_id");

-- ON DELETE CASCADE, like every other per-account table here: an account that is gone
-- must not leave a hash behind, and nothing in the product needs a Payment PIN to
-- outlive its owner.
ALTER TABLE "identity"."payment_pins"
  ADD CONSTRAINT "payment_pins_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
