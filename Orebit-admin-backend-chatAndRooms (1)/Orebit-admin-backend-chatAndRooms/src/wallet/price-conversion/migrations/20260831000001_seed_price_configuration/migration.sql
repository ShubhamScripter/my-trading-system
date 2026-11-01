BEGIN;

INSERT INTO price_conversion.price_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
INSERT INTO price_conversion.price_providers (code) VALUES ('COINGECKO'), ('ALCHEMY'), ('COINMARKETCAP') ON CONFLICT (code) DO NOTHING;

COMMIT;
