-- The country catalogue: name, ISO code, and the two flag assets held in Cloudflare R2.
--
-- ─── WHY THIS TABLE IS IN `admin` AND NOT `identity` ────────────────────────
--
-- The consumer backend (../Orebit-backend) owns `identity` and this service writes a
-- few of its tables by raw SQL — `kyc_policies`, `security_restriction_policies`. This
-- one goes the other way: admins OWN the catalogue and the consumer only ever reads it,
-- which is exactly the arrangement `admin.admin_captcha_providers` already has. The
-- consumer reads that table with a read-only raw query and models it in no Prisma
-- schema of its own; `admin.countries` is read the same way.
--
-- It is also the only option mechanically: db/migrate.ts refuses to run unless
-- DATABASE_URL carries `?schema=admin`, and `prisma migrate deploy` manages that schema
-- alone.
--
-- ─── `iso_code` IS THE KEY TO EVERYTHING ───────────────────────────────────
--
-- The R2 object keys are a pure function of this column:
--
--     countries/{iso_code}/round.webp
--     countries/{iso_code}/square.webp
--
-- so the physical layout in the bucket mirrors this table and an object can always be
-- traced back to its country without a lookup. `name` is display text and is matched on
-- by nothing. UNIQUE on `iso_code` is what makes both of those statements true.
--
-- A PLAIN unique index, not a partial one, so it belongs here rather than in
-- db/sql/admin.sql: that file exists for indexes with a WHERE clause (the soft-delete
-- predicates Prisma cannot express), and there is no `deleted_at` on this table to
-- filter on. `EXPECTED_INDEXES` in db/migrate.ts therefore needs no entry — it guards
-- the partial indexes, which are the ones a plain migration could not have created.
--
-- ─── NULLABLE IMAGE KEYS ───────────────────────────────────────────────────
--
-- A country is created before its images are uploaded, so both key columns start NULL.
-- They are written together and never independently: `POST /countries/images` takes
-- both files or neither. Nothing here enforces that pairing, because a CHECK constraint
-- would also have to permit the (NULL, NULL) start state and so could only forbid one
-- of the two half-states asymmetrically; the upload path is the single writer and is
-- where the rule lives.
--
-- `images_updated_at` is the cache-buster. Keys are deterministic, so a replacement
-- reuses the same public URL — without a version token a CDN would serve the previous
-- image indefinitely. The URL resolver appends it as `?v=<epoch ms>`.
--
-- DEFAULTs are written out so an operator can hand-insert a row in psql, the same
-- courtesy `admin_captcha_providers` extends. `id` deliberately has none: it holds a
-- UUIDv7 from the application, and gen_random_uuid() is v4 and scatters B-tree writes.

CREATE TABLE "admin"."countries" (
    "id"                UUID         NOT NULL,
    "name"              VARCHAR(80)  NOT NULL,
    "iso_code"          CHAR(2)      NOT NULL,
    "round_image_key"   VARCHAR(255),
    "square_image_key"  VARCHAR(255),
    "images_updated_at" TIMESTAMPTZ,
    "created_at"        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "countries_pkey" PRIMARY KEY ("id")
);

-- The name Prisma expects for a column-level @unique, so `prisma migrate` sees no drift.
CREATE UNIQUE INDEX "countries_iso_code_key" ON "admin"."countries" ("iso_code");
