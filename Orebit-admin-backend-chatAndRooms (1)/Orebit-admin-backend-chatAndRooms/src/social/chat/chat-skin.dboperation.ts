/**
 * Database access for chat skins and media uploads. Skins are deactivated, never deleted;
 * uploads are soft-deleted and keep who uploaded them and when (legal hold).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../db/client';
import type { ChatSkin, MediaUpload } from './chat.types';

interface SkinRow {
  id: string;
  name: string;
  styleConfig: Record<string, unknown> | null;
  cost: unknown;
  isPremium: boolean | null;
  isActive: boolean | null;
  createdAt: Date;
}

interface UploadRow {
  id: string;
  uploaderId: string;
  uploaderUsername: string | null;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  createdAt: Date;
  flaggedAt: Date | null;
  flaggedBy: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteNote: string | null;
}

@Injectable()
export class ChatSkinDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  // Skins
  async getSkins(): Promise<ChatSkin[]> {
    const rows = await this.prisma.$queryRaw<SkinRow[]>`
      SELECT id, name, style_config AS "styleConfig", cost, is_premium AS "isPremium",
             is_active AS "isActive", created_at AS "createdAt"
      FROM chat.message_cosmetics
      ORDER BY created_at ASC
    `;
    return rows.map((row) => {
      const style = row.styleConfig ?? {};
      return {
        id: row.id,
        name: row.name,
        description: (style.description as string | undefined) ?? '',
        gradient:
          (style.gradient as string | undefined) ?? 'linear-gradient(135deg, #1e293b, #334155)',
        borderColor: (style.borderColor as string | undefined) ?? '#64748b',
        badgeIcon: (style.badgeIcon as string | undefined) ?? '✨',
        cost: String(row.cost ?? '0'),
        isPremium: row.isPremium ?? false,
        isActive: row.isActive !== false,
        createdAt: new Date(row.createdAt).toISOString(),
      };
    });
  }

  async createSkin(data: {
    id: string;
    name: string;
    description: string;
    gradient: string;
    borderColor: string;
    badgeIcon: string;
    cost: string;
    isPremium: boolean;
  }): Promise<void> {
    const styleConfig = {
      description: data.description,
      gradient: data.gradient,
      borderColor: data.borderColor,
      badgeIcon: data.badgeIcon,
    };
    await this.prisma.$executeRaw`
      INSERT INTO chat.message_cosmetics (id, name, style_config, cost, is_premium, is_active, created_at)
      VALUES (
        ${data.id}::uuid,
        ${data.name},
        ${styleConfig}::jsonb,
        ${data.cost}::numeric,
        ${data.isPremium},
        true,
        now()
      )
    `;
  }

  /** Deactivates a skin: it can no longer be chosen, but messages that use it keep their look. */
  async deactivateSkin(id: string): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.message_cosmetics SET is_active = false WHERE id = ${id}::uuid AND is_active = true
    `;
    return changed > 0;
  }

  /** Makes a deactivated skin selectable again. */
  async activateSkin(id: string): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.message_cosmetics SET is_active = true WHERE id = ${id}::uuid AND is_active = false
    `;
    return changed > 0;
  }

  // Media uploads
  async getMediaUploads(opts: {
    before?: string;
    limit: number;
    flaggedOnly: boolean;
  }): Promise<MediaUpload[]> {
    const rows = await this.prisma.$queryRaw<UploadRow[]>`
      SELECT
        m.id,
        m.uploader_id     AS "uploaderId",
        u.username        AS "uploaderUsername",
        m.mime_type       AS "mimeType",
        m.size_bytes      AS "sizeBytes",
        m.sha256,
        m.storage_key     AS "storageKey",
        m.created_at      AS "createdAt",
        m.flagged_at      AS "flaggedAt",
        m.flagged_by      AS "flaggedBy",
        m.deleted_at      AS "deletedAt",
        m.deleted_by      AS "deletedBy",
        m.delete_note     AS "deleteNote"
      FROM chat.media_uploads m
      -- uploader_id has no link to users, so the record survives an account's erasure (legal hold).
      LEFT JOIN identity.users u ON u.id = m.uploader_id
      WHERE
        (${!opts.before} OR m.created_at < ${opts.before ?? null}::timestamptz)
        AND (${!opts.flaggedOnly} OR m.flagged_at IS NOT NULL)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${opts.limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      uploaderId: row.uploaderId,
      uploaderUsername: row.uploaderUsername ?? null,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      storageKey: row.storageKey,
      createdAt: new Date(row.createdAt).toISOString(),
      flaggedAt: row.flaggedAt ? new Date(row.flaggedAt).toISOString() : null,
      flaggedBy: row.flaggedBy ?? null,
      deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
      deletedBy: row.deletedBy ?? null,
      deleteNote: row.deleteNote ?? null,
    }));
  }

  async flagMedia(uploadId: string, adminId: string): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.media_uploads
      SET flagged_at = now(), flagged_by = ${adminId}::uuid
      WHERE id = ${uploadId}::uuid AND flagged_at IS NULL AND deleted_at IS NULL
    `;
    return changed > 0;
  }

  /** Soft-deletes an upload with the admin's note; the uploader record is kept. */
  async deleteMedia(uploadId: string, adminId: string, note: string): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.media_uploads
      SET deleted_at = now(), deleted_by = ${adminId}::uuid, delete_note = ${note}
      WHERE id = ${uploadId}::uuid AND deleted_at IS NULL
    `;
    return changed > 0;
  }
}
