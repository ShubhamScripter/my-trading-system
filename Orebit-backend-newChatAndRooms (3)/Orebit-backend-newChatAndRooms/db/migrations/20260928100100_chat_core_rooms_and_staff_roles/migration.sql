-- Chat: the Global and Staff rooms exist in every database that is migrated, and chat staff roles move into a
-- chat-owned table. Premium, KYC, country and wager facts are no longer kept by chat at all — they come from
-- their own modules through ports (chat.ports.ts).
--
-- Rollback: re-create identity."UserRole" and identity.user_memberships from the init chat migration and copy the
-- rows of chat.staff_roles back into it; drop chat.staff_roles and chat."StaffRole". The two rooms may stay.

-- ─── 1. Global and Staff rooms ────────────────────────────────────────────────────────────────────────────────────
-- ON CONFLICT DO NOTHING without a conflict target: an existing id OR an existing slug leaves the row alone, so a
-- database that was already seeded keeps whatever an admin has since changed.
INSERT INTO "chat"."rooms" ("id", "slug", "name", "description", "type", "config", "created_at")
VALUES ('00000000-0000-0000-0000-000000000000', 'global', 'Global Chat',
        'The global public room, open to every signed-in user.', 'GLOBAL', '{}', now())
ON CONFLICT DO NOTHING;

INSERT INTO "chat"."rooms" ("id", "slug", "name", "description", "type", "config", "created_at")
VALUES ('00000000-0000-0000-0000-000000000110', 'staff-room', 'Staff Room',
        'Coordination room for chat staff.', 'STAFF', '{}', now())
ON CONFLICT DO NOTHING;

-- The Staff room is hidden from everyone who is not chat staff. The room type already enforces that; the
-- rule records it so the admin panel shows it. Written with today's columns; the next migration converts them.
INSERT INTO "chat"."room_access_rules"
    ("id", "room_id", "min_level", "require_premium", "require_kyc", "require_merchant",
     "allowed_countries", "view_only_countries", "is_view_only_for_others", "config")
SELECT '00000000-0000-0000-0000-000000000111', '00000000-0000-0000-0000-000000000110', 0, false, false, false,
       '{}', '{}', false, '{}'
WHERE EXISTS (SELECT 1 FROM "chat"."rooms" WHERE "id" = '00000000-0000-0000-0000-000000000110')
  AND NOT EXISTS (SELECT 1 FROM "chat"."room_access_rules" WHERE "room_id" = '00000000-0000-0000-0000-000000000110')
ON CONFLICT DO NOTHING;

-- ─── 2. Chat staff roles ──────────────────────────────────────────────────────────────────────────────────────────
-- ADMIN and MODERATOR are chat staff. SUPPORT keeps only Staff-room access until the Module 4 role permissions exist.
CREATE TYPE "chat"."StaffRole" AS ENUM ('ADMIN', 'MODERATOR', 'SUPPORT');

CREATE TABLE "chat"."staff_roles" (
    "user_id"     UUID NOT NULL,
    "role"        "chat"."StaffRole" NOT NULL,
    -- The admin (admin backend id) who assigned the role; not a user id, so no link.
    "assigned_by" UUID,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "staff_roles_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "chat"."staff_roles" ADD CONSTRAINT "staff_roles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Copy the staff roles only. MERCHANT and SO were never chat roles: site-owner status comes from the Merchant
-- module, and an ADMIN role row is not a site owner.
INSERT INTO "chat"."staff_roles" ("user_id", "role", "assigned_by", "assigned_at")
SELECT "user_id", "role"::text::"chat"."StaffRole", NULL, "updated_at"
FROM "identity"."user_memberships"
WHERE "role"::text IN ('ADMIN', 'MODERATOR', 'SUPPORT');

-- Chat no longer keeps premium, KYC, country or wager copies, so the table and its role type go.
DROP TABLE "identity"."user_memberships";
DROP TYPE "identity"."UserRole";
