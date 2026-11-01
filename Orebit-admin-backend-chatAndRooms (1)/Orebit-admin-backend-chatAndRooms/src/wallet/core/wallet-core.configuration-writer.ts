import type {
  AdminAuditPort,
  WalletCoreAdminAuditInput,
} from '../../admin-audits/index.js';
import { uuidv7 } from '../../utils/public.utils.js';

import { walletCorePatchSchema, type ParsedWalletCorePatch } from './wallet-core.dto.js';
import {
  WalletConfigurationConflict,
  WalletConfigurationInvalid,
} from './wallet-core.errors.js';
import type {
  CatalogueEvidence,
  StoredConfigurationChange,
  WalletCoreClient,
  WalletEntityChange,
} from './wallet-core.database.js';
import { WalletCoreRepository } from './wallet-core.repository.js';
import type { WalletLogoAssetAttachmentPort } from './logo-asset.repository.js';
import type {
  WalletAuditContext,
  WalletCoreConfigurationPatch,
  WalletCorePatch,
  WalletCoreSystemAuditContext,
  WalletPositiveRevision,
  WalletScheduleRejectionReason,
  WalletSettingsPatch,
  WalletUpdateResult,
} from './wallet-core.types.js';
import { readStoredWalletSnapshot } from './wallet-core.stored-snapshot.js';

type StoredSnapshot = Readonly<{
  config: WalletCoreConfigurationPatch;
  catalogue: CatalogueEvidence;
}>;
type SettingsAction =
  | 'SETTINGS.PUSHED'
  | 'SETTINGS.SCHEDULED'
  | 'SETTINGS.SCHEDULE_APPLIED'
  | 'SETTINGS.SCHEDULE_REJECTED';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const revision = (value: number): WalletPositiveRevision => {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error('WALLET_REVISION_RESULT_INVALID');
  return text as WalletPositiveRevision;
};

const instant = (value: Date): string => {
  if (Number.isNaN(value.valueOf())) throw new WalletConfigurationInvalid('Invalid timestamp.');
  return value.toISOString();
};
const canonicalAuditInstant = (value: unknown): unknown =>
  typeof value === 'string' ? new Date(value).toISOString() : value;
const withoutAuditConfig = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { config: _auditOnlyConfig, ...summary } = value as Record<string, unknown>;
  return summary;
};

const assertScheduledContext = (changeId: string, now: Date,
  context: WalletCoreSystemAuditContext): void => {
  if (!UUID_V7.test(changeId) || !(now instanceof Date) || Number.isNaN(now.valueOf())
    || context?.actor?.kind !== 'SYSTEM') {
    throw new WalletConfigurationInvalid('Valid scheduled SYSTEM context is required.');
  }
};

const parsePatch = (input: WalletCorePatch): ParsedWalletCorePatch => {
  const parsed = walletCorePatchSchema.safeParse(input);
  if (!parsed.success) throw new WalletConfigurationInvalid('Configuration does not pass validation.');
  return parsed.data;
};


export const stableConfigurationEventKey = (
  changeId: string,
  action: string,
  subjectType: string,
  subjectId: string,
): string => `wallet:${changeId}:${action}:${subjectType}:${subjectId}`;

export const orderConfigurationAuditEvents = (
  events: readonly WalletCoreAdminAuditInput[],
): readonly WalletCoreAdminAuditInput[] => Object.freeze([...events].sort((left, right) => {
  const leftSettings = left.subject.type === 'SETTINGS_REVISION' ? 0 : 1;
  const rightSettings = right.subject.type === 'SETTINGS_REVISION' ? 0 : 1;
  return leftSettings - rightSettings
    || left.subject.type.localeCompare(right.subject.type)
    || left.subject.id.localeCompare(right.subject.id)
    || left.action.localeCompare(right.action);
}));

/** Serializes immediate and scheduled configuration changes with their audit records. */
export class WalletCoreConfigurationWriter {
  constructor(
    private readonly repository: WalletCoreRepository,
    private readonly audit: AdminAuditPort,
    private readonly logoAssets: WalletLogoAssetAttachmentPort,
  ) {}

