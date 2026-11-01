-- Uninitialized preference slots are absent intent, not fabricated fallback selections.
ALTER TABLE wallet_core.user_preferences
  ALTER COLUMN preferred_view_currency_id DROP NOT NULL,
  ALTER COLUMN preferred_cryptocurrency_id DROP NOT NULL;

-- PATCH must initialize at least one slot; existing FK and distinct-value checks remain intact.
ALTER TABLE wallet_core.user_preferences
  ADD CONSTRAINT user_preferences_nonempty
  CHECK (preferred_view_currency_id IS NOT NULL OR preferred_cryptocurrency_id IS NOT NULL);
