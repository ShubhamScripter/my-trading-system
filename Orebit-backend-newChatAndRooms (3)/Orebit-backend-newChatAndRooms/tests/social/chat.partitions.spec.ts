import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { ChatMaintenance } from '../../src/social/chat/chat.maintenance';
import { ChatRecordsDbOperation } from '../../src/social/chat/persistence/chat.records.dboperation';
import type { PrismaService } from '../../db/client';
import { uuidv7 } from '../../src/utils/public.utils';

/**
 * Monthly message partitions (NEW-1): the migration, the daily keep-ahead call and its error handling.
 * The last block runs against a migrated database named by CHAT_TEST_DATABASE_URL and is skipped without it.
 */
const MIGRATION = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    'db',
    'migrations',
    '20260928100000_chat_messages_monthly_partitions',
    'migration.sql',
  ),
  'utf8',
);

describe('the partition migration', () => {
  it('partitions chat.room_messages by range on created_at with the key (id, created_at)', () => {
    expect(MIGRATION).toMatch(/PARTITION BY RANGE \("created_at"\)/);
    expect(MIGRATION).toMatch(/PRIMARY KEY \("id", "created_at"\)/);
  });

  it('adds a DEFAULT partition as a safety net', () => {
    expect(MIGRATION).toContain(
      'CREATE TABLE "chat"."room_messages_default" PARTITION OF "chat"."room_messages" DEFAULT',
    );
  });

  it('creates a chat-owned function that keeps months ahead, idempotently', () => {
    expect(MIGRATION).toContain('"chat"."ensure_message_partitions"(months_ahead INT)');
    expect(MIGRATION).toMatch(/Idempotent/i);
  });

  it('cuts partitions on UTC month boundaries', () => {
    expect(MIGRATION).toContain("AT TIME ZONE 'UTC'");
  });
});

describe('the keep-ahead call (NEW-1)', () => {
  function make(ensure: () => Promise<{ created: number; defaultRows: number }>) {
    const records = { ensurePartitions: vi.fn(ensure) };
    const maintenance = new ChatMaintenance(
      records as never,
      { archiveOldMonths: vi.fn(async () => 0), pruneClientIds: vi.fn(async () => 0) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      // The ads service is not part of the partition step.
      {} as never,
    );
    return { maintenance, records };
  }

  it('asks for three months ahead', async () => {
    const { maintenance, records } = make(async () => ({ created: 0, defaultRows: 0 }));
    await maintenance.ensurePartitions();
    expect(records.ensurePartitions).toHaveBeenCalledWith(3);
  });

  it('writes an error line when rows landed in the DEFAULT partition', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { maintenance } = make(async () => ({ created: 0, defaultRows: 2 }));
    await maintenance.ensurePartitions();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ defaultRows: 2 }),
      expect.stringContaining('DEFAULT partition'),
    );
    error.mockRestore();
  });

  it('logs and carries on when the call fails, so a database blip never stops chat', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { maintenance } = make(async () => {
      throw new Error('db down');
    });
    await expect(maintenance.ensurePartitions()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

const url = process.env.CHAT_TEST_DATABASE_URL;

const DM_MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'db', 'migrations', '20261028100000_chat_dm_partitions_counters', 'migration.sql'),
  'utf8',
);