  async updateAtomically(
    input: WalletCorePatch,
    context: WalletAuditContext,
  ): Promise<WalletUpdateResult> {
    const parsed = parsePatch(input);
    if (context?.actor?.kind !== 'ADMIN') {
      throw new WalletConfigurationInvalid('Authenticated ADMIN audit context is required.');
    }
    if (parsed.action === 'SCHEDULE'
      && (parsed.effectiveAt === undefined || Date.parse(parsed.effectiveAt) <= Date.now())) {
      throw new WalletConfigurationInvalid('Scheduled effectiveAt must be in the future.');
    }
    return this.repository.transaction(async (client) => {
      const settings = await this.repository.lockSettings(client);
      if (settings.revision !== parsed.expectedRevision) {
        throw new WalletConfigurationConflict(settings.revision);
      }
      const nextRevision = settings.revision + 1;
      const config: WalletCoreConfigurationPatch = parsed.config;
      let catalogue: CatalogueEvidence;
      try {
        catalogue = await this.repository.captureCatalogue(client, config);
      } catch (error) {
        if (!['CATALOGUE_REFERENCE_UNAVAILABLE', 'CATALOGUE_CONFIGURATION_MISMATCH']
          .includes((error as Error).message)) throw error;
        throw new WalletConfigurationInvalid('Provider catalogue reference is invalid.');
      }
      const catalogueError = await this.repository.validateCatalogue(client, catalogue);
      if (catalogueError) {
        throw new WalletConfigurationInvalid(
          catalogueError === 'CATALOGUE_REVISION_CHANGED'
            ? 'Provider catalogue revision changed.' : 'Provider catalogue reference unavailable.',
        );
      }
      if (parsed.action === 'SCHEDULE'
        && !await this.repository.configurationWouldChange(
          client, config, nextRevision, catalogue,
        )) {
        throw new WalletConfigurationInvalid('Configuration does not change effective settings.');
      }
      const changeId = uuidv7();
      if (!UUID_V7.test(changeId)) throw new Error('WALLET_CONFIGURATION_ID_INVALID');
      await this.repository.insertChange(client, {
        id: changeId,
        revision: nextRevision,
        reason: parsed.reason,
        changelogId: parsed.changelogId ?? null,
        actorId: context.actor.actorId,
        snapshot: { config, catalogue } satisfies StoredSnapshot,
      });
      const objectKeys = [...new Set([
        ...(config.chains ?? []).map((chain) => chain.logoObjectKey),
        ...(config.currencies ?? []).map((currency) => currency.logoObjectKey),
      ].filter((key): key is string => typeof key === 'string' && key.length > 0))];
      await this.logoAssets.attachReferencedWithTransaction(client, {
        configurationChangeId: changeId, objectKeys,
      });
      // The governance sequence advances for staged schedules and immediate pushes.
      await this.repository.advanceRevision(client, settings.revision, nextRevision);

      if (parsed.action === 'SCHEDULE') {
        if (parsed.effectiveAt === undefined) {
          throw new WalletConfigurationInvalid('Scheduled effectiveAt is required.');
        }
        const effectiveAt = await this.repository.transitionChange(
          client, changeId, 'SCHEDULED', parsed.effectiveAt, null,
        );
        if (effectiveAt === null) throw new Error('WALLET_CONFIGURATION_EFFECTIVE_AT_MISSING');
        const event = this.settingsAudit(
          changeId, nextRevision, 'SETTINGS.SCHEDULED', context.actor,
          parsed.reason, parsed.changelogId ?? null, 'DRAFT', 'SCHEDULED', effectiveAt,
          config, undefined, config.settings ? settings.settings : undefined,
        );
        await this.appendEvents(client, changeId, [event]);
        return {
          outcome: 'SCHEDULED', configurationId: changeId,
          revision: revision(nextRevision), status: 'SCHEDULED',
          effectiveAt,
        };
      }

      await this.repository.archiveCurrentLive(client, changeId);
      const changes = await this.repository.applyConfiguration(
        client, config, nextRevision, catalogue,
      );
      const settingsChanged = config.settings
        ? await this.repository.applySettings(client, config.settings) : false;
      if (!settingsChanged && changes.length === 0) {
        throw new WalletConfigurationInvalid('Configuration does not change effective settings.');
      }
      const appliedAt = new Date();
      await this.repository.transitionChange(client, changeId, 'LIVE', null, appliedAt);
      const event = this.settingsAudit(
          changeId, nextRevision, 'SETTINGS.PUSHED', context.actor,
        parsed.reason, parsed.changelogId ?? null, 'DRAFT', 'LIVE', null, config,
        undefined, config.settings ? settings.settings : undefined,
      );
      await this.appendEvents(client, changeId, [
        event, ...this.entityAudits(changeId, nextRevision, parsed.reason, context.actor, changes),
      ]);
      return {
        outcome: 'PUSHED', configurationId: changeId,
        revision: revision(nextRevision), status: 'LIVE', appliedAt: instant(appliedAt),
      };
    });
  }

