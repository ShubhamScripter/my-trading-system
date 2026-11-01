-- Operator-controlled captcha provider enablement, for BOTH backends.
--
-- ═══ THIS TABLE CAN ONLY EVER SUBTRACT ════════════════════════════════════════
--
-- A provider is live iff a service has a SECRET for it in its own env AND it is not
-- disabled here. Secrets do not belong in a Postgres row, so a row can never enable
-- a provider — it can only take a configured one out of rotation. Each service's env
-- stays its own secret authority, which is why the same rows can legitimately yield
-- different effective sets in the admin and consumer backends.
--
-- ═══ AN ABSENT ROW MEANS ENABLED ══════════════════════════════════════════════
--
-- Storing disablements rather than enablements is what makes every failure mode
-- collapse into one safe answer. An empty table, a table that does not exist yet, a
-- revoked SELECT, a query that times out and a database that is simply down all mean
-- "nothing is disabled" -> the full env set -> exactly the behaviour before this
-- migration. So there is no seed row, and the deploy order between the two services
-- is safe in both directions.
--
-- The DEFAULTs below matter beyond Prisma, and are the point of writing them out:
-- they are what let an operator insert a row by hand without naming the timestamps.
--
--   INSERT INTO admin.admin_captcha_providers (provider, enabled, reason)
--   VALUES ('HCAPTCHA', false, 'vendor incident 2026-09-02');
--
-- READ BY THE CONSUMER BACKEND (../Orebit-backend) with a read-only raw query. It
-- does not model this table in its own Prisma schema, so renaming a column here is
-- a breaking change that nothing in either repo's type system will catch.

CREATE TABLE "admin"."admin_captcha_providers" (
    -- A CAPTCHA_PROVIDERS member, and the primary key. Not a uuidv7 `id` like every
    -- other table here: that convention buys B-tree locality on high-volume inserts,
    -- which is meaningless at four rows, and rows here are written by hand in psql
    -- where there is no way to produce a uuidv7.
    "provider"            VARCHAR(32)  NOT NULL,
    "enabled"             BOOLEAN      NOT NULL DEFAULT true,
    -- Why, for whoever finds this row at 3am.
    "reason"              VARCHAR(256),
    -- A note, never a join. Deliberately not a FOREIGN KEY: the operator making the
    -- write may have no admin id to hand, and a constraint that blocks an incident
    -- response is worse than an unverified string.
    "updated_by_admin_id" UUID,
    "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_captcha_providers_pkey" PRIMARY KEY ("provider")
);

-- No index beyond the primary key. The only read is "every row where enabled = false"
-- against a table with one row per provider, which is a sequential scan of one page
-- however it is written.
