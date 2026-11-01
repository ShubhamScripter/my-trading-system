import { uuidv7 } from '../../utils/public.utils.js';
import type {
  AdminAuditPort,
  WalletCoreAdminAuditInput,
} from '../../admin-audits/admin-audit.types.js';
import type { BlockchainAdminClient } from './blockchain-admin.client.js';
import {
  WalletCronLeaseLost,
  WalletCronjobRepository,
  type WalletCronjobLease,
} from './cronjob.repository.js';
import { WalletNotificationOutbox } from './notification-outbox.js';
import type { WalletCoreClient, WalletCoreDatabase } from './wallet-core.database.js';
import { resolveProviderMaintenanceObservation, selectDesiredState } from './wallet-core.policy.js';
import { persistProviderWaves } from './provider-request-wave.js';
import type {
  ProviderMaintenanceAlertPayload,
  ProviderObservationResult,
  ProviderObservationScope,
  WalletCronRunOutcome,
  WalletDesiredState,
  WalletProviderCheckOutcome,
  WalletProviderState,
} from './wallet-core.types.js';
export const WALLET_PROVIDER_STATUS_JOB_NAME = 'wallet-provider-status-sync';
interface ProviderSubject {
  readonly subjectType: 'CHAIN' | 'CURRENCY_CHAIN';
  readonly subjectId: string;
  readonly currencyId: string | null;
  readonly providerChainId: number;
  readonly providerCoinId: number | null;
  readonly providerState: WalletProviderState;
  readonly failureStreak: number;
  readonly maintenancePinned: boolean;
  readonly desiredState: WalletDesiredState;
}
type StoredProviderMaintenancePayload = Omit<
  ProviderMaintenanceAlertPayload,
  'category'
>;
interface SubjectRow extends Record<string, unknown> {
  readonly subject_type: unknown;
  readonly subject_id: unknown;
  readonly currency_id: unknown;
  readonly provider_chain_id: unknown;
  readonly provider_coin_id: unknown;
  readonly provider_state: unknown;
  readonly failure_streak: unknown;
  readonly maintenance_pinned: unknown;
  readonly global_desired_state: unknown;
  readonly chain_desired_state: unknown;
  readonly chain_provider_state: unknown; readonly chain_maintenance_pinned: unknown;
  readonly currency_desired_state: unknown;
  readonly binding_desired_state: unknown;
}
export interface WalletProviderStatusWorkerInput {
  readonly scheduledFor: Date;
  readonly workerInstanceId: string;
}
export type WalletProviderStatusWorkerResult = (WalletCronRunOutcome & Readonly<{
  runId: string;
  processedCount: number;
  failedCount: number;
}>) | null;
const providerState = (value: unknown): WalletProviderState => {
  if (value === 'ACTIVATED' || value === 'DISABLED'
    || value === 'MAINTENANCE' || value === 'UNAVAILABLE') return value;
  throw new Error('WALLET_PROVIDER_STATUS_DATABASE_RESULT_INVALID');
};
const desiredState = (value: unknown): WalletDesiredState => {
  if (value === 'ON' || value === 'OFF' || value === 'MAINTAIN') return value;
  throw new Error('WALLET_PROVIDER_STATUS_DATABASE_RESULT_INVALID');
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('WALLET_PROVIDER_STATUS_DATABASE_RESULT_INVALID');
  }
  return value;
};
const optionalText = (value: unknown): string | null => value === null ? null : text(value);
const bool = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('WALLET_PROVIDER_STATUS_DATABASE_RESULT_INVALID');
  return value;
};
const integer = (value: unknown, allowZero = false): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error('WALLET_PROVIDER_STATUS_DATABASE_RESULT_INVALID');
  }
  return parsed;
};
const effectiveState = (
  desired: WalletDesiredState,
  pinned: boolean,
  state: WalletProviderState,
): WalletDesiredState => desired === 'OFF' ? 'OFF'
  : desired === 'MAINTAIN' || pinned || state !== 'ACTIVATED' ? 'MAINTAIN' : 'ON';
/** Observes configured provider subjects and persists maintenance transitions under one cron claim. */
export class WalletProviderStatusWorker {
  private readonly wallet: string;
  constructor(private readonly dependencies: Readonly<{
    database: WalletCoreDatabase;
    cronjobs: WalletCronjobRepository;
    providerClient: BlockchainAdminClient;
    audit: AdminAuditPort;
    outbox: WalletNotificationOutbox;
  }>) {
    this.wallet = dependencies.database.schemas.wallet;
  }

