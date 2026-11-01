-- Slice: FR-253 (Module 4). Limit hits per user, reason and hour: what the admin reads before deciding to unblock a
-- frequent hitter. Written in the same flush as the hitter counts. Rollback: drop the table.
CREATE TABLE "chat"."limit_hits_hourly" (
    "user_id" UUID        NOT NULL,
    "hour"    TIMESTAMPTZ NOT NULL,
    "reason"  TEXT        NOT NULL,
    "hits"    INTEGER     NOT NULL,
    CONSTRAINT "limit_hits_hourly_pkey" PRIMARY KEY ("user_id", "hour", "reason"),
    CONSTRAINT "limit_hits_hourly_reason_check"
        CHECK ("reason" IN ('slow_mode', 'ip_limit', 'media_cooldown', 'flood', 'new_dm_limit', 'report_limit'))
);
CREATE INDEX "limit_hits_hourly_hour_idx" ON "chat"."limit_hits_hourly" ("hour");
