import { decodeWalletQueryCursor, encodeWalletQueryCursor } from './wallet-core.cursor.js';
import { allowed, BOOTSTRAP_SEARCH as SEARCH, BOOTSTRAP_UUID as UUID, boolean, count, exactKeys, fingerprint, health,
  instant, logo, optionalInstant, optionalText, strings, text, timestamp, validLimit,
  WalletCoreBootstrapPages, type BootstrapRow as Row } from './wallet-core.bootstrap-pages.js';
import { formatReconciliationLedgerView } from './reconciliation-ledger-view.js';
import { reconciliationAnomalySql,
  reconciliationComponentCountSql } from './wallet-core.reconciliation-evidence-query.js';
import type { WalletCoreClient, WalletCoreDatabase } from './wallet-core.database.js';
import { WalletConfigurationInvalid } from './wallet-core.errors.js';
import { formatReconciliationPercentage, normalizeReconciliationAlertPercent,
  resolveWalletEffectiveState, truncateApiCrypto, truncateApiFiat,
  truncateApiPercentage } from './wallet-core.policy.js';
import type { AdminBootstrapQuery, AdminBootstrapViewerInput, AdminChainQuery,
  AdminReconciliationDistribution,
  AdminReconciliationItemSummary, AdminReconciliationSnapshot,
  AdminWalletBinding, AdminWalletBootstrap, AdminWalletChain, AdminWalletCurrency,
  ReconciliationComponentCount, ReconciliationComponentEvidence,
  WalletDistributionBucket, WalletLogoUrlResolver,
  WalletPriceProvenanceView } from './wallet-core.types.js';
function rowsBy(rows: readonly Row[], key: string): ReadonlyMap<string, readonly Row[]> {
  const grouped = new Map<string, Row[]>(); for (const row of rows) { const id = String(row[key]);
    const values = grouped.get(id) ?? []; values.push(row); grouped.set(id, values); } return grouped;
}

const emptyCounts = (): Record<'HOT' | 'COLD' | 'STAKING' | 'BINANCE', ReconciliationComponentCount> => ({
  HOT: { total: 0, succeeded: 0, failed: 0 }, COLD: { total: 0, succeeded: 0, failed: 0 },
  STAKING: { total: 0, succeeded: 0, failed: 0 }, BINANCE: { total: 0, succeeded: 0, failed: 0 },
});
function mapComponent(row: Row): ReconciliationComponentEvidence {
  return { id: text(row.id), kind: allowed(row.kind, ['HOT', 'COLD', 'STAKING', 'BINANCE']),
    currencyChainId: optionalText(row.currency_chain_id), custodyAddressId: optionalText(row.custody_address_id),
    walletAddress: optionalText(row.wallet_address), binanceReference: optionalText(row.binance_reference),
    attemptsUsed: count(row.attempts_used), acceptedRawDecimal: optionalText(row.accepted_raw_decimal),
    selectedBalance: optionalText(row.selected_balance), safeErrorCode: optionalText(row.safe_error_code),
    totalAdminStakeBalance: optionalText(row.total_admin_stake_balance),
    totalAdminManualStakeBalance: optionalText(row.total_admin_manual_stake_balance),
    totalBalance: optionalText(row.total_balance), stakeSelectedSource: row.stake_selected_source === null
      ? null : allowed(row.stake_selected_source, ['REPORTED_TOTAL', 'COMPONENT_SUM'] as const),
    stakeTotalMismatch: boolean(row.stake_total_mismatch) };
}
const price = (row: Row): WalletPriceProvenanceView | null => row.price_resolution_id === null ? null : ({
  resolutionId: text(row.price_resolution_id), snapshotId: text(row.price_snapshot_id),
  provider: allowed(row.price_provider, ['COINGECKO', 'ALCHEMY', 'COINMARKETCAP']),
  priceUsd: truncateApiFiat(text(row.price_usd)), observedAt: instant(row.price_observed_at),
  resolutionReason: text(row.price_resolution_reason), usedFallback: boolean(row.price_used_fallback),
});
const bucket = (amount: string, usd: string | null, denominator: string,
  complete: boolean, priced: boolean): WalletDistributionBucket => ({
  cryptoAmount: truncateApiCrypto(amount), usdValue: complete && priced && usd ? truncateApiFiat(usd) : null,
  percentage: complete && priced ? formatReconciliationPercentage(amount, denominator) : null, complete,
});
/** Builds one transactionally consistent Admin bootstrap read model from Wallet evidence. */
export class WalletCoreBootstrapRepository {
  private readonly pages: WalletCoreBootstrapPages;
  constructor(private readonly database: WalletCoreDatabase,
    private readonly logoResolver: WalletLogoUrlResolver) {
    this.pages = new WalletCoreBootstrapPages(database, logoResolver);
  }