  async runOnce(input: WalletProviderStatusWorkerInput): Promise<WalletProviderStatusWorkerResult> {
    let lease = await this.dependencies.cronjobs.claim({
      jobName: WALLET_PROVIDER_STATUS_JOB_NAME,
      scheduledFor: input.scheduledFor,
      workerInstanceId: input.workerInstanceId,
      periodMs: 300_000,
    });
    if (!lease) return null;

    try {
      const subjects = await this.loadSubjects();
      if (subjects.length === 0) {
        const outcome = { status: 'SUCCESS', safeErrorCode: null,
          skippedBucketCount: 0, processedCount: 0, failedCount: 0 } as const;
        await this.dependencies.cronjobs.complete(lease, outcome);
        return { runId: lease.id, ...outcome };
      }
      let activeLease = await this.dependencies.cronjobs.renew(lease);
      const observations = await this.dependencies.providerClient
        .fetchScopedProviderObservations(this.scope(subjects), async () => {
          activeLease = await this.dependencies.cronjobs.renew(activeLease);
        });
      lease = await this.dependencies.cronjobs.renew(activeLease);
      const fencedLease = lease;
      const persisted = await this.dependencies.cronjobs.withFencedTransaction(
        fencedLease,
        (client) => this.persist(client, fencedLease, subjects, observations),
      );
      lease = persisted.lease;
      const outcome = this.outcome(observations, persisted);
      const counts = outcome.status === 'FAILED'
        ? { processedCount: 0, failedCount: Math.max(1, persisted.failedCount) }
        : { processedCount: persisted.processedCount, failedCount: persisted.failedCount };
      await this.dependencies.cronjobs.complete(lease, { ...outcome, ...counts });
      return { runId: lease.id, ...outcome, ...counts };
    } catch (error) {
      if (error instanceof WalletCronLeaseLost) throw error;
      const outcome = { status: 'FAILED', safeErrorCode: 'DEPENDENCY_UNAVAILABLE',
        skippedBucketCount: 0, processedCount: 0, failedCount: 1 } as const;
      await this.dependencies.cronjobs.complete(lease, outcome);
      return { runId: lease.id, ...outcome };
    }
  }
  /** Loads live chain and binding identities whose provider state must be observed. */
  private async loadSubjects(): Promise<readonly ProviderSubject[]> {
    return this.dependencies.database.transaction(async (client) => {
      const result = await client.query<SubjectRow>(`SELECT 'CHAIN'::text subject_type,
        chain.id::text subject_id,NULL::text currency_id,chain.provider_chain_id::text,
        NULL::text provider_coin_id,chain.provider_state::text,
        chain.consecutive_failed_checks failure_streak,chain.maintenance_pinned,
        settings.global_desired_state::text,chain.desired_state::text chain_desired_state,
        chain.provider_state::text chain_provider_state,chain.maintenance_pinned chain_maintenance_pinned,
        NULL::text currency_desired_state,NULL::text binding_desired_state
        FROM ${this.wallet}.chains chain CROSS JOIN ${this.wallet}.wallet_settings settings
        WHERE settings.id=true
        UNION ALL
        SELECT 'CURRENCY_CHAIN',binding.id::text,binding.currency_id::text,
        chain.provider_chain_id::text,binding.provider_coin_id::text,
        binding.provider_state::text,binding.consecutive_failed_checks,
        binding.maintenance_pinned,settings.global_desired_state::text,
        chain.desired_state::text,chain.provider_state::text chain_provider_state,
        chain.maintenance_pinned chain_maintenance_pinned,
        currency.desired_state::text,binding.desired_state::text
        FROM ${this.wallet}.currencies binding
        JOIN ${this.wallet}.chains chain ON chain.id=binding.chain_id
        JOIN ${this.wallet}.currency_settings currency ON currency.currency_id=binding.currency_id
        CROSS JOIN ${this.wallet}.wallet_settings settings WHERE settings.id=true
        ORDER BY provider_chain_id,provider_coin_id NULLS FIRST,subject_id`);
      return result.rows.map((row) => this.subject(row));
    });
  }

