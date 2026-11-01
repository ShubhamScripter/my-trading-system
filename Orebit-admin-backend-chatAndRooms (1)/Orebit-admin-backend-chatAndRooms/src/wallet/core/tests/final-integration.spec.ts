import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enabled, integration } from './final-integration.fixture.js';
import { WalletConfigurationInvalid } from '../wallet-core.errors.js';

test('mixed-case C-ordered custody sets reject identical and reordered PUSH and SCHEDULE with no persistence effects', { skip: !enabled },
  () => integration(async ({ client, writer, currency, actor, custodyWrites }) => {
    const sqlOrder = (await client.query(`SELECT wallet_address FROM wallet_core.custody_addresses
      WHERE currency_chain_id=$1 AND retired_at IS NULL ORDER BY wallet_address COLLATE "C"`, [currency.bindings[0]!.id])).rows.map(r => r.wallet_address);
    assert.deepEqual(sqlOrder, ['ZebraAddress','appleAddress']);
    assert.deepEqual([...sqlOrder].sort((a,b) => a.localeCompare(b)), ['appleAddress','ZebraAddress']);
    const state = async () => (await client.query(`SELECT
      (SELECT revision FROM wallet_core.wallet_settings WHERE id)::text revision,
      (SELECT count(*) FROM wallet_core.configuration_changes)::int changes,
      (SELECT count(*) FROM admin.admin_audit_events)::int audits,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM wallet_core.custody_addresses a WHERE currency_chain_id=$1) addresses`, [currency.bindings[0]!.id])).rows[0];
    const before = await state();
    custodyWrites.length = 0;
    for (const addresses of [sqlOrder, [...sqlOrder].reverse()]) for (const action of ['PUSH','SCHEDULE'] as const) {
      const next = { ...currency, bindings: [{ ...currency.bindings[0]!, hotWalletAddresses: addresses }] };
      await assert.rejects(() => writer.updateAtomically({ action, expectedRevision: Number(before.revision),
        reason: 'Unchanged mixed-case set', ...(action === 'SCHEDULE' ? { effectiveAt: '2099-09-10T00:00:00.000Z' } : {}),
        config: { currencies: [next] } }, actor), WalletConfigurationInvalid);
      assert.deepEqual(await state(), before);
      assert.deepEqual(custodyWrites, [], 'unchanged custody never enters retirement/recreation, including rolled-back previews');
    }
  }));

test('Admin denomination flag rejects User PATCH, retains saved choice and holdings, skips hidden BTC/ETH and recovers', { skip: !enabled },
  () => integration(async ({ client, pool, currency, push }) => {
    // Load the independent User owner at runtime without extending Admin's TypeScript root.
    const userCore = '../../../../../orebit-backend/src/wallet/core/';
    const { WalletCoreDatabase, WALLET_CORE_TEST_SCHEMAS } = await import(userCore + 'wallet-core.database.ts');
    const { WalletCoreRepository } = await import(userCore + 'wallet-core.repository.ts');
    const { WalletCoreService } = await import(userCore + 'wallet-core.service.ts');
    const { bootstrapFixture, userId } = await import(userCore + 'tests/bootstrap-fixture.ts');
    const repository = new WalletCoreRepository(WalletCoreDatabase.validatedTest(pool, WALLET_CORE_TEST_SCHEMAS));
    const { dependencies } = bootstrapFixture(); dependencies.repository = repository;
    dependencies.ledger.getOwnerBalances = async () => [{ accountId: currency.id!, currencyId: currency.id!,
      ownerId: userId, ownerType: 'USER', bucket: 'AVAILABLE', balance: '2', version: 0n }];
    const service = new WalletCoreService(dependencies);
    await client.query("UPDATE wallet_core.wallet_settings SET global_desired_state='ON',catalogue_mode='ALL' WHERE id");
    const fallbacks: string[] = [];
    for (const symbol of ['BTC','ETH']) {
      let master = (await client.query('SELECT id::text FROM price_conversion.currencies WHERE symbol=$1', [symbol])).rows[0];
      if (!master) master = (await client.query(`INSERT INTO price_conversion.currencies(symbol,name,decimals,kind,pricing_status)
        VALUES($1,$1,18,'CRYPTO','ACTIVE') RETURNING id::text`, [symbol])).rows[0];
      fallbacks.push(master.id);
      await client.query(`INSERT INTO wallet_core.currency_settings(currency_id) VALUES($1) ON CONFLICT DO NOTHING`, [master.id]);
    }
    await client.query(`UPDATE wallet_core.currency_settings SET view_currency_enabled=true,desired_state='ON',price_readiness='HEALTHY',
      geo_countries='{}',geo_continents='{}',available_for='BOTH',access_level='ALL',listing_start_at=NULL,delist_at=NULL,
      maintain_users=false WHERE currency_id=ANY($1::uuid[])`, [[currency.id,...fallbacks]]);
    await client.query("UPDATE price_conversion.currencies SET auto_disabled=false,pricing_status='ACTIVE' WHERE id=ANY($1::uuid[])", [[currency.id,...fallbacks]]);
    await service.updatePreferences(userId, { preferredCryptoId: currency.id });
    const before = await service.getWallet(userId,{limit:100});
    assert.equal(before.preferences.effective.preferredCryptoId,currency.id);
    const holding = before.currencies.items.find((item: { currencyId: string }) => item.currencyId === currency.id);
    assert.equal(holding?.balances.available, '2');
    await push({ ...currency,viewEnabled:false });
    assert.equal((await client.query('SELECT view_currency_enabled FROM wallet_core.currency_settings WHERE currency_id=$1',[currency.id])).rows[0].view_currency_enabled,false);
    await assert.rejects(() => service.updatePreferences(userId,{preferredCryptoId:currency.id}), /Invalid Wallet preference/);
    for (const expected of [...fallbacks,null]) {
      const result = await service.getWallet(userId,{limit:100});
      assert.equal(result.preferences.saved.preferredCryptoId,currency.id);
      assert.equal(result.preferences.effective.preferredCryptoId,expected);
      assert.deepEqual(result.currencies.items.find((item: { currencyId: string })=>item.currencyId===currency.id),holding);
      if (expected) await client.query('UPDATE wallet_core.currency_settings SET view_currency_enabled=false WHERE currency_id=$1',[expected]);
    }
    await push(currency);
    assert.equal((await service.getWallet(userId,{limit:100})).preferences.effective.preferredCryptoId,currency.id);
    assert.equal((await client.query('SELECT preferred_cryptocurrency_id::text id FROM wallet_core.user_preferences WHERE user_id=$1',[userId])).rows[0].id,currency.id);
  }));
