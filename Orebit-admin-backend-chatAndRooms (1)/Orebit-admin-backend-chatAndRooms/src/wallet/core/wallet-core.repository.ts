import type { AdminAuditActor } from '../../admin-audits/index.js';
import type { CatalogueEvidence, ChainCatalogueEvidence, ConfigurationChangeInsert, CurrencyCatalogueEvidence, LockedWalletSettings, StoredConfigurationChange, WalletCoreClient, WalletCoreDatabase, WalletEntityChange } from './wallet-core.database.js';
import { chainCatalogueEvidence, currencyCatalogueEvidence, sameCatalogueEvidence, walletDbDate, walletDbInteger } from './wallet-core.database.js';
import { WalletConfigurationInvalid } from './wallet-core.errors.js';
import { normalizeReconciliationAlertPercent } from './wallet-core.policy.js';
import { applyWalletCurrencyConfiguration,
  canonicalWalletConfigurationJson } from './wallet-core.currency-configuration.js';
import type { WalletCoreConfigurationPatch, WalletScheduleRejectionReason, WalletSettingsPatch } from './wallet-core.types.js';

type LockedSettingsWithValues = LockedWalletSettings & Readonly<{ settings: WalletSettingsPatch }>;
const settingsFromRow = (row: Record<string, unknown>): WalletSettingsPatch => {
  if (!['OFF', 'ON', 'MAINTAIN'].includes(String(row.global_desired_state))
    || !['ALL', 'RELEVANT'].includes(String(row.catalogue_mode))
    || typeof row.include_treasury !== 'boolean' || typeof row.include_collection !== 'boolean'
    || !['SIGNED', 'POSITIVE_ONLY'].includes(String(row.reconciliation_alert_basis))
    || !Array.isArray(row.default_currency_ids)
    || row.default_currency_ids.some((id) => typeof id !== 'string')) {
    throw new Error('WALLET_SETTINGS_ROW_INVALID');
  }
  const threshold = normalizeReconciliationAlertPercent(
    String(row.reconciliation_alert_percent),
  ).reconciliationAlertPercent;
  return { globalDesiredState: String(row.global_desired_state) as WalletSettingsPatch['globalDesiredState'],
    catalogueMode: String(row.catalogue_mode) as WalletSettingsPatch['catalogueMode'],
    reconciliationIncludeTreasury: row.include_treasury,
    reconciliationIncludeCollection: row.include_collection,
    reconciliationAlertPercent: threshold,
    reconciliationAlertBasis: String(row.reconciliation_alert_basis) as NonNullable<WalletSettingsPatch['reconciliationAlertBasis']>,
    defaultCurrencyIds: [...row.default_currency_ids] as string[] };
};
/** Applies configuration rows under caller-owned transactions and returns validated change evidence. */
export class WalletCoreRepository {
  private readonly wallet: string; private readonly price: string;
  constructor(private readonly database: WalletCoreDatabase) {
    this.wallet = database.schemas.wallet; this.price = database.schemas.price;
  }
  transaction<T>(work: (client: WalletCoreClient) => Promise<T>): Promise<T> {
    return this.database.transaction(work); }
  async lockSettings(client: WalletCoreClient): Promise<LockedSettingsWithValues> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT revision,global_desired_state::text,catalogue_mode::text,
        include_treasury,include_collection,reconciliation_alert_percent::text,
        reconciliation_alert_basis::text,default_currency_ids::text[]
       FROM ${this.wallet}.wallet_settings WHERE id = true FOR UPDATE`,
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row) throw new Error('WALLET_SETTINGS_ROW_MISSING');
    return { revision: walletDbInteger(row.revision, true), settings: settingsFromRow(row) };
  }
  async advanceRevision(client: WalletCoreClient, expectedRevision: number,
    revision: number): Promise<void> {
    const result = await client.query(
      `UPDATE ${this.wallet}.wallet_settings
       SET revision=$2, updated_at=clock_timestamp()
       WHERE id=true AND revision=$1`,
      [expectedRevision, revision],
    );
    if (result.rowCount !== 1) throw new Error('WALLET_SETTINGS_REVISION_UPDATE_FAILED');
  }
  async applySettings(client: WalletCoreClient, settings: WalletSettingsPatch): Promise<boolean> {
    const defaults = await client.query<{ id: unknown }>(`SELECT id::text FROM
      ${this.price}.currencies WHERE kind='CRYPTO' AND id=ANY($1::uuid[])`,
    [settings.defaultCurrencyIds]);
    if (defaults.rows.length !== settings.defaultCurrencyIds.length) {
      throw new WalletConfigurationInvalid('Default currencies must be configured cryptocurrencies.');
    }
    const result = await client.query(
      `UPDATE ${this.wallet}.wallet_settings SET
         global_desired_state=$1, catalogue_mode=$2, include_treasury=$3,
         include_collection=$4, reconciliation_alert_percent=$5,
         reconciliation_alert_basis=COALESCE($6::${this.wallet}."WalletReconciliationAlertBasis",reconciliation_alert_basis),
         default_currency_ids=$7::uuid[],
         updated_at=clock_timestamp()
       WHERE id=true AND ROW(global_desired_state,catalogue_mode,include_treasury,
         include_collection,reconciliation_alert_percent,reconciliation_alert_basis,
         default_currency_ids) IS DISTINCT FROM ROW($1::${this.wallet}."WalletDesiredState",
         $2::${this.wallet}."WalletCatalogueMode",$3::boolean,$4::boolean,$5::numeric,
         COALESCE($6::${this.wallet}."WalletReconciliationAlertBasis",reconciliation_alert_basis),
         $7::uuid[])`,
      [
        settings.globalDesiredState,
        settings.catalogueMode,
        settings.reconciliationIncludeTreasury,
        settings.reconciliationIncludeCollection,
        settings.reconciliationAlertPercent, settings.reconciliationAlertBasis ?? null,
        settings.defaultCurrencyIds,
      ],
    );
    if (result.rowCount !== 0 && result.rowCount !== 1) throw new Error('WALLET_SETTINGS_UPDATE_FAILED');
    return result.rowCount === 1;
  }
  async insertChange(client: WalletCoreClient, input: ConfigurationChangeInsert): Promise<void> {
    const result = await client.query(
      `INSERT INTO ${this.wallet}.configuration_changes
         (id,revision,status,reason,changelog_id,actor_id,snapshot)
       VALUES ($1,$2,'DRAFT',$3,$4,$5,$6::jsonb)`,
      [
        input.id, input.revision, input.reason, input.changelogId,
        input.actorId, JSON.stringify(input.snapshot),
      ],
    );
    if (result.rowCount !== 1) throw new Error('WALLET_CONFIGURATION_INSERT_FAILED');
  }
  /** Previews a scheduled patch against current effective rows without retaining any mutation. */
  async configurationWouldChange(client: WalletCoreClient,
    config: WalletCoreConfigurationPatch, configurationRevision: number,
    catalogue: CatalogueEvidence): Promise<boolean> {
    await client.query('SAVEPOINT wallet_configuration_preview');
    try {
      const changes = await this.applyConfiguration(
        client, config, configurationRevision, catalogue,
      );
      const settingsChanged = config.settings
        ? await this.applySettings(client, config.settings) : false;
      return settingsChanged || changes.length > 0;
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT wallet_configuration_preview');
      await client.query('RELEASE SAVEPOINT wallet_configuration_preview');
    }
  }
  async lockChange(
    client: WalletCoreClient,
    id: string,
  ): Promise<StoredConfigurationChange | null> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT id::text,revision,status::text,
              to_char(effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') effective_at,
              applied_at,
              reason,changelog_id::text,actor_id::text,snapshot
       FROM ${this.wallet}.configuration_changes WHERE id=$1 FOR UPDATE`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (
      typeof row.id !== 'string'
      || typeof row.status !== 'string'
      || !['DRAFT', 'SCHEDULED', 'LIVE', 'ARCHIVED', 'REJECTED'].includes(row.status)
      || typeof row.reason !== 'string'
      || (row.effective_at !== null && typeof row.effective_at !== 'string')
      || (row.changelog_id !== null && typeof row.changelog_id !== 'string')
      || typeof row.actor_id !== 'string'
    ) throw new Error('WALLET_CORE_DATABASE_RESULT_INVALID');
    return {
      id: row.id,
      revision: walletDbInteger(row.revision),
      status: row.status as StoredConfigurationChange['status'],
      effectiveAt: row.effective_at,
      appliedAt: walletDbDate(row.applied_at),
      reason: row.reason,
      changelogId: row.changelog_id,
      actorId: row.actor_id,
      snapshot: row.snapshot,
    };
  }
  async archiveCurrentLive(client: WalletCoreClient, replacementId: string): Promise<
  Readonly<{ id: string; revision: number }> | null> {
    const result = await client.query<Record<string, unknown>>(`UPDATE
      ${this.wallet}.configuration_changes SET status='ARCHIVED' WHERE id=(SELECT id FROM
      ${this.wallet}.configuration_changes WHERE status='LIVE' AND id<>$1
      ORDER BY revision DESC,id DESC LIMIT 1 FOR UPDATE) RETURNING id::text,revision`, [replacementId]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (result.rowCount !== 1 || typeof row?.id !== 'string') throw new Error('WALLET_CORE_DATABASE_RESULT_INVALID');
    return { id: row.id, revision: walletDbInteger(row.revision) };
  }
  async transitionChange(client: WalletCoreClient, id: string,
    status: 'SCHEDULED' | 'LIVE' | 'ARCHIVED' | 'REJECTED',
    effectiveAt: string | null, appliedAt: Date | null): Promise<string | null> {
    const result = await client.query<{ effective_at: unknown }>(
      `UPDATE ${this.wallet}.configuration_changes
       SET status=$2::${this.wallet}."WalletConfigurationStatus",effective_at=CASE
           WHEN $2::text='SCHEDULED' THEN $3 ELSE effective_at END,
           applied_at=$4 WHERE id=$1
       RETURNING to_char(effective_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') effective_at`,
      [id, status, effectiveAt, appliedAt],
    );
    if (result.rowCount !== 1) throw new Error('WALLET_CONFIGURATION_TRANSITION_FAILED');
    const stored = result.rows[0]?.effective_at;
    if (stored !== null && typeof stored !== 'string') {
      throw new Error('WALLET_CORE_DATABASE_RESULT_INVALID');
    }
    return stored;
  }
  async isChangeDue(client: WalletCoreClient, id: string, now: Date): Promise<boolean> {
    const result = await client.query<{ due: unknown }>(`SELECT effective_at <= $2 AS due FROM
      ${this.wallet}.configuration_changes WHERE id=$1`, [id, now]);
    if (typeof result.rows[0]?.due !== 'boolean') throw new Error('WALLET_CORE_DATABASE_RESULT_INVALID');
    return result.rows[0].due;
  }
  async appendStateEvent(
    client: WalletCoreClient,
    input: Readonly<{
      id: string;
      eventType: string;
      subjectType: string;
      subjectId: string;
      actor: AdminAuditActor;
      payload: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<void> {
    const actorId = input.actor.kind === 'ADMIN' ? input.actor.actorId : null;
    const runId = input.actor.kind === 'SYSTEM' ? input.actor.runId : null;
    const result = await client.query(
      `INSERT INTO ${this.wallet}.state_events
         (id,event_type,subject_type,subject_id,run_id,actor_id,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        input.id, input.eventType, input.subjectType, input.subjectId,
        runId, actorId, JSON.stringify(input.payload),
      ],
    );
    if (result.rowCount !== 1) throw new Error('WALLET_STATE_EVENT_INSERT_FAILED');
  }
  async captureCatalogue(
    client: WalletCoreClient,
    config: WalletCoreConfigurationPatch,
  ): Promise<CatalogueEvidence> {
    const chains: ChainCatalogueEvidence[] = [];
    const currencies: CurrencyCatalogueEvidence[] = [];
    const chainById = new Map((config.chains ?? []).map((chain) => [chain.id!, chain]));
    for (const chain of config.chains ?? []) {
      const result = await client.query<Record<string, unknown>>(
        `SELECT name,short_name,is_evm,provider_state::text,revision
         FROM ${this.wallet}.provider_catalogue_chains WHERE provider_chain_id=$1`,
        [chain.providerChainId],
      );
      const row = result.rows[0];
      if (!row || row.provider_state === 'UNAVAILABLE') {
        throw new Error('CATALOGUE_REFERENCE_UNAVAILABLE');
      }
      if (row.is_evm !== chain.isEvm) throw new Error('CATALOGUE_CONFIGURATION_MISMATCH');
      chains.push(chainCatalogueEvidence(chain.providerChainId, row));
    }
    for (const currency of config.currencies ?? []) {
      for (const binding of currency.bindings) {
        let providerChainId = chainById.get(binding.chainId)?.providerChainId;
        if (providerChainId === undefined) {
          const chain = await client.query<{ provider_chain_id: unknown }>(
            `SELECT provider_chain_id FROM ${this.wallet}.chains WHERE id=$1`,
            [binding.chainId],
          );
          providerChainId = walletDbInteger(chain.rows[0]?.provider_chain_id);
        }
        const result = await client.query<Record<string, unknown>>(
          `SELECT currency_name,token_address,is_base_currency,is_stake,
                  blockchain_precision,provider_state::text,revision
           FROM ${this.wallet}.provider_catalogue_currencies
           WHERE provider_chain_id=$1 AND provider_coin_id=$2`,
          [providerChainId, binding.providerCoinId],
        );
        const row = result.rows[0];
        if (!row || row.provider_state === 'UNAVAILABLE') {
          throw new Error('CATALOGUE_REFERENCE_UNAVAILABLE');
        }
        if (row.token_address !== (binding.tokenContractAddress ?? null)
          || row.is_base_currency !== !binding.isToken
          || row.blockchain_precision !== binding.blockchainPrecision
          || (binding.stakingWalletAddresses.length > 0 && row.is_stake !== true)) {
          throw new Error('CATALOGUE_CONFIGURATION_MISMATCH');
        }
        currencies.push(currencyCatalogueEvidence(providerChainId, binding.providerCoinId, row));
      }
    }
    return { chains, currencies };
    }
  /** Rejects scheduled snapshots when their imported provider evidence has since changed. */
  async validateCatalogue(
    client: WalletCoreClient,
    evidence: CatalogueEvidence,
  ): Promise<WalletScheduleRejectionReason | null> {
    for (const chain of evidence.chains) {
      const result = await client.query<Record<string, unknown>>(
        `SELECT name,short_name,is_evm,provider_state::text,revision
         FROM ${this.wallet}.provider_catalogue_chains
         WHERE provider_chain_id=$1 FOR SHARE`,
        [chain.providerChainId],
      );
      const row = result.rows[0];
      if (!row || row.provider_state === 'UNAVAILABLE') return 'CATALOGUE_REFERENCE_UNAVAILABLE';
      if (!sameCatalogueEvidence(chainCatalogueEvidence(chain.providerChainId, row), chain)) {
        return 'CATALOGUE_REVISION_CHANGED';
      }
    }
    for (const currency of evidence.currencies) {
      const result = await client.query<Record<string, unknown>>(
        `SELECT currency_name,token_address,is_base_currency,is_stake,
                blockchain_precision,provider_state::text,revision
         FROM ${this.wallet}.provider_catalogue_currencies
         WHERE provider_chain_id=$1 AND provider_coin_id=$2 FOR SHARE`,
        [currency.providerChainId, currency.providerCoinId],
      );
      const row = result.rows[0];
      if (!row || row.provider_state === 'UNAVAILABLE') return 'CATALOGUE_REFERENCE_UNAVAILABLE';
      if (!sameCatalogueEvidence(currencyCatalogueEvidence(
        currency.providerChainId, currency.providerCoinId, row,
      ), currency)) return 'CATALOGUE_REVISION_CHANGED';
    }
    return null;
    }
  /** Upserts a normalized snapshot and records the minimal entity changes needed for audit. */
  async applyConfiguration(
    client: WalletCoreClient,
    config: WalletCoreConfigurationPatch,
    configurationRevision: number,
    captured: CatalogueEvidence,
  ): Promise<readonly WalletEntityChange[]> {
    const changes: WalletEntityChange[] = [];
    const catalogue = new Map(captured.chains.map((row) => [row.providerChainId, row]));
    let evidenceOffset = 0;
    for (const chain of config.chains ?? []) {
      const beforeResult = await client.query<Record<string, unknown>>(
        `SELECT provider_chain_id,blockchain_reference,name,short_name,is_evm,
                available_for::text,desired_state::text,provider_state::text,logo_object_key
         FROM ${this.wallet}.chains WHERE id=$1 FOR UPDATE`,
        [chain.id],
      );
      const before = beforeResult.rows[0];
      const provider = catalogue.get(chain.providerChainId);
      if (!provider) throw new WalletConfigurationInvalid('Provider catalogue reference unavailable.');
      const identityChanged = before !== undefined
        && (walletDbInteger(before.provider_chain_id) !== chain.providerChainId
          || before.blockchain_reference !== chain.blockchainReference
          || before.is_evm !== chain.isEvm);
      if (identityChanged) {
        if (before.desired_state !== 'OFF' || chain.desiredState !== 'OFF') {
          throw new WalletConfigurationInvalid('Chain identity can change only while setup is OFF.');
        }
        const activeBinding = await client.query(`SELECT 1 FROM ${this.wallet}.currencies
          WHERE chain_id=$1 AND desired_state<>'OFF' LIMIT 1 FOR UPDATE`, [chain.id]);
        if (activeBinding.rows.length > 0) {
          throw new WalletConfigurationInvalid('Chain identity requires every binding to be OFF.');
        }
      }
      await client.query(
        `INSERT INTO ${this.wallet}.chains
           (id,provider_chain_id,blockchain_reference,name,short_name,is_evm,logo_object_key,available_for,
            desired_state,provider_state,policy_revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET provider_chain_id=EXCLUDED.provider_chain_id,
           blockchain_reference=EXCLUDED.blockchain_reference,name=EXCLUDED.name,
           short_name=EXCLUDED.short_name,is_evm=EXCLUDED.is_evm,
           logo_object_key=EXCLUDED.logo_object_key,available_for=EXCLUDED.available_for,
           desired_state=EXCLUDED.desired_state,provider_state=EXCLUDED.provider_state,
           policy_revision=EXCLUDED.policy_revision,
           updated_at=clock_timestamp()`,
        [
          chain.id, chain.providerChainId, chain.blockchainReference,
          chain.name, chain.shortName, chain.isEvm,
          chain.logoObjectKey ?? null, chain.availableFor, chain.desiredState,
          provider.providerState, configurationRevision,
        ],
      );
      const beforeProjection = before ? {
        blockchainReference: String(before.blockchain_reference),
        name: String(before.name), shortName: String(before.short_name),
        availableFor: String(before.available_for),
        ...(typeof before.logo_object_key === 'string' ? { logoObjectKey: before.logo_object_key } : {}),
        config: { id: chain.id, providerChainId: walletDbInteger(before.provider_chain_id),
          blockchainReference: String(before.blockchain_reference), name: String(before.name),
          shortName: String(before.short_name), isEvm: before.is_evm,
          ...(typeof before.logo_object_key === 'string'
            ? { logoObjectKey: before.logo_object_key } : {}),
          availableFor: String(before.available_for), desiredState: String(before.desired_state) },
      } : null;
      const afterProjection = {
        blockchainReference: chain.blockchainReference,
        name: chain.name, shortName: chain.shortName,
        availableFor: chain.availableFor,
        ...(chain.logoObjectKey ? { logoObjectKey: chain.logoObjectKey } : {}),
        config: chain,
      };
      if (!before || canonicalWalletConfigurationJson(beforeProjection)
        !== canonicalWalletConfigurationJson(afterProjection)) changes.push({
        action: before ? 'CHAIN.UPDATED' : 'CHAIN.IMPORTED',
        subject: { type: 'CHAIN', id: chain.id! },
        before: beforeProjection,
        after: afterProjection,
        importCatalogueRevision: provider.revision,
      });
      if (before && before.desired_state !== chain.desiredState) {
        changes.push({
          action: 'CHAIN.STATUS_CHANGED',
          subject: { type: 'CHAIN', id: chain.id! },
          before: { desiredState: String(before.desired_state) },
          after: { desiredState: chain.desiredState },
        });
      }
    }
    const referencedChainIds = [...new Set((config.currencies ?? []).flatMap((currency) => currency.bindings.map((binding) => binding.chainId)))];
    const chainRows = (await client.query<{ id: unknown; is_evm: unknown }>(
      `SELECT id::text,is_evm FROM ${this.wallet}.chains WHERE id=ANY($1::uuid[])`, [referencedChainIds])).rows;
    const chainKinds = new Map(chainRows.map((row) => [String(row.id), row.is_evm]));
    if (chainKinds.size !== referencedChainIds.length || [...chainKinds.values()].some((value) => typeof value !== 'boolean')) throw new Error('WALLET_BINDING_CHAIN_NOT_FOUND');
    for (const currency of config.currencies ?? []) {
      const evidence = captured.currencies.slice(evidenceOffset, evidenceOffset += currency.bindings.length);
      changes.push(...await applyWalletCurrencyConfiguration(
        client, currency, configurationRevision, evidence,
        chainKinds as Map<string, boolean>, this.database.schemas));
    }
    for (const pin of config.providerPins ?? []) {
      const table = pin.subject === 'CHAIN' ? 'chains' : 'currencies';
      const subjectType = pin.subject === 'CHAIN' ? 'CHAIN' : 'CURRENCY_CHAIN';
      const result = await client.query<{ maintenance_pinned: unknown }>(
        `SELECT maintenance_pinned FROM ${this.wallet}.${table} WHERE id=$1 FOR UPDATE`,
        [pin.subjectId],
      );
      if (typeof result.rows[0]?.maintenance_pinned !== 'boolean') {
        throw new Error('WALLET_PIN_SUBJECT_NOT_FOUND');
      }
      await client.query(
        `UPDATE ${this.wallet}.${table} SET maintenance_pinned=$2,updated_at=clock_timestamp()
         WHERE id=$1`,
        [pin.subjectId, pin.pinned],
      );
      if (result.rows[0].maintenance_pinned !== pin.pinned) changes.push({
        action: pin.pinned
          ? 'PROVIDER_MAINTENANCE.PINNED' : 'PROVIDER_MAINTENANCE.UNPINNED',
        subject: { type: subjectType, id: pin.subjectId },
        before: { maintenancePinned: result.rows[0].maintenance_pinned },
        after: { maintenancePinned: pin.pinned },
      });
    }
    return changes;
    }
}
