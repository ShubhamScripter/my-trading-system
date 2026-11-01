// Database access for group invites (Module 9, ): one pending invite per person and group (the unique index
// decides a race), an expiry, a pending cap per person and a limit per inviter and window, checked under one lock
// per inviter.
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../db/client';
import { uuidv7 } from '../../../utils/public.utils';
import type { Db } from '../persistence/chat.sql';
import type { GroupVisibility, InviteRecord } from './dm.groups.dboperation';

@Injectable()
export class DmGroupInvitesDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  async pendingInvite(conversationId: string, inviteeId: string): Promise<InviteRecord | null> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        conversation_id: string;
        inviter_id: string;
        invitee_id: string;
        status: InviteRecord['status'];
        created_at: Date;
      }[]
    >`
      SELECT id, conversation_id, inviter_id, invitee_id, status, created_at FROM chat.dm_group_invites
      WHERE conversation_id = ${conversationId}::uuid AND invitee_id = ${inviteeId}::uuid AND status = 'PENDING'
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `;
    const row = rows[0];
    return row
      ? {
          id: row.id,
          conversationId: row.conversation_id,
          inviterId: row.inviter_id,
          inviteeId: row.invitee_id,
          status: row.status,
          createdAt: row.created_at,
        }
      : null;
  }

  // The invite of this person: the unexpired pending one when there is, otherwise a new one if the limits allow
// . Under one lock per inviter: expired invites are closed first, then the pending-per-person cap and the
// "invites per window" limit are counted, then the row is written with its expiry. The unique pending index decides
// a race on the same person, so two parallel invites give one id.
  async createInvite(
    conversationId: string,
    inviterId: string,
    inviteeId: string,
    limits: { perWindow: number; windowHours: number; pendingPerPerson: number; expiryHours: number },
  ): Promise<{ inviteId: string } | { refused: 'window_limit' | 'pending_cap' }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`invite:${inviterId}`}, 0))`;
      await tx.$executeRaw`
        UPDATE chat.dm_group_invites SET status = 'REVOKED', responded_at = now()
        WHERE invitee_id = ${inviteeId}::uuid AND status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= now()
      `;
      const existing = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM chat.dm_group_invites
        WHERE conversation_id = ${conversationId}::uuid AND invitee_id = ${inviteeId}::uuid AND status = 'PENDING'
      `;
      if (existing[0]) return { inviteId: existing[0].id };
      const pending = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chat.dm_group_invites WHERE invitee_id = ${inviteeId}::uuid AND status = 'PENDING'
      `;
      if ((pending[0]?.n ?? 0) >= limits.pendingPerPerson) return { refused: 'pending_cap' as const };
      const sent = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM chat.dm_group_invites
        WHERE inviter_id = ${inviterId}::uuid AND created_at > now() - make_interval(hours => ${limits.windowHours}::int)
      `;
      if ((sent[0]?.n ?? 0) >= limits.perWindow) return { refused: 'window_limit' as const };
      const id = uuidv7();
      await tx.$executeRaw`
        INSERT INTO chat.dm_group_invites (id, conversation_id, inviter_id, invitee_id, expires_at)
        VALUES (${id}::uuid, ${conversationId}::uuid, ${inviterId}::uuid, ${inviteeId}::uuid,
                now() + make_interval(hours => ${limits.expiryHours}::int))
      `;
      return { inviteId: id };
    });
  }

  async inviteById(id: string): Promise<InviteRecord | null> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        conversation_id: string;
        inviter_id: string;
        invitee_id: string;
        status: InviteRecord['status'];
        created_at: Date;
      }[]
    >`
      SELECT id, conversation_id, inviter_id, invitee_id, status, created_at FROM chat.dm_group_invites
      WHERE id = ${id}::uuid
    `;
    const row = rows[0];
    return row
      ? {
          id: row.id,
          conversationId: row.conversation_id,
          inviterId: row.inviter_id,
          inviteeId: row.invitee_id,
          status: row.status,
          createdAt: row.created_at,
        }
      : null;
  }

  // The user's pending invites with the group and who invited them (closed groups are not offered).
  async invitesFor(userId: string) {
    return this.prisma.$queryRaw<
      {
        id: string;
        conversation_id: string;
        group_name: string;
        group_logo: string | null;
        visibility: GroupVisibility;
        inviter_id: string;
        inviter_username: string | null;
        created_at: Date;
      }[]
    >`
      SELECT i.id, i.conversation_id, g.name AS group_name, g.logo_url AS group_logo, g.visibility, i.inviter_id,
             u.username AS inviter_username, i.created_at
      FROM chat.dm_group_invites i
      JOIN chat.dm_groups g ON g.conversation_id = i.conversation_id AND g.closed_at IS NULL
      LEFT JOIN identity.users u ON u.id = i.inviter_id
      WHERE i.invitee_id = ${userId}::uuid AND i.status = 'PENDING' AND (i.expires_at IS NULL OR i.expires_at > now())
      ORDER BY i.created_at DESC LIMIT 200
    `;
  }

  // PENDING → the answer; false when it was answered or revoked first.
  async answerInvite(
    id: string,
    status: 'ACCEPTED' | 'DECLINED' | 'REVOKED',
    db: Db = this.prisma,
  ): Promise<boolean> {
    const changed = await db.$executeRaw`
      UPDATE chat.dm_group_invites SET status = ${status}, responded_at = now()
      WHERE id = ${id}::uuid AND status = 'PENDING' AND (expires_at IS NULL OR expires_at > now())
    `;
    return changed > 0;
  }
}
