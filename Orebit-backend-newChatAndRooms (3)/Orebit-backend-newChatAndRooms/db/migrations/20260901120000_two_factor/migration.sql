-- Opt-in two-factor authentication: TOTP, passkeys, recovery codes, and the
-- half-authenticated sign-in that sits between the two factors.
--
-- Four tables and two enums arrive together because they are one feature. Landing
-- the factor tables without `login_attempts` would give the service somewhere to
-- record an enrollment and nowhere to enforce it, which is the worst of the three
-- possible orderings: a user could turn 2FA on and it would do nothing.
--
-- Nothing here is required of an existing account. Every column that would force a
-- decision on one is nullable or defaulted, and no row is created for a user who
-- has not enrolled — so this migration changes the behaviour of exactly zero
-- current sign-ins.

-- CreateEnum
--
-- The factor kinds that have a table. `recovery_code` is a sign-in method on the
-- wire and deliberately NOT a member here: a recovery code is a single-use string,
-- not something a user enrols, and nothing in Postgres needs to name it.
CREATE TYPE "identity"."MfaMethod" AS ENUM ('TOTP', 'PASSKEY');

-- CreateEnum
CREATE TYPE "identity"."LoginState" AS ENUM ('FACTOR_REQUIRED', 'COMPLETED', 'EXPIRED');

-- CreateTable
--
-- The TOTP secret is ENCRYPTED rather than hashed, which is the one place this
-- schema stores a recoverable secret on purpose: verifying a code means
-- regenerating it from the seed, so a one-way hash would make the factor unusable.
-- Three columns rather than one blob so a key rotation is an UPDATE per row.
CREATE TABLE "identity"."totp_factors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "secret_ciphertext" BYTEA NOT NULL,
    "secret_iv" BYTEA NOT NULL,
    "secret_tag" BYTEA NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Authenticator',
    "confirmed_at" TIMESTAMPTZ,
    -- The RFC 6238 step of the last accepted code. BIGINT because the counter is
    -- seconds/30 since the epoch and will outlive a 32-bit column in 2038.
    "last_used_step" BIGINT,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "totp_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- No secret at all, which is the whole appeal: `public_key` is public and the
-- private half never leaves the authenticator. A dump of this table lets an
-- attacker verify assertions, not forge them.
CREATE TABLE "identity"."passkeys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aaguid" TEXT,
    "label" TEXT NOT NULL DEFAULT 'Passkey',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- `used_at` is the terminal marker and spent codes are RETAINED rather than
-- deleted, so "how many are left" and "was one used the night of the incident"
-- both stay answerable after the fact. Same reasoning as
-- verification_challenges.consumed_at.
CREATE TABLE "identity"."recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- The half-authenticated sign-in. Server-side because anything the client could
-- present as a bearer would make the second factor optional to whoever holds it;
-- the client gets only an opaque handle whose hash is `token_hash`.
--
-- The client context columns are copied in rather than re-read at the end: the
-- session is minted by the SECOND request, by which point the request that proved
-- the password is gone. Without them every sign-in with 2FA on would silently lose
-- remember-me.
CREATE TABLE "identity"."login_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "state" "identity"."LoginState" NOT NULL DEFAULT 'FACTOR_REQUIRED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ip_class" TEXT NOT NULL,
    "device_fingerprint" TEXT NOT NULL,
    "user_agent" VARCHAR(256),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "totp_factors_user_id_confirmed_at_idx"
  ON "identity"."totp_factors" ("user_id", "confirmed_at");

-- CreateIndex
CREATE INDEX "passkeys_user_id_idx" ON "identity"."passkeys" ("user_id");

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_used_at_idx"
  ON "identity"."recovery_codes" ("user_id", "used_at");

-- CreateIndex
CREATE INDEX "login_attempts_user_id_state_idx"
  ON "identity"."login_attempts" ("user_id", "state");

-- AddForeignKey
--
-- CASCADE on all four: none of these outlive the account they belong to, and
-- unlike a session there is no audit value in a factor whose owner is gone.
ALTER TABLE "identity"."totp_factors"
  ADD CONSTRAINT "totp_factors_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."passkeys"
  ADD CONSTRAINT "passkeys_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."recovery_codes"
  ADD CONSTRAINT "recovery_codes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."login_attempts"
  ADD CONSTRAINT "login_attempts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