  private subject(row: SubjectRow): ProviderSubject {
    const subjectType = row.subject_type;
    if (subjectType !== 'CHAIN' && subjectType !== 'CURRENCY_CHAIN') {
      throw new Error('WALLET_PROVIDER_STATUS_DATABASE_RESULT_INVALID');
    }
    const global = desiredState(row.global_desired_state);
    const chain = desiredState(row.chain_desired_state);
    const chainControl = subjectType === 'CHAIN' || chain !== 'ON' ? chain
      : bool(row.chain_maintenance_pinned) || providerState(row.chain_provider_state) !== 'ACTIVATED'
        ? 'MAINTAIN' : 'ON';
    const aggregate = subjectType === 'CHAIN'
      ? selectDesiredState([global, chain, 'ON', 'ON'])
      : selectDesiredState([global, chainControl, desiredState(row.currency_desired_state),
        desiredState(row.binding_desired_state)]);
    const streak = integer(row.failure_streak, true);
    if (streak > 3) throw new Error('WALLET_PROVIDER_STATUS_DATABASE_RESULT_INVALID');
    return {
      subjectType, subjectId: text(row.subject_id), currencyId: optionalText(row.currency_id),
      providerChainId: integer(row.provider_chain_id),
      providerCoinId: row.provider_coin_id === null ? null : integer(row.provider_coin_id),
      providerState: providerState(row.provider_state), failureStreak: streak,
      maintenancePinned: bool(row.maintenance_pinned), desiredState: aggregate,
    };
  }
  /** Groups configured subjects into the provider's chain-scoped observation request. */
  private scope(subjects: readonly ProviderSubject[]): ProviderObservationScope {
    const chains = new Map<number, number[]>();
    for (const subject of subjects) {
      const bindings = chains.get(subject.providerChainId) ?? [];
      if (subject.providerCoinId !== null) bindings.push(subject.providerCoinId);
      chains.set(subject.providerChainId, bindings);
    }
    return { chains: [...chains].map(([providerChainId, bindings]) => ({
      providerChainId, bindings: bindings.map((providerCoinId) => ({ providerCoinId })),
    })) };
  }
  /** Persists subjects in bounded waves and renews the cron lease between waves. */
  private async persist(
    client: WalletCoreClient,
    lease: WalletCronjobLease,
    subjects: readonly ProviderSubject[],
    observations: ProviderObservationResult,
  ) {
    const globalFailure = observations.failures.some((failure) => failure.scope === 'ALL');
    const failedChains = new Set(observations.failures.flatMap((failure) =>
      failure.scope === 'CHAIN' ? [failure.providerChainId] : []));
    const chains = new Map(observations.chains.map((entry) => [entry.providerChainId, entry]));
    const bindings = new Map(observations.bindings.map((entry) => [
      `${entry.providerChainId}:${entry.providerCoinId}`, entry,
    ]));
    let activeLease = lease;
    const result = await persistProviderWaves(client, subjects, async (subject) => {
      const providerOutcome = this.providerOutcome(
        subject, globalFailure, failedChains, chains, bindings,
      );
      await this.persistSubject(client, lease.id, subject, providerOutcome);
      return providerOutcome === 'FAILED';
    }, async () => {
      activeLease = await this.dependencies.cronjobs.renewWithClient(client, activeLease);
    });
    return { ...result, lease: activeLease };
  }
  /** Maps missing or failed provider evidence to a fail-closed subject outcome. */
  private providerOutcome(
    subject: ProviderSubject,
    globalFailure: boolean,
    failedChains: ReadonlySet<number>,
    chains: ReadonlyMap<number, ProviderObservationResult['chains'][number]>,
    bindings: ReadonlyMap<string, ProviderObservationResult['bindings'][number]>,
  ): WalletProviderCheckOutcome {
    if (globalFailure) return 'FAILED';
    const observation = subject.providerCoinId === null
      ? chains.get(subject.providerChainId)
      : failedChains.has(subject.providerChainId) ? undefined
        : bindings.get(`${subject.providerChainId}:${subject.providerCoinId}`);
    return observation?.outcome === 'OBSERVED' ? observation.providerState : 'FAILED';
  }
  /** Atomically updates one observation with its alert, audit, status, and outbox effects. */
  private async persistSubject(
    client: WalletCoreClient,
    runId: string,
    expected: ProviderSubject,
    outcome: WalletProviderCheckOutcome,
  ): Promise<void> {
    const current = await this.lockSubject(client, expected);
    const beforeEffective = effectiveState(
      current.desiredState, current.maintenancePinned, current.providerState,
    );
    const resolution = resolveProviderMaintenanceObservation({
      previousProviderState: current.providerState,
      failureStreak: current.failureStreak,
      desiredState: current.desiredState,
      maintenancePinned: current.maintenancePinned,
      outcome,
    });
    const observedAt = await this.observedAt(client);
    await this.updateSubject(client, current, outcome, resolution.providerState,
      resolution.failureStreak, observedAt);
    const reference = current.subjectType === 'CHAIN'
      ? `CHAIN:${current.providerChainId}` as const
      : `CURRENCY_CHAIN:${current.providerChainId}:${current.providerCoinId}` as const;
    const payload = {
      subjectType: current.subjectType,
      subjectId: current.subjectId, providerReference: reference,
      providerState: resolution.providerState, failureStreak: resolution.failureStreak,
      maintenancePinned: current.maintenancePinned,
      effectiveState: resolution.effectiveState, observedAt,
    } as StoredProviderMaintenancePayload;
    const revision = await this.configurationRevision(client);
    await this.updateAlert(client, payload, current.currencyId, resolution.transition);
    if (resolution.transition === null || resolution.outboxEvent === null) return;
    const action = `PROVIDER_MAINTENANCE.${resolution.transition}` as const;
    const before = { effectiveState: beforeEffective, failureStreak: current.failureStreak,
      maintenancePinned: current.maintenancePinned };
    const after = { effectiveState: resolution.effectiveState,
      failureStreak: resolution.failureStreak, maintenancePinned: current.maintenancePinned };
    const eventKey = `provider:${runId}:${current.subjectType}:${current.subjectId}:${resolution.transition}`;
    const providerAudit = { domain: 'WALLET_CORE', action, eventKey,
      actor: { kind: 'SYSTEM', runId },
      subject: { type: current.subjectType, id: current.subjectId },
      reason: 'provider-status-sync', before, after,
      metadata: { configurationRevision: revision, providerReference: reference },
    } as const satisfies WalletCoreAdminAuditInput;
    await this.appendEvent(client, runId, providerAudit,
      [current.providerState, resolution.providerState]);
    const providerAuditResult = await this.dependencies.audit
      .appendWithTransaction(client, providerAudit);
    if (providerAuditResult.replayed) throw new Error('WALLET_PROVIDER_AUDIT_REPLAYED');
    await this.dependencies.outbox.enqueueWithClient(client, {
      eventType: resolution.outboxEvent,
      dedupeKey: `${resolution.outboxEvent}:${runId}:${current.subjectType}:${current.subjectId}`,
      payload: { ...payload, configurationRevision: revision },
    });
    if (beforeEffective !== resolution.effectiveState) {
      await this.appendStatusChange(client, runId, current, beforeEffective,
        resolution.effectiveState, revision, eventKey);
    }
  }

