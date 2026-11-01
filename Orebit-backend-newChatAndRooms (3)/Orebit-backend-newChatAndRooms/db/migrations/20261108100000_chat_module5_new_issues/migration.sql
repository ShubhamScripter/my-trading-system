-- Slice: Module 5 NEW issues (chat advertising and gifts enhancements).
-- FR-261: kind on chat_ads ('USER', 'INTERNAL')
-- FR-260: is_18_plus on chat_ads
-- FR-234: plan_id and discount_usd on chat_ads
-- FR-264: revert_shortfall on gift_transfers ('ZERO', 'NEGATIVE')

ALTER TABLE "chat"."chat_ads"
    ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'USER',
    ADD COLUMN "is_18_plus" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "plan_id" TEXT,
    ADD COLUMN "discount_usd" DECIMAL(18, 8);

ALTER TABLE "chat"."gift_transfers"
    ADD COLUMN "revert_shortfall" TEXT;

