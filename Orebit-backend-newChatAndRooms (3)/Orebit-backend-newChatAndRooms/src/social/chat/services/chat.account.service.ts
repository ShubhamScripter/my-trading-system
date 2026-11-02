import { Injectable, Logger } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import { ChatAccessService } from '../chat.access.service';
import { ChatBus } from '../realtime/chat.bus';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatRecordsDbOperation } from '../persistence/chat.records.dboperation';
import { ChatModerationService, refuse } from '../chat.moderation.service';
import { ChatPresenceService } from '../chat.presence.service';
import type { ChatUserContext, EligibilityFacts, PublicSkin } from '../chat.types';
import { compareDecimal, isChatStaff } from '../chat.utility';
import { DmInboxService } from '../dm/dm.inbox.service';
import { ChatRelationsService } from './chat.relations.service';
import { assertAvailable, roomControlRefusal } from './chat.availability';
import { canAct } from './chat.permissions';
import {
  FileTooLargeError,
  openUpload,
  removeUploadFile,
  saveUpload,
  UnsupportedFileTypeError,
  UploadStorageError,
  uploadsEnabled,
  type UploadedFilePart,
  chatMediaBase,
} from '../chat.upload';

export { chatMediaBase };

/**
 * The user's own chat account: preferences, profile cards, skins and uploads.
 */
@Injectable()
export class ChatAccountService {
  private readonly logger = new Logger('ChatAccountService');

  constructor(
    private readonly db: ChatDbOperation,
    private readonly records: ChatRecordsDbOperation,
    private readonly access: ChatAccessService,
    private readonly moderation: ChatModerationService,
    private readonly presence: ChatPresenceService,
    private readonly bus: ChatBus,
    private readonly relations: ChatRelationsService,
    private readonly privacy: DmInboxService,
  ) {}

  // Preferences
  /**
   * Read only — a user without a row gets the defaults and no row is written. `effectiveDefaultRoomId` is the room
   * that should open: the browser's last room if still viewable, else the admin's default-room rules.
   */
  async preferences(user: ChatUserContext, lastRoomHint: string | null) {
    // The last room kept on the server wins over the browser's hint.
    const serverLastRoom = await this.presence.lastRoom(user.id);
    const [prefs, effective] = await Promise.all([
      this.db.preferences(user.id),
      this.access.effectiveRoom(user, serverLastRoom ?? lastRoomHint),
    ]);
    const facts = await this.access.factsFor(user);
    const skin = prefs.activeSkinId ? await this.usableSkin(prefs.activeSkinId, facts) : null;
    return {
      hideIdentity: prefs.hideIdentity,
      activeSkinId: skin?.id ?? null,
      effectiveDefaultRoomId: effective.room.id,
      // The chat staff role assigned in the admin panel, so the app shows staff tools only to staff.
      staffRole: user.staffRole ?? null,
    };
  }

  async updatePreferences(
    user: ChatUserContext,
    dto: { hideIdentity?: boolean; activeSkinId?: string | null },
  ) {
    if (dto.activeSkinId) await this.assertSkinUsable(user, dto.activeSkinId);
    const saved = await this.db.savePreferences(user.id, {
      ...(dto.hideIdentity !== undefined ? { hideIdentity: dto.hideIdentity } : {}),
      ...(dto.activeSkinId !== undefined ? { activeSkinId: dto.activeSkinId } : {}),
    });
    this.bus.publish({
      kind: 'preferences',
      userId: user.id,
      hideIdentity: saved.hideIdentity,
      activeSkinId: saved.activeSkinId,
    });
    return {
      hideIdentity: saved.hideIdentity,
      activeSkinId: saved.activeSkinId,
    };
  }