  /** Locks the current subject, rereads policy, and rejects changed provider references. */
  private async lockSubject(
    client: WalletCoreClient,
    subject: ProviderSubject,
  ): Promise<ProviderSubject> {
    const chainSql = `SELECT 'CHAIN'::text subject_type,chain.id::text subject_id,
      NULL::text currency_id,chain.provider_chain_id::text,NULL::text provider_coin_id,
      chain.provider_state::text,chain.consecutive_failed_checks failure_streak,
      chain.maintenance_pinned,settings.global_desired_state::text,
      chain.desired_state::text chain_desired_state,chain.provider_state::text chain_provider_state,
      chain.maintenance_pinned chain_maintenance_pinned,NULL::text currency_desired_state,
      NULL::text binding_desired_state FROM ${this.wallet}.chains chain
      CROSS JOIN ${this.wallet}.wallet_settings settings
      WHERE chain.id=$1 AND settings.id=true FOR UPDATE OF chain`;
    const bindingSql = `SELECT 'CURRENCY_CHAIN'::text subject_type,binding.id::text subject_id,
      binding.currency_id::text,chain.provider_chain_id::text,binding.provider_coin_id::text,
      binding.provider_state::text,binding.consecutive_failed_checks failure_streak,
      binding.maintenance_pinned,settings.global_desired_state::text,
      chain.desired_state::text chain_desired_state,chain.provider_state::text chain_provider_state,
      chain.maintenance_pinned chain_maintenance_pinned,
      currency.desired_state::text currency_desired_state,
      binding.desired_state::text binding_desired_state FROM ${this.wallet}.currencies binding
      JOIN ${this.wallet}.chains chain ON chain.id=binding.chain_id
      JOIN ${this.wallet}.currency_settings currency ON currency.currency_id=binding.currency_id
      CROSS JOIN ${this.wallet}.wallet_settings settings
      WHERE binding.id=$1 AND settings.id=true FOR UPDATE OF binding`;
    const result = await client.query<SubjectRow>(
      subject.subjectType === 'CHAIN' ? chainSql : bindingSql, [subject.subjectId],
    );
    if (!result.rows[0]) throw new Error('WALLET_PROVIDER_STATUS_SUBJECT_MISSING');
    const current = this.subject(result.rows[0]);
    if (current.providerChainId !== subject.providerChainId
      || current.providerCoinId !== subject.providerCoinId) {
      throw new Error('WALLET_PROVIDER_STATUS_REFERENCE_CHANGED');
    }
    return current;
  }

