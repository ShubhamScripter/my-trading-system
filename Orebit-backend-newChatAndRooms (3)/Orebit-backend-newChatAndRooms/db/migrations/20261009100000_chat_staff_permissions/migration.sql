-- Chat Module 4: role permissions need two records the room config cannot hold.
--  1. chat.user_restrictions — restrictions on a user or a group of users (Premium, KYC, level) across chat or in one
--     room, given by staff from the app or by an admin (Chat SETTINGS "Restrict a Specific User / Group of Users").
--     Room-config restrictions stay where they are; both are enforced.
--  2. chat.staff_requests — the REPORT mode of a role permission: "report means they can ask their above role to do
--     it, Report will have input text box in user end UI". A higher role (or an admin) approves or rejects.
-- Nothing is deleted: a lifted restriction keeps its row with lifted_at, a resolved request keeps its row.
--
-- Rollback: DROP TABLE "chat"."staff_requests"; DROP TABLE "chat"."user_restrictions";

CREATE TABLE "chat"."user_restrictions" (
    "id"               UUID NOT NULL,
    "target_type"      TEXT NOT NULL,
    "target_value"     TEXT NOT NULL,
    "kind"             TEXT NOT NULL,
    "commands"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "room_id"          UUID,
    "reason"           TEXT NOT NULL,
    "created_by"       UUID,
    "created_by_admin" UUID,
    "created_by_role"  TEXT,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
    "expires_at"       TIMESTAMPTZ,
    "lifted_at"        TIMESTAMPTZ,
    "lifted_by"        UUID,
    "lifted_by_admin"  UUID,

    CONSTRAINT "user_restrictions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_restrictions_target_type_check" CHECK ("target_type" IN ('USER', 'PREMIUM', 'KYC', 'LEVEL')),
    CONSTRAINT "user_restrictions_kind_check" CHECK ("kind" IN (
        'MUTE', 'RESTRICT_MEDIA', 'RESTRICT_EMOJI', 'RESTRICT_GIF', 'RESTRICT_COMMANDS', 'RESTRICT_ADS',
        'RESTRICT_DM', 'RESTRICT_GIFTS')),
    CONSTRAINT "user_restrictions_reason_check" CHECK (length("reason") BETWEEN 1 AND 500)
);
CREATE INDEX "user_restrictions_target_type_target_value_idx" ON "chat"."user_restrictions" ("target_type", "target_value");
CREATE INDEX "user_restrictions_created_at_idx" ON "chat"."user_restrictions" ("created_at" DESC);
ALTER TABLE "chat"."user_restrictions" ADD CONSTRAINT "user_restrictions_room_id_fkey"
    FOREIGN KEY ("room_id") REFERENCES "chat"."rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat"."user_restrictions" ADD CONSTRAINT "user_restrictions_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "chat"."staff_requests" (
    "id"                UUID NOT NULL,
    "requester_id"      UUID NOT NULL,
    "requester_role"    TEXT NOT NULL,
    "permission"        TEXT NOT NULL,
    "target_user_id"    UUID,
    "target_room_id"    UUID,
    "payload"           JSONB NOT NULL DEFAULT '{}',
    "note"              TEXT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'PENDING',
    "resolved_by"       UUID,
    "resolved_by_admin" UUID,
    "resolution_note"   TEXT,
    "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
    "resolved_at"       TIMESTAMPTZ,

    CONSTRAINT "staff_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "staff_requests_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')),
    CONSTRAINT "staff_requests_note_check" CHECK (length("note") BETWEEN 1 AND 1000)
);
CREATE INDEX "staff_requests_status_created_at_idx" ON "chat"."staff_requests" ("status", "created_at" DESC);
CREATE INDEX "staff_requests_requester_id_created_at_idx" ON "chat"."staff_requests" ("requester_id", "created_at" DESC);
ALTER TABLE "chat"."staff_requests" ADD CONSTRAINT "staff_requests_requester_id_fkey"
    FOREIGN KEY ("requester_id") REFERENCES "identity"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