  async bootstrap(input: AdminBootstrapQuery,
    viewer: AdminBootstrapViewerInput): Promise<AdminWalletBootstrap> {
    const limit = input.limit ?? 50;
    const sortBy = input.sortBy ?? 'symbol'; const sortDirection = input.sortDirection ?? 'asc';
    const queryShape = { ...input, sortBy, sortDirection };
    const cursor = input.cursor === undefined ? null : decodeWalletQueryCursor(input.cursor,
      'CURRENCY', fingerprint(queryShape, ['search', 'state', 'chainId', 'sortBy', 'sortDirection']), 2);
    const scheduledLimit = input.scheduledLimit ?? 50;
    const activeAlertLimit = input.activeAlertLimit ?? 50;
    const allowedKeys = ['search', 'state', 'chainId', 'sortBy', 'sortDirection', 'cursor', 'limit',
      'scheduledCursor', 'scheduledLimit', 'activeAlertCursor', 'activeAlertLimit'];
    if (Object.keys(input).some((key) => !allowedKeys.includes(key))
      || !exactKeys(viewer, ['adminId'])
      || !validLimit(limit) || !validLimit(scheduledLimit) || !validLimit(activeAlertLimit)
      || (input.search !== undefined && (!SEARCH.test(input.search) || input.search !== input.search.trim()))
      || (input.state !== undefined && !['OFF', 'ON', 'MAINTAIN', 'UPCOMING', 'DELISTED'].includes(input.state))
      || (input.chainId !== undefined && !UUID.test(input.chainId))
      || !['symbol', 'name', 'state'].includes(sortBy)
      || !['asc', 'desc'].includes(sortDirection)
      || (input.cursor !== undefined && cursor === null)
      || !UUID.test(viewer.adminId)) {
      throw new WalletConfigurationInvalid('Invalid Wallet bootstrap query.');
    }
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const settingsRow = (await client.query<Row>(`SELECT revision::text,
        global_desired_state::text,catalogue_mode::text,include_treasury,include_collection,
        reconciliation_alert_percent::text,reconciliation_alert_basis::text,
        default_currency_ids::text[],${timestamp('updated_at')} updated_at
        FROM ${this.database.schemas.wallet}.wallet_settings WHERE id`)).rows[0];
      if (!settingsRow) throw new Error('WALLET_SETTINGS_ROW_MISSING');
      const settings = { globalDesiredState: allowed(settingsRow.global_desired_state, ['OFF', 'ON', 'MAINTAIN']),
        catalogueMode: allowed(settingsRow.catalogue_mode, ['ALL', 'RELEVANT']),
        reconciliationIncludeTreasury: boolean(settingsRow.include_treasury),
        reconciliationIncludeCollection: boolean(settingsRow.include_collection),
        reconciliationAlertPercent: normalizeReconciliationAlertPercent(
          text(settingsRow.reconciliation_alert_percent)).reconciliationAlertPercent,
        reconciliationAlertBasis: allowed(settingsRow.reconciliation_alert_basis, ['SIGNED', 'POSITIVE_ONLY']),
        defaultCurrencyIds: strings(settingsRow.default_currency_ids),
        updatedAt: instant(settingsRow.updated_at) };
      const configuration = await this.pages.configurations(client, input.scheduledCursor,
        scheduledLimit);
      const chains = await this.pages.chains(client, settings.globalDesiredState);
      const currencyResult = await client.query<Row>(this.pages.currencySql(sortBy, sortDirection), [
        input.search ?? null, input.state ?? null, input.chainId ?? null,
        cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1]);
      const pageRows = currencyResult.rows.slice(0, limit);
      const currencyIds = pageRows.map((row) => text(row.id));
      const [refs, bindings, addresses] = await this.currencyChildren(client, currencyIds);
      const chainIndex = new Map(chains.map((chain) => [chain.id, chain])); const refIndex = rowsBy(refs, 'currency_id'); const bindingIndex = rowsBy(bindings, 'currency_id');
      const addressIndex = rowsBy(addresses, 'currency_chain_id');
      const currencies = pageRows.map((row) => this.mapCurrency(row, chainIndex,
        refIndex, bindingIndex, addressIndex, settings.globalDesiredState));
      const last = currencies.at(-1); const extra = currencyResult.rows.length > limit;
      const activeAlerts = await this.pages.activeAlerts(client, input.activeAlertCursor,
        activeAlertLimit);
      const lastReconciliation = await this.reconciliation(client, currencyIds);
      const timezone = (await client.query<Row>(`SELECT timezone FROM
        ${this.database.schemas.wallet}.admin_preferences WHERE admin_id=$1`, [viewer.adminId])).rows[0];
      return { currentRevision: text(settingsRow.revision), settings, configuration, chains,
        currencies: { items: currencies, nextCursor: extra && last
          ? encodeWalletQueryCursor('CURRENCY', fingerprint(queryShape,
            ['search', 'state', 'chainId', 'sortBy', 'sortDirection']),
          [sortBy === 'state' ? last.effectiveState : last[sortBy], last.id]) : null },
        activeAlerts, lastReconciliation,
        viewer: { displayTimezone: timezone ? text(timezone.timezone) : 'Asia/Kolkata' } };
    });
  }

  async chainPage(input: AdminChainQuery) {
    return this.pages.chainPage(input);
  }

  private async currencyChildren(client: WalletCoreClient, currencyIds: string[]) {
    const priceSchema = this.database.schemas.price; const wallet = this.database.schemas.wallet;
    const refs = (await client.query<Row>(`SELECT reference.id::text,reference.currency_id::text,
      provider.code::text provider,reference.external_id,reference.symbol,reference.network,
      reference.address FROM ${priceSchema}.currency_provider_refs reference
      JOIN ${priceSchema}.price_providers provider ON provider.id=reference.provider_id
      WHERE reference.currency_id=ANY($1::uuid[]) AND reference.active
        AND reference.retired_at IS NULL
      ORDER BY provider.code::text,reference.id`, [currencyIds])).rows;
    const bindings = (await client.query<Row>(`SELECT binding.id::text,binding.currency_id::text,
      binding.chain_id::text,chain.short_name,binding.provider_coin_id::text,
      binding.blockchain_reference,binding.is_token,
      binding.token_contract_address,binding.blockchain_precision,binding.desired_state::text,
      binding.maintenance_pinned,binding.provider_state::text,binding.consecutive_failed_checks,
      ${timestamp('binding.last_success_at')} last_success_at,
      ${timestamp('binding.last_error_at')} last_error_at,
      ${timestamp('binding.provider_updated_at')} provider_updated_at
      FROM ${wallet}.currencies binding JOIN ${wallet}.chains chain ON chain.id=binding.chain_id
      WHERE binding.currency_id=ANY($1::uuid[]) ORDER BY chain.short_name,binding.id`,
    [currencyIds])).rows;
    const bindingIds = bindings.map((row) => text(row.id));
    const addresses = (await client.query<Row>(`SELECT currency_chain_id::text,kind::text,wallet_address
      FROM ${wallet}.custody_addresses WHERE currency_chain_id=ANY($1::uuid[]) AND retired_at IS NULL
      ORDER BY kind,wallet_address,id`, [bindingIds])).rows;
    return [refs, bindings, addresses] as const;
  }

  private mapCurrency(row: Row, chains: ReadonlyMap<string, AdminWalletChain>,
    refs: ReadonlyMap<string, readonly Row[]>, bindings: ReadonlyMap<string, readonly Row[]>,
    addresses: ReadonlyMap<string, readonly Row[]>,
    global: 'OFF' | 'ON' | 'MAINTAIN'): AdminWalletCurrency {
    const id = text(row.id); const decimals = count(row.decimals);
    if (decimals !== 18) throw new Error('WALLET_BOOTSTRAP_ROW_INVALID');
    const desiredState = allowed(row.desired_state, ['OFF', 'ON', 'MAINTAIN']);
    const listingState = allowed(row.listing_state, ['LISTED', 'UPCOMING_VISIBLE', 'UPCOMING_HIDDEN']);
    const readiness = allowed(row.price_readiness, ['HEALTHY', 'UNAVAILABLE']);
    const completedDelist = boolean(row.completed_delist);
    const mappedBindings = (bindings.get(id) ?? []).map((entry): AdminWalletBinding => {
      const chain = chains.get(text(entry.chain_id));
      if (!chain) throw new Error('WALLET_BOOTSTRAP_ROW_INVALID');
      const bindingDesired = allowed(entry.desired_state, ['OFF', 'ON', 'MAINTAIN']);
      const provider = health(entry); const chainProvider = chain.provider.state;
      const list = (kind: string) => (addresses.get(text(entry.id)) ?? []).filter((address) =>
        address.kind === kind)
        .map((address) => text(address.wallet_address));
      return { id: text(entry.id), chainId: chain.id, chainShortName: chain.shortName,
        providerCoinId: text(entry.provider_coin_id),
        blockchainReference: text(entry.blockchain_reference), isToken: boolean(entry.is_token),
        tokenContractAddress: optionalText(entry.token_contract_address), blockchainPrecision: count(
          entry.blockchain_precision), desiredState: bindingDesired,
        effectiveState: resolveWalletEffectiveState({ completedDelist, globalDesiredState: global,
          chainDesiredState: chain.desiredState, currencyDesiredState: desiredState,
          bindingDesiredState: bindingDesired, listingState,
          providerState: chainProvider === 'ACTIVATED' && provider.state === 'ACTIVATED'
            ? 'ACTIVATED' : chainProvider === 'ACTIVATED' ? provider.state : chainProvider,
          providerPinned: chain.maintenancePinned || boolean(entry.maintenance_pinned), priceReadiness: readiness }),
        maintenancePinned: boolean(entry.maintenance_pinned), provider,
        hotWalletAddresses: list('HOT'), coldWalletAddresses: list('COLD'),
        stakingWalletAddresses: list('STAKING') };
    });
    return { id, symbol: text(row.symbol), name: text(row.name), decimals: 18,
      pricingStatus: allowed(row.pricing_status, ['ACTIVE', 'DISABLED']),
      pricingAutoDisabled: boolean(row.auto_disabled), providerReferences: (refs.get(id) ?? []).map((ref) => ({ provider: allowed(ref.provider,
        ['COINGECKO', 'ALCHEMY', 'COINMARKETCAP']), providerAssetId: text(ref.external_id),
        providerSymbol: text(ref.symbol), ...(ref.network === null ? {} : { network: text(ref.network) }),
        ...(ref.address === null ? {} : { address: text(ref.address) }) })),
      binanceReference: optionalText(row.binance_reference), logo: logo(row.logo_object_key, this.logoResolver),
      viewEnabled: boolean(row.view_currency_enabled), geoCountryDeny: strings(row.geo_countries),
      geoContinentDeny: strings(row.geo_continents),
      accessLevel: allowed(row.access_level, ['ALL', 'KYC_L1', 'KYC_L2']),
      availableFor: allowed(row.available_for, ['USER', 'MERCHANT', 'BOTH']),
      listingKind: allowed(row.listing_kind, ['PERMANENT', 'TIME_LIMITED']),
      listingStartsAt: optionalInstant(row.listing_start_at),
      showBeforeListing: boolean(row.show_before_listing),
      premiumEarlyAccessAt: optionalInstant(row.premium_early_access_at),
      premiumOperations: strings(row.premium_early_access_ops) as never,
      soEarlyAccessAt: optionalInstant(row.so_early_access_at),
      soOperations: strings(row.so_early_access_ops) as never,
      delistAt: optionalInstant(row.delist_at), afterDelistMode: row.after_delist_mode === null
        ? null : allowed(row.after_delist_mode, ['AUTO_EXCHANGE', 'LEAVE'] as const),
      autoExchangeToCurrencyId: optionalText(row.auto_exchange_to_currency_id),
      autoExchangeFeeBps: row.auto_exchange_fee_bps === null ? null : count(row.auto_exchange_fee_bps),
      leaveDays: row.leave_days === null ? null : count(row.leave_days),
      afterLeaveMode: row.after_leave_action === null ? null
        : allowed(row.after_leave_action, ['LOSS', 'AUTO_EXCHANGE'] as const),
      afterLeaveAutoExchangeToCurrencyId: optionalText(row.after_leave_to_currency_id),
      afterLeaveAutoExchangeFeeBps: row.after_leave_fee_bps === null ? null
        : count(row.after_leave_fee_bps), postDelistOperations: strings(row.post_delist_ops) as never,
      desiredState, effectiveState: resolveWalletEffectiveState({ completedDelist,
        globalDesiredState: global, chainDesiredState: 'ON', currencyDesiredState: desiredState,
        bindingDesiredState: 'ON', listingState, providerState: 'ACTIVATED',
        providerPinned: false, priceReadiness: readiness }),
      maintenanceAudiences: [...(boolean(row.maintain_users) ? ['USER' as const] : []),
        ...(boolean(row.maintain_so) ? ['SO' as const] : [])],
      showBalanceInMaintenance: { USER: boolean(row.show_balance_users),
        SO: boolean(row.show_balance_so) },
      price: { readiness, changedAt: optionalInstant(row.price_readiness_changed_at) },
      bindings: mappedBindings };
  }

  private async reconciliation(client: WalletCoreClient,
    currencyIds: string[]): Promise<AdminReconciliationSnapshot | null> {
    const wallet = this.database.schemas.wallet;
    const run = (await client.query<Row>(`SELECT id::text,status::text,
      ${timestamp('scheduled_for')} scheduled_for,${timestamp('valuation_at')} valuation_at,
      ${timestamp('completed_at')} completed_at,applied_configuration_revision::text,
      applied_reconciliation_alert_percent::text,comparison_rule,currency_count,warning_count,
      safe_error_code,applied_reconciliation_alert_basis::text FROM ${wallet}.wallet_reconciliation_runs
      WHERE status IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1`)).rows[0];
    if (!run) return null;
    const rows = (await client.query<Row>(`SELECT item.*,item.id::text,item.currency_id::text,
      item.status::text,item.price_provider::text,item.price_resolution_reason::text,
      item.hot_cold_balance::text,item.staking_balance::text,item.binance_balance::text,
      item.total_custody_balance::text,item.required_backing::text,item.user_merchant_balance::text,
      item.treasury_balance::text,item.collection_balance::text,item.ledger_signed_total::text,
      item.ledger_positive_total::text,item.applied_reconciliation_alert_basis::text,item.shortfall_percent::text,
      item.price_usd::text,${timestamp('item.price_observed_at')} price_observed_at,master.symbol,
      (item.hot_cold_balance*item.price_usd)::text hot_usd,
      (item.staking_balance*item.price_usd)::text staking_usd,
      (item.binance_balance*item.price_usd)::text binance_usd,
      (item.total_custody_balance*item.price_usd)::text total_usd,
      sum(item.hot_cold_balance*item.price_usd) OVER()::text overall_hot_usd,
      sum(item.staking_balance*item.price_usd) OVER()::text overall_staking_usd,
      sum(item.binance_balance*item.price_usd) OVER()::text overall_binance_usd,
      sum(item.total_custody_balance*item.price_usd) OVER()::text overall_total_usd,
      (SELECT count(*) FROM ${wallet}.wallet_reconciliation_components component
        WHERE component.run_item_id=item.id AND component.selected_balance IS NOT NULL)
        successful_components FROM ${wallet}.wallet_reconciliation_items item
      JOIN ${this.database.schemas.price}.currencies master ON master.id=item.currency_id
      WHERE item.run_id=$1 ORDER BY item.currency_id,item.id`, [run.id])).rows;
    const pageRows = rows.filter((row) => currencyIds.includes(text(row.currency_id)));
    const itemIds = pageRows.map((row) => text(row.id));
    const counts = (await client.query<Row>(reconciliationComponentCountSql(wallet), [itemIds])).rows;
    const components = (await client.query<Row>(reconciliationAnomalySql(wallet), [itemIds])).rows;
    return { run: { id: text(run.id), status: allowed(run.status, ['SUCCESS', 'PARTIAL', 'FAILED']),
      scheduledFor: instant(run.scheduled_for), valuationAt: instant(run.valuation_at),
      completedAt: optionalInstant(run.completed_at),
      appliedConfigurationRevision: text(run.applied_configuration_revision),
      appliedAlertPercent: normalizeReconciliationAlertPercent(
        text(run.applied_reconciliation_alert_percent)).reconciliationAlertPercent,
      appliedAlertBasis: run.applied_reconciliation_alert_basis === null ? null : allowed(run.applied_reconciliation_alert_basis, ['SIGNED', 'POSITIVE_ONLY'] as const),
      comparisonRule: allowed(run.comparison_rule,
        ['SHORTFALL_PERCENT_STRICTLY_GREATER_THAN_THRESHOLD']),
      currencyCount: count(run.currency_count), warningCount: count(run.warning_count),
      safeErrorCode: optionalText(run.safe_error_code) },
    distribution: this.distribution(run, rows, pageRows, components),
    items: pageRows.map((row) => this.summaryItem(row, counts, components)) };
  }

  private summaryItem(row: Row, counts: readonly Row[],
    components: readonly Row[]): AdminReconciliationItemSummary {
    const componentCounts = emptyCounts();
    for (const component of counts.filter((value) => value.run_item_id === row.id)) {
      const kind = allowed(component.kind, ['HOT', 'COLD', 'STAKING', 'BINANCE']);
      const total = count(component.total); const succeeded = count(component.succeeded);
      componentCounts[kind] = { total, succeeded, failed: total - succeeded };
    }
    const anomalousComponents = components.filter((value) => value.run_item_id === row.id)
      .map(mapComponent);
    return { id: text(row.id), currencyId: text(row.currency_id),
      status: allowed(row.status, ['COMPLETE', 'PARTIAL']),
      hotColdBalance: truncateApiCrypto(text(row.hot_cold_balance)),
      stakingBalance: truncateApiCrypto(text(row.staking_balance)),
      binanceBalance: truncateApiCrypto(text(row.binance_balance)),
      totalCustodyBalance: truncateApiCrypto(text(row.total_custody_balance)),
      requiredBacking: truncateApiCrypto(text(row.required_backing)),
      userMerchantBalance: truncateApiCrypto(text(row.user_merchant_balance)),
      treasuryBalance: truncateApiCrypto(text(row.treasury_balance)),
      collectionBalance: truncateApiCrypto(text(row.collection_balance)),
      ...formatReconciliationLedgerView({ ledgerSignedTotal: optionalText(row.ledger_signed_total), ledgerPositiveTotal: optionalText(row.ledger_positive_total),
        priceUsd: optionalText(row.price_usd), alertBasis: row.applied_reconciliation_alert_basis === null ? null : allowed(row.applied_reconciliation_alert_basis, ['SIGNED', 'POSITIVE_ONLY'] as const) }),
      partialReasons: strings(row.partial_reasons), shortfallSuppressed: boolean(row.shortfall_suppressed),
      shortfallPercent: row.shortfall_percent === null ? null
        : truncateApiPercentage(text(row.shortfall_percent)),
      evidenceSummary: { componentCounts, anomalousComponentCount: anomalousComponents.length },
      anomalousComponents };
  }

  private distribution(run: Row, all: readonly Row[], page: readonly Row[],
    components: readonly Row[]): AdminReconciliationDistribution {
    const allComplete = run.status === 'SUCCESS' && all.length > 0
      && all.every((row) => row.status === 'COMPLETE' && row.price_resolution_id !== null);
    const someUsable = all.some((row) => row.price_resolution_id !== null
      && (row.status === 'COMPLETE' || count(row.successful_components) > 0));
    const overallStatus = allComplete ? 'COMPLETE' : someUsable ? 'PARTIAL' : 'UNAVAILABLE';
    const exact = (key: string) => allComplete ? optionalText(all[0]?.[`overall_${key}`]) : null;
    const overallTotal = exact('total_usd');
    const currencies = page.map((row) => {
      const itemComponents = components.filter((value) => value.run_item_id === row.id);
      const failed = (kinds: string[]) => itemComponents.some((value) =>
        kinds.includes(text(value.kind)) && value.selected_balance === null);
      const priced = row.price_resolution_id !== null; const anySuccess = count(row.successful_components) > 0;
      const status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE' = priced && row.status === 'COMPLETE' ? 'COMPLETE'
        : priced && row.status === 'PARTIAL' && anySuccess ? 'PARTIAL' : 'UNAVAILABLE';
      const totalCrypto = text(row.total_custody_balance); const complete = !failed(
        ['HOT', 'COLD', 'STAKING', 'BINANCE']); const itemUsd = priced && complete
        ? optionalText(row.total_usd) : null;
      return { currencyId: text(row.currency_id), symbol: text(row.symbol), status,
        price: price(row), blockchainWallets: bucket(text(row.hot_cold_balance),
          optionalText(row.hot_usd), totalCrypto, !failed(['HOT', 'COLD']), priced),
        stakingWallets: bucket(text(row.staking_balance), optionalText(row.staking_usd),
          totalCrypto, !failed(['STAKING']), priced),
        binance: bucket(text(row.binance_balance), optionalText(row.binance_usd),
          totalCrypto, !failed(['BINANCE']), priced), totalCrypto: truncateApiCrypto(totalCrypto),
        totalUsd: itemUsd ? truncateApiFiat(itemUsd) : null,
        percentageOfOverallUsd: overallTotal && itemUsd
          ? formatReconciliationPercentage(itemUsd, overallTotal) : null };
    });
    const overallBucket = (key: string) => ({ usdValue: exact(key) ? truncateApiFiat(exact(key)!) : null,
      percentage: overallTotal && exact(key)
        ? formatReconciliationPercentage(exact(key)!, overallTotal) : null });
    return { currencies, overall: { status: overallStatus, valuationAt: instant(run.valuation_at),
      blockchainWallets: overallBucket('hot_usd'), stakingWallets: overallBucket('staking_usd'),
      binance: overallBucket('binance_usd'),
      totalUsd: overallTotal ? truncateApiFiat(overallTotal) : null } };
  }
}
