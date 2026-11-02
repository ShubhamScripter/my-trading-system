ALTER TABLE chat.chat_ad_placements
  ADD COLUMN duration_seconds INTEGER;

UPDATE chat.chat_ad_placements
SET duration_seconds = minutes * 60;

ALTER TABLE chat.chat_ad_placements
  ALTER COLUMN duration_seconds SET NOT NULL,
  ADD CONSTRAINT chat_ad_placements_duration_seconds_check CHECK (duration_seconds > 0);
