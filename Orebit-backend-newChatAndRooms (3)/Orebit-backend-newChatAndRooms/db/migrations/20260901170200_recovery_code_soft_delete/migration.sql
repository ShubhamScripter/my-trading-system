-- Make recovery-code regeneration a soft delete, as everything else in this schema
-- already is.
--
-- ─── The defect ──────────────────────────────────────────────────────────────
--
-- `replaceRecoveryCodes` ran `deleteMany({ where: { userId } })` — the only hard
-- delete in any dboperation in this repository — and the predicate was scoped to the
-- USER, not to unspent rows. So it erased spent codes along with live ones.
--
-- That directly contradicted this table's own documented promise. The comment on
-- `used_at` says spent codes are retained "so 'how many are left' and 'was one used
-- the night of the incident' both stay answerable". The second question was
-- unanswerable in practice: regenerating a set, or removing the last factor (which
-- calls the same function with an empty list), destroyed the entire history
-- including the evidence that a code had been used.
--
-- ─── Why a new column rather than reusing used_at ────────────────────────────
--
-- They mean different things and both need to be readable. `used_at` is "somebody
-- signed in with this"; `superseded_at` is "a newer generation replaced this". Only
-- the first is interesting during an incident, and collapsing them would make every
-- regenerated code look as though it had been spent — turning the audit trail from
-- absent into actively misleading.
--
-- ─── What "live" now means ───────────────────────────────────────────────────
--
-- `used_at IS NULL AND superseded_at IS NULL`, everywhere: the spend CAS, the
-- remaining count, and the partial unique index in db/sql/identity.sql. That index
-- had to change with this column — it was UNIQUE on (user_id, code_hash) WHERE
-- used_at IS NULL, and since superseded rows are now retained rather than deleted, a
-- regenerated set could otherwise collide with the generation it replaced and make
-- an ordinary regenerate fail.
ALTER TABLE "identity"."recovery_codes"
  ADD COLUMN "superseded_at" TIMESTAMPTZ;

-- The replacement index is declared in db/sql/identity.sql, which is applied after
-- every migration and is where the partial indexes live. Recreated here as well so a
-- database migrated by these files alone is correct at this point in the sequence
-- rather than only after the SQL pass.
DROP INDEX IF EXISTS "identity"."ux_recovery_codes_unused";
CREATE UNIQUE INDEX IF NOT EXISTS "ux_recovery_codes_unused"
  ON "identity"."recovery_codes" ("user_id", "code_hash")
  WHERE "used_at" IS NULL AND "superseded_at" IS NULL;
