import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';

import { AdminAuditRepository } from '../../../admin-audits/admin-audit.repository.js';
import { AdminAuditWriterService } from '../../../admin-audits/admin-audit.writer.service.js';
import { uuidv7 } from '../../../utils/public.utils.js';
import { WalletCronjobRepository, WalletCronLeaseLost } from '../cronjob.repository.js';
import { WalletLogoAssetRepository } from '../logo-asset.repository.js';
import { WalletCoreConfigurationWriter } from '../wallet-core.configuration-writer.js';
import { WalletCoreBootstrapPages } from '../wallet-core.bootstrap-pages.js';
import { WALLET_CORE_TEST_SCHEMAS, WalletCoreDatabase,
  type WalletCorePool } from '../wallet-core.database.js';
import { WalletConfigurationInvalid } from '../wallet-core.errors.js';
import { WalletCoreHistoryRepository } from '../wallet-core.history-repository.js';
import { WalletCoreRepository } from '../wallet-core.repository.js';

const enabled = process.env.WP11_SCHEMA_DATABASE_URL !== undefined;

async function transaction(work: (client: pg.Client, database: WalletCoreDatabase) => Promise<void>) {
  const url = new URL(process.env.WP11_SCHEMA_DATABASE_URL!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55441');
  assert.equal(url.pathname, '/orebit_wallet_pricing_fixes_20260910');
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    const identity = (await client.query(`SELECT current_database() name,
      current_setting('cluster_name') cluster`)).rows[0];
    assert.deepEqual(identity, { name: 'orebit_wallet_pricing_fixes_20260910',
      cluster: 'orebit_wallet_pricing_fixes_20260910' });
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const pool: WalletCorePool = { async end() {}, async connect() { return {
      release() {}, async query<Row extends Record<string, unknown>>(sql: string,
        values?: readonly unknown[]) {
        if (sql === 'BEGIN') sql = 'SAVEPOINT admin_wallet_wp11';
        else if (sql === 'COMMIT') sql = 'RELEASE SAVEPOINT admin_wallet_wp11';
        else if (sql === 'ROLLBACK') sql = 'ROLLBACK TO SAVEPOINT admin_wallet_wp11';
        else if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') {
          const isolation = (await client.query('SHOW transaction_isolation')).rows[0];
          assert.equal(isolation.transaction_isolation, 'repeatable read');
          return { rows: [] as Row[], rowCount: 0 };
        }
        sql = sql.replaceAll('wallet_core_test.', 'wallet_core.')
          .replaceAll('price_conversion_test.', 'price_conversion.')
          .replaceAll('admin_test.', 'admin.');
        const result = await client.query(sql, values as unknown[] | undefined);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    }; } };
    await work(client, WalletCoreDatabase.validatedTest(pool, WALLET_CORE_TEST_SCHEMAS));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

test('WP11 Admin Wallet atomically preserves identities, defaults, no-ops and complete audit',
  { skip: !enabled }, () => transaction(async (client, database) => {
    const ids = { chain: uuidv7(), currency: uuidv7(), binding: uuidv7() };
    const providerChainId = Number((await client.query(`SELECT GREATEST(
      COALESCE((SELECT max(provider_chain_id) FROM wallet_core.provider_catalogue_chains),0),
      COALESCE((SELECT max(provider_chain_id) FROM wallet_core.chains),0))+1 id`)).rows[0].id);
    const providerCoinId = 1;
    await client.query(`INSERT INTO wallet_core.provider_catalogue_chains
      (provider_chain_id,name,short_name,is_evm,provider_state,revision,refreshed_at)
      VALUES($1,'Provider label','WP11PROVIDER',true,'ACTIVATED',1,clock_timestamp())`,
    [providerChainId]);
    await client.query(`INSERT INTO wallet_core.provider_catalogue_currencies
      (provider_chain_id,provider_coin_id,currency_name,token_address,is_base_currency,is_stake,
       blockchain_precision,provider_state,revision,refreshed_at)
      VALUES($1,$2,'Provider asset',NULL,true,true,18,'ACTIVATED',1,clock_timestamp())`,
    [providerChainId, providerCoinId]);
    const config = { settings: { globalDesiredState: 'ON' as const, catalogueMode: 'RELEVANT' as const,
      reconciliationIncludeTreasury: true, reconciliationIncludeCollection: false,
      reconciliationAlertPercent: '5', reconciliationAlertBasis: 'SIGNED' as const,
      defaultCurrencyIds: [ids.currency] },
    chains: [{ id: ids.chain, providerChainId, blockchainReference: 'wp11-chain',
      name: 'Website chain', shortName: 'WP11WEB', isEvm: true, availableFor: 'BOTH' as const,
      desiredState: 'OFF' as const }],
    currencies: [{ id: ids.currency, symbol: `W${ids.currency.replaceAll('-', '').slice(0, 20).toUpperCase()}`,
      name: 'Website coin', providerRefs: (['COINGECKO', 'ALCHEMY', 'COINMARKETCAP'] as const)
        .map((provider) => ({ provider, providerAssetId: `wp11-${provider.toLowerCase()}-${ids.currency}`,
          providerSymbol: 'WP11' })), viewEnabled: false, geoCountryDeny: [], geoContinentDeny: [],
      accessLevel: 'ALL' as const, availableFor: 'BOTH' as const, listingKind: 'PERMANENT' as const,
      showBeforeListing: false, premiumOperations: [], soOperations: [], postDelistOperations: [],
      desiredState: 'OFF' as const, maintenanceAudiences: [],
      showBalanceInMaintenance: { USER: true, SO: true }, bindings: [{ id: ids.binding,
        chainId: ids.chain, providerCoinId, blockchainReference: 'wp11-asset', isToken: false,
        blockchainPrecision: 18, desiredState: 'OFF' as const, hotWalletAddresses: [],
        coldWalletAddresses: [], stakingWalletAddresses: [] }] }] };
    const repository = new WalletCoreRepository(database);
    const writer = new WalletCoreConfigurationWriter(repository,
      new AdminAuditWriterService(new AdminAuditRepository()), new WalletLogoAssetRepository(database));
    const actor = { actor: { kind: 'ADMIN' as const, actorId: uuidv7(), sessionId: uuidv7(),
      requestId: uuidv7(), ipAddress: '127.0.0.1', deviceId: 'wp11-admin-wallet' } };
    const lockedBefore = await database.transaction((tx) => repository.lockSettings(tx));
    const revision = lockedBefore.revision;
    const pushed = await writer.updateAtomically({ action: 'PUSH', expectedRevision: revision,
      reason: 'WP11 Admin Wallet integration', config }, actor);
    assert.equal(pushed.outcome, 'PUSHED');
    assert.deepEqual((await client.query(`SELECT default_currency_ids::text[] ids FROM
      wallet_core.wallet_settings WHERE id`)).rows[0].ids, [ids.currency]);
    assert.deepEqual((await client.query(`SELECT blockchain_reference FROM wallet_core.chains
      WHERE id=$1`, [ids.chain])).rows[0], { blockchain_reference: 'wp11-chain' });
    assert.equal((await client.query(`SELECT count(*)::int count FROM
      price_conversion.currency_provider_refs WHERE currency_id=$1 AND retired_at IS NULL`,
    [ids.currency])).rows[0].count, 3);
    const pushedAudit = (await client.query(`SELECT before_json,after_json FROM
      admin.admin_audit_events WHERE event_key LIKE $1 AND action='SETTINGS.PUSHED'`,
    [`wallet:${pushed.configurationId}:%`])).rows[0];
    assert.deepEqual(pushedAudit.before_json.config.settings, lockedBefore.settings);
    assert.deepEqual(pushedAudit.after_json.config.settings, config.settings);
    await assert.rejects(() => writer.updateAtomically({ action: 'PUSH',
      expectedRevision: Number(pushed.revision), reason: 'WP11 unchanged', config }, actor),
    WalletConfigurationInvalid);
    const beforeSchedule = (await client.query(`SELECT
      (SELECT revision FROM wallet_core.wallet_settings WHERE id)::int revision,
      (SELECT count(*)::int FROM wallet_core.configuration_changes) changes,
      (SELECT count(*)::int FROM admin.admin_audit_events) audits`)).rows[0];
    await assert.rejects(() => writer.updateAtomically({ action: 'SCHEDULE',
      expectedRevision: Number(pushed.revision), reason: 'WP11 unchanged schedule',
      effectiveAt: new Date(Date.now() + 86_400_000).toISOString(), config },
    { actor: { ...actor.actor, requestId: uuidv7() } }), WalletConfigurationInvalid);
    assert.deepEqual((await client.query(`SELECT
      (SELECT revision FROM wallet_core.wallet_settings WHERE id)::int revision,
      (SELECT count(*)::int FROM wallet_core.configuration_changes) changes,
      (SELECT count(*)::int FROM admin.admin_audit_events) audits`)).rows[0], beforeSchedule);
    const nextProviderCoinId = providerCoinId + 1;
    const nextTokenContract = `0x${'ab'.repeat(20)}`;
    await client.query(`INSERT INTO wallet_core.provider_catalogue_currencies
      (provider_chain_id,provider_coin_id,currency_name,token_address,is_base_currency,is_stake,
       blockchain_precision,provider_state,revision,refreshed_at)
      VALUES($1,$2,'Provider token',$3,false,false,8,'ACTIVATED',2,clock_timestamp())`,
    [providerChainId, nextProviderCoinId, nextTokenContract]);
    const changed = { ...config, currencies: [{ ...config.currencies[0]!, providerRefs:
      config.currencies[0]!.providerRefs.map((ref) => ref.provider === 'COINGECKO'
        ? { ...ref, providerAssetId: `${ref.providerAssetId}-next` } : ref),
    bindings: [{ ...config.currencies[0]!.bindings[0]!, providerCoinId: nextProviderCoinId,
      blockchainReference: 'wp11-token', isToken: true,
      tokenContractAddress: nextTokenContract, blockchainPrecision: 8 }] }] };
    const rotated = await writer.updateAtomically({ action: 'PUSH', expectedRevision: Number(pushed.revision),
      reason: 'WP11 provider identity rotation while OFF', config: changed },
    { actor: { ...actor.actor, requestId: uuidv7() } });
    const refs = (await client.query(`SELECT retired_at IS NULL current,count(*) OVER() total
      FROM price_conversion.currency_provider_refs WHERE currency_id=$1`, [ids.currency])).rows;
    assert.equal(refs.length, 4); assert.equal(refs.filter((row) => row.current).length, 3);
    assert.deepEqual((await client.query(`SELECT provider_coin_id::int,is_token "isToken",
      is_native "isNative",token_contract_address,
      blockchain_precision "blockchainPrecision",blockchain_reference
      FROM wallet_core.currencies WHERE id=$1`, [ids.binding])).rows[0], {
      provider_coin_id: nextProviderCoinId, isToken: true, isNative: false,
      token_contract_address: nextTokenContract, blockchainPrecision: 8,
      blockchain_reference: 'wp11-token',
    });
    const audit = (await client.query(`SELECT action,before_json,after_json FROM admin.admin_audit_events
      WHERE subject_id IN ($1,$2) ORDER BY created_at,id`, [ids.chain, ids.currency])).rows;
    assert.ok(audit.some((row) => row.action === 'CHAIN.IMPORTED' && row.after_json.config));
    const bindingAudit = audit.find((row) => row.action === 'CURRENCY.UPDATED'
      && row.after_json.config?.bindings?.[0]?.providerCoinId === nextProviderCoinId);
    assert.equal(bindingAudit.before_json.config.bindings[0].providerCoinId, providerCoinId);
    assert.equal(bindingAudit.before_json.config.bindings[0].isToken, false);
    assert.equal(bindingAudit.after_json.config.bindings[0].isToken, true);
    assert.equal(bindingAudit.after_json.config.bindings[0].tokenContractAddress,
      nextTokenContract);
    const scheduledConfig = { settings: { ...config.settings,
      reconciliationAlertPercent: '6' }, chains: [{ ...config.chains[0]!,
      name: 'Scheduled website chain' }], providerPins: [{ subject: 'CHAIN' as const,
      subjectId: ids.chain, pinned: true }] };
    const effectiveAt = new Date(Date.now() + 60_000);
    const scheduled = await writer.updateAtomically({ action: 'SCHEDULE',
      expectedRevision: Number(rotated.revision), reason: 'WP11 scheduled audit evidence',
      effectiveAt: effectiveAt.toISOString(), config: scheduledConfig },
    { actor: { ...actor.actor, requestId: uuidv7() } });
    const systemRunId = uuidv7();
    assert.equal((await writer.applyScheduledChangeAtomically(scheduled.configurationId,
      new Date(effectiveAt.valueOf() + 1), { actor: { kind: 'SYSTEM', runId: systemRunId } })).outcome,
    'SCHEDULE_APPLIED');
    const scheduledEntities = (await client.query(`SELECT action,actor_kind,run_id::text,
      before_json,after_json,metadata_json FROM admin.admin_audit_events
      WHERE metadata_json->>'scheduledChangeId'=$1 ORDER BY action`,
    [scheduled.configurationId])).rows;
    assert.deepEqual(scheduledEntities.map((row) => row.action), [
      'CHAIN.UPDATED', 'PROVIDER_MAINTENANCE.PINNED',
    ]);
    assert.ok(scheduledEntities.every((row) => row.actor_kind === 'SYSTEM'
      && row.run_id === systemRunId && row.before_json && row.after_json));
    const appliedAudit = (await client.query(`SELECT before_json,after_json FROM
      admin.admin_audit_events WHERE event_key LIKE $1 AND action='SETTINGS.SCHEDULE_APPLIED'`,
    [`wallet:${scheduled.configurationId}:%`])).rows[0];
    assert.equal(appliedAudit.before_json.config.settings.reconciliationAlertPercent, '5');
    assert.equal(appliedAudit.after_json.config.settings.reconciliationAlertPercent, '6');
  }));

test('WP11 Admin Wallet history and cron ownership use bounded UUID pages and stale-owner fences',
  { skip: !enabled }, () => transaction(async (client, database) => {
    const cron = new WalletCronjobRepository(database);
    const scheduledFor = new Date(Math.floor(Date.now() / 300_000) * 300_000);
    const first = await cron.claim({ jobName: `wp11-admin-${uuidv7()}`, scheduledFor,
      periodMs: 300_000, workerInstanceId: 'host:first' });
    assert.ok(first);
    await client.query('ALTER TABLE wallet_core.cronjob_runs DISABLE TRIGGER cronjob_runs_lease_guard');
    try {
      await client.query(`UPDATE wallet_core.cronjob_runs
        SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [first.id]);
    } finally {
      await client.query('ALTER TABLE wallet_core.cronjob_runs ENABLE TRIGGER cronjob_runs_lease_guard');
    }
    const second = await cron.claim({ jobName: first.jobName, scheduledFor,
      periodMs: 300_000, workerInstanceId: 'host:second' });
    assert.ok(second); assert.equal(second.attemptCount, 2);
    await assert.rejects(() => cron.complete(first, { status: 'SUCCESS', safeErrorCode: null,
      skippedBucketCount: 0, processedCount: 0, failedCount: 0 }), WalletCronLeaseLost);
    await cron.complete(second, { status: 'SUCCESS', safeErrorCode: null,
      skippedBucketCount: 0, processedCount: 0, failedCount: 0 });
    const historyIds = [uuidv7(), uuidv7()];
    const historyRunId = uuidv7();
    for (const [index, id] of historyIds.entries()) await client.query(`INSERT INTO
      wallet_core.state_events(id,event_type,subject_type,subject_id,run_id,payload,created_at)
      VALUES($1,'CHAIN.STATUS_CHANGED','CHAIN',$2,$3,$4,
        clock_timestamp()+($5::text||' hours')::interval)`,
    [id, uuidv7(), historyRunId, { before: { desiredState: 'OFF' },
      after: { desiredState: 'ON' } }, 2 - index]);
    const fixtureRows = (await client.query(`SELECT id::text FROM wallet_core.state_events
      WHERE id=ANY($1::uuid[]) ORDER BY created_at DESC,id DESC`, [historyIds])).rows;
    assert.equal(fixtureRows.length, 2);
    assert.ok(fixtureRows.every((row) => /^[0-9a-f-]{14}7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/.test(row.id)));
    const history = new WalletCoreHistoryRepository(database);
    const historyQuery = { limit: 1, eventType: 'CHAIN.STATUS_CHANGED' as const,
      actorId: historyRunId };
    const page = await history.history(historyQuery);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.id, fixtureRows[0].id);
    assert.ok(page.nextCursor);
    const later = await history.history({ ...historyQuery, cursor: page.nextCursor! });
    assert.equal(later.items[0]?.id, fixtureRows[1].id);
  }));

test('WP11 Admin Wallet logo cleanup preserves current, scheduled and historical references',
  { skip: !enabled }, () => transaction(async (client, database) => {
    const assets = new WalletLogoAssetRepository(database);
    const key = () => `${randomBytes(32).toString('hex')}.webp`;
    const referenced = { current: key(), scheduled: key(), historical: key() };
    const orphan = key(); const raced = key();
    const baseRevision = Number((await client.query(`SELECT COALESCE(max(revision),0) revision
      FROM wallet_core.configuration_changes`)).rows[0].revision);
    const currentId = uuidv7(); const scheduledId = uuidv7();
    const historicalId = uuidv7(); const actorId = uuidv7();
    const draft = async (id: string, revision: number, reason: string) => client.query(`INSERT INTO
      wallet_core.configuration_changes(id,revision,status,reason,actor_id,snapshot)
      VALUES($1,$2,'DRAFT',$3,$4,'{}'::jsonb)`, [id, revision, reason, actorId]);
    await draft(currentId, baseRevision + 1, 'WP11 current logo');
    await client.query(`UPDATE wallet_core.configuration_changes
      SET status='LIVE',applied_at=clock_timestamp() WHERE id=$1`, [currentId]);
    await draft(scheduledId, baseRevision + 2, 'WP11 scheduled logo');
    await client.query(`UPDATE wallet_core.configuration_changes SET status='SCHEDULED',
      effective_at=clock_timestamp()+interval '1 day' WHERE id=$1`, [scheduledId]);
    await draft(historicalId, baseRevision + 3, 'WP11 historical logo');
    await client.query(`UPDATE wallet_core.configuration_changes
      SET status='ARCHIVED' WHERE id=$1`, [historicalId]);
    for (const objectKey of [...Object.values(referenced), orphan, raced]) {
      await assets.reserve(objectKey);
      await database.transaction((tx) => assets.markUploadedWithTransaction(tx, objectKey));
    }
    for (const [configurationChangeId, objectKey] of [
      [currentId, referenced.current], [scheduledId, referenced.scheduled],
      [historicalId, referenced.historical],
    ] as const) await database.transaction((tx) => assets.attachReferencedWithTransaction(tx, {
      configurationChangeId: configurationChangeId!, objectKeys: [objectKey],
    }));
    const expiryConstraint = (await client.query(`SELECT pg_get_constraintdef(oid) definition
      FROM pg_constraint WHERE conrelid='wallet_core.wallet_logo_assets'::regclass
        AND conname='wallet_logo_assets_expiry'`)).rows[0]?.definition;
    assert.match(expiryConstraint ?? '', /expires_at.*created_at.*24:00:00/);
    await client.query(`WITH stamp AS (SELECT clock_timestamp()-interval '25 hours' created)
      UPDATE wallet_core.wallet_logo_assets SET created_at=stamp.created,
        expires_at=stamp.created+interval '24 hours' FROM stamp
      WHERE object_key=ANY($1::text[])`, [[...Object.values(referenced), orphan, raced]]);

    const firstClaim = await assets.claimExpired();
    assert.ok(firstClaim.objectKeys.includes(orphan));
    assert.ok(firstClaim.objectKeys.includes(raced));
    for (const objectKey of Object.values(referenced)) {
      assert.equal(firstClaim.objectKeys.includes(objectKey), false, objectKey);
    }
    await assert.rejects(() => database.transaction((tx) =>
      assets.attachReferencedWithTransaction(tx, {
        configurationChangeId: currentId!, objectKeys: [raced],
      })), WalletConfigurationInvalid);
    await assets.completeDeletion(orphan, firstClaim.token);
    await assets.releaseDeletion(raced, firstClaim.token);
    assert.equal((await client.query(`SELECT state::text FROM wallet_core.wallet_logo_assets
      WHERE object_key=$1`, [orphan])).rows[0].state, 'DELETED');
    const survivors = (await client.query(`SELECT object_key,state::text FROM
      wallet_core.wallet_logo_assets WHERE object_key=ANY($1::text[]) ORDER BY object_key`,
    [Object.values(referenced)])).rows;
    assert.equal(survivors.length, 3);
    assert.ok(survivors.every((row) => row.state === 'ATTACHED'));
  }));

test('WP11 legacy scheduled no-op rejects without archiving LIVE or retaining preview mutations',
  { skip: !enabled }, () => transaction(async (client, database) => {
    const repository = new WalletCoreRepository(database);
    const writer = new WalletCoreConfigurationWriter(repository,
      new AdminAuditWriterService(new AdminAuditRepository()),
      new WalletLogoAssetRepository(database));
    const current = await database.transaction((tx) => repository.lockSettings(tx));
    const liveSettings = { ...current.settings, reconciliationAlertPercent:
      current.settings.reconciliationAlertPercent === '11' ? '12' : '11',
    defaultCurrencyIds: [] };
    const actor = { actor: { kind: 'ADMIN' as const, actorId: uuidv7(), sessionId: uuidv7(),
      requestId: uuidv7(), ipAddress: '127.0.0.1', deviceId: 'legacy-schedule' } };
    const pushed = await writer.updateAtomically({ action: 'PUSH',
      expectedRevision: current.revision, reason: 'WP11 legacy schedule live baseline',
      config: { settings: liveSettings } }, actor);
    assert.equal(pushed.outcome, 'PUSHED');
    const legacyId = uuidv7(); const legacyRevision = Number(pushed.revision) + 1;
    const { defaultCurrencyIds: _newField, ...legacySettings } = liveSettings;
    await client.query(`INSERT INTO wallet_core.configuration_changes
      (id,revision,status,reason,actor_id,snapshot) VALUES($1,$2,'DRAFT',$3,$4,$5)`,
    [legacyId, legacyRevision, 'pre-WP11 valid no-op', actor.actor.actorId,
      { config: { settings: legacySettings }, catalogue: { chains: [], currencies: [] } }]);
    await client.query(`UPDATE wallet_core.configuration_changes SET status='SCHEDULED',
      effective_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [legacyId]);
    await client.query(`UPDATE wallet_core.wallet_settings SET revision=$1 WHERE id`,
    [legacyRevision]);
    const beforeRows = (await client.query(`SELECT global_desired_state::text,catalogue_mode::text,
      include_treasury,include_collection,reconciliation_alert_percent::text,
      reconciliation_alert_basis::text,default_currency_ids::text[]
      FROM wallet_core.wallet_settings WHERE id`)).rows[0];
    const systemRunId = uuidv7();

    const result = await writer.applyScheduledChangeAtomically(legacyId, new Date(),
      { actor: { kind: 'SYSTEM', runId: systemRunId } });

    assert.equal(result.outcome, 'SCHEDULE_REJECTED');
    assert.equal(result.outcome === 'SCHEDULE_REJECTED' ? result.reasonCode : null,
      'CONFIGURATION_INVALID');
    assert.deepEqual((await client.query(`SELECT global_desired_state::text,catalogue_mode::text,
      include_treasury,include_collection,reconciliation_alert_percent::text,
      reconciliation_alert_basis::text,default_currency_ids::text[]
      FROM wallet_core.wallet_settings WHERE id`)).rows[0], beforeRows);
    assert.deepEqual((await client.query(`SELECT id::text,status::text FROM
      wallet_core.configuration_changes WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [[pushed.configurationId, legacyId]])).rows.map((row) => row.status).sort(),
    ['LIVE', 'REJECTED']);
    const rejection = (await client.query(`SELECT actor_kind,run_id::text,metadata_json FROM
      admin.admin_audit_events WHERE event_key LIKE $1 AND action='SETTINGS.SCHEDULE_REJECTED'`,
    [`wallet:${legacyId}:%`])).rows[0];
    assert.equal(rejection.actor_kind, 'SYSTEM'); assert.equal(rejection.run_id, systemRunId);
    assert.equal(rejection.metadata_json.safeErrorCode, 'CONFIGURATION_INVALID');
  }));

test('WP11 Admin bootstrap reads a persisted User no-custody partial alert',
  { skip: !enabled }, () => transaction(async (client, database) => {
    const currencyId = uuidv7(); const alertId = uuidv7();
    await client.query(`INSERT INTO price_conversion.currencies
      (id,symbol,name,decimals,kind,pricing_status) VALUES($1,$2,'WP11 alert coin',18,
        'CRYPTO','DISABLED')`,
    [currencyId, `A${currencyId.replaceAll('-', '').slice(0, 20).toUpperCase()}`]);
    const payload = { runId: uuidv7(), itemId: uuidv7(), currencyId,
      partialReasons: ['CUSTODY_NOT_CONFIGURED', 'PRICE_UNAVAILABLE'],
      shortfallSuppressed: true };
    await client.query(`INSERT INTO wallet_core.wallet_alerts
      (id,dedupe_key,category,status,currency_id,payload,opened_at,updated_at)
      VALUES($1,$2,'PARTIAL_DATA','ACTIVE',$3,$4,clock_timestamp(),clock_timestamp())`,
    [alertId, `wp11-partial:${alertId}`, currencyId, payload]);
    const pages = new WalletCoreBootstrapPages(database, { publicUrl: (key) => key });

    const result = await database.transaction((tx) => pages.activeAlerts(tx, undefined, 100));
    const alert = result.items.find((item) => item.id === alertId);

    assert.equal(alert?.category, 'PARTIAL_DATA');
    assert.deepEqual(alert?.category === 'PARTIAL_DATA' ? alert.payload.partialReasons : null,
      ['CUSTODY_NOT_CONFIGURED', 'PRICE_UNAVAILABLE']);
    assert.equal(alert?.category === 'PARTIAL_DATA'
      ? alert.payload.shortfallSuppressed : null, true);
  }));

test('WP11 persists the full 10k HOT, COLD and STAKING custody boundary atomically',
  { skip: !enabled }, (context) => transaction(async (client, database) => {
    const ids = { chain: uuidv7(), currency: uuidv7(), binding: uuidv7() };
    const providerChainId = Number((await client.query(`SELECT GREATEST(
      COALESCE((SELECT max(provider_chain_id) FROM wallet_core.provider_catalogue_chains),0),
      COALESCE((SELECT max(provider_chain_id) FROM wallet_core.chains),0))+1 id`)).rows[0].id);
    const providerCoinId = 1;
    await client.query(`INSERT INTO wallet_core.provider_catalogue_chains
      (provider_chain_id,name,short_name,is_evm,provider_state,revision,refreshed_at)
      VALUES($1,'Boundary provider chain','BOUNDARY',true,'ACTIVATED',1,clock_timestamp())`,
    [providerChainId]);
    await client.query(`INSERT INTO wallet_core.provider_catalogue_currencies
      (provider_chain_id,provider_coin_id,currency_name,token_address,is_base_currency,is_stake,
       blockchain_precision,provider_state,revision,refreshed_at)
      VALUES($1,$2,'Boundary native',NULL,true,true,18,'ACTIVATED',1,clock_timestamp())`,
    [providerChainId, providerCoinId]);
    const address = (value: number) => `0x${value.toString(16).padStart(40, '0')}`;
    const hotWalletAddresses = Array.from({ length: 10_000 }, (_, index) => address(index + 1));
    const coldWalletAddresses = Array.from({ length: 10_000 }, (_, index) =>
      address(index + 10_001));
    const stakingWalletAddresses = [...hotWalletAddresses];
    const config = { chains: [{ id: ids.chain, providerChainId,
      blockchainReference: `boundary-chain-${ids.chain}`, name: 'Boundary website chain',
      shortName: `B${ids.chain.replaceAll('-', '').slice(0, 20).toUpperCase()}`, isEvm: true,
      availableFor: 'BOTH' as const, desiredState: 'ON' as const }], currencies: [{
      id: ids.currency, symbol: `B${ids.currency.replaceAll('-', '').slice(0, 20).toUpperCase()}`,
      name: 'Boundary website currency', providerRefs:
        (['COINGECKO', 'ALCHEMY', 'COINMARKETCAP'] as const).map((provider) => ({ provider,
          providerAssetId: `boundary-${provider.toLowerCase()}-${ids.currency}`,
          providerSymbol: 'BOUNDARY' })), viewEnabled: false, geoCountryDeny: [],
      geoContinentDeny: [], accessLevel: 'ALL' as const, availableFor: 'BOTH' as const,
      listingKind: 'PERMANENT' as const, showBeforeListing: false, premiumOperations: [],
      soOperations: [], postDelistOperations: [], desiredState: 'ON' as const,
      maintenanceAudiences: [], showBalanceInMaintenance: { USER: true, SO: true }, bindings: [{
        id: ids.binding, chainId: ids.chain, providerCoinId,
        blockchainReference: `boundary-native-${ids.currency}`, isToken: false,
        blockchainPrecision: 18, desiredState: 'ON' as const,
        hotWalletAddresses, coldWalletAddresses, stakingWalletAddresses }] }] };
    const repository = new WalletCoreRepository(database);
    const writer = new WalletCoreConfigurationWriter(repository,
      new AdminAuditWriterService(new AdminAuditRepository()),
      new WalletLogoAssetRepository(database));
    const locked = await database.transaction((tx) => repository.lockSettings(tx));
    const request = { action: 'PUSH' as const, expectedRevision: locked.revision,
      reason: 'WP11 full custody boundary', config };
    const payloadBytes = Buffer.byteLength(JSON.stringify(request));
    let peakRssBytes = process.memoryUsage().rss;
    const sampler = setInterval(() => {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }, 5);
    sampler.unref(); const started = process.hrtime.bigint();
    let outcome;
    try {
      outcome = await writer.updateAtomically(request, { actor: { kind: 'ADMIN',
        actorId: uuidv7(), sessionId: uuidv7(), requestId: uuidv7(), ipAddress: '127.0.0.1',
        deviceId: 'custody-boundary' } });
    } finally {
      clearInterval(sampler);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    context.diagnostic(JSON.stringify({ payloadBytes, durationMs, peakRssBytes }));
    assert.equal(outcome.outcome, 'PUSHED');
    assert.deepEqual((await client.query(`SELECT kind::text,count(*)::int count FROM
      wallet_core.custody_addresses WHERE currency_chain_id=$1 AND retired_at IS NULL
      GROUP BY kind ORDER BY kind`, [ids.binding])).rows, [
      { kind: 'COLD', count: 10_000 }, { kind: 'HOT', count: 10_000 },
      { kind: 'STAKING', count: 10_000 },
    ]);
    const overlap = (await client.query(`SELECT
      (SELECT count(*)::int FROM wallet_core.custody_addresses hot JOIN
        wallet_core.custody_addresses cold ON cold.currency_chain_id=hot.currency_chain_id
        AND cold.kind='COLD' AND cold.retired_at IS NULL
        AND cold.address_identity=hot.address_identity WHERE hot.currency_chain_id=$1
        AND hot.kind='HOT' AND hot.retired_at IS NULL) hot_cold,
      (SELECT count(*)::int FROM wallet_core.custody_addresses hot JOIN
        wallet_core.custody_addresses stake ON stake.currency_chain_id=hot.currency_chain_id
        AND stake.kind='STAKING' AND stake.retired_at IS NULL
        AND stake.address_identity=hot.address_identity WHERE hot.currency_chain_id=$1
        AND hot.kind='HOT' AND hot.retired_at IS NULL) hot_staking`, [ids.binding])).rows[0];
    assert.deepEqual(overlap, { hot_cold: 0, hot_staking: 10_000 });
    const audit = (await client.query(`SELECT before_json,after_json,metadata_json FROM
      admin.admin_audit_events WHERE event_key LIKE $1 AND action='CURRENCY.IMPORTED'`,
    [`wallet:${outcome.configurationId}:%`])).rows[0];
    assert.equal(audit.before_json, null);
    const auditedBinding = audit.after_json.config.bindings[0];
    assert.equal(auditedBinding.hotWalletAddresses.length, 10_000);
    assert.equal(auditedBinding.coldWalletAddresses.length, 10_000);
    assert.equal(auditedBinding.stakingWalletAddresses.length, 10_000);
    assert.equal(audit.metadata_json.configurationRevision, Number(outcome.revision));
    assert.equal((await client.query(`SELECT payload#>'{after,config}' config FROM
      wallet_core.state_events WHERE event_type='CURRENCY.IMPORTED'
        AND payload->>'eventKey' LIKE $1`, [`wallet:${outcome.configurationId}:%`])).rows[0].config,
    null);
  }));