describe('the DM partition migration (FR-060, V2-56, V2-143)', () => {
  it('partitions chat.dm_messages by month on created_at with the key (id, created_at)', () => {
    expect(DM_MIGRATION).toMatch(/PARTITION BY RANGE \("created_at"\)/);
    expect(DM_MIGRATION).toMatch(/PRIMARY KEY \("id", "created_at"\)/);
    expect(DM_MIGRATION).toContain('"chat"."dm_messages_default" PARTITION OF "chat"."dm_messages" DEFAULT');
  });

  it('moves old months to an archive schema and never deletes them', () => {
    expect(DM_MIGRATION).toContain('archive_old_dm_partitions');
    expect(DM_MIGRATION).toContain('DETACH PARTITION');
    expect(DM_MIGRATION).toContain('SET SCHEMA chat_archive');
    expect(DM_MIGRATION).not.toMatch(/DROP TABLE "chat_archive|DELETE FROM "chat"."dm_messages"/);
  });
});

describe.skipIf(!url)('partitions on a real database', () => {
  let prisma: PrismaClient;
  let records: ChatRecordsDbOperation;

  beforeAll(() => {
    prisma = new PrismaClient({ datasourceUrl: url });
    records = new ChatRecordsDbOperation(prisma as unknown as PrismaService);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('has a partition for this month and the three after it', async () => {
    await records.ensurePartitions(3);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    for (let i = 0; i <= 3; i += 1) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const name = `room_messages_${month.getUTCFullYear()}_${pad(month.getUTCMonth() + 1)}`;
      const found = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'chat' AND c.relname = ${name}
      `;
      expect(found[0]?.n, name).toBe(1);
    }
  });

  it('creates nothing on a second call, and the DEFAULT partition stays empty', async () => {
    await records.ensurePartitions(3);
    const second = await records.ensurePartitions(3);
    expect(second.created).toBe(0);
    expect(second.defaultRows).toBe(0);
  });
});

describe.skipIf(!url)('DM partitions and the archive on a real database', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasourceUrl: url });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('keeps DM partitions for this month and the three after it, together with the public ones', async () => {
    await prisma.$queryRaw`SELECT chat.ensure_message_partitions(3)`;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    for (let i = 0; i <= 3; i += 1) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const name = `dm_messages_${month.getUTCFullYear()}_${pad(month.getUTCMonth() + 1)}`;
      const found = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
        WHERE s.nspname = 'chat' AND c.relname = ${name}
      `;
      expect(found[0]!.n, name).toBe(1);
    }
    const again = await prisma.$queryRaw<{ n: number }[]>`SELECT chat.ensure_message_partitions(3) AS n`;
    expect(again[0]!.n).toBe(0);
  });

  it('archives a month older than the limit: the rows move to chat_archive, none is lost, the cut-off is recorded', async () => {
    const id = uuidv7();
    const name = `arch${id.slice(-6)}`;
    await prisma.$executeRaw`
      INSERT INTO identity.users (id, public_code, public_code_key, username, username_lower, email, email_lower, referral_code)
      VALUES (${id}::uuid, ${name}, ${name.toUpperCase()}, ${name}, ${name}, ${`${name}@e2e.test`}, ${`${name}@e2e.test`}, ${name})
    `;
    const conversation = uuidv7();
    await prisma.$executeRaw`INSERT INTO chat.dm_conversations (id, kind, direct_key, created_by) VALUES (${conversation}::uuid, 'DIRECT', ${`arch:${conversation}`}, ${id}::uuid)`;
    await prisma.$queryRaw`SELECT chat.create_dm_message_partition('2019-03-01'::date)`;
    await prisma.$executeRaw`
      INSERT INTO chat.dm_messages (id, conversation_id, sender_id, content, created_at)
      VALUES (${uuidv7()}::uuid, ${conversation}::uuid, ${id}::uuid, 'old', '2019-03-15T10:00:00Z')
    `;
    const moved = await prisma.$queryRaw<{ n: number }[]>`SELECT chat.archive_old_dm_partitions(12) AS n`;
    expect(moved[0]!.n).toBeGreaterThanOrEqual(1);
    const live = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM chat.dm_messages WHERE conversation_id = ${conversation}::uuid`;
    const archived = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM chat_archive.dm_messages_2019_03 WHERE conversation_id = ${conversation}::uuid`;
    expect(live[0]!.n).toBe(0);
    expect(archived[0]!.n).toBe(1);
    const cut = await prisma.$queryRaw<{ cut: Date | null }[]>`SELECT dm_messages_archived_before AS cut FROM chat.archive_state`;
    expect(cut[0]!.cut).not.toBeNull();
    // A second call has nothing left to move.
    const again = await prisma.$queryRaw<{ n: number }[]>`SELECT chat.archive_old_dm_partitions(12) AS n`;
    expect(again[0]!.n).toBe(0);
    await prisma.$executeRaw`DROP TABLE chat_archive.dm_messages_2019_03`;
    await prisma.$executeRaw`UPDATE chat.archive_state SET dm_messages_archived_before = NULL`;
  });
});