  private async observedAt(client: WalletCoreClient): Promise<string> {
    const result = await client.query<{ readonly observed_at: unknown }>(
      'SELECT clock_timestamp() observed_at',
    );
    const raw = result.rows[0]?.observed_at;
    const value = raw instanceof Date ? raw : new Date(String(raw));
    if (!Number.isFinite(value.valueOf())) {
      throw new Error('WALLET_PROVIDER_STATUS_DATABASE_RESULT_INVALID');
    }
    return value.toISOString();
  }

  private async updateSubject(
    client: WalletCoreClient,
    subject: ProviderSubject,
    outcome: WalletProviderCheckOutcome,
    state: WalletProviderState,
    streak: number,
    observedAt: string,
  ): Promise<void> {
    const table = subject.subjectType === 'CHAIN' ? 'chains' : 'currencies';
    const result = await client.query(`UPDATE ${this.wallet}.${table} SET
      provider_state=$2,consecutive_failed_checks=$3,
      last_success_at=CASE WHEN $4 THEN $5::timestamptz ELSE last_success_at END,
      last_error_at=CASE WHEN $4 THEN last_error_at ELSE $5::timestamptz END,
      provider_updated_at=$5::timestamptz,updated_at=clock_timestamp() WHERE id=$1`, [
      subject.subjectId, state, streak, outcome !== 'FAILED', observedAt,
    ]);
    if (result.rowCount !== 1) throw new Error('WALLET_PROVIDER_STATUS_SUBJECT_MISSING');
  }

  private async configurationRevision(client: WalletCoreClient): Promise<number> {
    const result = await client.query<{ readonly revision: unknown }>(
      `SELECT revision::text FROM ${this.wallet}.wallet_settings WHERE id=true FOR SHARE`,
    );
    return integer(result.rows[0]?.revision, true);
  }
  /** Refreshes active evidence and opens, reopens, or clears alerts only on transitions. */
  private async updateAlert(
    client: WalletCoreClient,
    payload: StoredProviderMaintenancePayload,
    currencyId: string | null,
    transition: 'ENTERED' | 'RECOVERED' | null,
  ): Promise<void> {
    const dedupeKey = `provider-maintenance:${payload.subjectType}:${payload.subjectId}`;
    const existing = await client.query<{ readonly id: unknown; readonly status: unknown }>(
      `SELECT id::text,status::text FROM ${this.wallet}.wallet_alerts
      WHERE dedupe_key=$1 FOR UPDATE`, [dedupeKey],
    );
    let alertId = existing.rows[0] ? text(existing.rows[0].id) : null;
    const json = JSON.stringify(payload);
    if (alertId === null) {
      if (transition === null) return;
      alertId = uuidv7();
      await client.query(`INSERT INTO ${this.wallet}.wallet_alerts
        (id,dedupe_key,category,status,currency_id,payload,opened_at,updated_at)
        VALUES ($1,$2,'PROVIDER_MAINTENANCE','ACTIVE',$3,$4::jsonb,$5::timestamptz,$5::timestamptz)`,
      [alertId, dedupeKey, currencyId, json, payload.observedAt]);
    } else if (existing.rows[0]?.status === 'ACTIVE') {
      await client.query(`UPDATE ${this.wallet}.wallet_alerts SET payload=$2::jsonb,
        updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond')
        WHERE id=$1 AND payload IS DISTINCT FROM $2::jsonb`,
      [alertId, json]);
    } else if (transition !== null) {
      await client.query(`UPDATE ${this.wallet}.wallet_alerts SET status='ACTIVE',payload=$2::jsonb,
        cleared_at=NULL,updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond')
        WHERE id=$1`, [alertId, json]);
    }
    if (transition === 'RECOVERED') {
      await client.query(`UPDATE ${this.wallet}.wallet_alerts SET status='CLEARED',
        cleared_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond'),
        updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond') WHERE id=$1`,
      [alertId]);
    }
    if (transition !== null) {
      await client.query(`INSERT INTO ${this.wallet}.wallet_alert_events
        (id,alert_id,category,status,payload) VALUES
        ($1,$2,'PROVIDER_MAINTENANCE',$3,$4::jsonb)`, [
        uuidv7(), alertId, transition === 'ENTERED' ? 'ACTIVE' : 'CLEARED', json,
      ]);
    }
  }

