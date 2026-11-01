BEGIN;

-- Internal bounded walker for the explicit Wallet/Pricing descriptor embedded below.
-- Callers cannot supply their own validation rules through the public append API.
CREATE FUNCTION admin.validate_admin_audit_configuration_node_v1(p_value jsonb, p_rule jsonb, p_depth integer DEFAULT 0)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, admin
AS $node$
DECLARE entry record; item jsonb; scalar text;
BEGIN
  IF p_rule IS NULL OR p_value IS NULL OR p_depth > 8 THEN RETURN false; END IF;
  IF p_value = 'null'::jsonb THEN RETURN COALESCE((p_rule->>'nullable')::boolean,false); END IF;
  IF jsonb_typeof(p_value) IS DISTINCT FROM p_rule->>'type' THEN RETURN false; END IF;
  CASE p_rule->>'type'
  WHEN 'object' THEN
    IF NOT (p_value ?& ARRAY(SELECT jsonb_array_elements_text(p_rule->'required'))) THEN RETURN false; END IF;
    FOR entry IN SELECT key,value FROM jsonb_each(p_value) LOOP
      IF NOT admin.validate_admin_audit_configuration_node_v1(entry.value,p_rule->'fields'->entry.key,p_depth+1) THEN RETURN false; END IF;
    END LOOP;
  WHEN 'array' THEN
    IF jsonb_array_length(p_value) > (p_rule->>'max')::integer THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(p_value) LOOP
      IF NOT admin.validate_admin_audit_configuration_node_v1(item,p_rule->'items',p_depth+1) THEN RETURN false; END IF;
    END LOOP;
  WHEN 'string' THEN
    scalar := p_value #>> '{}';
    IF scalar ~ '[\x01-\x1f\x7f]'
      OR (p_rule ? 'min' AND char_length(scalar)<(p_rule->>'min')::integer)
      OR (p_rule ? 'max' AND char_length(scalar)>(p_rule->>'max')::integer)
      OR (p_rule ? 'pattern' AND scalar !~ (p_rule->>'pattern'))
      OR (p_rule ? 'values' AND NOT (p_rule->'values' ? scalar)) THEN RETURN false; END IF;
  WHEN 'number' THEN
    IF (p_value::text)::numeric <> trunc((p_value::text)::numeric)
      OR (p_value::text)::numeric < (p_rule->>'min')::numeric
      OR (p_value::text)::numeric > (p_rule->>'max')::numeric THEN RETURN false; END IF;
  WHEN 'boolean' THEN NULL;
  ELSE RETURN false;
  END CASE;
  RETURN true;
END;
$node$;
ALTER FUNCTION admin.validate_admin_audit_configuration_node_v1(jsonb,jsonb,integer) OWNER TO orebit_admin_audit_owner;
REVOKE ALL ON FUNCTION admin.validate_admin_audit_configuration_node_v1(jsonb,jsonb,integer) FROM PUBLIC;

-- End configuration helper. The forward append amendment follows.

