import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WalletCoreConfigurationWriter } from '../wallet-core.configuration-writer.js';
import { WalletConfigurationInvalid } from '../wallet-core.errors.js';
import type { WalletCoreRepository } from '../wallet-core.repository.js';

const ACTOR = { actor: { kind: 'ADMIN' as const,
  actorId: '01980000-0000-7000-8000-000000000001',
  sessionId: '01980000-0000-7000-8000-000000000002',
  requestId: '01980000-0000-7000-8000-000000000003',
  ipAddress: '127.0.0.1', deviceId: 'schedule-noop' } };
const patch = { action: 'SCHEDULE' as const, expectedRevision: 7,
  reason: 'true no-op schedule', effectiveAt: '2099-09-10T00:00:00.000Z',
  config: { settings: { globalDesiredState: 'ON' as const, catalogueMode: 'ALL' as const,
    reconciliationIncludeTreasury: true, reconciliationIncludeCollection: false,
    reconciliationAlertPercent: '5', defaultCurrencyIds: [] } } };
const SYSTEM = { actor: { kind: 'SYSTEM' as const,
  runId: '01980000-0000-7000-8000-000000000004' } };

describe('scheduled Wallet no-op creation', () => {
  it('rejects against current effective state before revision, change, logo or audit writes', async () => {
    const calls: string[] = [];
    const repository = {
      transaction: async (work: (client: object) => Promise<unknown>) => work({}),
      lockSettings: async () => ({ revision: 7 }),
      captureCatalogue: async () => ({ chains: [], currencies: [] }),
      validateCatalogue: async () => null,
      configurationWouldChange: async () => false,
      insertChange: async () => { calls.push('insert'); },
      advanceRevision: async () => { calls.push('revision'); },
      transitionChange: async () => { calls.push('transition'); return patch.effectiveAt; },
    } as unknown as WalletCoreRepository;
    const writer = new WalletCoreConfigurationWriter(repository, {
      appendWithTransaction: async () => { calls.push('audit'); return { id: ACTOR.actor.requestId,
        replayed: false }; },
    }, { attachReferencedWithTransaction: async () => { calls.push('logo'); } });

    await assert.rejects(() => writer.updateAtomically(patch, ACTOR),
      WalletConfigurationInvalid);
    assert.deepEqual(calls, []);
  });

  it('preserves current revision semantics for a real effective change', async () => {
    const calls: string[] = [];
    const repository = {
      transaction: async (work: (client: object) => Promise<unknown>) => work({}),
      lockSettings: async () => ({ revision: 7 }),
      captureCatalogue: async () => ({ chains: [], currencies: [] }),
      validateCatalogue: async () => null,
      configurationWouldChange: async () => true,
      insertChange: async () => { calls.push('insert'); },
      advanceRevision: async () => { calls.push('revision'); },
      transitionChange: async () => { calls.push('transition'); return patch.effectiveAt; },
      appendStateEvent: async () => { calls.push('state'); },
    } as unknown as WalletCoreRepository;
    const writer = new WalletCoreConfigurationWriter(repository, {
      appendWithTransaction: async () => { calls.push('audit'); return {
        id: ACTOR.actor.requestId, replayed: false }; },
    }, { attachReferencedWithTransaction: async () => { calls.push('logo'); } });

    const result = await writer.updateAtomically(patch, ACTOR);

    assert.equal(result.outcome, 'SCHEDULED');
    assert.deepEqual(calls, ['insert', 'logo', 'revision', 'transition', 'state', 'audit']);
  });

  it('rejects a valid legacy scheduled no-op without archiving LIVE or retaining preview writes',
    async () => {
      const calls: string[] = [];
      const repository = {
        lockSettings: async () => ({ revision: 7 }),
        lockChange: async () => ({ id: '01980000-0000-7000-8000-000000000010',
          revision: 7, status: 'SCHEDULED', effectiveAt: '2026-09-10T00:00:00.000000Z',
          appliedAt: null, reason: 'legacy no-op', changelogId: null,
          actorId: ACTOR.actor.actorId, snapshot: { config: { settings: {
            globalDesiredState: 'ON', catalogueMode: 'ALL',
            reconciliationIncludeTreasury: true, reconciliationIncludeCollection: false,
            reconciliationAlertPercent: '5' } }, catalogue: { chains: [], currencies: [] } } }),
        isChangeDue: async () => true,
        validateCatalogue: async () => null,
        configurationWouldChange: async () => { calls.push('preview'); return false; },
        archiveCurrentLive: async () => { calls.push('archive'); },
        applyConfiguration: async () => { calls.push('apply'); return []; },
        applySettings: async () => { calls.push('settings'); return false; },
        transitionChange: async () => { calls.push('reject'); return null; },
        appendStateEvent: async () => { calls.push('state'); },
      } as unknown as WalletCoreRepository;
      const writer = new WalletCoreConfigurationWriter(repository, {
        appendWithTransaction: async () => { calls.push('audit'); return {
          id: ACTOR.actor.requestId, replayed: false }; },
      }, { attachReferencedWithTransaction: async () => undefined });

      const result = await writer.applyScheduledChangeWithClient({} as never,
        '01980000-0000-7000-8000-000000000010',
        new Date('2026-09-10T00:00:01.000Z'), SYSTEM);

      assert.equal(result.outcome, 'SCHEDULE_REJECTED');
      assert.deepEqual(calls, ['preview', 'reject', 'state', 'audit']);
    });
});
