/** Database operations for chat settings document snapshots, versioning, and change history. */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../db/client';
import { ChatSettingsDocumentSchema } from '../chat.settings.contract';
import type { SettingsChange } from '../chat.types';

interface ChangeRow {
  id: string;
  target: string;
  roomId: string | null;
  actorId: string | null;
  patch: unknown;
  before: unknown;
  effectiveAt: Date;
  status: string;
  createdAt: Date;
  appliedAt: Date | null;
}

type Layer = Record<string, Record<string, unknown>>;

@Injectable()
export class ChatSettingsDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  /** The database clock: every "is it due yet" decision uses it, never this process's clock. */
  async dbNow(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return rows[0]?.now ?? new Date();
  }

  async getSettingsDocument(): Promise<{ document: unknown; version: number; updatedAt: string }> {
    const rows = await this.prisma.$queryRaw<
      { document: unknown; version: number; updated_at: Date }[]
    >`
      SELECT document, version, updated_at FROM chat.settings WHERE id = 1
    `;
    const row = rows[0];
    if (!row)
      return {
        document: { global: {}, countries: {} },
        version: 0,
        updatedAt: new Date(0).toISOString(),
      };
    return {
      document: row.document,
      version: row.version,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  /**
   * Records a settings change. Applied now: the document is replaced and `before` kept for rollback. Otherwise
   * the change is scheduled and the chat server applies it when its time comes.
   */
  async saveSettingsChange(data: {
    id: string;
    patch: unknown;
    actorId: string;
    effectiveAt: Date;
    applyNow: boolean;
    currentDocument: unknown;
    nextDocument: unknown;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (data.applyNow) {
        await tx.$executeRaw`
          UPDATE chat.settings
          SET document = ${JSON.stringify(data.nextDocument)}::jsonb,
              version = version + 1,
              updated_by = ${data.actorId}::uuid,
              updated_at = now()
          WHERE id = 1
        `;
        await tx.$executeRaw`
          INSERT INTO chat.settings_changes (id, target, actor_id, patch, before, effective_at, status, created_at, applied_at)
          VALUES (
            ${data.id}::uuid, 'SETTINGS', ${data.actorId}::uuid,
            ${JSON.stringify(data.patch)}::jsonb,
            ${JSON.stringify(data.currentDocument)}::jsonb,
            ${data.effectiveAt}, 'APPLIED', now(), now()
          )
        `;
      } else {
        await tx.$executeRaw`
          INSERT INTO chat.settings_changes (id, target, actor_id, patch, effective_at, status, created_at)
          VALUES (
            ${data.id}::uuid, 'SETTINGS', ${data.actorId}::uuid,
            ${JSON.stringify(data.patch)}::jsonb,
            ${data.effectiveAt}, 'SCHEDULED', now()
          )
        `;
      }
    });
  }

  async getSettingsChanges(opts: {
    before?: string;
    limit: number;
    status: string;
  }): Promise<SettingsChange[]> {
    const rows = await this.prisma.$queryRaw<ChangeRow[]>`
      SELECT id, target, room_id AS "roomId", actor_id AS "actorId", patch, before,
             effective_at AS "effectiveAt", status, created_at AS "createdAt", applied_at AS "appliedAt"
      FROM chat.settings_changes
      WHERE
        (${opts.status === 'ALL'} OR status = ${opts.status})
        AND (${!opts.before} OR created_at < ${opts.before ?? null}::timestamptz)
      ORDER BY created_at DESC, id DESC
      LIMIT ${opts.limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      target: row.target as SettingsChange['target'],
      roomId: row.roomId ?? null,
      actorId: row.actorId ?? null,
      patch: row.patch,
      before: row.before ?? null,
      effectiveAt: new Date(row.effectiveAt).toISOString(),
      status: row.status as SettingsChange['status'],
      createdAt: new Date(row.createdAt).toISOString(),
      appliedAt: row.appliedAt ? new Date(row.appliedAt).toISOString() : null,
    }));
  }

  /** Undoes one applied change, key by key, and marks it cancelled. False when it cannot be rolled back. */
  async rollbackSettingsChange(changeId: string, actorId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; before: unknown; patch: unknown }[]>`
        SELECT status, before, patch FROM chat.settings_changes WHERE id = ${changeId}::uuid FOR UPDATE
      `;
      const change = rows[0];
      // A change still waiting for its time (settings or a room) is simply called off.
      if (change?.status === 'SCHEDULED') {
        await tx.$executeRaw`
          UPDATE chat.settings_changes SET status = 'CANCELLED', applied_at = now()
          WHERE id = ${changeId}::uuid AND status = 'SCHEDULED'
        `;
        return true;
      }
      if (!change || change.status !== 'APPLIED' || !change.before) return false;

      // Undo only the keys this change set. Restoring the whole old document would also undo every
      // later change, for example turning the test providers off again.
      const current = await tx.$queryRaw<{ document: unknown }[]>`
        SELECT document FROM chat.settings WHERE id = 1 FOR UPDATE
      `;
      const reverted = revertSettingsChange(current[0]?.document, change.before, change.patch);
      const parsed = ChatSettingsDocumentSchema.safeParse(reverted);
      if (!parsed.success) return false;

      await tx.$executeRaw`
        UPDATE chat.settings
        SET document = ${JSON.stringify(parsed.data)}::jsonb, version = version + 1,
            updated_by = ${actorId}::uuid, updated_at = now()
        WHERE id = 1
      `;
      await tx.$executeRaw`
        UPDATE chat.settings_changes SET status = 'CANCELLED', applied_at = now()
        WHERE id = ${changeId}::uuid
      `;
      return true;
    });
  }
}

/** Puts back, key by key, the values `patch` replaced; keys it added are removed. */
function revertLayer(current: Layer | undefined, before: Layer | undefined, patch: Layer): Layer {
  const out: Layer = {};
  for (const [section, values] of Object.entries(current ?? {})) out[section] = { ...values };
  for (const [section, values] of Object.entries(patch)) {
    if (!values || typeof values !== 'object') continue;
    const target = { ...(out[section] ?? {}) };
    for (const key of Object.keys(values)) {
      const old = before?.[section]?.[key];
      if (old === undefined) delete target[key];
      else target[key] = old;
    }
    if (Object.keys(target).length > 0) out[section] = target;
    else delete out[section];
  }
  return out;
}

/** The settings document with one change undone, leaving every other change in place. */
export function revertSettingsChange(
  currentRaw: unknown,
  beforeRaw: unknown,
  patchRaw: unknown,
): unknown {
  const current = (currentRaw ?? {}) as { global?: Layer; countries?: Record<string, Layer> };
  const before = (beforeRaw ?? {}) as { global?: Layer; countries?: Record<string, Layer> };
  const patch = (patchRaw ?? {}) as { global?: Layer; countries?: Record<string, Layer | null> };
  const countries: Record<string, Layer> = { ...(current.countries ?? {}) };
  for (const [code, layer] of Object.entries(patch.countries ?? {})) {
    const old = before.countries?.[code];
    if (layer === null) {
      if (old) countries[code] = old;
      continue;
    }
    const next = revertLayer(countries[code], old, layer);
    if (Object.keys(next).length > 0) countries[code] = next;
    else delete countries[code];
  }
  return {
    global: patch.global
      ? revertLayer(current.global, before.global, patch.global)
      : (current.global ?? {}),
    countries,
  };
}
