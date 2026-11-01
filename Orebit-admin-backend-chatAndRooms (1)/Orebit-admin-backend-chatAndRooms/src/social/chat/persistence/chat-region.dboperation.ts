/**
 * Database access for chat regions: named groups of countries that room access rules can point at.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../db/client';
import type { ChatRegion } from '../chat.types';

interface RegionRow {
  id: string;
  name: string;
  countries: string[] | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ChatRegionDbOperation {
  constructor(private readonly prisma: PrismaService) {}

  async getRegions(): Promise<ChatRegion[]> {
    const rows = await this.prisma.$queryRaw<RegionRow[]>`
      SELECT id, name, countries, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM chat.regions
      ORDER BY name ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      countries: row.countries ?? [],
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
  }

  async createRegion(data: { id: string; name: string; countries: string[] }): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO chat.regions (id, name, countries, created_at, updated_at)
      VALUES (${data.id}::uuid, ${data.name}, ${data.countries}::char(2)[], now(), now())
    `;
  }

  async updateRegion(
    regionId: string,
    data: { name?: string; countries?: string[] },
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE chat.regions
      SET
        name       = COALESCE(${data.name ?? null}, name),
        countries  = COALESCE(${data.countries ?? null}::char(2)[], countries),
        updated_at = now()
      WHERE id = ${regionId}::uuid
    `;
    return changed > 0;
  }

  async deleteRegion(regionId: string): Promise<boolean> {
    const changed = await this.prisma
      .$executeRaw`DELETE FROM chat.regions WHERE id = ${regionId}::uuid`;
    return changed > 0;
  }
}
