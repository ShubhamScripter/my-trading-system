-- Correlate the delivery attempts of one queued message.
--
-- Mail is now queued on a durable Redis stream and retried with backoff, so one
-- message can produce several delivery records — failed twice against the primary,
-- delivered on the third attempt via the backup. Before the queue there was exactly
-- one attempt per message and therefore nothing to correlate.
--
-- ─── Why the job id and not the stream entry id ──────────────────────────────
--
-- A retry is a new `XADD`, so the Redis entry id CHANGES between attempts at the same
-- message. It cannot be what groups them. `MailJob.id` is minted once, at enqueue,
-- and carried through every retry — which is what makes "show me every attempt at the
-- code this user says never arrived" a single indexed query rather than a guess based
-- on recipient and timestamp.
--
-- ─── Why both columns are nullable ──────────────────────────────────────────
--
-- Rows written before the queue existed have neither, and inventing values for them
-- would be worse than admitting the gap: a fabricated `attempt = 1` would claim those
-- messages were delivered first time, which is exactly the kind of thing somebody
-- reading an incident timeline would take at face value.
--
-- No backfill for the same reason. `NULL` reads as "this predates the queue", which is
-- true and useful.
ALTER TABLE "identity"."mail_deliveries"
  ADD COLUMN "job_id" UUID,
  ADD COLUMN "attempt" INTEGER;

-- The correlation query. Composite rather than on `job_id` alone so the attempts come
-- back in order without a sort — a delivery history is always read as a sequence.
CREATE INDEX IF NOT EXISTS "mail_deliveries_job_id_attempt_idx"
  ON "identity"."mail_deliveries" ("job_id", "attempt");
