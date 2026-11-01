import type { PoolClient } from 'pg';
import type { AdminAuditPort, PriceConversionAdminAuditInput } from '../../admin-audits/admin-audit.types.js';
import { PriceConfigurationValidationError } from './price-conversion.errors.js';
import { type PriceConversionPool, type PriceConversionSchema } from './price-conversion.database.js';
import { priceConversionTransaction } from './price-conversion.transaction.js';
import {
  mergeProviderStates,
  parsePersistedPriceConfiguration,
  persistedProviderStates,
  serializePriceConfiguration,
  validateFinalProviders,
  type ProviderState,
} from './price-conversion.policy.js';
import type {
  FiatCode,
  PersistedPriceConfiguration,
  PriceConversionAuditContext,
  PriceConversionPatch,
  PriceConversionUpdateResult,
} from './price-conversion.types.js';

/** Owns the complete optimistic configuration transaction, including draft lifecycle and audit. */
export class PriceConversionConfigurationWriter {
  private readonly schema: PriceConversionSchema;

  constructor(
    private readonly database: PriceConversionPool,
    private readonly globalAudit: AdminAuditPort,
  ) {
    this.schema = database.priceConversionSchema ?? 'price_conversion';
  }

  /**
   * Applies one governance revision atomically. Drafts and schedules advance
   * only the admin token; PUSH also advances the live price revision.
   */
  async updateAtomically(
    input: PriceConversionPatch,
    audit: PriceConversionAuditContext,
  ): Promise<PriceConversionUpdateResult> {
    try {
      return await priceConversionTransaction(this.database, tx => this.write(tx, input, audit));
    } catch (error) {
      if (error instanceof RevisionConflict) {
        return { kind: 'revision_conflict', actualRevision: error.actualRevision };
      }
      throw configurationWriteError(error);
    }
  }

