import { Injectable, Logger } from '@nestjs/common';
import { config } from '../../config';
import { RoomPatchSchema } from './chat.contract';
import { ChatSettingsDbOperation } from './persistence/chat.settings.dboperation';
import {
  ChatSettingsDocumentSchema,
  SettingsPatchSchema,
  applySettingsPatch,
  effectiveSettings,
  type ChatSettings,
  type ChatSettingsDocument,
} from './chat.settings.contract';
import { TIMERS } from './chat.constants';
import { ChatBus } from './realtime/chat.bus';

/**
 * Chat-wide admin settings: global values plus per-country exceptions, read through one resolver.
 *
 * The document is cached for at most 30 seconds (a cache-freshness timer) and dropped at once when the admin
 * signals a change. A stored document that fails the contract is logged and replaced by the defaults for
 * reading, so a bad save cannot stop chat.
 */
@Injectable()
export class ChatSettingsService {
  private readonly logger = new Logger('ChatSettingsService');
  private cached: { document: ChatSettingsDocument; loadedAt: number } | null = null;
  private loading: Promise<ChatSettingsDocument> | null = null;
  private lastBadVersion: number | null = null;

  constructor(
    private readonly db: ChatSettingsDbOperation,
    private readonly bus: ChatBus,
  ) {
    this.bus.subscribe((change) => {
      if (change.kind === 'settings') this.invalidate();
    });
  }

  invalidate(): void {
    this.cached = null;
  }

  async document(): Promise<ChatSettingsDocument> {
    if (this.cached && Date.now() - this.cached.loadedAt < TIMERS.CACHE_SECONDS * 1000)
      return this.cached.document;
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<ChatSettingsDocument> {
    const row = await this.db.settingsRow();
    const parsed = ChatSettingsDocumentSchema.safeParse(row?.document ?? {});
    let document: ChatSettingsDocument;
    if (parsed.success) {
      document = parsed.data;
    } else {
      if (this.lastBadVersion !== (row?.version ?? null)) {
        this.lastBadVersion = row?.version ?? null;
        this.logger.error(
          {
            component: 'ChatSettingsService',
            version: row?.version,
            issues: parsed.error.issues.slice(0, 5),
          },
          'stored chat settings fail the contract; using the defaults',
        );
      }
      document = ChatSettingsDocumentSchema.parse({});
    }
    this.cached = { document, loadedAt: Date.now() };
    return document;
  }

  /** The settings for everyone, without per-country exceptions. */
  async global(): Promise<ChatSettings> {
    return this.withLinkDefault(effectiveSettings(await this.document(), null));
  }

  /** `effective(key, country)`: the country's exception if present, else the global value, else the default. */
  async forCountry(country: string | null): Promise<ChatSettings> {
    return this.withLinkDefault(effectiveSettings(await this.document(), country));
  }

  /** An empty allow-list means the web app's own host (initially the host of WEB_APP_URL). */
  private withLinkDefault(settings: ChatSettings): ChatSettings {
    if (settings.links.allowedDomains.length > 0) return settings;
    let host: string;
    try {
      host = new URL(config.WEB_APP_URL).hostname.toLowerCase();
    } catch {
      return settings;
    }
    return { ...settings, links: { allowedDomains: [host] } };
  }

  /**
   * Applies every scheduled settings change whose time has come, on the database clock. Rows are locked
   * with SKIP LOCKED so two ticks never apply one change twice; `before` is recorded for rollback. Returns what
   * changed so the caller can publish it.
   */
  async applyDueChanges(): Promise<{ settings: boolean; roomIds: string[] }> {
    const result = { settings: false, roomIds: [] as string[] };
    await this.db.transaction(async (tx) => {
      for (const change of await this.db.dueChanges(tx)) {
        if (change.target === 'SETTINGS') {
          const patch = SettingsPatchSchema.safeParse(change.patch);
          const currentDocument = await this.db.lockSettingsDocument(tx);
          const before = ChatSettingsDocumentSchema.safeParse(currentDocument);
          const next =
            patch.success && before.success
              ? ChatSettingsDocumentSchema.safeParse(applySettingsPatch(before.data, patch.data))
              : null;
          if (!next?.success) {
            await this.db.cancelChange(tx, change.id);
            this.logger.error(
              { component: 'ChatSettingsService', changeId: change.id },
              'scheduled settings change is invalid; cancelled',
            );
            continue;
          }
          await this.db.writeSettingsDocument(tx, next.data, change.actor_id);
          await this.db.finishChange(tx, change.id, currentDocument);
          result.settings = true;
        } else if (change.target === 'ROOM' && change.room_id) {
          const patch = RoomPatchSchema.safeParse(change.patch);
          if (!patch.success) {
            await this.db.cancelChange(tx, change.id);
            continue;
          }
          const before = await this.db.applyRoomPatch(tx, change.room_id, patch.data);
          await this.db.finishChange(tx, change.id, before);
          if (before !== null) result.roomIds.push(change.room_id);
        }
      }
    });
    return result;
  }
}
