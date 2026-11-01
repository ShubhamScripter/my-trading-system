/** Admin service for chat skins and uploaded media audit, moderation, and soft deletion. */
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { ChatModerationDbOperation } from '../chat-moderation.dboperation';
import { ChatSkinDbOperation } from '../chat-skin.dboperation';
import type { CreateSkinInput, DeleteMediaInput, FlagMediaInput } from '../chat.dto';
import type { ChatSkin, MediaUpload } from '../chat.types';
import { ChatUtility } from '../chat.utility';

@Injectable()
export class ChatSkinService {
  constructor(
    private readonly skins: ChatSkinDbOperation,
    private readonly moderation: ChatModerationDbOperation,
  ) {}

  // Skins
  getSkins(): Promise<ChatSkin[]> {
    return this.skins.getSkins();
  }

  async createSkin(dto: CreateSkinInput, adminId: string): Promise<{ id: string }> {
    const id = ChatUtility.generateUuid();
    await this.skins.createSkin({
      id,
      name: dto.name,
      description: dto.description ?? '',
      gradient: dto.gradient,
      borderColor: dto.borderColor,
      badgeIcon: dto.badgeIcon,
      cost: dto.cost ?? '0',
      isPremium: dto.isPremium ?? false,
    });
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'CREATE_SKIN',
      newValue: { name: dto.name },
    });
    return { id };
  }

  /** Deactivates a skin: it can no longer be chosen, but messages that use it keep their look. */
  async deactivateSkin(skinId: string, adminId: string): Promise<{ success: boolean }> {
    if (!(await this.skins.deactivateSkin(skinId))) {
      throw new ProblemException({
        type: ERR.CHAT_COSMETIC_NOT_FOUND,
        detail: `Skin ${skinId} not found or already inactive`,
      });
    }
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'DEACTIVATE_SKIN',
      newValue: { skinId },
    });
    return { success: true };
  }

  /** Makes a deactivated skin selectable again. */
  async activateSkin(skinId: string, adminId: string): Promise<{ success: boolean }> {
    if (!(await this.skins.activateSkin(skinId))) {
      throw new ProblemException({
        type: ERR.CHAT_COSMETIC_NOT_FOUND,
        detail: `Skin ${skinId} not found or already active`,
      });
    }
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'ACTIVATE_SKIN',
      newValue: { skinId },
    });
    return { success: true };
  }

  // Media uploads
  getMediaUploads(opts: {
    before?: string;
    limit: number;
    flaggedOnly: boolean;
  }): Promise<MediaUpload[]> {
    return this.skins.getMediaUploads(opts);
  }

  async flagMedia(dto: FlagMediaInput, adminId: string): Promise<{ success: boolean }> {
    if (!(await this.skins.flagMedia(dto.uploadId, adminId))) {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: `Upload ${dto.uploadId} not found or already flagged/deleted`,
      });
    }
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'FLAG_MEDIA',
      newValue: { uploadId: dto.uploadId },
      note: dto.note,
    });
    return { success: true };
  }

  async deleteMedia(dto: DeleteMediaInput, adminId: string): Promise<{ success: boolean }> {
    // Soft delete: the record of who uploaded it and when is kept for legal hold.
    if (!(await this.skins.deleteMedia(dto.uploadId, adminId, dto.note))) {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: `Upload ${dto.uploadId} not found or already deleted`,
      });
    }
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'DELETE_MEDIA',
      newValue: { uploadId: dto.uploadId },
      note: dto.note,
    });
    return { success: true };
  }
}
