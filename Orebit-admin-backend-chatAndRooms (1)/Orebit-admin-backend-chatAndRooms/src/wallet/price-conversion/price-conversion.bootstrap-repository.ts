import type { PoolClient } from 'pg';
import { type PriceConversionPool, type PriceConversionSchema } from './price-conversion.database.js';
import { priceRoleConfigurationStatus } from './price-conversion.policy.js';
import { isoOrNull, requiredCursorTimestamp, requiredIso,
  stringOrNull } from './price-conversion.row-values.js';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  scheduledCursorContext,
} from './price-conversion.cursor.js';
import { priceConversionTransaction } from './price-conversion.transaction.js';
import { FIAT_CODES, type FiatCode, type PriceConfigChange, type PriceConversionBootstrap, type PriceConversionBootstrapQuery, type ProviderCode, type ProviderRole } from './price-conversion.types.js';

/** Reads one coherent admin view on a checked-out repeatable-read transaction without provider I/O. */
export class PriceConversionBootstrapRepository {
  private readonly schema: PriceConversionSchema;
  constructor(private readonly database: PriceConversionPool) { this.schema = database.priceConversionSchema ?? 'price_conversion'; }

  /** Holds one read-only snapshot so settings, providers, prices, and history cannot disagree. */
  async bootstrap(input: PriceConversionBootstrapQuery): Promise<PriceConversionBootstrap> {
    return priceConversionTransaction(this.database, client => this.readSnapshot(client, input),
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }

  private async readSnapshot(
    client: PoolClient,
    input: PriceConversionBootstrapQuery,
  ): Promise<PriceConversionBootstrap> {
    const scheduledLimit = input.scheduledLimit ?? 50;
    const scheduledCursor = input.scheduledCursor === undefined
      ? null
      : decodeHistoryCursor(input.scheduledCursor);
    if (input.scheduledCursor !== undefined
      && (scheduledCursor === null || scheduledCursor[2] !== scheduledCursorContext)) {
      throw new Error('Invalid scheduled configuration cursor');
    }
    const changeValues: unknown[] = [];
    const scheduledAfter = scheduledCursor === null
      ? ''
      : (() => {
        changeValues.push(scheduledCursor[0], scheduledCursor[1]);
        return `AND (effective_at, id) > ($1::timestamptz, $2::uuid)`;
      })();
    changeValues.push(scheduledLimit + 1);
    const settings = await client.query(`SELECT GREATEST(s.revision, COALESCE((SELECT MAX(c.revision)
        FROM ${this.schema}.price_config_changes c), 0))::int AS revision,
        s.divergence_threshold_bps AS "divergenceThresholdBps", s.security_state::text AS "securityState",
        GREATEST(s.updated_at, COALESCE((SELECT MAX(c.created_at)
          FROM ${this.schema}.price_config_changes c), s.updated_at)) AS "updatedAt"
        FROM ${this.schema}.price_settings s WHERE s.id`);
    const providers = await client.query(`SELECT p.code::text AS code, p.enabled, p.sensitive_role::text AS role, p.view_enabled AS "viewEnabled", p.revision::int AS revision, p.refresh_interval_seconds AS "refreshIntervalSeconds", COALESCE(refs.count, 0)::int AS "referenceCount", COALESCE(health.tracked, 0)::int AS "trackedCurrencies", COALESCE(health.healthy, 0)::int AS "healthyCurrencies", health.last_success_at AS "lastSuccessAt", health.last_error_at AS "lastErrorAt", health.updated_at AS "healthUpdatedAt", COALESCE(usage.daily_requests, 0)::int AS "dailyRequests", COALESCE(usage.monthly_requests, 0)::int AS "monthlyRequests" FROM ${this.schema}.price_providers p LEFT JOIN LATERAL (SELECT count(*) AS count FROM ${this.schema}.currency_provider_refs r WHERE r.provider_id = p.id AND r.active AND r.retired_at IS NULL) refs ON true LEFT JOIN LATERAL (SELECT count(*) AS tracked, count(*) FILTER (WHERE h.healthy) AS healthy, max(h.last_success_at) AS last_success_at, max(h.last_error_at) AS last_error_at, max(h.updated_at) AS updated_at FROM ${this.schema}.price_provider_health h WHERE h.provider_id = p.id) health ON true LEFT JOIN LATERAL (SELECT sum(u.request_count) FILTER (WHERE u.period_type = 'DAILY' AND u.period_start = CURRENT_DATE) AS daily_requests, sum(u.request_count) FILTER (WHERE u.period_type = 'MONTHLY' AND u.period_start = date_trunc('month', CURRENT_DATE)::date) AS monthly_requests FROM ${this.schema}.price_provider_call_stats u WHERE u.provider_id = p.id) usage ON true ORDER BY p.code::text`);
    const changes = await client.query(`WITH scheduled AS (
        SELECT id FROM ${this.schema}.price_config_changes
        WHERE status = 'SCHEDULED' ${scheduledAfter}
        ORDER BY effective_at ASC, id ASC LIMIT $${changeValues.length}
      ) SELECT id, revision::int AS revision, status::text AS status,
        effective_at AS "effectiveAt",
        to_char(effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "effectiveAtCursor",
        changelog, actor_id AS "actorId", config,
        created_at AS "createdAt", applied_at AS "appliedAt"
      FROM ${this.schema}.price_config_changes
      WHERE status IN ('DRAFT', 'LIVE') OR id IN (SELECT id FROM scheduled)
      ORDER BY created_at DESC, id DESC`, changeValues);
    const fiats = await client.query(`SELECT code, enabled FROM ${this.schema}.price_view_fiats
      WHERE code = ANY($1::text[]) ORDER BY code`, [FIAT_CODES]);
    const setting = settings.rows[0] as Record<string, unknown> | undefined;
    if (setting === undefined) throw new Error('price settings singleton is missing');
    const configuration = changes.rows.filter((row: any) => row.status !== 'SCHEDULED')
      .map(mapConfigChange);
    const scheduledRows = changes.rows.filter((row: any) => row.status === 'SCHEDULED')
      .sort((a: any, b: any) => requiredCursorTimestamp(a.effectiveAtCursor)
        .localeCompare(requiredCursorTimestamp(b.effectiveAtCursor))
        || String(a.id).localeCompare(String(b.id)));
    const scheduledItems = scheduledRows.slice(0, scheduledLimit).map(mapConfigChange);
    return {
      settings: { revision: Number(setting.revision), divergenceThresholdBps: Number(setting.divergenceThresholdBps), updatedAt: requiredIso(setting.updatedAt) },
      providers: providers.rows.map((row: any) => ({ code: row.code as ProviderCode, enabled: Boolean(row.enabled), role: row.role as ProviderRole | null, viewEnabled: Boolean(row.viewEnabled), revision: Number(row.revision), referenceCount: Number(row.referenceCount), refreshIntervalSeconds: Number(row.refreshIntervalSeconds), health: { trackedCurrencies: Number(row.trackedCurrencies), healthyCurrencies: Number(row.healthyCurrencies), lastSuccessAt: isoOrNull(row.lastSuccessAt), lastErrorAt: isoOrNull(row.lastErrorAt), updatedAt: isoOrNull(row.healthUpdatedAt) }, usage: { dailyRequests: Number(row.dailyRequests), monthlyRequests: Number(row.monthlyRequests) } })),
      configuration: {
        draft: configuration.find((row) => row.status === 'DRAFT') ?? null,
        live: configuration.find((row) => row.status === 'LIVE') ?? null,
        scheduled: scheduledItems,
        scheduledNextCursor: scheduledRows.length > scheduledLimit
          ? encodeHistoryCursor([
            requiredCursorTimestamp(scheduledRows[scheduledLimit - 1]?.effectiveAtCursor),
            String(scheduledItems.at(-1)?.id),
            scheduledCursorContext,
          ])
          : null,
      },
      fiatOptions: fiats.rows.map((row: any) => ({
        code: String(row.code) as FiatCode,
        visible: Boolean(row.enabled),
      })),
      roleConfigurationStatus: priceRoleConfigurationStatus(providers.rows.map((row: any) => ({ enabled: Boolean(row.enabled), role: row.role as ProviderRole | null }))),
      securityState: setting.securityState as PriceConversionBootstrap['securityState'],
    };
  }
}

function mapConfigChange(row: Record<string, unknown>): PriceConfigChange { return { id: String(row.id), revision: Number(row.revision), status: row.status as PriceConfigChange['status'], effectiveAt: isoOrNull(row.effectiveAt), changelog: String(row.changelog), actorId: stringOrNull(row.actorId), config: row.config, createdAt: requiredIso(row.createdAt), appliedAt: isoOrNull(row.appliedAt) }; }
