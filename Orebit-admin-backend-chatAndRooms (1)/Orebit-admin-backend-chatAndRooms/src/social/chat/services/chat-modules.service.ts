/** Admin service for Modules 4, 8, and 9: manages restrictions, penalty edits, and DM/group oversight. */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ERR } from '../../../contracts';
import { ProblemException, parseDto } from '../../../http';
import { CHAT_COMMANDS, RESTRICTION_KINDS, RESTRICTION_TARGETS } from '../chat.contract';
import { ChatModerationDbOperation } from '../chat-moderation.dboperation';
import { ChatModulesDbOperation } from '../persistence/chat-modules.dboperation';

const UUID = z.string().uuid();
const LIMIT = z.coerce.number().int().min(1).max(200).default(50);

export const CreateRestrictionSchema = z
  .object({
    targetType: z.enum(RESTRICTION_TARGETS),
    /** USER: an id or username. LEVEL: the minimum level. PREMIUM / KYC: anything. */
    targetValue: z.string().trim().min(1).max(64),
    kind: z.enum(RESTRICTION_KINDS),
    commands: z.array(z.enum(CHAT_COMMANDS)).max(CHAT_COMMANDS.length).default([]),
    roomId: UUID.nullable().default(null),
    // Required internal audit reason.
    internalReason: z.string().trim().min(1).max(500),
    // Optional reason visible to user.
    userReason: z.string().trim().min(1).max(500).optional(),
    /** Absent = until lifted. */
    durationHours: z
      .number()
      .positive()
      .max(24 * 365 * 10)
      .optional(),
  })
  .strict();

export const LiftRestrictionSchema = z
  .object({ restrictionId: UUID, note: z.string().trim().max(500).optional() })
  .strict();

