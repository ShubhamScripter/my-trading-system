import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WalletCoreConfigurationWriter } from '../wallet-core.configuration-writer.js';
import type { WalletCoreRepository } from '../wallet-core.repository.js';

const IDS = { admin: '01980000-0000-7000-8000-000000000001',
  session: '01980000-0000-7000-8000-000000000002',
  request: '01980000-0000-7000-8000-000000000003',
  change: '01980000-0000-7000-8000-000000000004',
  chain: '01980000-0000-7000-8000-000000000005',
  run: '01980000-0000-7000-8000-000000000006' } as const;
const previousSettings = { globalDesiredState: 'ON' as const, catalogueMode: 'ALL' as const,
  reconciliationIncludeTreasury: true, reconciliationIncludeCollection: false,
  reconciliationAlertPercent: '5', reconciliationAlertBasis: 'SIGNED' as const,
  defaultCurrencyIds: [] };
const nextSettings = { ...previousSettings, reconciliationAlertPercent: '10' };
const ADMIN = { actor: { kind: 'ADMIN' as const, actorId: IDS.admin,
  sessionId: IDS.session, requestId: IDS.request, ipAddress: '127.0.0.1',
  deviceId: 'audit-evidence' } };
const SYSTEM = { actor: { kind: 'SYSTEM' as const, runId: IDS.run } };

describe('complete Wallet configuration audit evidence', () => {
  it('records normalized effective settings before and after a manual push', async () => {
    const audits: any[] = [];
    const repository = {
      transaction: async (work: (client: object) => Promise<unknown>) => work({}),
      lockSettings: async () => ({ revision: 7, settings: previousSettings }),
      captureCatalogue: async () => ({ chains: [], currencies: [] }),
      validateCatalogue: async () => null,
      insertChange: async () => undefined,
      advanceRevision: async () => undefined,
      archiveCurrentLive: async () => null,
      applyConfiguration: async () => [],
      applySettings: async () => true,
      transitionChange: async () => null,
      appendStateEvent: async () => undefined,
    } as unknown as WalletCoreRepository;
    const writer = new WalletCoreConfigurationWriter(repository, {
      appendWithTransaction: async (_client: unknown, input: unknown) => {
        audits.push(input); return { id: IDS.request, replayed: false };
      },
    }, { attachReferencedWithTransaction: async () => undefined });

    await writer.updateAtomically({ action: 'PUSH', expectedRevision: 7,
      reason: 'settings evidence', config: { settings: nextSettings } }, ADMIN);

    const event = audits.find((entry) => entry.action === 'SETTINGS.PUSHED');
    assert.deepEqual(event.before.config, { settings: previousSettings });
    assert.deepEqual(event.after.config, { settings: nextSettings });
  });

  it('sends every scheduled entity and pin change to global Audit with correlation', async () => {
    const audits: any[] = [];
    const config = { chains: [{ id: IDS.chain, providerChainId: 42,
      blockchainReference: 'chain', name: 'Chain', shortName: 'CHAIN', isEvm: true,
      availableFor: 'BOTH' as const, desiredState: 'OFF' as const }],
    providerPins: [{ subject: 'CHAIN' as const, subjectId: IDS.chain, pinned: true }] };
    const catalogue = { chains: [{ providerChainId: 42, name: 'Provider Chain',
      shortName: 'PROVIDER', isEvm: true, providerState: 'ACTIVATED', revision: 3 }],
    currencies: [] };
    const repository = {
      lockSettings: async () => ({ revision: 8, settings: previousSettings }),
      lockChange: async () => ({ id: IDS.change, revision: 8, status: 'SCHEDULED',
        effectiveAt: '2026-09-10T00:00:00.000000Z', appliedAt: null,
        reason: 'scheduled evidence', changelogId: null, actorId: IDS.admin,
        snapshot: { config, catalogue } }),
      isChangeDue: async () => true,
      validateCatalogue: async () => null,
      configurationWouldChange: async () => true,
      archiveCurrentLive: async () => null,
      applyConfiguration: async () => [{ action: 'CHAIN.UPDATED',
        subject: { type: 'CHAIN', id: IDS.chain }, before: { name: 'Old' },
        after: { name: 'Chain' } }, { action: 'PROVIDER_MAINTENANCE.PINNED',
        subject: { type: 'CHAIN', id: IDS.chain }, before: { maintenancePinned: false },
        after: { maintenancePinned: true } }],
      transitionChange: async () => null,
      appendStateEvent: async () => undefined,
    } as unknown as WalletCoreRepository;
    const writer = new WalletCoreConfigurationWriter(repository, {
      appendWithTransaction: async (_client: unknown, input: unknown) => {
        audits.push(input); return { id: IDS.request, replayed: false };
      },
    }, { attachReferencedWithTransaction: async () => undefined });

    await writer.applyScheduledChangeWithClient({} as never, IDS.change,
      new Date('2026-09-10T00:00:01.000Z'), SYSTEM);

    assert.deepEqual(audits.map((entry) => entry.action).sort(), [
      'CHAIN.UPDATED', 'PROVIDER_MAINTENANCE.PINNED', 'SETTINGS.SCHEDULE_APPLIED',
    ]);
    assert.ok(audits.filter((entry) => entry.action !== 'SETTINGS.SCHEDULE_APPLIED')
      .every((entry) => entry.metadata.scheduledChangeId === IDS.change));
  });
});
