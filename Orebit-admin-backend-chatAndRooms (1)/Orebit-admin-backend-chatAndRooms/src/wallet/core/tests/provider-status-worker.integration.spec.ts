import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import pg from 'pg';

import { WalletCronjobRepository } from '../cronjob.repository.js';
import { WalletNotificationOutbox } from '../notification-outbox.js';
import { WalletProviderStatusWorker } from '../provider-status-worker.js';
import {
  createValidatedWalletCoreTestDatabase,
  WALLET_CORE_TEST_SCHEMAS,
} from '../wallet-core.database.js';
import {
  ProviderStatusAudit as Audit,
  ProviderStatusPool as Pool,
  ProviderStatusProvider as Provider,
  providerStatusFixture as fixture,
  providerStatusUuidv7 as uuidv7,
  seedProviderStatusFixture as seed,
} from './provider-status-worker.fixtures.js';

const TEST_URL = 'postgresql://orebit_wallet_core_test_owner:local_wallet_core_test_only@127.0.0.1:55435/orebit_wallet_core_test?schema=wallet_core_test';
const LIVE = process.env.NODE_ENV === 'test'
  && process.env.WALLET_CORE_TEST_ALLOW_RESET === 'true'
  && process.env.WALLET_CORE_TEST_DATABASE_URL === TEST_URL;