DO $extension$
DECLARE
  definition text;
  original text;
  contract jsonb;
  entry jsonb;
  price jsonb;
  actions jsonb := '[]'::jsonb;
  marker text := '$admin_audit_contract$';
  rules jsonb := $configuration_rules${"WALLET_CORE":{"SETTINGS_REVISION":{"type":"object","fields":{"settings":{"type":"object","fields":{"globalDesiredState":{"type":"string","values":["OFF","ON","MAINTAIN"]},"catalogueMode":{"type":"string","values":["ALL","RELEVANT"]},"reconciliationIncludeTreasury":{"type":"boolean"},"reconciliationIncludeCollection":{"type":"boolean"},"reconciliationAlertPercent":{"type":"string","min":1,"max":148,"pattern":"^(0|[1-9][0-9]*)(\\.[0-9]{1,18})?$"},"reconciliationAlertBasis":{"type":"string","values":["SIGNED","POSITIVE_ONLY"]},"defaultCurrencyIds":{"type":"array","items":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"max":10}},"required":["globalDesiredState","catalogueMode","reconciliationIncludeTreasury","reconciliationIncludeCollection","reconciliationAlertPercent","defaultCurrencyIds"]},"chains":{"type":"array","items":{"type":"object","fields":{"id":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"providerChainId":{"type":"number","min":1,"max":9007199254740991},"blockchainReference":{"type":"string","min":1,"max":160},"name":{"type":"string","min":1,"max":128},"shortName":{"type":"string","min":1,"max":32},"isEvm":{"type":"boolean"},"logoObjectKey":{"type":"string","min":1,"max":255},"availableFor":{"type":"string","values":["USER","MERCHANT","BOTH"]},"desiredState":{"type":"string","values":["OFF","ON","MAINTAIN"]}},"required":["providerChainId","blockchainReference","name","shortName","isEvm","availableFor"]},"max":100},"currencies":{"type":"array","items":{"type":"object","fields":{"id":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"symbol":{"type":"string","min":1,"max":32},"name":{"type":"string","min":1,"max":128},"providerRefs":{"type":"array","items":{"type":"object","fields":{"provider":{"type":"string","values":["COINGECKO","ALCHEMY","COINMARKETCAP"]},"providerAssetId":{"type":"string","min":1,"max":160},"providerSymbol":{"type":"string","min":1,"max":32},"network":{"type":"string","min":1,"max":64},"address":{"type":"string","min":1,"max":256}},"required":["provider","providerAssetId","providerSymbol"]},"max":3},"binanceReference":{"type":"string","min":1,"max":64},"logoObjectKey":{"type":"string","min":1,"max":255},"viewEnabled":{"type":"boolean"},"geoCountryDeny":{"type":"array","items":{"type":"string","min":1,"max":2,"pattern":"^[A-Z]{2}$"},"max":249},"geoContinentDeny":{"type":"array","items":{"type":"string","values":["AF","AN","AS","EU","NA","OC","SA"]},"max":7},"accessLevel":{"type":"string","values":["ALL","KYC_L1","KYC_L2"]},"availableFor":{"type":"string","values":["USER","MERCHANT","BOTH"]},"listingKind":{"type":"string","values":["PERMANENT","TIME_LIMITED"]},"listingStartsAt":{"type":"string","min":1,"max":30,"pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"},"showBeforeListing":{"type":"boolean"},"premiumEarlyAccessAt":{"type":"string","min":1,"max":30,"pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"},"premiumOperations":{"type":"array","items":{"type":"string","values":["DEPOSIT","WITHDRAW","EXCHANGE","USER_TRANSFER","SEND_API","STAKE","BANKROLL"]},"max":7},"soEarlyAccessAt":{"type":"string","min":1,"max":30,"pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"},"soOperations":{"type":"array","items":{"type":"string","values":["DEPOSIT","WITHDRAW","EXCHANGE","USER_TRANSFER","SEND_API","STAKE","BANKROLL"]},"max":7},"delistAt":{"type":"string","min":1,"max":30,"pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"},"afterDelistMode":{"type":"string","values":["AUTO_EXCHANGE","LEAVE"]},"autoExchangeToCurrencyId":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"autoExchangeFeeBps":{"type":"number","min":0,"max":10000},"leaveDays":{"type":"number","min":1,"max":9007199254740991},"afterLeaveMode":{"type":"string","values":["LOSS","AUTO_EXCHANGE"]},"afterLeaveAutoExchangeToCurrencyId":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"afterLeaveAutoExchangeFeeBps":{"type":"number","min":0,"max":10000},"postDelistOperations":{"type":"array","items":{"type":"string","values":["WITHDRAW","EXCHANGE"]},"max":2},"desiredState":{"type":"string","values":["OFF","ON","MAINTAIN"]},"maintenanceAudiences":{"type":"array","items":{"type":"string","values":["USER","SO"]},"max":2},"showBalanceInMaintenance":{"type":"object","fields":{"USER":{"type":"boolean"},"SO":{"type":"boolean"}},"required":["USER","SO"]},"bindings":{"type":"array","items":{"type":"object","fields":{"id":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"chainId":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"providerCoinId":{"type":"number","min":1,"max":9007199254740991},"blockchainReference":{"type":"string","min":1,"max":160},"isToken":{"type":"boolean"},"tokenContractAddress":{"type":"string","min":1,"max":256},"blockchainPrecision":{"type":"number","min":0,"max":18},"desiredState":{"type":"string","values":["OFF","ON","MAINTAIN"]},"hotWalletAddresses":{"type":"array","items":{"type":"string","min":1,"max":256},"max":10000},"coldWalletAddresses":{"type":"array","items":{"type":"string","min":1,"max":256},"max":10000},"stakingWalletAddresses":{"type":"array","items":{"type":"string","min":1,"max":256},"max":10000}},"required":["chainId","providerCoinId","blockchainReference","isToken","blockchainPrecision","desiredState","hotWalletAddresses","coldWalletAddresses","stakingWalletAddresses"]},"max":100}},"required":["symbol","name","providerRefs","viewEnabled","geoCountryDeny","geoContinentDeny","accessLevel","availableFor","listingKind","showBeforeListing","premiumOperations","soOperations","postDelistOperations","desiredState","maintenanceAudiences","showBalanceInMaintenance","bindings"]},"max":10000},"providerPins":{"type":"array","items":{"type":"object","fields":{"subject":{"type":"string","values":["CHAIN","CURRENCY_CHAIN"]},"subjectId":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"pinned":{"type":"boolean"}},"required":["subject","subjectId","pinned"]},"max":10000}},"required":[]},"CHAIN":{"type":"object","fields":{"id":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"providerChainId":{"type":"number","min":1,"max":9007199254740991},"blockchainReference":{"type":"string","min":1,"max":160},"name":{"type":"string","min":1,"max":128},"shortName":{"type":"string","min":1,"max":32},"isEvm":{"type":"boolean"},"logoObjectKey":{"type":"string","min":1,"max":255},"availableFor":{"type":"string","values":["USER","MERCHANT","BOTH"]},"desiredState":{"type":"string","values":["OFF","ON","MAINTAIN"]}},"required":["providerChainId","blockchainReference","name","shortName","isEvm","availableFor"]},"CURRENCY":{"type":"object","fields":{"id":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"symbol":{"type":"string","min":1,"max":32},"name":{"type":"string","min":1,"max":128},"providerRefs":{"type":"array","items":{"type":"object","fields":{"provider":{"type":"string","values":["COINGECKO","ALCHEMY","COINMARKETCAP"]},"providerAssetId":{"type":"string","min":1,"max":160},"providerSymbol":{"type":"string","min":1,"max":32},"network":{"type":"string","min":1,"max":64},"address":{"type":"string","min":1,"max":256}},"required":["provider","providerAssetId","providerSymbol"]},"max":3},"binanceReference":{"type":"string","min":1,"max":64},"logoObjectKey":{"type":"string","min":1,"max":255},"viewEnabled":{"type":"boolean"},"geoCountryDeny":{"type":"array","items":{"type":"string","min":1,"max":2,"pattern":"^[A-Z]{2}$"},"max":249},"geoContinentDeny":{"type":"array","items":{"type":"string","values":["AF","AN","AS","EU","NA","OC","SA"]},"max":7},"accessLevel":{"type":"string","values":["ALL","KYC_L1","KYC_L2"]},"availableFor":{"type":"string","values":["USER","MERCHANT","BOTH"]},"listingKind":{"type":"string","values":["PERMANENT","TIME_LIMITED"]},"listingStartsAt":{"type":"string","min":1,"max":30,"pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"},"showBeforeListing":{"type":"boolean"},"premiumEarlyAccessAt":{"type":"string","min":1,"max":30,"pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"},"premiumOperations":{"type":"array","items":{"type":"string","values":["DEPOSIT","WITHDRAW","EXCHANGE","USER_TRANSFER","SEND_API","STAKE","BANKROLL"]},"max":7},"soEarlyAccessAt":{"type":"string","min":1,"max":30,"pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"},"soOperations":{"type":"array","items":{"type":"string","values":["DEPOSIT","WITHDRAW","EXCHANGE","USER_TRANSFER","SEND_API","STAKE","BANKROLL"]},"max":7},"delistAt":{"type":"string","min":1,"max":30,"pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"},"afterDelistMode":{"type":"string","values":["AUTO_EXCHANGE","LEAVE"]},"autoExchangeToCurrencyId":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"autoExchangeFeeBps":{"type":"number","min":0,"max":10000},"leaveDays":{"type":"number","min":1,"max":9007199254740991},"afterLeaveMode":{"type":"string","values":["LOSS","AUTO_EXCHANGE"]},"afterLeaveAutoExchangeToCurrencyId":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"afterLeaveAutoExchangeFeeBps":{"type":"number","min":0,"max":10000},"postDelistOperations":{"type":"array","items":{"type":"string","values":["WITHDRAW","EXCHANGE"]},"max":2},"desiredState":{"type":"string","values":["OFF","ON","MAINTAIN"]},"maintenanceAudiences":{"type":"array","items":{"type":"string","values":["USER","SO"]},"max":2},"showBalanceInMaintenance":{"type":"object","fields":{"USER":{"type":"boolean"},"SO":{"type":"boolean"}},"required":["USER","SO"]},"bindings":{"type":"array","items":{"type":"object","fields":{"id":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"chainId":{"type":"string","min":1,"max":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"providerCoinId":{"type":"number","min":1,"max":9007199254740991},"blockchainReference":{"type":"string","min":1,"max":160},"isToken":{"type":"boolean"},"tokenContractAddress":{"type":"string","min":1,"max":256},"blockchainPrecision":{"type":"number","min":0,"max":18},"desiredState":{"type":"string","values":["OFF","ON","MAINTAIN"]},"hotWalletAddresses":{"type":"array","items":{"type":"string","min":1,"max":256},"max":10000},"coldWalletAddresses":{"type":"array","items":{"type":"string","min":1,"max":256},"max":10000},"stakingWalletAddresses":{"type":"array","items":{"type":"string","min":1,"max":256},"max":10000}},"required":["chainId","providerCoinId","blockchainReference","isToken","blockchainPrecision","desiredState","hotWalletAddresses","coldWalletAddresses","stakingWalletAddresses"]},"max":100}},"required":["symbol","name","providerRefs","viewEnabled","geoCountryDeny","geoContinentDeny","accessLevel","availableFor","listingKind","showBeforeListing","premiumOperations","soOperations","postDelistOperations","desiredState","maintenanceAudiences","showBalanceInMaintenance","bindings"]}},"PRICE_CONVERSION":{"SETTINGS_REVISION":{"type":"object","fields":{"divergenceThresholdBps":{"type":"number","min":0,"max":10000},"visibleFiatCodes":{"type":"array","items":{"type":"string","values":["AED","ARS","AUD","BDT","BHD","BMD","BRL","CAD","CHF","CLP","CNY","CZK","DKK","EUR","GBP","GEL","HKD","HUF","IDR","ILS","INR","JPY","KRW","KWD","LKR","MMK","MXN","MYR","NGN","NOK","NZD","PHP","PKR","PLN","RUB","SAR","SEK","SGD","THB","TRY","TWD","UAH","USD","VND","ZAR"]},"max":45},"providers":{"type":"object","fields":{"COINGECKO":{"type":"object","fields":{"enabled":{"type":"boolean"},"role":{"type":"string","values":["PRIMARY","COMPARISON","FALLBACK"],"nullable":true},"viewEnabled":{"type":"boolean"},"refreshIntervalSeconds":{"type":"number","min":1,"max":2147483647}},"required":["enabled","role","viewEnabled","refreshIntervalSeconds"]},"ALCHEMY":{"type":"object","fields":{"enabled":{"type":"boolean"},"role":{"type":"string","values":["PRIMARY","COMPARISON","FALLBACK"],"nullable":true},"viewEnabled":{"type":"boolean"},"refreshIntervalSeconds":{"type":"number","min":1,"max":2147483647}},"required":["enabled","role","viewEnabled","refreshIntervalSeconds"]},"COINMARKETCAP":{"type":"object","fields":{"enabled":{"type":"boolean"},"role":{"type":"string","values":["PRIMARY","COMPARISON","FALLBACK"],"nullable":true},"viewEnabled":{"type":"boolean"},"refreshIntervalSeconds":{"type":"number","min":1,"max":2147483647}},"required":["enabled","role","viewEnabled","refreshIntervalSeconds"]}},"required":["COINGECKO","ALCHEMY","COINMARKETCAP"]}},"required":["divergenceThresholdBps","visibleFiatCodes","providers"]}}}$configuration_rules$::jsonb;
BEGIN
  SELECT pg_get_functiondef('admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb)'::regprocedure) INTO STRICT definition;
  IF strpos(definition,'v_configuration_contract')>0 THEN RAISE EXCEPTION 'ADMIN_AUDIT_CONFIGURATION_ALREADY_APPLIED'; END IF;
  original := split_part(definition,marker,2);
  contract := original::jsonb;
  FOR entry IN SELECT value FROM jsonb_array_elements(contract->'actions') LOOP
    IF entry->>'domain'='WALLET_CORE' AND (
      entry->'subjects' = '["SETTINGS_REVISION"]'::jsonb
      OR entry->'actions' ?| ARRAY['CHAIN.CREATED','CHAIN.UPDATED','CHAIN.IMPORTED','CURRENCY.CREATED','CURRENCY.UPDATED','CURRENCY.IMPORTED']
    ) THEN
      entry := jsonb_set(jsonb_set(entry,'{before}',entry->'before'||'["config"]'::jsonb),'{after}',entry->'after'||'["config"]'::jsonb);
    END IF;
    actions := actions || jsonb_build_array(entry);
    IF entry->>'domain'='WALLET_CORE' AND entry->'subjects'='["SETTINGS_REVISION"]'::jsonb THEN
      price := entry || '{"domain":"PRICE_CONVERSION","optionalMetadata":["configChangeId","changelog","safeErrorCode"]}'::jsonb;
      CASE entry->'actions'->>0
        WHEN 'SETTINGS.SAVED' THEN price := price || '{"beforeStatuses":[null,"DRAFT","LIVE"]}'::jsonb;
        WHEN 'SETTINGS.PUSHED' THEN price := price || '{"beforeStatuses":["DRAFT","LIVE"]}'::jsonb;
        WHEN 'SETTINGS.SCHEDULED' THEN price := price || '{"beforeStatuses":["DRAFT","LIVE","SCHEDULED"]}'::jsonb;
        ELSE NULL;
      END CASE;
      actions := actions || jsonb_build_array(price);
    END IF;
  END LOOP;
  contract := jsonb_set(contract,'{actions}',actions);
  contract := jsonb_set(contract,'{validators}',contract->'validators' ||
    '{"configChangeId":{"family":"uuid","nullable":false,"versions":[1,2,3,4,5,6,7,8],"trim":"ASCII","normalize":"lowercase"},"changelog":{"family":"text","nullable":false,"minLength":1,"maxLength":1000,"trim":"ASCII"}}'::jsonb);
  definition := replace(definition,marker||original||marker,marker||contract::text||marker);
  -- Every replacement is a single guarded seam; all previous actor/idempotency/null/history logic remains.
  FOR entry IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('old','  v_hash text;','new','  v_configuration_contract jsonb := $configuration_contract$'||rules::text||'$configuration_contract$::jsonb;
  v_hash text;'),
    jsonb_build_object('old','octet_length(v_before::text) > 65536 OR octet_length(v_after::text) > 65536',
      'new','octet_length(v_before::text) > (CASE WHEN p_domain = ''WALLET_CORE'' AND v_before ? ''config'' THEN 33554432 ELSE 65536 END)
    OR octet_length(v_after::text) > (CASE WHEN p_domain = ''WALLET_CORE'' AND v_after ? ''config'' THEN 33554432 ELSE 65536 END)'),
    jsonb_build_object('old','FROM jsonb_each(v_before) WHERE jsonb_typeof(value) IN (''array'',''object'')',
      'new','FROM jsonb_each(v_before) WHERE key <> ''config'' AND jsonb_typeof(value) IN (''array'',''object'')'),
    jsonb_build_object('old','FROM jsonb_each(v_after) WHERE jsonb_typeof(value) IN (''array'',''object'')',
      'new','FROM jsonb_each(v_after) WHERE key <> ''config'' AND jsonb_typeof(value) IN (''array'',''object'')'),
    jsonb_build_object('old','  IF v_action_contract ? ''beforeStatuses'' AND (',
      'new','  IF p_domain = ''PRICE_CONVERSION'' AND ((p_before_json IS NOT NULL AND NOT (v_before ? ''config'')) OR NOT (v_after ? ''config'')) THEN
    RAISE EXCEPTION ''ADMIN_AUDIT_INPUT_INVALID'' USING ERRCODE = ''22023'';
  END IF;
  IF v_action_contract ? ''beforeStatuses'' AND ('),
    jsonb_build_object('old','    v_validator := v_contract #> ARRAY[''validators'', v_entry.key];',
      'new','    IF v_entry.key = ''config'' AND v_entry.source IN (''before'',''after'') THEN
      IF NOT admin.validate_admin_audit_configuration_node_v1(v_entry.value,v_configuration_contract #> ARRAY[p_domain,p_subject_type]) THEN
        RAISE EXCEPTION ''ADMIN_AUDIT_INPUT_INVALID'' USING ERRCODE = ''22023'';
      END IF;
      CONTINUE;
    END IF;
    v_validator := v_contract #> ARRAY[''validators'', v_entry.key];')
  )) LOOP
    IF (length(definition)-length(replace(definition,entry->>'old',''))) <> length(entry->>'old') THEN
      RAISE EXCEPTION 'ADMIN_AUDIT_CONFIGURATION_CONTRACT_UNEXPECTED';
    END IF;
    definition := replace(definition,entry->>'old',entry->>'new');
  END LOOP;
  EXECUTE definition;
END;
$extension$;

ALTER TABLE admin.admin_audit_events DROP CONSTRAINT admin_audit_events_domain_check;
ALTER TABLE admin.admin_audit_events ADD CONSTRAINT admin_audit_events_domain_check CHECK (domain IN ('WALLET_CORE','DEPOSIT','PRICE_CONVERSION'));
ALTER TABLE admin.admin_audit_events DROP CONSTRAINT admin_audit_events_before_json_check;
ALTER TABLE admin.admin_audit_events DROP CONSTRAINT admin_audit_events_after_json_check;
ALTER TABLE admin.admin_audit_events ADD CONSTRAINT admin_audit_events_before_json_check CHECK (
  before_json IS NULL OR (jsonb_typeof(before_json)='object' AND octet_length(before_json::text)<=
    CASE WHEN domain='WALLET_CORE' AND before_json ? 'config' AND action IN ('SETTINGS.SAVED','SETTINGS.PUSHED','SETTINGS.SCHEDULED','SETTINGS.SCHEDULE_APPLIED','SETTINGS.SCHEDULE_REJECTED','CHAIN.CREATED','CHAIN.UPDATED','CHAIN.IMPORTED','CURRENCY.CREATED','CURRENCY.UPDATED','CURRENCY.IMPORTED') THEN 33554432 ELSE 65536 END));
ALTER TABLE admin.admin_audit_events ADD CONSTRAINT admin_audit_events_after_json_check CHECK (
  after_json IS NULL OR (jsonb_typeof(after_json)='object' AND octet_length(after_json::text)<=
    CASE WHEN domain='WALLET_CORE' AND after_json ? 'config' AND action IN ('SETTINGS.SAVED','SETTINGS.PUSHED','SETTINGS.SCHEDULED','SETTINGS.SCHEDULE_APPLIED','SETTINGS.SCHEDULE_REJECTED','CHAIN.CREATED','CHAIN.UPDATED','CHAIN.IMPORTED','CURRENCY.CREATED','CURRENCY.UPDATED','CURRENCY.IMPORTED') THEN 33554432 ELSE 65536 END));

-- Existing installs already have the Pricing capability role. Fresh installs receive
-- the same narrow grants from the later Wallet capability migration after role creation.
DO $grants$
BEGIN
  IF to_regrole('orebit_price_conversion_writer') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA admin TO orebit_price_conversion_writer;
    GRANT EXECUTE ON FUNCTION admin.append_admin_audit_event_v1(uuid,text,text,text,text,uuid,uuid,uuid,uuid,inet,text,text,text,text,jsonb,jsonb,jsonb) TO orebit_price_conversion_writer;
  END IF;
END;
$grants$;
COMMIT;
