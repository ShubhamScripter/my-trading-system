import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import {
  CHAT_COMMANDS,
  LINK_POLICIES,
  MAX_BAN_HOURS_CEILING,
  RESTRICTION_KINDS,
  RESTRICTION_TARGETS,
} from '../chat.contract';
import { ChatModerationDbOperation } from '../chat-moderation.dboperation';
import { ChatRoomDbOperation } from '../chat-room.dboperation';
import { ChatSettingsAdminService } from './chat.settings.service';

/** Validates moderation settings updates, link policies, banned words, and room-level restrictions. */
const SaveSchema = z
  .object({
    roomId: z.string().uuid(),
    linkPolicy: z.enum(LINK_POLICIES).optional(),
    bannedWords: z.array(z.string().trim().min(1).max(100)).max(1000).optional(),
    userRestrictions: z
      .array(
        z
          .object({
            targetType: z.enum(RESTRICTION_TARGETS),
            targetValue: z.string().trim().min(1).max(64),
            restriction: z.enum(RESTRICTION_KINDS),
            // Required internal audit note.
            internalReason: z.string().trim().min(1).max(500),
            /** Optional: what the restricted user sees. */
            userReason: z.string().trim().min(1).max(500).optional(),
            /** RESTRICT_COMMANDS only: the commands taken away; absent or empty = every command. */
            commands: z.array(z.enum(CHAT_COMMANDS)).max(CHAT_COMMANDS.length).optional(),
            permanent: z.literal(true).optional(),
            durationHours: z.number().min(1).max(MAX_BAN_HOURS_CEILING).optional(),
            expiresAt: z.string().datetime({ offset: true }).optional(),
          })
          .strict()
          .refine(
            (r) => [r.permanent, r.durationHours, r.expiresAt].filter((v) => v !== undefined).length === 1,
            'Say how long it lasts: permanent, durationHours (1 or more) or expiresAt',
          ),
      )
      .max(500)
      .optional(),
  })
  .strict();

// Per-room moderation settings stored in room configuration.
@Injectable()
export class ChatModerationSettingsService {
  constructor(
    private readonly rooms: ChatRoomDbOperation,
    private readonly moderation: ChatModerationDbOperation,
    private readonly settings: ChatSettingsAdminService,
  ) {}

  async get(roomId: string): Promise<Record<string, unknown>> {
    if (!z.string().uuid().safeParse(roomId).success) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: 'roomId must be a room id',
      });
    }
    const cfg = await this.rooms.getRoomConfig(roomId);
    if (!cfg) {
      throw new ProblemException({
        type: ERR.CHAT_ROOM_NOT_FOUND,
        detail: `Room ${roomId} not found`,
      });
    }
    const restrictions = Array.isArray(cfg.userRestrictions)
      ? (cfg.userRestrictions as Record<string, unknown>[])
      : [];
    return {
      roomId,
      linkPolicy: cfg.linksPolicy ?? 'NO_LINKS',
      bannedWords: cfg.bannedWords ?? [],
      userRestrictions: restrictions.map((r, index) => ({
        id: String(index),
        targetType: r.targetType,
        targetValue: r.targetValue,
        restriction: r.restriction,
        internalReason: r.internalReason,
        userReason: r.userReason ?? null,
        commands: Array.isArray(r.commands) ? r.commands : [],
        expiresAt: r.expiresAt ?? null,
        createdAt: '',
      })),
    };
  }

  async save(body: unknown, adminId: string): Promise<{ success: boolean }> {
    const parsed = SaveSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const dto = parsed.data;

    // A USER restriction must name a live account. Targets already stored are not re-checked, so an
    // account deleted since never blocks an unrelated save.
    if (dto.userRestrictions) {
      const stored = await this.rooms.getRoomConfig(dto.roomId);
      const known = new Set(
        (Array.isArray(stored?.userRestrictions)
          ? (stored.userRestrictions as Record<string, unknown>[])
          : []
        )
          .filter((r) => r.targetType === 'USER')
          .map((r) => String(r.targetValue).toLowerCase()),
      );
      // Resolves username or code to persistent user UUID to guard against handle renames.
      for (const r of dto.userRestrictions) {
        if (r.targetType !== 'USER' || known.has(r.targetValue.toLowerCase())) continue;
        const id = await this.moderation.resolveUserId(r.targetValue);
        if (!id) {
          throw new ProblemException({
            type: ERR.VALIDATION_FAILED,
            detail: `User '${r.targetValue}' does not exist`,
          });
        }
        r.targetValue = id;
      }
    }

    // A mute is a ban: it may not outlast the longest ban chat allows (`limits.maxBanHours`); longer needs `permanent`.
    // Other restrictions have no maximum below the contract ceiling.
    const maxBanHours = ((await this.settings.preview()) as { limits: { maxBanHours: number } }).limits.maxBanHours;
    for (const r of dto.userRestrictions ?? []) {
      if (r.restriction === 'MUTE' && r.durationHours !== undefined && r.durationHours > maxBanHours) {
        throw new ProblemException({
          type: ERR.VALIDATION_FAILED,
          detail: `A mute may last at most ${maxBanHours} hours; use permanent for longer`,
        });
      }
    }

    // Under a row lock, so two saves never lose each other's changes.
    const found = await this.rooms.changeRoomConfig(dto.roomId, (config, dbNow) => {
      if (dto.bannedWords) config.bannedWords = dto.bannedWords;
      // Stores explicit link policy so violations trigger configured moderation rules.
      if (dto.linkPolicy) config.linksPolicy = dto.linkPolicy;
      if (dto.userRestrictions) {
        // The expiry is stamped from the database clock.
        config.userRestrictions = dto.userRestrictions.map((r) => ({
          targetType: r.targetType,
          targetValue: r.targetValue,
          restriction: r.restriction,
          internalReason: r.internalReason,
          ...(r.userReason ? { userReason: r.userReason } : {}),
          ...(r.restriction === 'RESTRICT_COMMANDS' && r.commands?.length ? { commands: r.commands } : {}),
          ...(r.durationHours !== undefined
            ? { expiresAt: new Date(dbNow.getTime() + r.durationHours * 3600 * 1000).toISOString() }
            : {}),
          ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
        }));
      }
      return config;
    });
    if (!found) {
      throw new ProblemException({
        type: ERR.CHAT_ROOM_NOT_FOUND,
        detail: `Room ${dto.roomId} not found`,
      });
    }

    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'UPDATE_MODERATION_SETTINGS',
      targetRoomId: dto.roomId,
      newValue: {
        linkPolicy: dto.linkPolicy,
        bannedWords: dto.bannedWords?.length,
        userRestrictions: dto.userRestrictions?.length,
      },
    });
    await this.moderation.notify({ kind: 'room', roomId: dto.roomId });
    return { success: true };
  }
}