export const RestrictionsQuerySchema = z
  .object({
    active: z.enum(['true', 'false']).default('true'),
    userId: z.string().trim().min(1).max(64).optional(),
    limit: LIMIT,
    before: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const ChangeBanSchema = z
  .object({
    banId: UUID,
    /** A new end counted from now; or `permanent: true`. */
    durationHours: z
      .number()
      .positive()
      .max(24 * 365 * 10)
      .optional(),
    permanent: z.literal(true).optional(),
    internalReason: z.string().trim().min(1).max(500).optional(),
    // Optional reason visible to user.
    userReason: z.string().trim().min(1).max(500).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((b) => (b.permanent === true) !== (b.durationHours !== undefined), {
    message: 'Give durationHours or permanent: true',
    path: ['durationHours'],
  });

export const ChangeRestrictionSchema = z
  .object({
    restrictionId: UUID,
    /** A new end counted from now; null = until lifted. */
    durationHours: z
      .number()
      .positive()
      .max(24 * 365 * 10)
      .nullable(),
    internalReason: z.string().trim().min(1).max(500).optional(),
    // Optional reason visible to user.
    userReason: z.string().trim().min(1).max(500).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const BotLogQuerySchema = z
  .object({
    userId: z.string().trim().min(1).max(64).optional(),
    limit: LIMIT,
    before: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

const CURSOR = z.string().trim().min(1).max(200);

export const UserConversationsQuerySchema = z
  .object({ userId: z.string().trim().min(1).max(64), limit: LIMIT, cursor: CURSOR.optional() })
  .strict();

export const ReadConversationSchema = z
  .object({
    conversationId: UUID,
    /** Chat DM Settings "Input: Unencrypt Reason": required, kept in the moderation log. */
    reason: z.string().trim().min(5).max(500),
    limit: z.number().int().min(1).max(200).default(100),
    cursor: CURSOR.optional(),
  })
  .strict();

export const GroupsQuerySchema = z
  .object({ q: z.string().trim().min(1).max(64).optional(), limit: LIMIT, cursor: CURSOR.optional() })
  .strict();

@Injectable()
export class ChatModulesService {
  constructor(
    private readonly db: ChatModulesDbOperation,
    private readonly moderation: ChatModerationDbOperation,
  ) {}

  private async userId(handle: string): Promise<string> {
    const id = await this.moderation.resolveUserId(handle);
    if (!id)
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: `User '${handle}' not found` });
    return id;
  }

  // Restrictions
  async restrictions(query: unknown) {
    const q = parseDto(RestrictionsQuerySchema, query);
    return {
      restrictions: await this.db.restrictions({
        activeOnly: q.active === 'true',
        userId: q.userId ? await this.userId(q.userId) : null,
        limit: q.limit,
        before: q.before ?? null,
      }),
    };
  }

  async createRestriction(body: unknown, adminId: string) {
    const dto = parseDto(CreateRestrictionSchema, body);
    if (dto.kind !== 'RESTRICT_COMMANDS' && dto.commands.length > 0) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: 'commands applies only to RESTRICT_COMMANDS',
      });
    }
    if (dto.targetType === 'LEVEL' && !/^\d{1,6}$/.test(dto.targetValue)) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: 'A LEVEL target is the minimum level',
      });
    }
    const targetValue =
      dto.targetType === 'USER' ? await this.userId(dto.targetValue) : dto.targetValue;
    const created = await this.db.createRestriction({
      targetType: dto.targetType,
      targetValue,
      kind: dto.kind,
      commands: dto.commands,
      roomId: dto.roomId,
      internalReason: dto.internalReason,
      userReason: dto.userReason ?? null,
      adminId,
      hours: dto.durationHours ?? null,
    });
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'RESTRICT_USER',
      targetUserId: dto.targetType === 'USER' ? targetValue : null,
      targetRoomId: dto.roomId,
      newValue: {
        restrictionId: created.id,
        kind: dto.kind,
        targetType: dto.targetType,
        targetValue,
      },
      note: dto.internalReason,
    });
    await this.moderation.notify({ kind: 'restrictions' });
    if (dto.targetType === 'USER') {
      await this.moderation.notify({
        kind: 'notice',
        userId: targetValue,
        notice: {
          action: 'restrict',
          roomId: dto.roomId,
          note: dto.userReason ?? null,
          expiresAt: created.expiresAt,
        },
      });
    }
    return { id: created.id, expiresAt: created.expiresAt };
  }

  async liftRestriction(body: unknown, adminId: string) {
    const dto = parseDto(LiftRestrictionSchema, body);
    const lifted = await this.db.liftRestriction(dto.restrictionId, adminId);
    if (!lifted)
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'No such active restriction' });
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'LIFT_RESTRICTION',
      targetUserId: lifted.targetType === 'USER' ? lifted.targetValue : null,
      newValue: { restrictionId: dto.restrictionId },
      note: dto.note ?? null,
    });
    await this.moderation.notify({ kind: 'restrictions' });
    if (lifted.targetType === 'USER') {
      await this.moderation.notify({
        kind: 'notice',
        userId: lifted.targetValue,
        notice: { action: 'unrestrict', note: dto.note ?? null },
      });
    }
    return { success: true };
  }

  /** "Check Chat Banned / Penalised Users List: Edit": a new end (from now, or permanent) and reason for a live ban. */
  async changeBan(body: unknown, adminId: string) {
    const dto = parseDto(ChangeBanSchema, body);
    const maxHours = await this.moderation.maxBanHours();
    if (dto.durationHours !== undefined && dto.durationHours > maxHours) {
      throw new ProblemException({
        type: ERR.VALIDATION_FAILED,
        detail: `At most ${maxHours} hours, or permanent`,
      });
    }
    const changed = await this.db.updateBan(dto.banId, {
      seconds: dto.permanent ? null : Math.round(dto.durationHours! * 3600),
      internalReason: dto.internalReason ?? null,
      userReason: dto.userReason ?? null,
    });
    if (!changed) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'No such active ban' });
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'CHANGE_BAN',
      targetUserId: changed.userId,
      targetRoomId: changed.roomId,
      oldValue: changed.old,
      newValue: {
        banId: dto.banId,
        expiresAt: changed.expiresAt,
        internalReason: dto.internalReason ?? null,
        userReason: dto.userReason ?? null,
      },
      note: dto.note ?? null,
    });
    await this.moderation.notify({ kind: 'ban', userId: changed.userId });
    await this.moderation.notify({
      kind: 'notice',
      userId: changed.userId,
      notice: {
        action: 'ban',
        roomId: changed.roomId,
        note: dto.userReason ?? changed.userReason,
        expiresAt: changed.expiresAt,
      },
    });
    return { banId: dto.banId, expiresAt: changed.expiresAt };
  }

  /** A new end (from now, or until lifted) and reason for a live restriction. */
  async changeRestriction(body: unknown, adminId: string) {
    const dto = parseDto(ChangeRestrictionSchema, body);
    const changed = await this.db.updateRestriction(dto.restrictionId, {
      hours: dto.durationHours,
      internalReason: dto.internalReason ?? null,
      userReason: dto.userReason ?? null,
    });
    if (!changed)
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'No such active restriction' });
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'CHANGE_RESTRICTION',
      targetUserId: changed.targetType === 'USER' ? changed.targetValue : null,
      newValue: {
        restrictionId: dto.restrictionId,
        expiresAt: changed.expiresAt,
        internalReason: dto.internalReason ?? null,
        userReason: dto.userReason ?? null,
      },
      note: dto.note ?? null,
    });
    await this.moderation.notify({ kind: 'restrictions' });
    return { restrictionId: dto.restrictionId, expiresAt: changed.expiresAt };
  }

  /** "Check Bot Log": what automatic moderation did, to one user or everyone. */
  async botLog(query: unknown) {
    const q = parseDto(BotLogQuerySchema, query);
    return {
      entries: await this.db.botLog(
        q.userId ? await this.userId(q.userId) : null,
        q.limit,
        q.before ?? null,
      ),
    };
  }

  // Direct messages and groups
  // Lists conversations of a user with audit logging.
  async userConversations(query: unknown, adminId: string) {
    const q = parseDto(UserConversationsQuerySchema, query);
    const userId = await this.userId(q.userId);
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'DM_LIST',
      targetUserId: userId,
      newValue: { limit: q.limit, cursor: q.cursor ?? null },
    });
    const page = await this.db.conversationsOf(userId, q.limit, q.cursor ?? null);
    return { userId, conversations: page.items, nextCursor: page.nextCursor };
  }

  /** "UnEncrypt User Conversations": the full conversation, recorded with the admin's reason. */
  async readConversation(body: unknown, adminId: string) {
    const dto = parseDto(ReadConversationSchema, body);
    if (!(await this.db.conversationExists(dto.conversationId))) {
      throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Conversation not found' });
    }
    // The row names the conversation, whose messages were read (its members) and the range (page size, cursor).
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'DM_VIEW',
      newValue: {
        conversationId: dto.conversationId,
        memberIds: await this.db.memberIds(dto.conversationId),
        limit: dto.limit,
        cursor: dto.cursor ?? null,
      },
      note: dto.reason,
    });
    const page = await this.db.conversationMessages(dto.conversationId, dto.limit, dto.cursor ?? null);
    return { conversationId: dto.conversationId, messages: page.items, nextCursor: page.nextCursor };
  }

  async groups(query: unknown, adminId: string) {
    const q = parseDto(GroupsQuerySchema, query);
    await this.moderation.recordModerationAction({
      actorId: adminId,
      action: 'DM_GROUP_LIST',
      newValue: { q: q.q ?? null, limit: q.limit, cursor: q.cursor ?? null },
    });
    const page = await this.db.groups(q.q ?? null, q.limit, q.cursor ?? null);
    return { groups: page.items, nextCursor: page.nextCursor };
  }
}
