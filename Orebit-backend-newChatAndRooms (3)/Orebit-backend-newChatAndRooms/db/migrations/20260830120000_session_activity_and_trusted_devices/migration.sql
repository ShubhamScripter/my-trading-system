-- Idle sessions, device trust, and the table that binds them.
--
-- Three things arrive together because they are one feature: a session now expires
-- from disuse rather than on a fixed 30-day clock, and "trust this device" is the
-- opt-out from that rule. Splitting them would leave a release where the idle
-- window is live and nothing can suspend it.

-- Last authenticated request, written by AuthGuard behind a throttle.
--
-- NOT NULL with a default rather than nullable: every existing row was, by
-- definition, last used no later than now, and a nullable column would make every
-- reader handle an "unknown" case that cannot arise. Backfilling to now() is
-- deliberately generous — it treats live sessions as active rather than
-- retroactively idling out every session in the table on deploy.
ALTER TABLE "identity"."sessions"
  ADD COLUMN "last_used_at" TIMESTAMPTZ NOT NULL DEFAULT now();

-- Non-null only while a trusted device is holding this session open. Null is the
-- ordinary case and means "idle rule applies".
ALTER TABLE "identity"."sessions"
  ADD COLUMN "remember_until" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "identity"."trusted_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent_at_trust" VARCHAR(256),
    "ip_class_at_trust" TEXT NOT NULL,
    "label" VARCHAR(80),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

-- Added after the table it references, so the FK below has something to point at.
ALTER TABLE "identity"."sessions"
  ADD COLUMN "trusted_device_id" UUID;

-- CreateIndex
CREATE INDEX "trusted_devices_user_id_revoked_at_idx"
  ON "identity"."trusted_devices" ("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_trusted_device_id_idx"
  ON "identity"."sessions" ("trusted_device_id");

-- AddForeignKey
ALTER TABLE "identity"."trusted_devices"
  ADD CONSTRAINT "trusted_devices_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ON DELETE SET NULL, not CASCADE: deleting the trust record must not delete the
-- sessions it was extending. Untrusting a device revokes those sessions
-- explicitly, in application code, so that the revocation is recorded with a
-- reason rather than happening as an invisible side effect of a foreign key.
ALTER TABLE "identity"."sessions"
  ADD CONSTRAINT "sessions_trusted_device_id_fkey"
  FOREIGN KEY ("trusted_device_id") REFERENCES "identity"."trusted_devices"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The registration-time answer to "trust this device?".
--
-- Defaults to false so in-flight registrations created before this migration —
-- and any client that never sends the step — complete with an ordinary untrusted
-- session rather than silently acquiring a week-long one.
ALTER TABLE "identity"."registrations"
  ADD COLUMN "trust_device" BOOLEAN NOT NULL DEFAULT false;
