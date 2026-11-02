-- Expired invites are distinct from moderator revocations.
-- Rollback: UPDATE "chat"."dm_group_invites" SET "status" = 'REVOKED' WHERE "status" = 'EXPIRED';
--           ALTER TABLE "chat"."dm_group_invites" DROP CONSTRAINT "dm_group_invites_status_check";
--           ALTER TABLE "chat"."dm_group_invites" ADD CONSTRAINT "dm_group_invites_status_check"
--             CHECK ("status" IN ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED'));
ALTER TABLE "chat"."dm_group_invites" DROP CONSTRAINT "dm_group_invites_status_check";
ALTER TABLE "chat"."dm_group_invites" ADD CONSTRAINT "dm_group_invites_status_check"
    CHECK ("status" IN ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED'));
UPDATE "chat"."dm_group_invites" SET "status" = 'EXPIRED', "responded_at" = now()
WHERE "status" = 'PENDING' AND "expires_at" IS NOT NULL AND "expires_at" <= now();
