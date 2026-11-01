-- FR-099: a warning given to a GROUP (Premium, KYC, a level) is one rule, not one row per user. A user's warnings list
-- shows the rules that name them (checked when it is read), so a group of any size costs one row.
-- Rollback: DROP TABLE chat.group_warnings.

CREATE TABLE "chat"."group_warnings" (
    "id"             UUID NOT NULL,
    "target_type"    TEXT NOT NULL,
    "target_value"   TEXT NOT NULL,
    "room_id"        UUID,
    "reason"         TEXT NOT NULL,
    "issued_by"      UUID NOT NULL,
    "issued_by_role" TEXT NOT NULL,
    "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "group_warnings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "group_warnings_target_type_check" CHECK ("target_type" IN ('PREMIUM', 'KYC', 'LEVEL')),
    CONSTRAINT "group_warnings_reason_check" CHECK (length("reason") BETWEEN 1 AND 500)
);
CREATE INDEX "group_warnings_created_at_id_idx" ON "chat"."group_warnings" ("created_at" DESC, "id" DESC);
