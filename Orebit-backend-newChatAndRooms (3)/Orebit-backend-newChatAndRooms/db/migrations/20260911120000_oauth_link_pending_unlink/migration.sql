-- Delayed social-account unlink.
--
-- Both columns are NULL on every existing row and on every ordinary link. They are
-- set together when the owner requests an unlink, and the link stays FULLY LIVE
-- until `unlink_at` passes — `deleted_at` remains the only column that decides
-- whether a link resolves at sign-in.
ALTER TABLE "identity"."oauth_links" ADD COLUMN "unlink_requested_at" TIMESTAMPTZ;
ALTER TABLE "identity"."oauth_links" ADD COLUMN "unlink_at" TIMESTAMPTZ;

-- The sweep's only query: "which live links are due?".
CREATE INDEX "oauth_links_unlink_at_idx" ON "identity"."oauth_links"("unlink_at");
