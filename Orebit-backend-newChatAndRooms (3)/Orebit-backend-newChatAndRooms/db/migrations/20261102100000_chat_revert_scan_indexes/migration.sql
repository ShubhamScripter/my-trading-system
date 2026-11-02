-- Partial keyset index for completed gift revert scans.
CREATE INDEX IF NOT EXISTS "gift_transfers_completed_created_id_idx"
    ON "chat"."gift_transfers" ("created_at", "id")
    WHERE "status" = 'COMPLETED';