  async applyScheduledChangeAtomically(
    changeId: string,
    now: Date,
    context: WalletCoreSystemAuditContext,
  ): Promise<WalletUpdateResult> {
    assertScheduledContext(changeId, now, context);
    return this.repository.transaction((client) =>
      this.applyScheduledChangeWithClient(client, changeId, now, context));
  }

  async applyScheduledChangeWithClient(
    client: WalletCoreClient,
    changeId: string,
    now: Date,
    context: WalletCoreSystemAuditContext,
  ): Promise<WalletUpdateResult> {
    assertScheduledContext(changeId, now, context);
      const settings = await this.repository.lockSettings(client);
      const change = await this.repository.lockChange(client, changeId);
      if (!change) throw new WalletConfigurationInvalid('Scheduled configuration does not exist.');
      if (['LIVE', 'ARCHIVED', 'REJECTED'].includes(change.status)) {
        return {
          outcome: 'ALREADY_PROCESSED', configurationId: change.id,
          revision: revision(change.revision),
          status: change.status as 'LIVE' | 'ARCHIVED' | 'REJECTED',
        };
      }
      if (change.status !== 'SCHEDULED' || !change.effectiveAt
        || !await this.repository.isChangeDue(client, change.id, now)) {
        throw new WalletConfigurationInvalid('Scheduled configuration is not due.');
      }
      if (settings.revision !== change.revision) {
        return this.rejectSchedule(
          client, change, context, 'STALE_SETTINGS_REVISION',
        );
      }
      let config: WalletCoreConfigurationPatch;
      let catalogue: CatalogueEvidence;
      try {
        const stored = readStoredWalletSnapshot(change);
        config = stored.config;
        catalogue = stored.catalogue;
      } catch (error) {
        if (!(error instanceof WalletConfigurationInvalid)) throw error;
        return this.rejectSchedule(client, change, context, 'CONFIGURATION_INVALID');
      }
      const catalogueError = await this.repository.validateCatalogue(client, catalogue);
      if (catalogueError) {
        return this.rejectSchedule(client, change, context, catalogueError, config);
      }
      if (!await this.repository.configurationWouldChange(
        client, config, change.revision, catalogue,
      )) {
        return this.rejectSchedule(client, change, context, 'CONFIGURATION_INVALID', config);
      }
      await this.repository.archiveCurrentLive(client, change.id);
      const changes = await this.repository.applyConfiguration(
        client, config, change.revision, catalogue,
      );
      const settingsChanged = config.settings
        ? await this.repository.applySettings(client, config.settings) : false;
      if (!settingsChanged && changes.length === 0) {
        throw new Error('WALLET_CONFIGURATION_PREVIEW_MISMATCH');
      }
      await this.repository.transitionChange(
        client, change.id, 'LIVE', change.effectiveAt, now,
      );
      const event = this.settingsAudit(
        change.id, change.revision, 'SETTINGS.SCHEDULE_APPLIED', context.actor,
        change.reason, change.changelogId, 'SCHEDULED', 'LIVE', change.effectiveAt, config,
        undefined, config.settings ? settings.settings : undefined,
      );
      const entityEvents = this.entityAudits(
        change.id, change.revision, change.reason, context.actor, changes, change.id,
      );
      await this.appendEvents(client, change.id, [event, ...entityEvents]);
      return {
        outcome: 'SCHEDULE_APPLIED', configurationId: change.id,
        revision: revision(change.revision), status: 'LIVE', appliedAt: instant(now),
      };
  }

  /** Persists a safe rejection outcome instead of applying stale scheduled intent. */
  private async rejectSchedule(
    client: WalletCoreClient,
    change: StoredConfigurationChange,
    context: WalletCoreSystemAuditContext,
    reasonCode: WalletScheduleRejectionReason,
    config?: WalletCoreConfigurationPatch,
  ): Promise<WalletUpdateResult> {
    await this.repository.transitionChange(
      client, change.id, 'REJECTED', change.effectiveAt, null,
    );
    const event = this.settingsAudit(
      change.id, change.revision, 'SETTINGS.SCHEDULE_REJECTED', context.actor,
      change.reason, change.changelogId, 'SCHEDULED', 'REJECTED',
      change.effectiveAt, config, reasonCode,
    );
    await this.appendEvents(client, change.id, [event]);
    return {
      outcome: 'SCHEDULE_REJECTED', configurationId: change.id,
      revision: revision(change.revision), status: 'REJECTED', reasonCode,
    };
  }