  private async write(
    tx: PoolClient,
    input: PriceConversionPatch,
    audit: PriceConversionAuditContext,
  ): Promise<PriceConversionUpdateResult> {
    const settingsResult = await tx.query<Record<string, unknown>>(`SELECT revision::int AS "liveRevision",
      divergence_threshold_bps AS "divergenceThresholdBps" FROM ${this.schema}.price_settings
      WHERE id FOR UPDATE`);
    const currentSettings = settingsResult.rows[0];
    if (currentSettings === undefined) throw new Error('price settings singleton is missing');
    // A separate statement after the settings lock sees any config committed by a prior writer.
    const governance = await tx.query<{ revision: unknown }>(`SELECT GREATEST(
      $1::bigint, COALESCE(MAX(revision), 0))::int AS revision
      FROM ${this.schema}.price_config_changes`, [Number(currentSettings.liveRevision)]);
    const currentRevision = Number(governance.rows[0]?.revision);
    if (currentRevision !== input.expectedRevision) {
      throw new RevisionConflict(currentRevision);
    }
    if (input.action === 'SCHEDULE' && new Date(input.effectiveAt ?? 0).valueOf() <= Date.now()) {
      throw new PriceConfigurationValidationError('Scheduled effectiveAt must be in the future');
    }
    let comparisonTarget: PersistedPriceConfiguration | null = null;
    let comparisonTargetState: {
      readonly revision: number;
      readonly status: 'DRAFT' | 'SCHEDULED';
      readonly effectiveAt: string | null;
    } | null = null;
    if (input.action === 'SAVE_DRAFT') {
      const target = await tx.query<Record<string, unknown>>(`SELECT revision::int AS revision,
        status::text AS status, effective_at AS "effectiveAt", config
        FROM ${this.schema}.price_config_changes WHERE status = 'DRAFT'
        ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`);
      if (target.rows[0] !== undefined) {
        comparisonTarget = parsePersistedPriceConfiguration(target.rows[0].config);
        comparisonTargetState = {
          revision: Number(target.rows[0].revision), status: 'DRAFT',
          effectiveAt: null,
        };
      }
    } else if (input.action === 'SCHEDULE') {
      const target = await tx.query<Record<string, unknown>>(`SELECT revision::int AS revision,
        status::text AS status, effective_at AS "effectiveAt", config
        FROM ${this.schema}.price_config_changes
        WHERE status = 'SCHEDULED' AND effective_at <= $1::timestamptz
        ORDER BY effective_at DESC, revision DESC LIMIT 1 FOR UPDATE`, [input.effectiveAt]);
      if (target.rows[0] !== undefined) {
        comparisonTarget = parsePersistedPriceConfiguration(target.rows[0].config);
        comparisonTargetState = {
          revision: Number(target.rows[0].revision), status: 'SCHEDULED',
          effectiveAt: new Date(target.rows[0].effectiveAt as string | Date).toISOString(),
        };
      }
    }
    const currentProviders = await this.providerState(tx, true);
    const currentVisibleFiatCodes = await this.visibleFiatCodes(tx, true);
    let consumedDraftId: string | null = null;
    let storedDraft: PersistedPriceConfiguration | null = null;
    if (input.action === 'PUSH' && input.draftId !== undefined) {
      const draft = await tx.query<{ id: unknown; config: unknown }>(`SELECT id, config
        FROM ${this.schema}.price_config_changes
        WHERE id = $1::uuid AND status = 'DRAFT' FOR UPDATE`, [input.draftId]);
      if (draft.rows[0] === undefined) {
        throw new PriceConfigurationValidationError('Active draft was not found');
      }
      consumedDraftId = String(draft.rows[0].id);
      storedDraft = parsePersistedPriceConfiguration(draft.rows[0].config);
    }
    const finalProviders = storedDraft === null
      ? mergeProviderStates(currentProviders, input.providers ?? [])
      : persistedProviderStates(storedDraft, currentProviders);
    validateFinalProviders(finalProviders);
    const before = {
      settings: {
        revision: currentRevision,
        divergenceThresholdBps: Number(currentSettings.divergenceThresholdBps),
        visibleFiatCodes: currentVisibleFiatCodes,
      },
      providers: currentProviders,
    };
    const revision = input.expectedRevision + 1;
    const previewThreshold = storedDraft?.settings.divergenceThresholdBps
      ?? input.divergenceThresholdBps ?? Number(currentSettings.divergenceThresholdBps);
    const finalVisibleFiatCodes = storedDraft?.settings.visibleFiatCodes
      ?? input.visibleFiatCodes
      ?? currentVisibleFiatCodes;
    const config = serializePriceConfiguration(
      previewThreshold,
      finalProviders,
      finalVisibleFiatCodes,
    );
    const currentConfig = serializePriceConfiguration(
      Number(currentSettings.divergenceThresholdBps),
      currentProviders,
      currentVisibleFiatCodes,
    );
    const normalizedTarget = comparisonTarget === null
      ? currentConfig
      : serializePriceConfiguration(
        comparisonTarget.settings.divergenceThresholdBps,
        persistedProviderStates(comparisonTarget, currentProviders),
        comparisonTarget.settings.visibleFiatCodes ?? currentVisibleFiatCodes,
      );
    if (JSON.stringify(config) === JSON.stringify(normalizedTarget)) {
      throw new PriceConfigurationValidationError('Price configuration is unchanged');
    }
    if (input.action === 'PUSH') {
      await tx.query(`UPDATE ${this.schema}.price_settings SET revision = $1,
        divergence_threshold_bps = $2,
        security_state = 'DEGRADED'::${this.schema}."PriceSecurityState",
        updated_at = now() WHERE id`, [revision, previewThreshold]);
      await this.applyProviders(tx, finalProviders);
      await tx.query(`UPDATE ${this.schema}.price_view_fiats
        SET enabled = code = ANY($1::text[])`, [config.settings.visibleFiatCodes]);
      await tx.query(`UPDATE ${this.schema}.price_config_changes SET status = 'ARCHIVED'
        WHERE status = 'LIVE'`);
    }
    if (input.action === 'SAVE_DRAFT') {
      await tx.query(`UPDATE ${this.schema}.price_config_changes SET status = 'ARCHIVED'
        WHERE status = 'DRAFT'`);
    } else if (consumedDraftId !== null) {
      await tx.query(`UPDATE ${this.schema}.price_config_changes SET status = 'ARCHIVED'
        WHERE id = $1::uuid AND status = 'DRAFT'`, [consumedDraftId]);
    }
    const status = input.action === 'SAVE_DRAFT'
      ? 'DRAFT'
      : input.action === 'SCHEDULE' ? 'SCHEDULED' : 'LIVE';
    const inserted = await tx.query<{ id: string }>(`INSERT INTO ${this.schema}.price_config_changes
      (revision, status, effective_at, changelog, actor_id, config, applied_at)
      VALUES ($1, $2::${this.schema}."PriceConfigChangeStatus", $3::timestamptz, $4,
        $5::uuid, $6::jsonb, CASE WHEN $2 = 'LIVE' THEN now() ELSE NULL END)
      RETURNING id::text`,
    [revision, status, input.effectiveAt ?? null, input.changelog, audit.actorId, JSON.stringify(config)]);
    const configChangeId = inserted.rows[0]?.id;
    if (configChangeId === undefined) throw new Error('Price configuration change id is missing');
    const afterProviders = input.action === 'PUSH' ? finalProviders : currentProviders;
    const after = {
      settings: {
        revision,
        divergenceThresholdBps: input.action === 'PUSH'
          ? previewThreshold
          : Number(currentSettings.divergenceThresholdBps),
        visibleFiatCodes: input.action === 'PUSH'
          ? config.settings.visibleFiatCodes
          : currentVisibleFiatCodes,
      },
      providers: afterProviders,
      change: {
        id: configChangeId,
        revision,
        status,
        effectiveAt: input.effectiveAt ?? null,
        changelog: input.changelog,
        consumedDraftId,
      },
    };
    await tx.query(`INSERT INTO ${this.schema}.price_admin_audit
      (actor_id, session_id, request_id, ip_address, device_id, action, reason, before_json, after_json)
      VALUES ($1::uuid, $2, $3::uuid, $4::inet, $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [
      audit.actorId,
      audit.sessionId,
      audit.requestId,
      audit.ipAddress,
      audit.deviceId,
      `PRICE_CONFIG_${input.action}`,
      input.reason,
      JSON.stringify(before),
      JSON.stringify(after),
    ]);
    const action = input.action === 'SAVE_DRAFT'
      ? 'SETTINGS.SAVED'
      : input.action === 'SCHEDULE' ? 'SETTINGS.SCHEDULED' : 'SETTINGS.PUSHED';
    const currentAuditConfig = toAuditConfig(currentConfig);
    const targetAuditConfig = comparisonTarget === null
      ? currentAuditConfig
      : toAuditConfig(normalizedTarget);
    const previous = input.action === 'SAVE_DRAFT'
      ? comparisonTargetState === null
        ? { revision: currentRevision, status: 'LIVE' as const, effectiveAt: null,
          config: currentAuditConfig }
        : { ...comparisonTargetState, config: targetAuditConfig }
      : input.action === 'SCHEDULE' && comparisonTargetState !== null
        ? { ...comparisonTargetState, config: targetAuditConfig }
        : { revision: currentRevision, status: 'LIVE' as const, effectiveAt: null, config: currentAuditConfig };
    const globalInput = {
      domain: 'PRICE_CONVERSION',
      action,
      eventKey: `price-conversion:${action.toLowerCase()}:${configChangeId}`,
      actor: { kind: 'ADMIN' as const, ...audit },
      subject: { type: 'SETTINGS_REVISION' as const, id: String(revision) },
      reason: input.reason,
      before: previous,
      after: {
        revision,
        status,
        effectiveAt: input.effectiveAt ?? null,
        config: toAuditConfig(config),
      },
      metadata: { configurationRevision: revision, configChangeId, changelog: input.changelog },
    } as PriceConversionAdminAuditInput;
    const globalResult = await this.globalAudit.appendWithTransaction(tx, globalInput);
    if (globalResult.replayed) throw new Error('Price configuration global audit replayed');
    return { kind: 'updated', revision };
  }

  /** Reads current assignments, optionally locking them for the full governance write. */
  private async providerState(tx: PoolClient, lock: boolean): Promise<ProviderState[]> {
    const result = await tx.query<Record<string, unknown>>(`SELECT code::text AS code, enabled,
      sensitive_role::text AS role, view_enabled AS "viewEnabled",
      refresh_interval_seconds AS "refreshIntervalSeconds"
      FROM ${this.schema}.price_providers ORDER BY code ${lock ? 'FOR UPDATE' : ''}`);
    return result.rows.map((row) => ({
      code: row.code as ProviderState['code'],
      enabled: Boolean(row.enabled),
      role: row.role as ProviderState['role'],
      viewEnabled: Boolean(row.viewEnabled),
      refreshIntervalSeconds: Number(row.refreshIntervalSeconds),
    }));
  }

  /** Locks and returns the current canonical visibility set for normalized comparison. */
  private async visibleFiatCodes(tx: PoolClient, lock: boolean): Promise<FiatCode[]> {
    const result = await tx.query<{ code: FiatCode }>(`SELECT code
      FROM ${this.schema}.price_view_fiats WHERE enabled ORDER BY code ${lock ? 'FOR UPDATE' : ''}`);
    return result.rows.map((row) => row.code);
  }

  /** Clears unique role/view assignments before reassigning them to their final providers. */
  private async applyProviders(tx: PoolClient, providers: readonly ProviderState[]): Promise<void> {
    await tx.query(`UPDATE ${this.schema}.price_providers SET sensitive_role = NULL, view_enabled = false`);
    for (const provider of providers) {
      await tx.query(`UPDATE ${this.schema}.price_providers SET enabled = $1,
        sensitive_role = $2::${this.schema}."PriceProviderRole", view_enabled = $3,
        refresh_interval_seconds = $4,
        revision = revision + 1, updated_at = now()
        WHERE code = $5::${this.schema}."PriceProviderCode"`,
      [provider.enabled, provider.role, provider.viewEnabled,
        provider.refreshIntervalSeconds, provider.code]);
    }
  }

}

function toAuditConfig(config: PersistedPriceConfiguration) {
  const provider = (code: keyof PersistedPriceConfiguration['providers']) => ({
    enabled: config.providers[code].enabled,
    role: config.providers[code].sensitiveRole,
    viewEnabled: config.providers[code].viewEnabled,
    refreshIntervalSeconds: config.providers[code].refreshIntervalSeconds,
  });
  return {
    divergenceThresholdBps: config.settings.divergenceThresholdBps,
    visibleFiatCodes: config.settings.visibleFiatCodes ?? [],
    providers: {
      COINGECKO: provider('COINGECKO'),
      ALCHEMY: provider('ALCHEMY'),
      COINMARKETCAP: provider('COINMARKETCAP'),
    },
  };
}

/** Signals a read-only conflict so the transaction rolls back before returning its result. */
class RevisionConflict extends Error {
  constructor(readonly actualRevision: number) { super('Price configuration revision conflict'); }
}

/** Converts expected catalogue constraint failures to a safe client-facing validation error. */
function configurationWriteError(error: unknown): unknown {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
  if (code !== null && ['23503', '23505', '23514'].includes(code)) {
    return new PriceConfigurationValidationError('Price catalogue conflicts with existing configuration');
  }
  return error;
}