describe('Wallet provider-status worker', { skip: !LIVE }, () => {
  it('scopes observations and emits durable transition effects exactly once', async () => {
    const owner = new pg.Pool({ connectionString: TEST_URL, max: 1 });
    try {
      const raw = await owner.connect();
      try {
        await raw.query('BEGIN');
        const pool = new Pool(raw);
    const database = createValidatedWalletCoreTestDatabase(pool, WALLET_CORE_TEST_SCHEMAS);
    const cronjobs = new WalletCronjobRepository(database);
    const audit = new Audit();
    const value = fixture();
    const providerClient = new Provider(value);
    const worker = new WalletProviderStatusWorker({
      database, cronjobs, providerClient, audit,
      outbox: new WalletNotificationOutbox(database),
    });
    const base = Math.floor(Date.now() / 300_000) * 300_000
      - randomInt(10_000, 100_000) * 300_000;
    const runOnce = (index: number) => worker.runOnce({
      scheduledFor: new Date(base + index * 300_000),
      workerInstanceId: `task7-provider-${randomUUID()}`,
    });
    const run = async (index: number) => {
      const result = await runOnce(index);
      assert.notEqual(result, null);
      return result!;
    };
    const subjectRows = () => raw.query(`SELECT 'CHAIN' subject_type,id::text,
        provider_state::text,consecutive_failed_checks,maintenance_pinned
      FROM wallet_core_test.chains WHERE id=ANY($1::uuid[])
      UNION ALL
      SELECT 'CURRENCY_CHAIN',id::text,provider_state::text,
        consecutive_failed_checks,maintenance_pinned
      FROM wallet_core_test.currencies WHERE id=ANY($2::uuid[]) ORDER BY subject_type,id`,
    [value.chains.map((entry) => entry.id), value.bindings.map((entry) => entry.id)]);
      await seed(raw, value);
      const configuredCount = Number((await raw.query(`SELECT
        (SELECT count(*) FROM wallet_core_test.chains)
        +(SELECT count(*) FROM wallet_core_test.currencies binding JOIN
          wallet_core_test.currency_settings setting ON setting.currency_id=binding.currency_id)
        count`)).rows[0].count);

      const globalFailure = await run(0);
      assert.equal(globalFailure.status, 'FAILED');
      assert.equal(globalFailure.safeErrorCode, 'PROVIDER_OBSERVATION_FAILED');
      assert.deepEqual((await subjectRows()).rows.map((row) => row.consecutive_failed_checks),
        [1, 1, 1, 1, 1]);

      const reset = await run(1);
      assert.equal(reset.status, 'SUCCESS');
      assert.deepEqual((await subjectRows()).rows.map((row) => row.consecutive_failed_checks),
        [0, 0, 0, 0, 0]);

      const chainFailure = await run(2);
      assert.equal(chainFailure.status, 'PARTIAL');
      assert.equal(chainFailure.safeErrorCode, 'PROVIDER_OBSERVATION_PARTIAL');
      const scoped = (await subjectRows()).rows;
      const firstChain = scoped.find((row) => row.id === value.chains[0].id);
      const secondChain = scoped.find((row) => row.id === value.chains[1].id);
      const firstBinding = scoped.find((row) => row.id === value.bindings[0].id);
      const secondBinding = scoped.find((row) => row.id === value.bindings[1].id);
      const thirdBinding = scoped.find((row) => row.id === value.bindings[2].id);
      assert.equal(firstChain.consecutive_failed_checks, 0);
      assert.equal(secondChain.consecutive_failed_checks, 0);
      assert.equal(firstBinding.consecutive_failed_checks, 1);
      assert.equal(secondBinding.consecutive_failed_checks, 1);
      assert.equal(thirdBinding.consecutive_failed_checks, 0);

      const omission = await run(3);
      assert.equal(omission.status, 'PARTIAL');
      assert.equal(omission.safeErrorCode, 'PROVIDER_OBSERVATION_PARTIAL');
      const afterOmission = (await subjectRows()).rows;
      assert.equal(afterOmission.find((row) => row.id === value.bindings[0].id)
        .consecutive_failed_checks, 2);
      assert.equal(afterOmission.find((row) => row.id === value.bindings[1].id)
        .consecutive_failed_checks, 0);

      assert.equal((await run(4)).status, 'SUCCESS');
      const explicit = (await subjectRows()).rows;
      assert.equal(explicit.find((row) => row.id === value.chains[1].id).provider_state,
        'MAINTENANCE');
      assert.equal(explicit.find((row) => row.id === value.bindings[1].id).provider_state,
        'DISABLED');
      assert.equal(explicit.find((row) => row.id === value.bindings[2].id).provider_state,
        'DISABLED');

      assert.equal((await run(5)).status, 'PARTIAL');
      assert.equal((await run(6)).status, 'PARTIAL');
      assert.equal((await run(7)).status, 'PARTIAL');
      const unavailable = (await subjectRows()).rows
        .find((row) => row.id === value.bindings[0].id);
      assert.equal(unavailable.provider_state, 'UNAVAILABLE');
      assert.equal(unavailable.consecutive_failed_checks, 3);

      const recovered = await run(8);
      assert.equal(recovered.status, 'SUCCESS');
      const recoveredRows = (await subjectRows()).rows;
      const pinnedRecovery = recoveredRows.find((row) => row.id === value.bindings[0].id);
      assert.equal(pinnedRecovery.provider_state, 'ACTIVATED');
      assert.equal(pinnedRecovery.consecutive_failed_checks, 0);
      assert.equal(pinnedRecovery.maintenance_pinned, true);

      const ownSubjectIds = [
        ...value.chains.map((entry) => entry.id),
        ...value.bindings.map((entry) => entry.id),
      ];
      const beforeUnchanged = await raw.query(`SELECT
        (SELECT count(*)::int FROM wallet_core_test.wallet_alert_events event
          JOIN wallet_core_test.wallet_alerts alert ON alert.id=event.alert_id
          WHERE alert.payload->>'subjectId'=ANY($1::text[])) alert_events,
        (SELECT count(*)::int FROM wallet_core_test.wallet_notification_outbox
          WHERE payload->>'subjectId'=ANY($1::text[])) outbox_events,
        (SELECT count(*)::int FROM wallet_core_test.state_events
          WHERE subject_id=ANY($2::uuid[])) state_events`, [ownSubjectIds, ownSubjectIds]);
      assert.equal((await run(9)).status, 'SUCCESS');
      assert.deepEqual((await raw.query(`SELECT
        (SELECT count(*)::int FROM wallet_core_test.wallet_alert_events event
          JOIN wallet_core_test.wallet_alerts alert ON alert.id=event.alert_id
          WHERE alert.payload->>'subjectId'=ANY($1::text[])) alert_events,
        (SELECT count(*)::int FROM wallet_core_test.wallet_notification_outbox
          WHERE payload->>'subjectId'=ANY($1::text[])) outbox_events,
        (SELECT count(*)::int FROM wallet_core_test.state_events
          WHERE subject_id=ANY($2::uuid[])) state_events`,
      [ownSubjectIds, ownSubjectIds])).rows, beforeUnchanged.rows);

      assert.equal((await run(10)).status, 'SUCCESS');
      const chainTwoAlertBefore = (await raw.query(`SELECT id::text FROM
        wallet_core_test.wallet_alerts WHERE category='PROVIDER_MAINTENANCE'
          AND payload->>'subjectId'=$1`, [value.chains[1].id])).rows[0].id;
      const sideEffectsBeforeRepeat = (await raw.query(`SELECT
        (SELECT count(*)::int FROM wallet_core_test.wallet_alert_events event
          JOIN wallet_core_test.wallet_alerts alert ON alert.id=event.alert_id
          WHERE alert.payload->>'subjectId'=$1) alert_events,
        (SELECT count(*)::int FROM wallet_core_test.wallet_notification_outbox
          WHERE payload->>'subjectId'=$1) outbox_events,
        (SELECT count(*)::int FROM wallet_core_test.state_events
          WHERE subject_id=$1::uuid) state_events`, [value.chains[1].id])).rows[0];
      assert.equal((await run(11)).status, 'SUCCESS');
      assert.deepEqual((await raw.query(`SELECT
        (SELECT count(*)::int FROM wallet_core_test.wallet_alert_events event
          JOIN wallet_core_test.wallet_alerts alert ON alert.id=event.alert_id
          WHERE alert.payload->>'subjectId'=$1) alert_events,
        (SELECT count(*)::int FROM wallet_core_test.wallet_notification_outbox
          WHERE payload->>'subjectId'=$1) outbox_events,
        (SELECT count(*)::int FROM wallet_core_test.state_events
          WHERE subject_id=$1::uuid) state_events`, [value.chains[1].id])).rows[0],
      sideEffectsBeforeRepeat);
      assert.equal((await raw.query(`SELECT id::text FROM wallet_core_test.wallet_alerts
        WHERE category='PROVIDER_MAINTENANCE' AND payload->>'subjectId'=$1`,
      [value.chains[1].id])).rows[0].id, chainTwoAlertBefore);

      const alerts = (await raw.query(`SELECT id::text,status::text,currency_id::text,payload
        FROM wallet_core_test.wallet_alerts WHERE category='PROVIDER_MAINTENANCE'
          AND payload->>'subjectId'=ANY($1::text[]) ORDER BY payload->>'subjectId'`,
      [ownSubjectIds])).rows;
      assert.equal(alerts.length, 4);
      const pinnedAlert = alerts.find((row) => row.payload.subjectId === value.bindings[0].id);
      assert.equal(pinnedAlert.status, 'CLEARED');
      assert.equal(pinnedAlert.payload.providerState, 'ACTIVATED');
      assert.equal(pinnedAlert.payload.failureStreak, 0);
      assert.equal(pinnedAlert.payload.maintenancePinned, true);
      assert.equal(pinnedAlert.payload.effectiveState, 'MAINTAIN');
      assert.deepEqual(Object.keys(pinnedAlert.payload).sort(), [
        'effectiveState', 'failureStreak', 'maintenancePinned', 'observedAt',
        'providerReference', 'providerState', 'subjectId', 'subjectType',
      ]);
      const chainAlert = alerts.find((row) => row.payload.subjectId === value.chains[1].id);
      assert.equal(chainAlert.status, 'ACTIVE');
      assert.equal(chainAlert.id, chainTwoAlertBefore);
      assert.equal(chainAlert.currency_id, null);

      const outbox = (await raw.query(`SELECT event_type,payload FROM
        wallet_core_test.wallet_notification_outbox
        WHERE payload->>'subjectId'=ANY($1::text[]) ORDER BY created_at,id`,
      [ownSubjectIds])).rows;
      assert.deepEqual([...new Set(outbox.map((row) => row.event_type))].sort(), [
        'WALLET_PROVIDER_MAINTENANCE_ENTERED',
        'WALLET_PROVIDER_MAINTENANCE_RECOVERED',
      ]);
      assert.equal(outbox.filter((row) => row.payload.subjectId === value.chains[1].id).length, 3);
      assert.equal(outbox.filter((row) => row.payload.subjectId === value.bindings[0].id).length, 2);
      assert.equal(outbox.filter((row) => row.payload.subjectId === value.bindings[1].id).length, 2);
      assert.equal(outbox.filter((row) => row.payload.subjectId === value.bindings[2].id).length, 2);

      const providerAudits = audit.calls.filter((call) =>
        call.action === 'PROVIDER_MAINTENANCE.ENTERED'
        || call.action === 'PROVIDER_MAINTENANCE.RECOVERED');
      assert.equal(providerAudits.filter((call) => call.subject.id === value.chains[1].id).length, 3);
      assert.equal(providerAudits.filter((call) => call.subject.id === value.bindings[0].id).length, 2);
      assert.equal(providerAudits.filter((call) => call.subject.id === value.bindings[1].id).length, 2);
      const inheritedAudits = providerAudits.filter((call) =>
        call.subject.id === value.bindings[2].id);
      assert.equal(inheritedAudits.length, 2);
      assert.equal(inheritedAudits.every((call) => call.after !== null
        && 'effectiveState' in call.after && call.after.effectiveState === 'MAINTAIN'), true);
      for (const call of providerAudits) {
        assert.equal(call.actor.kind, 'SYSTEM');
        assert.ok(call.actor.runId);
        assert.deepEqual(Object.keys(call.before ?? {}).sort(),
          ['effectiveState', 'failureStreak', 'maintenancePinned']);
        assert.ok(call.after);
        assert.deepEqual(Object.keys(call.after).sort(),
          ['effectiveState', 'failureStreak', 'maintenancePinned']);
        assert.deepEqual(Object.keys(call.metadata).sort(),
          ['configurationRevision', 'providerReference']);
      }
      assert.equal(audit.calls.some((call) => call.action === 'PROVIDER_MAINTENANCE.PINNED'
        || call.action === 'PROVIDER_MAINTENANCE.UNPINNED'), false);
      const bindingStatuses = audit.calls.filter((call) =>
        call.action === 'CURRENCY.STATUS_CHANGED'
        && call.subject.id === value.bindings[1].id);
      assert.equal(bindingStatuses.length, 2);
      assert.equal(bindingStatuses.every((call) => call.subject.type === 'CURRENCY_CHAIN'), true);
      assert.equal(audit.calls.filter((call) => call.action === 'CURRENCY.STATUS_CHANGED'
        && call.subject.id === value.bindings[2].id).length, 0);
      assert.equal(providerClient.calls.length, 12);

      const auditCount = audit.calls.length;
      const eventCounts = await raw.query(`SELECT
        (SELECT count(*)::int FROM wallet_core_test.wallet_alert_events event
          JOIN wallet_core_test.wallet_alerts alert ON alert.id=event.alert_id
          WHERE alert.payload->>'subjectId'=ANY($1::text[])) alert_events,
        (SELECT count(*)::int FROM wallet_core_test.wallet_notification_outbox
          WHERE payload->>'subjectId'=ANY($1::text[])) outbox_events,
        (SELECT count(*)::int FROM wallet_core_test.state_events
          WHERE subject_id=ANY($2::uuid[])) state_events`, [ownSubjectIds, ownSubjectIds]);
      assert.equal(await runOnce(11), null);
      assert.equal(providerClient.calls.length, 12);
      assert.equal(audit.calls.length, auditCount);
      assert.deepEqual((await raw.query(`SELECT
        (SELECT count(*)::int FROM wallet_core_test.wallet_alert_events event
          JOIN wallet_core_test.wallet_alerts alert ON alert.id=event.alert_id
          WHERE alert.payload->>'subjectId'=ANY($1::text[])) alert_events,
        (SELECT count(*)::int FROM wallet_core_test.wallet_notification_outbox
          WHERE payload->>'subjectId'=ANY($1::text[])) outbox_events,
        (SELECT count(*)::int FROM wallet_core_test.state_events
          WHERE subject_id=ANY($2::uuid[])) state_events`,
      [ownSubjectIds, ownSubjectIds])).rows, eventCounts.rows);

      const chainOneId = value.chains[0].id;
      const chainOneEffects = () => raw.query(`SELECT
        (SELECT count(*)::int FROM wallet_core_test.state_events WHERE subject_id=$1) states,
        (SELECT count(*)::int FROM wallet_core_test.wallet_notification_outbox
          WHERE payload->>'subjectId'=$1::text) outbox`, [chainOneId]);
      const beforeReplay = await chainOneEffects();
      audit.replayNext = true;
      const replay = await run(12);
      assert.deepEqual({ status: replay.status, processed: replay.processedCount,
        failed: replay.failedCount },
      { status: 'PARTIAL', processed: configuredCount, failed: 1 });
      assert.equal((await raw.query(`SELECT provider_state::text FROM
        wallet_core_test.chains WHERE id=$1`, [chainOneId])).rows[0].provider_state, 'ACTIVATED');
      assert.deepEqual((await chainOneEffects()).rows, beforeReplay.rows);
      assert.deepEqual((await raw.query(`SELECT processed_count,failed_count FROM
        wallet_core_test.cronjob_runs WHERE id=$1`, [replay.runId])).rows[0],
      { processed_count: configuredCount, failed_count: 1 });

      assert.equal((await run(13)).status, 'SUCCESS');
      const beforeConflict = await chainOneEffects();
      audit.conflictNext = true;
      const conflict = await run(14);
      assert.deepEqual({ status: conflict.status, processed: conflict.processedCount,
        failed: conflict.failedCount },
      { status: 'PARTIAL', processed: configuredCount, failed: 1 });
      assert.equal((await raw.query(`SELECT provider_state::text FROM
        wallet_core_test.chains WHERE id=$1`, [chainOneId])).rows[0].provider_state,
      'MAINTENANCE');
      assert.deepEqual((await chainOneEffects()).rows, beforeConflict.rows);
      assert.equal((await run(15)).status, 'SUCCESS');

      const extras = Array.from({ length: 47 }, (_, index) => ({
        id: uuidv7(), providerId: value.chains[1].providerId + 1_000 + index,
      }));
      for (const [index, extra] of extras.entries()) await raw.query(`INSERT INTO
        wallet_core_test.chains (id,provider_chain_id,name,short_name,is_evm,
          desired_state,provider_state) VALUES ($1,$2,$3,$4,true,'ON','ACTIVATED')`,
      [extra.id, extra.providerId, `Wave Chain ${value.key} ${index}`, `X${value.key}${index}`]);
      const waveCount = configuredCount + extras.length;
      const waveSuccess = await run(16);
      assert.deepEqual({ status: waveSuccess.status, processed: waveSuccess.processedCount,
        failed: waveSuccess.failedCount },
      { status: 'SUCCESS', processed: waveCount, failed: 0 });
      assert.deepEqual((await raw.query(`SELECT processed_count,failed_count FROM
        wallet_core_test.cronjob_runs WHERE id=$1`, [waveSuccess.runId])).rows[0],
      { processed_count: waveCount, failed_count: 0 });
      const tailCount = waveCount - 50;
      const tailRows = () => raw.query(`SELECT subject_type,id,provider_state,provider_updated_at
        FROM (SELECT 'CHAIN'::text subject_type,id::text,provider_state::text,
          provider_updated_at,provider_chain_id::text sort_chain,NULL::text sort_coin
          FROM wallet_core_test.chains UNION ALL SELECT 'CURRENCY_CHAIN',binding.id::text,
          binding.provider_state::text,binding.provider_updated_at,chain.provider_chain_id::text,
          binding.provider_coin_id::text FROM wallet_core_test.currencies binding JOIN
          wallet_core_test.chains chain ON chain.id=binding.chain_id) subjects
        ORDER BY sort_chain,sort_coin NULLS FIRST,id OFFSET 50`);
      const tailBefore = await tailRows();
      assert.equal(tailBefore.rows.length, tailCount);
      const firstExtraWasDeferred = tailBefore.rows.some((row) => row.id === extras[0]?.id);
      audit.replayAll = true;
      const stopped = await run(17);
      assert.deepEqual({ status: stopped.status, processed: stopped.processedCount,
        failed: stopped.failedCount }, { status: 'FAILED', processed: 0, failed: 50 });
      assert.deepEqual((await raw.query(`SELECT processed_count,failed_count FROM
        wallet_core_test.cronjob_runs WHERE id=$1`, [stopped.runId])).rows[0],
      { processed_count: 0, failed_count: 50 });
      assert.deepEqual((await tailRows()).rows, tailBefore.rows);
      audit.beginReplayAfter(50);
      const laterStopped = await run(18);
      const secondWaveCount = Math.min(waveCount - 50, 50);
      assert.deepEqual({ status: laterStopped.status, processed: laterStopped.processedCount,
        failed: laterStopped.failedCount },
      { status: 'PARTIAL', processed: 50 + secondWaveCount, failed: secondWaveCount });
      assert.deepEqual((await raw.query(`SELECT processed_count,failed_count FROM
        wallet_core_test.cronjob_runs WHERE id=$1`, [laterStopped.runId])).rows[0],
      { processed_count: 50 + secondWaveCount, failed_count: secondWaveCount });
      assert.equal((await raw.query(`SELECT provider_state::text FROM wallet_core_test.chains
        WHERE id=$1`, [extras[0]?.id])).rows[0].provider_state,
      firstExtraWasDeferred ? 'ACTIVATED' : 'MAINTENANCE');
      assert.deepEqual((await tailRows()).rows, tailBefore.rows);
      assert.equal(providerClient.calls.length, 19);
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined);
        raw.release();
      }
    } finally {
      await owner.end();
    }
  });

  it('accepts only exact semantic notification-outbox dedupe matches', async () => {
    const owner = new pg.Pool({ connectionString: TEST_URL, max: 1 });
    try {
      const raw = await owner.connect();
      try {
        await raw.query('BEGIN');
        const database = createValidatedWalletCoreTestDatabase(
          new Pool(raw), WALLET_CORE_TEST_SCHEMAS,
        );
        const outbox = new WalletNotificationOutbox(database);
        const dedupeKey = `task7-outbox-${randomUUID()}`;
        const subjectId = uuidv7();
      await database.transaction(async (client) => {
        await outbox.enqueueWithClient(client, { eventType: 'WALLET_PROVIDER_MAINTENANCE_ENTERED',
          dedupeKey, payload: { subjectId, facts: { state: 'MAINTAIN', streak: 3 } } });
        await outbox.enqueueWithClient(client, { eventType: 'WALLET_PROVIDER_MAINTENANCE_ENTERED',
          dedupeKey, payload: { facts: { streak: 3, state: 'MAINTAIN' },
            subjectId } });
      });
      await assert.rejects(() => database.transaction((client) => outbox.enqueueWithClient(client,
        { eventType: 'WALLET_PROVIDER_MAINTENANCE_ENTERED', dedupeKey,
          payload: { subjectId: uuidv7() } })), /WALLET_NOTIFICATION_OUTBOX_CONFLICT/);
      await assert.rejects(() => database.transaction((client) => outbox.enqueueWithClient(client,
        { eventType: 'WALLET_PROVIDER_MAINTENANCE_RECOVERED', dedupeKey,
          payload: { subjectId, facts: { state: 'MAINTAIN', streak: 3 } } })),
      /WALLET_NOTIFICATION_OUTBOX_CONFLICT/);
      assert.equal((await raw.query(`SELECT count(*)::int count FROM
        wallet_core_test.wallet_notification_outbox WHERE dedupe_key=$1`, [dedupeKey])).rows[0].count, 1);
      } finally {
        await raw.query('ROLLBACK').catch(() => undefined);
        raw.release();
      }
    } finally {
      await owner.end();
    }
  });
});
