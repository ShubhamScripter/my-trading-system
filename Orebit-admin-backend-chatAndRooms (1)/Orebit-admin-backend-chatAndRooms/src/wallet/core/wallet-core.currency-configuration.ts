import type { CurrencyCatalogueEvidence, WalletCoreClient, WalletCoreSchemaMap,
  WalletEntityChange } from './wallet-core.database.js';
import { walletDbDate, walletDbInteger } from './wallet-core.database.js';
import { WalletConfigurationInvalid } from './wallet-core.errors.js';
import { normalizeCustodyAddressLists } from './wallet-core.policy.js';
import type { CurrencyUpsert } from './wallet-core.types.js';

export const canonicalWalletConfigurationJson = (value: unknown): string => JSON.stringify(
  value, (_key, nested) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right)));
  });

/** Persists one currency, its provider references, bindings and custody lists in caller order. */
export async function applyWalletCurrencyConfiguration(
  client: WalletCoreClient, currency: CurrencyUpsert,
  configurationRevision: number, evidence: readonly CurrencyCatalogueEvidence[],
  chainKinds: ReadonlyMap<string, boolean>, schemas: WalletCoreSchemaMap,
): Promise<readonly WalletEntityChange[]> {
  const wallet = schemas.wallet;
  const price = schemas.price;
    const changes: WalletEntityChange[] = [];
    let bindingBusinessChanged = false;
    const priorBindings: Record<string, unknown>[] = [];
    const importCatalogueRevision = evidence.length === 0 ? undefined : Math.max(...evidence.map((row) => row.revision));
    const beforeResult = await client.query<Record<string, unknown>>(
      `SELECT master.symbol,master.name,master.kind::text,master.pricing_status::text,
              setting.desired_state::text,setting.binance_reference,setting.logo_object_key,
              setting.view_currency_enabled,setting.geo_countries,setting.geo_continents,
              setting.access_level::text,setting.available_for::text,setting.listing_kind::text,
              setting.listing_start_at,setting.delist_at,setting.show_before_listing,
              setting.premium_early_access_at,setting.premium_early_access_ops,
              setting.so_early_access_at,setting.so_early_access_ops,setting.maintain_users,
              setting.maintain_so,setting.show_balance_users,setting.show_balance_so,
              setting.post_delist_ops,setting.after_delist_mode::text,
              setting.auto_exchange_to_currency_id::text,setting.auto_exchange_fee_bps,
              setting.leave_days,setting.after_leave_action::text,
              setting.after_leave_to_currency_id::text,setting.after_leave_fee_bps
       FROM ${price}.currencies master
       LEFT JOIN ${wallet}.currency_settings setting ON setting.currency_id=master.id
       WHERE master.id=$1 FOR UPDATE OF master`, [currency.id],
    );
    const before = beforeResult.rows[0];
    if (before && before.kind !== 'CRYPTO') {
      throw new WalletConfigurationInvalid('Currency holding kind cannot be changed.');
    }
    const storedReferences = (await client.query<Record<string, unknown>>(`SELECT reference.id::text,
      provider.code::text provider,reference.external_id,reference.symbol,reference.network,
      reference.address FROM ${price}.currency_provider_refs reference
      JOIN ${price}.price_providers provider ON provider.id=reference.provider_id
      WHERE reference.currency_id=$1 AND reference.retired_at IS NULL FOR UPDATE OF reference`,
    [currency.id])).rows;
    const incoming = new Map(currency.providerRefs.map((reference) => [reference.provider, reference]));
    const providerIdentityChanged = before !== undefined
      && (before.binance_reference !== (currency.binanceReference ?? null)
        || storedReferences.length !== incoming.size
        || storedReferences.some((stored) => {
          const next = incoming.get(String(stored.provider) as CurrencyUpsert['providerRefs'][number]['provider']);
          return !next || stored.external_id !== next.providerAssetId
            || stored.symbol !== next.providerSymbol || stored.network !== (next.network ?? null)
            || stored.address !== (next.address ?? null);
        }));
    if (providerIdentityChanged
      && (before.desired_state !== 'OFF' || currency.desiredState !== 'OFF')) {
      throw new WalletConfigurationInvalid(
        'Currency provider identity can change only while setup is OFF.',
      );
    }
    await client.query(
      `INSERT INTO ${price}.currencies
       (id,symbol,name,decimals,kind,pricing_status)
       VALUES ($1,$2,$3,18,'CRYPTO','ACTIVE')
       ON CONFLICT (id) DO UPDATE SET symbol=EXCLUDED.symbol,name=EXCLUDED.name,
          updated_at=clock_timestamp()`,
      [currency.id, currency.symbol, currency.name],
    );
    await client.query(
      `INSERT INTO ${wallet}.currency_settings
         (currency_id,binance_reference,logo_object_key,view_currency_enabled,
          geo_countries,geo_continents,access_level,available_for,listing_kind,
          listing_start_at,delist_at,show_before_listing,premium_early_access_at,
          premium_early_access_ops,so_early_access_at,so_early_access_ops,desired_state,
          maintain_users,maintain_so,show_balance_users,show_balance_so,post_delist_ops,
          after_delist_mode,auto_exchange_to_currency_id,auto_exchange_fee_bps,
          leave_days,after_leave_action,after_leave_to_currency_id,after_leave_fee_bps,
          policy_revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
         $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
       ON CONFLICT (currency_id) DO UPDATE SET binance_reference=EXCLUDED.binance_reference,
         logo_object_key=EXCLUDED.logo_object_key,view_currency_enabled=EXCLUDED.view_currency_enabled,
         geo_countries=EXCLUDED.geo_countries,geo_continents=EXCLUDED.geo_continents,
         access_level=EXCLUDED.access_level,available_for=EXCLUDED.available_for,
         listing_kind=EXCLUDED.listing_kind,listing_start_at=EXCLUDED.listing_start_at,
         delist_at=EXCLUDED.delist_at,show_before_listing=EXCLUDED.show_before_listing,
         premium_early_access_at=EXCLUDED.premium_early_access_at,
         premium_early_access_ops=EXCLUDED.premium_early_access_ops,
         so_early_access_at=EXCLUDED.so_early_access_at,so_early_access_ops=EXCLUDED.so_early_access_ops,
         desired_state=EXCLUDED.desired_state,maintain_users=EXCLUDED.maintain_users,
         maintain_so=EXCLUDED.maintain_so,show_balance_users=EXCLUDED.show_balance_users,
         show_balance_so=EXCLUDED.show_balance_so,post_delist_ops=EXCLUDED.post_delist_ops,
         after_delist_mode=EXCLUDED.after_delist_mode,
         auto_exchange_to_currency_id=EXCLUDED.auto_exchange_to_currency_id,
         auto_exchange_fee_bps=EXCLUDED.auto_exchange_fee_bps,leave_days=EXCLUDED.leave_days,
         after_leave_action=EXCLUDED.after_leave_action,
         after_leave_to_currency_id=EXCLUDED.after_leave_to_currency_id,
         after_leave_fee_bps=EXCLUDED.after_leave_fee_bps,
         policy_revision=EXCLUDED.policy_revision,updated_at=clock_timestamp()`,
      [currency.id, currency.binanceReference ?? null, currency.logoObjectKey ?? null,
        currency.viewEnabled, currency.geoCountryDeny, currency.geoContinentDeny,
        currency.accessLevel, currency.availableFor, currency.listingKind,
        currency.listingStartsAt ?? null, currency.delistAt ?? null, currency.showBeforeListing,
        currency.premiumEarlyAccessAt ?? null, currency.premiumOperations,
        currency.soEarlyAccessAt ?? null, currency.soOperations, currency.desiredState,
        currency.maintenanceAudiences.includes('USER'),
        currency.maintenanceAudiences.includes('SO'),
        currency.showBalanceInMaintenance.USER, currency.showBalanceInMaintenance.SO,
        currency.postDelistOperations, currency.afterDelistMode ?? null,
        currency.autoExchangeToCurrencyId ?? null, currency.autoExchangeFeeBps ?? null,
        currency.leaveDays ?? null, currency.afterLeaveMode ?? null,
        currency.afterLeaveAutoExchangeToCurrencyId ?? null,
        currency.afterLeaveAutoExchangeFeeBps ?? null, configurationRevision],
    );
    for (const stored of storedReferences) {
      const next = incoming.get(String(stored.provider) as CurrencyUpsert['providerRefs'][number]['provider']);
      if (next && stored.external_id === next.providerAssetId
        && stored.symbol === next.providerSymbol && stored.network === (next.network ?? null)
        && stored.address === (next.address ?? null)) {
        incoming.delete(next.provider);
        continue;
      }
      const retired = await client.query(`UPDATE ${price}.currency_provider_refs SET
        active=false,retired_at=clock_timestamp() WHERE id=$1 AND retired_at IS NULL`, [stored.id]);
      if (retired.rowCount !== 1) throw new Error('WALLET_PRICE_PROVIDER_REFERENCE_CONFLICT');
    }
    for (const reference of incoming.values()) {
      const inserted = await client.query(
        `INSERT INTO ${price}.currency_provider_refs
           (currency_id,provider_id,external_id,symbol,network,address)
         SELECT $1,id,$3,$4,$5,$6 FROM ${price}.price_providers WHERE code::text=$2`,
        [currency.id, reference.provider, reference.providerAssetId, reference.providerSymbol,
          reference.network ?? null, reference.address ?? null],
      );
      if (inserted.rowCount !== 1) throw new Error('WALLET_PRICE_PROVIDER_NOT_FOUND');
    }
    for (const [bindingIndex, binding] of currency.bindings.entries()) {
      const verified = evidence[bindingIndex];
      if (!verified) throw new WalletConfigurationInvalid('Provider catalogue reference unavailable.');
      const isEvm = chainKinds.get(binding.chainId)!;
      // Partial currency patches omit chains, so normalize against the authoritative stored kind.
      let addresses;
      try { addresses = normalizeCustodyAddressLists({ ...binding, isEvm }); }
      catch { throw new WalletConfigurationInvalid('Custody address configuration is invalid.'); }
      const existing = await client.query<Record<string, unknown>>(
        `SELECT currency_id::text,chain_id::text,provider_coin_id,blockchain_reference,
                is_token,is_native,
                token_contract_address,blockchain_precision,desired_state::text,provider_state::text
         FROM ${wallet}.currencies WHERE id=$1 FOR UPDATE`, [binding.id],
      );
      const prior = existing.rows[0];
      if (prior && (prior.currency_id !== currency.id || prior.chain_id !== binding.chainId)) {
        throw new WalletConfigurationInvalid('Currency-chain binding identity cannot change.');
      }
      const bindingIdentityChanged = prior !== undefined
        && (walletDbInteger(prior.provider_coin_id) !== binding.providerCoinId
          || prior.blockchain_reference !== binding.blockchainReference
          || prior.is_token !== binding.isToken || prior.is_native !== !binding.isToken
          || prior.token_contract_address !== (binding.tokenContractAddress ?? null));
      if (bindingIdentityChanged
        && (prior.desired_state !== 'OFF' || binding.desiredState !== 'OFF')) {
        throw new WalletConfigurationInvalid(
          'Currency-chain identity can change only while setup is OFF.',
        );
      }
      if (!prior || bindingIdentityChanged
        || walletDbInteger(prior.blockchain_precision, true) !== binding.blockchainPrecision) {
        bindingBusinessChanged = true;
      }
      await client.query(
        `INSERT INTO ${wallet}.currencies
           (id,currency_id,chain_id,provider_coin_id,blockchain_reference,is_token,is_native,
            token_contract_address,blockchain_precision,desired_state,provider_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET provider_coin_id=EXCLUDED.provider_coin_id,
           blockchain_reference=EXCLUDED.blockchain_reference,
           is_token=EXCLUDED.is_token,is_native=EXCLUDED.is_native,
           token_contract_address=EXCLUDED.token_contract_address,
           desired_state=EXCLUDED.desired_state,
           blockchain_precision=EXCLUDED.blockchain_precision,
           provider_state=EXCLUDED.provider_state,updated_at=clock_timestamp()`,
        [binding.id, currency.id, binding.chainId, binding.providerCoinId,
          binding.blockchainReference,
          binding.isToken, !binding.isToken, binding.tokenContractAddress ?? null,
          binding.blockchainPrecision, binding.desiredState, verified.providerState],
      );
      if (prior && (prior.desired_state !== binding.desiredState
        || prior.provider_state !== verified.providerState)) changes.push({
        action: 'CURRENCY.STATUS_CHANGED', subject: { type: 'CURRENCY_CHAIN', id: binding.id! },
        before: { desiredState: String(prior.desired_state),
          effectiveState: prior.provider_state === 'ACTIVATED'
            ? String(prior.desired_state) : 'MAINTAIN' },
        after: { desiredState: binding.desiredState,
          effectiveState: verified.providerState === 'ACTIVATED'
            ? binding.desiredState : 'MAINTAIN' },
      });
      const currentAddresses = (await client.query<{ kind: unknown; wallet_address: unknown }>(
        `SELECT kind::text,wallet_address FROM ${wallet}.custody_addresses
         WHERE currency_chain_id=$1 AND retired_at IS NULL ORDER BY kind,wallet_address`,
      [binding.id])).rows;
      const desiredAddresses = ([['HOT', addresses.hotWalletAddresses],
        ['COLD', addresses.coldWalletAddresses], ['STAKING', addresses.stakingWalletAddresses]] as const)
        .flatMap(([kind, values]) => values.map((walletAddress) => ({ kind, walletAddress })));
      const desiredAddressSet = new Set(desiredAddresses.map(({ kind, walletAddress }) =>
        JSON.stringify([kind, walletAddress])));
      if (prior) {
        const list = (kind: string) => currentAddresses.filter((row) => row.kind === kind)
          .map((row) => String(row.wallet_address));
        priorBindings.push({ id: binding.id, chainId: String(prior.chain_id),
          providerCoinId: walletDbInteger(prior.provider_coin_id),
          blockchainReference: String(prior.blockchain_reference),
          isToken: prior.is_token,
          ...(prior.token_contract_address === null
            ? {} : { tokenContractAddress: prior.token_contract_address }),
          blockchainPrecision: walletDbInteger(prior.blockchain_precision, true),
          desiredState: String(prior.desired_state), hotWalletAddresses: list('HOT'),
          coldWalletAddresses: list('COLD'), stakingWalletAddresses: list('STAKING') });
      }
      const addressesChanged = currentAddresses.length !== desiredAddresses.length
        || currentAddresses.some(row => !desiredAddressSet.has(JSON.stringify([row.kind, row.wallet_address])));
      if (addressesChanged) {
        bindingBusinessChanged = true;
        await client.query(`UPDATE ${wallet}.custody_addresses SET retired_revision=$2,
          retired_at=clock_timestamp() WHERE currency_chain_id=$1 AND retired_at IS NULL`, [binding.id, configurationRevision]);
        for (const [kind, values] of [['HOT', addresses.hotWalletAddresses], ['COLD', addresses.coldWalletAddresses], ['STAKING', addresses.stakingWalletAddresses]] as const) {
          const stored = [...values]; if (stored.length === 0) continue;
          const inserted = await client.query(`INSERT INTO ${wallet}.custody_addresses
            (currency_chain_id,kind,wallet_address,address_identity,created_revision) SELECT $1,$2,entry.wallet_address,entry.address_identity,$5 FROM unnest($3::text[],$4::text[])
            WITH ORDINALITY entry(wallet_address,address_identity,ordinal) ORDER BY entry.ordinal`,
          [binding.id, kind, stored, stored.map((address) => isEvm ? address.toLowerCase() : address), configurationRevision]);
          if (inserted.rowCount !== stored.length) throw new Error('WALLET_CUSTODY_INSERT_FAILED');
        }
      }
    }
    const storedProviderRefs = storedReferences.map((row) => ({ provider: row.provider,
      providerAssetId: row.external_id, providerSymbol: row.symbol,
      ...(row.network === null ? {} : { network: row.network }),
      ...(row.address === null ? {} : { address: row.address }) }))
      .sort((left, right) => String(left.provider).localeCompare(String(right.provider)));
    const requestedProviderRefs = [...currency.providerRefs]
      .sort((left, right) => left.provider.localeCompare(right.provider));
    const currentTopLevel = before ? { id: currency.id, symbol: String(before.symbol),
      name: String(before.name), providerRefs: storedProviderRefs,
      ...(before.binance_reference === null ? {} : { binanceReference: before.binance_reference }),
      ...(before.logo_object_key === null ? {} : { logoObjectKey: before.logo_object_key }),
      viewEnabled: before.view_currency_enabled,
      geoCountryDeny: [...(before.geo_countries as string[])].sort(),
      geoContinentDeny: [...(before.geo_continents as string[])].sort(),
      accessLevel: before.access_level,
      availableFor: before.available_for, listingKind: before.listing_kind,
      ...(before.listing_start_at === null ? {} : { listingStartsAt: walletDbDate(before.listing_start_at)?.toISOString() }),
      showBeforeListing: before.show_before_listing,
      ...(before.premium_early_access_at === null ? {} : { premiumEarlyAccessAt: walletDbDate(before.premium_early_access_at)?.toISOString() }),
      premiumOperations: [...(before.premium_early_access_ops as string[])].sort(),
      ...(before.so_early_access_at === null ? {} : { soEarlyAccessAt: walletDbDate(before.so_early_access_at)?.toISOString() }),
      soOperations: [...(before.so_early_access_ops as string[])].sort(),
      ...(before.delist_at === null ? {} : { delistAt: walletDbDate(before.delist_at)?.toISOString() }),
      ...(before.after_delist_mode === null ? {} : { afterDelistMode: before.after_delist_mode }),
      ...(before.auto_exchange_to_currency_id === null ? {} : { autoExchangeToCurrencyId: before.auto_exchange_to_currency_id }),
      ...(before.auto_exchange_fee_bps === null ? {} : { autoExchangeFeeBps: before.auto_exchange_fee_bps }),
      ...(before.leave_days === null ? {} : { leaveDays: before.leave_days }),
      ...(before.after_leave_action === null ? {} : { afterLeaveMode: before.after_leave_action }),
      ...(before.after_leave_to_currency_id === null ? {} : { afterLeaveAutoExchangeToCurrencyId: before.after_leave_to_currency_id }),
      ...(before.after_leave_fee_bps === null ? {} : { afterLeaveAutoExchangeFeeBps: before.after_leave_fee_bps }),
      postDelistOperations: [...(before.post_delist_ops as string[])].sort(),
      desiredState: before.desired_state,
      maintenanceAudiences: [...(before.maintain_users ? ['USER'] : []),
        ...(before.maintain_so ? ['SO'] : [])].sort(),
      showBalanceInMaintenance: { USER: before.show_balance_users, SO: before.show_balance_so } } : null;
    const beforeProjection = before ? { symbol: String(before.symbol), name: String(before.name),
      kind: 'CRYPTO', pricingStatus: String(before.pricing_status),
      desiredState: String(before.desired_state),
      ...(typeof before.logo_object_key === 'string' ? { logoObjectKey: before.logo_object_key } : {}),
      config: { ...currentTopLevel, bindings: priorBindings } } : null;
    const afterProjection = { symbol: currency.symbol, name: currency.name,
      kind: 'CRYPTO', pricingStatus: before ? String(before.pricing_status) : 'ACTIVE',
      desiredState: currency.desiredState,
      ...(currency.logoObjectKey ? { logoObjectKey: currency.logoObjectKey } : {}),
      config: currency };
    const { bindings: _requestedBindings, ...requestedTopLevelRaw } = currency;
    const requestedTopLevel = { ...requestedTopLevelRaw, providerRefs: requestedProviderRefs,
      geoCountryDeny: [...currency.geoCountryDeny].sort(),
      geoContinentDeny: [...currency.geoContinentDeny].sort(),
      premiumOperations: [...currency.premiumOperations].sort(),
      soOperations: [...currency.soOperations].sort(),
      postDelistOperations: [...currency.postDelistOperations].sort(),
      maintenanceAudiences: [...currency.maintenanceAudiences].sort() };
    const scalarChanged = !before
      || canonicalWalletConfigurationJson(currentTopLevel) !== canonicalWalletConfigurationJson(requestedTopLevel);
    if (scalarChanged || bindingBusinessChanged) changes.unshift({
      action: before ? 'CURRENCY.UPDATED' : 'CURRENCY.IMPORTED',
      subject: { type: 'CURRENCY', id: currency.id! },
      before: beforeProjection,
      after: afterProjection,
      importCatalogueRevision,
    });
    if (before && before.desired_state !== currency.desiredState) changes.push({
      action: 'CURRENCY.STATUS_CHANGED', subject: { type: 'CURRENCY', id: currency.id! },
      before: { desiredState: String(before.desired_state) },
      after: { desiredState: currency.desiredState },
    });
    return changes;
}