  private entityAudits(
    changeId: string,
    configurationRevision: number,
    reason: string,
    actor: WalletCoreAdminAuditInput['actor'],
    changes: readonly WalletEntityChange[],
    scheduledChangeId?: string,
  ): readonly WalletCoreAdminAuditInput[] {
    return changes.map((change) => {
      const metadata = {
        configurationRevision,
        ...(change.importCatalogueRevision === undefined
          ? {} : { importCatalogueRevision: change.importCatalogueRevision }),
        ...(scheduledChangeId === undefined ? {} : { scheduledChangeId }),
      };
      return {
        domain: 'WALLET_CORE',
        action: change.action,
        eventKey: stableConfigurationEventKey(
          changeId, change.action, change.subject.type, change.subject.id,
        ),
        actor,
        subject: change.subject,
        reason,
        before: change.before,
        after: change.after,
        metadata,
      } as WalletCoreAdminAuditInput;
    });
  }

  private settingsAudit(
    changeId: string,
    configurationRevision: number,
    action: SettingsAction,
    actor: WalletCoreAdminAuditInput['actor'],
    reason: string,
    changelogId: string | null,
    beforeStatus: 'DRAFT' | 'SCHEDULED' | null,
    afterStatus: 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'REJECTED',
    effectiveAt: string | null,
    config?: WalletCoreConfigurationPatch,
    safeErrorCode?: WalletScheduleRejectionReason,
    beforeSettings?: WalletSettingsPatch,
  ): WalletCoreAdminAuditInput {
    return {
      domain: 'WALLET_CORE',
      action,
      eventKey: stableConfigurationEventKey(
        changeId, action, 'SETTINGS_REVISION', String(configurationRevision),
      ),
      actor,
      subject: { type: 'SETTINGS_REVISION', id: String(configurationRevision) },
      reason,
      before: beforeStatus === null ? null : {
        revision: configurationRevision, status: beforeStatus, effectiveAt,
        ...(beforeSettings ? { config: { settings: beforeSettings } } : {}),
      },
      after: { revision: configurationRevision, status: afterStatus, effectiveAt,
        ...(config ? { config } : {}) },
      metadata: {
        configurationRevision,
        ...(changelogId === null ? {} : { changelogId }),
        ...(safeErrorCode ? { safeErrorCode } : {}),
      },
    } as WalletCoreAdminAuditInput;
  }

  private async appendEvents(
    client: WalletCoreClient,
    changeId: string,
    events: readonly WalletCoreAdminAuditInput[],
    auditEvents: readonly WalletCoreAdminAuditInput[] = events,
  ): Promise<void> {
    for (const event of orderConfigurationAuditEvents(events)) {
      await this.repository.appendStateEvent(client, {
        id: uuidv7(),
        eventType: event.action,
        subjectType: event.subject.type,
        subjectId: event.subject.type === 'SETTINGS_REVISION'
          ? changeId : event.subject.id,
        actor: event.actor,
        payload: {
          eventKey: event.eventKey,
          before: withoutAuditConfig(event.before),
          after: withoutAuditConfig(event.after),
          metadata: event.metadata,
        },
      });
    }
    for (const event of orderConfigurationAuditEvents(auditEvents)) {
      const before = event.before as Readonly<Record<string, unknown>> | null;
      const after = event.after as Readonly<Record<string, unknown>> | null;
      const normalized = event.subject.type === 'SETTINGS_REVISION' ? {
        ...event,
        before: before === null ? null : { ...before,
          effectiveAt: canonicalAuditInstant(before.effectiveAt) },
        after: after === null ? null : { ...after,
          effectiveAt: canonicalAuditInstant(after.effectiveAt) },
      } as WalletCoreAdminAuditInput : event;
      const result = await this.audit.appendWithTransaction(client, normalized);
      if (result.replayed) throw new Error('WALLET_CONFIGURATION_AUDIT_REPLAYED');
    }
  }
}