  private async appendEvent(
    client: WalletCoreClient,
    runId: string,
    event: WalletCoreAdminAuditInput,
    states?: readonly [WalletProviderState, WalletProviderState],
  ): Promise<void> {
    await client.query(`INSERT INTO ${this.wallet}.state_events
      (id,event_type,subject_type,subject_id,run_id,payload) VALUES
      ($1,$2,$3,$4,$5,$6::jsonb)`, [uuidv7(), event.action, event.subject.type,
      event.subject.id, runId, JSON.stringify({ eventKey: event.eventKey,
        before: states ? { ...event.before, providerState: states[0] } : event.before,
        after: states ? { ...event.after, providerState: states[1] } : event.after,
        metadata: event.metadata })]);
  }

  private async appendStatusChange(
    client: WalletCoreClient,
    runId: string,
    subject: ProviderSubject,
    beforeState: WalletDesiredState,
    afterState: WalletDesiredState,
    revision: number,
    providerEventKey: string,
  ): Promise<void> {
    const action = subject.subjectType === 'CHAIN'
      ? 'CHAIN.STATUS_CHANGED' as const : 'CURRENCY.STATUS_CHANGED' as const;
    const audit = { domain: 'WALLET_CORE', action,
      eventKey: `${providerEventKey}:status`, actor: { kind: 'SYSTEM', runId },
      subject: { type: subject.subjectType, id: subject.subjectId },
      reason: 'provider-status-sync', before: { effectiveState: beforeState },
      after: { effectiveState: afterState }, metadata: { configurationRevision: revision },
    } as WalletCoreAdminAuditInput;
    await this.appendEvent(client, runId, audit);
    const result = await this.dependencies.audit.appendWithTransaction(client, audit);
    if (result.replayed) throw new Error('WALLET_PROVIDER_AUDIT_REPLAYED');
  }
  /** Reports total early-wave dependency failure separately from partial useful progress. */
  private outcome(
    observations: ProviderObservationResult,
    counts: Readonly<{ processedCount: number; failedCount: number;
      persistenceFailedCount: number; stopped: boolean }>,
  ): WalletCronRunOutcome {
    const globalFailure = observations.failures.some((failure) => failure.scope === 'ALL');
    if (globalFailure || (counts.stopped
      && counts.processedCount === counts.persistenceFailedCount)) {
      return { status: 'FAILED', safeErrorCode: globalFailure
        ? 'PROVIDER_OBSERVATION_FAILED' : 'DEPENDENCY_UNAVAILABLE', skippedBucketCount: 0 };
    }
    if (counts.failedCount > 0 || observations.failures.length > 0
      || observations.chains.some((entry) => entry.outcome === 'OMITTED')
      || observations.bindings.some((entry) => entry.outcome === 'OMITTED')) {
      return { status: 'PARTIAL', safeErrorCode: 'PROVIDER_OBSERVATION_PARTIAL',
        skippedBucketCount: 0 };
    }
    return { status: 'SUCCESS', safeErrorCode: null, skippedBucketCount: 0 };
  }
}
