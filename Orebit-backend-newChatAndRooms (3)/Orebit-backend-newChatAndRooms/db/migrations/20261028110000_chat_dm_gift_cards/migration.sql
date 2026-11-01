-- Chat Module 8, FR-269 / V2-99: a gift card (coupon) can be sent in a direct conversation. The card is a message of its
-- own kind, CARD; it shows the card's title and value, never its code.
--
-- Rollback: delete or convert the CARD rows, then restore the old CHECK (TEXT, MEDIA, GIFT, SYSTEM).

ALTER TABLE "chat"."dm_messages" DROP CONSTRAINT "dm_messages_type_check";
ALTER TABLE "chat"."dm_messages" ADD CONSTRAINT "dm_messages_type_check"
    CHECK ("type" IN ('TEXT', 'MEDIA', 'GIFT', 'CARD', 'SYSTEM'));
