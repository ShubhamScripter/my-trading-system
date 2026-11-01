import { Injectable, Logger } from '@nestjs/common';
import { ChatModerationDbOperation } from '../chat-moderation.dboperation';
import { ChatSettingsDbOperation } from '../persistence/chat-settings.dboperation';
import { ChatUtility } from '../chat.utility';
import {
  ChatSettingsDocumentSchema,
  SettingsPatchSchema,
  applySettingsPatch,
  effectiveSettings,
} from '../chat.settings.contract';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';

/** Admin service for chat settings: validates, applies, and rolls back settings document patches. */
@Injectable()
export class ChatSettingsAdminService {
  private readonly logger = new Logger('ChatSettingsAdminService');

  constructor(
    private readonly settings: ChatSettingsDbOperation,
    private readonly moderation: ChatModerationDbOperation,
  ) { }

  async getDocument(): Promise<{ document: unknown; version: number; updatedAt: string }> {
    return this.settings.getSettingsDocument();
  }

  /**
   * Validates the patch, merges it with the current document, and saves. When `effectiveAt` is
   * in the future the change is scheduled; the user BE's tick applies it.
   */
  async savePatch(data: {
    patch: unknown;
    actorId: string;
    effectiveAt?: string;
  }): Promise<{ changeId: string; applied: boolean }> {
    // 1. The patch must match the settings contract.
    const patchParsed = SettingsPatchSchema.safeParse(data.patch);
    if (!patchParsed.success) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: patchParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }

    // 2. Load the stored document. Refuse with 409 conflict if stored doc fails contract (FR-005).
    const { document: rawDoc, version } = await this.settings.getSettingsDocument();
    const currentParsed = ChatSettingsDocumentSchema.safeParse(rawDoc ?? {});
    if (rawDoc !== null && rawDoc !== undefined && Object.keys(rawDoc as object).length > 0 && !currentParsed.success) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        status: 409,
        detail: `The stored settings document is invalid against contract: ${currentParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      });
    }
    const current = currentParsed.success
      ? currentParsed.data
      : ChatSettingsDocumentSchema.parse({});

    // 3. Merge, then validate the whole result before saving.
    const next = applySettingsPatch(current, patchParsed.data);
    const nextParsed = ChatSettingsDocumentSchema.safeParse(next);
    if (!nextParsed.success) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: `The resulting settings document is invalid: ${nextParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      });
    }

    const changeId = ChatUtility.generateUuid();
    // Due now or scheduled is decided on the database clock, never this server's clock.
    const dbNow = await this.settings.dbNow();
    const effectiveAt = data.effectiveAt ? new Date(data.effectiveAt) : dbNow;
    const applyNow = effectiveAt <= dbNow;

    await this.settings.saveSettingsChange({
      id: changeId,
      patch: data.patch,
      actorId: data.actorId,
      effectiveAt,
      applyNow,
      currentDocument: rawDoc,
      nextDocument: nextParsed.data,
    });

    if (applyNow) {
      // Tell the chat server the settings changed.
      await this.moderation.notify({ kind: 'settings' });
      this.logger.log(
        { changeId, actorId: data.actorId, version: version + 1 },
        'chat settings applied immediately',
      );
    } else {
      this.logger.log(
        { changeId, actorId: data.actorId, effectiveAt },
        'chat settings change scheduled',
      );
    }

    return { changeId, applied: applyNow };
  }

  async rollback(changeId: string, actorId: string): Promise<{ success: boolean }> {
    const success = await this.settings.rollbackSettingsChange(changeId, actorId);
    if (!success) {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: `Settings change ${changeId} not found, has already been rolled back, or has no before snapshot`,
      });
    }
    await this.moderation.notify({ kind: 'settings' });
    this.logger.log({ changeId, actorId }, 'chat settings rolled back');
    return { success: true };
  }

  async getChanges(opts: {
    before?: string;
    limit: number;
    status: string;
  }): Promise<import('../chat.types').SettingsChange[]> {
    return this.settings.getSettingsChanges(opts);
  }

  /**
   * Returns the effective settings for a given country — the same function the user BE uses,
   * so the admin panel can preview what users will see.
   */
  async preview(country?: string): Promise<unknown> {
    const { document: rawDoc } = await this.settings.getSettingsDocument();
    const parsed = ChatSettingsDocumentSchema.safeParse(rawDoc ?? {});
    const doc = parsed.success ? parsed.data : ChatSettingsDocumentSchema.parse({});
    return effectiveSettings(doc, country ?? null);
  }
}
