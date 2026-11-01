-- AlterTable
ALTER TABLE "identity"."users" ADD COLUMN "avatar_url" TEXT;

-- AlterTable
ALTER TABLE "identity"."registrations" ADD COLUMN "oauth_avatar_url" TEXT;

-- AlterTable
ALTER TABLE "identity"."oauth_links" ADD COLUMN "avatar_url_at_link" TEXT;
