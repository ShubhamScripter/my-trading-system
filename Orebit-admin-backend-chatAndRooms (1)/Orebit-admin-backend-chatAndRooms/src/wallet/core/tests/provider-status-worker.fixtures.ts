import { randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';

import type { AdminAuditPort, WalletCoreAdminAuditInput } from '../../../admin-audits/index.js';
import type {
  BlockchainAdminClient,
  NormalizedCatalogueSnapshot,
} from '../blockchain-admin.client.js';
import type {
  ProviderObservationResult,
  ProviderObservationScope,
} from '../wallet-core.types.js';
import type {
  WalletCoreClient,
  WalletCorePool,
} from '../wallet-core.database.js';

export class ProviderStatusClient implements WalletCoreClient {
  constructor(private readonly client: pg.PoolClient) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ) {
    const statement = sql === 'BEGIN' ? 'SAVEPOINT provider_status_worker_transaction'
      : sql === 'COMMIT' ? 'RELEASE SAVEPOINT provider_status_worker_transaction' : sql;
    if (sql === 'ROLLBACK') {
      await this.client.query('ROLLBACK TO SAVEPOINT provider_status_worker_transaction');
      const result = await this.client.query('RELEASE SAVEPOINT provider_status_worker_transaction');
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    }
    const result = await this.client.query(statement, values as unknown[]);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
  release(): void {}
}

export class ProviderStatusPool implements WalletCorePool {
  constructor(readonly client: pg.PoolClient) {}
  async connect(): Promise<WalletCoreClient> {
    return new ProviderStatusClient(this.client);
  }
  async end(): Promise<void> {}
}

export function providerStatusUuidv7(): string {
  const chars = randomUUID().split('');
  chars[14] = '7'; chars[19] = '8';
  return chars.join('');
}

export class ProviderStatusAudit implements AdminAuditPort {
  readonly calls: WalletCoreAdminAuditInput[] = [];
  replayNext = false;
  replayAll = false;
  conflictNext = false;
  private replayAfter: number | null = null;
  private transitionIndex = 0;
  beginReplayAfter(successfulTransitions: number): void {
    this.replayAll = false;
    this.replayAfter = successfulTransitions;
    this.transitionIndex = 0;
  }
  async appendWithTransaction(tx: unknown, input: WalletCoreAdminAuditInput) {
    this.calls.push(input);
    const transition = input.action === 'PROVIDER_MAINTENANCE.ENTERED'
      || input.action === 'PROVIDER_MAINTENANCE.RECOVERED';
    const replayed = transition && (this.replayAll || this.replayNext
      || (this.replayAfter !== null && this.transitionIndex >= this.replayAfter));
    if (transition) { this.replayNext = false; this.transitionIndex += 1; }
    if (transition && this.conflictNext && input.actor.kind === 'SYSTEM') {
      this.conflictNext = false;
      const eventType = input.action.endsWith('ENTERED')
        ? 'WALLET_PROVIDER_MAINTENANCE_ENTERED' : 'WALLET_PROVIDER_MAINTENANCE_RECOVERED';
      await (tx as WalletCoreClient).query(`INSERT INTO
        wallet_core_test.wallet_notification_outbox
        (id,event_type,dedupe_key,payload,status) VALUES ($1,$2,$3,$4,'PENDING')`, [
        providerStatusUuidv7(), eventType,
        `${eventType}:${input.actor.runId}:${input.subject.type}:${input.subject.id}`,
        { conflict: true },
      ]);
    }
    return { id: providerStatusUuidv7(), replayed };
  }
}

type Step = (scope: ProviderObservationScope) => ProviderObservationResult;
export class ProviderStatusProvider implements BlockchainAdminClient {
  readonly calls: ProviderObservationScope[] = [];
  private readonly steps: Step[];
  constructor(value: ProviderStatusFixture) { this.steps = sequence(value); }
  async fetchCompleteCatalogue(): Promise<NormalizedCatalogueSnapshot> {
    throw new Error('catalogue refresh is outside this worker');
  }
  async fetchScopedProviderObservations(
    scope: ProviderObservationScope,
    checkpoint?: () => Promise<void>,
  ): Promise<ProviderObservationResult> {
    this.calls.push(scope);
    await checkpoint?.();
    const step = this.steps.shift();
    if (!step) throw new Error('TASK7_PROVIDER_STEP_MISSING');
    return step(scope);
  }
}

export function providerStatusFixture() {
  const key = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  const base = 200_000_000 + randomInt(100_000_000);
  return {
    key,
    chains: [
      { id: providerStatusUuidv7(), providerId: base + 1 },
      { id: providerStatusUuidv7(), providerId: base + 2 },
    ],
    bindings: [
      { id: randomUUID(), currencyId: randomUUID(), chain: 0, providerId: base + 11,
        pinned: true },
      { id: randomUUID(), currencyId: randomUUID(), chain: 0, providerId: base + 12,
        pinned: false },
      { id: randomUUID(), currencyId: randomUUID(), chain: 1, providerId: base + 21,
        pinned: false },
    ],
  } as const;
}
export type ProviderStatusFixture = ReturnType<typeof providerStatusFixture>;

const observed = (
  scope: ProviderObservationScope,
  options: Readonly<{
    chainStates?: ReadonlyMap<number, 'ACTIVATED' | 'DISABLED' | 'MAINTENANCE'>;
    bindingStates?: ReadonlyMap<string, 'ACTIVATED' | 'DISABLED' | 'MAINTENANCE'>;
    omittedBindings?: ReadonlySet<string>;
    failedBindingChains?: ReadonlySet<number>;
  }> = {},
): ProviderObservationResult => ({
  chains: scope.chains.map((chain) => ({
    outcome: 'OBSERVED', providerChainId: chain.providerChainId,
    providerState: options.chainStates?.get(chain.providerChainId) ?? 'ACTIVATED',
  })),
  bindings: scope.chains.flatMap((chain) => options.failedBindingChains?.has(chain.providerChainId)
    ? [] : chain.bindings.map((binding) => {
      const key = `${chain.providerChainId}:${binding.providerCoinId}`;
      return options.omittedBindings?.has(key)
        ? { outcome: 'OMITTED' as const, providerChainId: chain.providerChainId,
            providerCoinId: binding.providerCoinId }
        : { outcome: 'OBSERVED' as const, providerChainId: chain.providerChainId,
            providerCoinId: binding.providerCoinId,
            providerState: options.bindingStates?.get(key) ?? 'ACTIVATED' as const };
    })),
  failures: [...(options.failedBindingChains ?? [])].map((providerChainId) => ({
    scope: 'CHAIN' as const, providerChainId, safeErrorCode: 'TIMEOUT' as const,
  })),
});

const bindingKey = (value: ProviderStatusFixture, index: number): string => {
  const binding = value.bindings[index];
  if (!binding) throw new Error('TASK7_TEST_BINDING_MISSING');
  return `${value.chains[binding.chain].providerId}:${binding.providerId}`;
};

function sequence(value: ProviderStatusFixture): Step[] {
  const chainOne = value.chains[0].providerId;
  const chainTwo = value.chains[1].providerId;
  const firstBinding = bindingKey(value, 0);
  const secondBinding = bindingKey(value, 1);
  const thirdBinding = bindingKey(value, 2);
  return [
    () => ({ chains: [], bindings: [],
      failures: [{ scope: 'ALL', safeErrorCode: 'TRANSPORT_ERROR' }] }),
    (scope) => observed(scope),
    (scope) => observed(scope, { failedBindingChains: new Set([chainOne]) }),
    (scope) => observed(scope, { omittedBindings: new Set([firstBinding]) }),
    (scope) => observed(scope, { chainStates: new Map([[chainTwo, 'MAINTENANCE']]),
      bindingStates: new Map([[secondBinding, 'DISABLED'], [thirdBinding, 'DISABLED']]) }),
    (scope) => observed(scope, { chainStates: new Map([[chainTwo, 'MAINTENANCE']]),
      omittedBindings: new Set([firstBinding]) }),
    (scope) => observed(scope, { omittedBindings: new Set([firstBinding]) }),
    (scope) => observed(scope, { omittedBindings: new Set([firstBinding]) }),
    (scope) => observed(scope),
    (scope) => observed(scope),
    (scope) => observed(scope, { chainStates: new Map([[chainTwo, 'MAINTENANCE']]) }),
    (scope) => observed(scope, { chainStates: new Map([[chainTwo, 'MAINTENANCE']]) }),
    (scope) => observed(scope, { chainStates: new Map([[chainOne, 'MAINTENANCE']]) }),
    (scope) => observed(scope, { chainStates: new Map([[chainOne, 'MAINTENANCE']]) }),
    (scope) => observed(scope), (scope) => observed(scope), (scope) => observed(scope),
    (scope) => observed(scope, {
      chainStates: new Map(scope.chains.map((entry) => [entry.providerChainId, 'MAINTENANCE'])),
      bindingStates: new Map(scope.chains.flatMap((entry) => entry.bindings.map((binding) =>
        [`${entry.providerChainId}:${binding.providerCoinId}`, 'MAINTENANCE']))),
    }),
    (scope) => observed(scope, {
      chainStates: new Map(scope.chains.map((entry) => [entry.providerChainId, 'MAINTENANCE'])),
      bindingStates: new Map(scope.chains.flatMap((entry) => entry.bindings.map((binding) =>
        [`${entry.providerChainId}:${binding.providerCoinId}`, 'MAINTENANCE']))),
    }),
  ];
}

export async function seedProviderStatusFixture(
  client: pg.PoolClient,
  value: ProviderStatusFixture,
): Promise<void> {
  for (const [index, chain] of value.chains.entries()) await client.query(`INSERT INTO
      wallet_core_test.chains (id,provider_chain_id,name,short_name,is_evm,desired_state,
        provider_state) VALUES ($1,$2,$3,$4,true,'ON','ACTIVATED')`,
  [chain.id, chain.providerId, `Provider Chain ${value.key} ${index}`, `P${value.key}${index}`]);
  for (const [index, binding] of value.bindings.entries()) {
    const symbol = `W${value.key.slice(0, 5)}${index}`;
    await client.query(`INSERT INTO price_conversion_test.currencies
        (id,symbol,name,decimals,kind,pricing_status)
        VALUES ($1,$2,$3,18,'CRYPTO','DISABLED')`,
    [binding.currencyId, symbol, `Worker Currency ${value.key} ${index}`]);
    await client.query(`INSERT INTO wallet_core_test.currency_settings
        (currency_id,desired_state,price_readiness) VALUES ($1,'ON','HEALTHY')`,
    [binding.currencyId]);
    await client.query(`INSERT INTO wallet_core_test.currencies
        (id,currency_id,chain_id,provider_coin_id,is_token,is_native,
         token_contract_address,blockchain_precision,desired_state,maintenance_pinned,provider_state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,18,'ON',$8,'ACTIVATED')`,
    [binding.id, binding.currencyId, value.chains[binding.chain].id,
      binding.providerId, index === 1, index !== 1,
      index === 1 ? `0x${value.key.toLowerCase().padEnd(40, '0')}` : null,
      binding.pinned]);
  }
}
