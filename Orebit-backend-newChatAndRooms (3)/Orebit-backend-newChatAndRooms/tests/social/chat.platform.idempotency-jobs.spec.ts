import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { ProblemException } from '../../src/http';
import { assertSameRequest, fingerprint, requireKey } from '../../src/social/chat/platform/idempotency';
import { claimBatch, releaseClaim } from '../../src/social/chat/platform/jobs';

/**
 * platform/idempotency and platform/jobs (FR-016, FR-017, FR-106): the same request is the same fingerprint, a key with
 * a different request is a 409, and parallel claims never take the same row.
 */
describe('idempotency', () => {
  it('the same request has the same fingerprint whatever the key order', () => {
    expect(fingerprint({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(fingerprint({ b: { d: 'x', c: [1, 2] }, a: 1 }));
    expect(fingerprint({ a: 1, b: undefined })).toBe(fingerprint({ a: 1 }));
  });

  it('a different request has a different fingerprint', () => {
    expect(fingerprint({ amount: '5' })).not.toBe(fingerprint({ amount: '6' }));
    expect(fingerprint([1, 2])).not.toBe(fingerprint([2, 1]));
  });

  it('a key with the same request passes; with another request it is a 409', () => {
    const first = { rooms: ['a'], text: 'hello' };
    expect(() => assertSameRequest(fingerprint(first), { text: 'hello', rooms: ['a'] })).not.toThrow();
    try {
      assertSameRequest(fingerprint(first), { rooms: ['a'], text: 'changed' });
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemException);
      expect((err as ProblemException).extra?.reason).toBe('idempotency_key_reused');
      expect((err as ProblemException).status).toBe(409);
    }
  });

  it('a key is 8 to 64 letters, digits, - or _', () => {
    expect(requireKey(' abcdefgh ')).toBe('abcdefgh');
    for (const bad of [undefined, null, '', 'short', 'has space in it', 'x'.repeat(65), 'sym$bols!']) {
      expect(() => requireKey(bad as string | null | undefined), String(bad)).toThrow(ProblemException);
    }
  });
});

const url = process.env.CHAT_TEST_DATABASE_URL;

describe.skipIf(!url)('claiming jobs on a real database', () => {
  let prisma: PrismaClient;
  const table = `jobs_probe_${Date.now().toString(36)}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$executeRawUnsafe(
      `CREATE TABLE chat.${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text NOT NULL, claimed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await prisma.$executeRawUnsafe(`INSERT INTO chat.${table} (status) SELECT 'DUE' FROM generate_series(1, 40)`);
  });
  afterAll(async () => {
    await prisma?.$executeRawUnsafe(`DROP TABLE IF EXISTS chat.${table}`);
    await prisma?.$disconnect();
  });

  const claim = (limit: number, staleSeconds = 60) =>
    claimBatch(prisma, { table, due: Prisma.sql`status = 'DUE'`, orderBy: 'created_at', limit, staleSeconds });

  it('parallel claimers never take the same row', async () => {
    const taken = await Promise.all(Array.from({ length: 8 }, () => claim(10)));
    const all = taken.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(40);
  });

  it('a claimed row is not taken again until its claim is stale', async () => {
    expect(await claim(10)).toEqual([]);
    await prisma.$executeRawUnsafe(`UPDATE chat.${table} SET claimed_at = now() - interval '2 minutes' WHERE id IN (SELECT id FROM chat.${table} LIMIT 3)`);
    expect(await claim(10, 60)).toHaveLength(3);
  });

  it('a released row can be claimed again at once', async () => {
    const [id] = await (async () => {
      await prisma.$executeRawUnsafe(`INSERT INTO chat.${table} (status) VALUES ('DUE')`);
      return claim(1);
    })();
    expect(id).toBeDefined();
    expect(await claim(1)).toEqual([]);
    await releaseClaim(prisma, table, id!);
    expect(await claim(1)).toEqual([id]);
  });

  it('only rows that are due are claimed', async () => {
    await prisma.$executeRawUnsafe(`UPDATE chat.${table} SET status = 'DONE', claimed_at = NULL`);
    expect(await claim(10)).toEqual([]);
  });

  it('refuses a table name that is not a plain identifier', async () => {
    await expect(
      claimBatch(prisma, { table: 'x; DROP TABLE y', due: Prisma.sql`true`, orderBy: 'id', limit: 1, staleSeconds: 1 }),
    ).rejects.toThrow(/not a table or column name/);
  });
});