  // Skins
  /**
   * Until a feature owns buying skins, a skin is usable only when it exists, is active, costs nothing, and — if it is
   * a premium skin — the user holds an active premium plan (Chat MAIN: skins "received through Premium Membership").
   */
  private isUsable(
    skin: {
      isActive: boolean;
      isPremium: boolean;
      cost: { toString(): string };
    },
    facts: EligibilityFacts,
  ): boolean {
    if (!skin.isActive || compareDecimal(skin.cost, '0') !== 0) return false;
    return !skin.isPremium || (facts.premiumPlanIds?.length ?? 0) > 0;
  }

  async usableSkin(skinId: string, facts: EligibilityFacts): Promise<PublicSkin | null> {
    const skin = await this.db.skinById(skinId);
    if (!skin || !this.isUsable(skin, facts)) return null;
    return { id: skin.id, name: skin.name, style: skin.styleConfig };
  }

  async assertSkinUsable(user: ChatUserContext, skinId: string): Promise<PublicSkin> {
    assertAvailable(await this.access.settingsFor(user), 'skins', true);
    const skin = await this.usableSkin(skinId, await this.access.factsFor(user));
    if (!skin)
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.SKIN_NOT_ALLOWED,
        'You cannot use this skin',
      );
    return skin;
  }

  /** Only the skins this user may use. A database error is a 500, never an invented list; an empty table is []. */
  async skins(user: ChatUserContext): Promise<(PublicSkin & { isPremium: boolean })[]> {
    const facts = await this.access.factsFor(user);
    return (await this.db.skins())
      .filter((skin) => this.isUsable(skin, facts))
      .map((skin) => ({
        id: skin.id,
        name: skin.name,
        style: skin.styleConfig,
        isPremium: skin.isPremium,
      }));
  }

  // Profile cards
  async profile(viewer: ChatUserContext, handle: string) {
    const userId = await this.db.resolvePublicUsername(handle);
    if (!userId)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'User not found',
      });
    const [fields, target, prefs] = await Promise.all([
      this.db.profileFields(userId),
      this.db.findChatUser(userId),
      this.db.preferences(userId),
    ]);
    if (!fields || !target)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'User not found',
      });
    const facts = await this.access.factsFor(target);
    const skin = prefs.activeSkinId ? await this.usableSkin(prefs.activeSkinId, facts) : null;
    const own = viewer.id === target.id;
    // "/block: the other user won't be able to open profile" (Module 5).
    const relation = own ? null : await this.relations.relation(viewer.id, target.id);
    if (relation?.blockedMe)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'User not found',
      });
    // Online and last seen follow the user's privacy setting (Module 8); hidden reads as null.
    const presence = own
      ? {
          online: this.presence.isOnline(target.id),
          lastSeenAt: prefs.lastSeenAt?.toISOString() ?? null,
        }
      : ((await this.privacy.presenceFor(viewer.id, [target.id])).get(target.id) ?? null);
    return {
      id: target.id,
      username: target.username,
      // The login code is shown only to its owner.
      ...(own ? { publicCode: target.publicCode } : {}),
      avatarUrl: fields.avatarUrl,
      country: facts.country,
      isStaff: isChatStaff(target.staffRole),
      badges: {
        premium: (facts.premiumPlanIds?.length ?? 0) > 0,
        kycVerified: (facts.kycLevel ?? 0) >= 1,
      },
      isOnline: presence ? presence.online : null,
      lastSeenAt: presence ? presence.lastSeenAt : null,
      ...(relation ? { muted: relation.iMuted, blocked: relation.iBlocked } : {}),
      memberSince: fields.registeredAt.toISOString(),
      activeSkin: skin,
    };
  }

  // Uploads and media
  async upload(
    user: ChatUserContext,
    part: UploadedFilePart | undefined,
    roomRef: string | null = null,
  ) {
    if (!uploadsEnabled()) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_DISABLED,
        'Uploads are switched off',
      );
    }
    if (!part)
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: 'No file provided',
      });

    const dbNow = await this.db.dbNow();
    await this.moderation.assertNotBanned(user, null, dbNow);
    const settings = await this.access.settingsFor(user);

    // The room the file is for (optional): the user must be able to write there, checked before anything is stored.
    const room = roomRef ? await this.access.requireRoom(roomRef) : null;
    if (room) {
      const access = await this.access.evaluate(user, room);
      if (!access.isEligibleToWrite) {
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.ROOM_READ_ONLY,
          access.reason ?? 'You cannot write in this room',
          { roomId: room.id },
        );
      }
    }

    const wait = await this.records.uploadWaitSeconds(
      user.id,
      settings.limits.mediaCooldownSeconds,
    );
    if (wait > 0) {
      throw new ProblemException({
        type: ERR.RATE_LIMITED,
        detail: `Wait ${wait}s before uploading again`,
        extra: { reason: 'upload_cooldown', remainingSeconds: wait },
        retryAfterSeconds: wait,
      });
    }

    let saved;
    try {
      saved = await saveUpload(part, settings.uploads);
    } catch (err: unknown) {
      if (err instanceof UnsupportedFileTypeError || err instanceof FileTooLargeError) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          detail: err.message,
        });
      }
      if (err instanceof UploadStorageError) {
        this.logger.error(
          { component: 'ChatAccountService', err, userId: user.id },
          'chat upload storage unavailable',
        );
        throw new ProblemException({
          type: ERR.INTERNAL_ERROR,
          status: 503,
          detail: 'Upload storage is unavailable',
          extra: { reason: CHAT_REFUSAL_REASONS.UPLOAD_STORAGE_UNAVAILABLE },
        });
      }
      throw err;
    }

    // A type the room does not allow is refused and the file removed, so nothing lands in Media & Takedown.
    if (room) {
      const isVideo = saved.mimeType.startsWith('video/');
      // "Chat Room Controls" under MAINTENANCE: refused with the maintenance text, and the file removed.
      const maintenance = roomControlRefusal(room, settings, isVideo ? 'VIDEO' : 'IMAGE');
      if (maintenance) {
        await removeUploadFile(saved.storageKey).catch(() => undefined);
        throw maintenance;
      }
      // Staff with "Send Pictures / Videos in Chat" may upload where the room does not allow it (Module 4).
      const allowed = isVideo
        ? room.config.contentControls.allowVideo || canAct(settings, user.staffRole, 'SEND_VIDEOS')
        : room.config.contentControls.allowImage ||
          canAct(settings, user.staffRole, 'SEND_PICTURES');
      if (!allowed) {
        await removeUploadFile(saved.storageKey).catch(() => undefined);
        throw refuse(
          ERR.FORBIDDEN,
          CHAT_REFUSAL_REASONS.CONTENT_BLOCKED,
          isVideo ? 'Videos are not allowed in this room' : 'Images are not allowed in this room',
          { rule: 'media_type' },
        );
      }
    }

    await this.records.insertUpload({
      id: saved.id,
      uploaderId: user.id,
      mimeType: saved.mimeType,
      sizeBytes: saved.sizeBytes,
      sha256: saved.sha256,
      storageKey: saved.storageKey,
    });
    return {
      id: saved.id,
      url: `${chatMediaBase()}/social/chat/media/${saved.id}`,
      mediaType: saved.mimeType.startsWith('video/') ? ('video' as const) : ('image' as const),
      sizeBytes: saved.sizeBytes,
    };
  }

  /** Serves an upload to a signed-in user: 404 unknown, 410 deleted. */
  async media(id: string): Promise<{
    stream: import('node:stream').Readable;
    size: number;
    mimeType: string;
  }> {
    const row = /^[0-9a-f-]{36}$/i.test(id) ? await this.records.uploadById(id) : null;
    if (!row)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Media not found',
      });
    if (row.deletedAt) {
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        status: 410,
        detail: 'This media was removed',
        extra: { reason: CHAT_REFUSAL_REASONS.MEDIA_DELETED },
      });
    }
    const file = await openUpload(row.storageKey);
    if (!file)
      throw new ProblemException({
        type: ERR.NOT_FOUND,
        detail: 'Media not found',
      });
    return { ...file, mimeType: row.mimeType };
  }
}
