import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/utils/public.utils';

/**
 * Fixtures and a lock barrier for the specs that need a real PostgreSQL.
 *
 * ═══ THE BARRIER IS THE INTERESTING PART ═════════════════════════════════════
 *
 * To reproduce a race deterministically, one transaction has to be held open while
 * the other is *proven* to be waiting on it. A `sleep` cannot prove that — it only
 * makes the failure less likely to be noticed, which is how a concurrency test ends
 * up green and worthless.
 *
 * `waitUntilBlocked` asks PostgreSQL instead. `pg_blocking_pids` returns the
 * backends a given backend is waiting on, so a non-empty answer IS the proof, and
 * the adversary is only released once it arrives. If it never arrives the helper
 * fails the test rather than hanging the suite.
 *
 * Two details make it work here:
 *
 *   same role       `pg_stat_activity` shows other sessions' details only to a
 *                   superuser or a member of `pg_read_all_stats` — everyone else
 *                   sees NULLs. Every connection in these tests is the same
 *                   `orebit` role, which is what keeps the view populated.
 *   application     vitest runs spec FILES in parallel, so the poll has to be
 *   _name           scoped or two files would see each other's locks. Each
 *                   connection carries its own name and the poll filters on it.
 */

const POLL_MS = 10;
const TIMEOUT_MS = 5_000;

/** The database name, parsed from the URL so it cannot drift from global setup. */
export function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

/** The same URL, tagged so `pg_stat_activity` can tell this connection from any
 *  other spec file's. `application_name` is a libpq parameter, which both `pg` and
 *  Prisma pass straight through. */
export function tagged(url: string, applicationName: string): string {
  const u = new URL(url);
  u.searchParams.set('application_name', applicationName);
  return u.toString();
}

export function prismaFor(url: string, applicationName: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: tagged(url, applicationName) } } });
}

/**
 * Block until `applicationName` has at least one backend waiting on a lock.
 *
 * Throws on timeout. A test that reaches that has NOT proven what it set out to —
 * far better to fail loudly than to release the adversary anyway and assert against
 * an interleaving that never happened.
 */
export async function waitUntilBlocked(
  monitor: Client,
  database: string,
  applicationName: string,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const { rows } = await monitor.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM pg_stat_activity
        WHERE datname = $1
          AND application_name = $2
          AND cardinality(pg_blocking_pids(pid)) > 0`,
      [database, applicationName],
    );
    if (Number(rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for "${applicationName}" to block on a lock. ` +
          `The statement under test did not contend for the row it was supposed to.`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Wait for a connection to be sitting in an open transaction — how a test knows the
 *  adversary has finished its statements and is now merely holding its locks. */
export async function waitUntilIdleInTransaction(
  monitor: Client,
  applicationName: string,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const { rows } = await monitor.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE application_name = $1 AND state = 'idle in transaction'`,
      [applicationName],
    );
    if (Number(rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for "${applicationName}" to hold a transaction open`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * A raw connection that can hold a transaction open across `await` points.
 *
 * Prisma's interactive transactions cannot do this: the callback owns the whole
 * transaction, so there is no way to pause inside one from the test. The adversary
 * therefore issues plain SQL, and the code under test remains the real
 * `SessionDbOperation` over a real `PrismaClient`.
 */
export class Adversary {
  private constructor(
    readonly client: Client,
    readonly applicationName: string,
  ) {}

  static async connect(url: string, applicationName: string): Promise<Adversary> {
    const client = new Client({ connectionString: tagged(url, applicationName) });
    await client.connect();
    return new Adversary(client, applicationName);
  }

  async begin(): Promise<void> {
    await this.client.query('BEGIN');
    // Bounded so a mistake in a test cannot wedge a backend for the whole run.
    await this.client.query("SET LOCAL lock_timeout = '5s'");
  }

  async sql(text: string, values: unknown[] = []): Promise<void> {
    await this.client.query(text, values);
  }

  async commit(): Promise<void> {
    await this.client.query('COMMIT');
  }

  async end(): Promise<void> {
    try {
      await this.client.query('ROLLBACK');
    } catch {
      // Already committed, or the connection is gone. Either way there is nothing
      // to undo and nothing a test could do about it.
    }
    await this.client.end();
  }
}

// ─── fixtures ────────────────────────────────────────────────────────────────

export interface Login {
  readonly adminId: string;
  readonly familyId: string;
  /** The first generation. */
  readonly sessionId: string;
}

/**
 * A fresh admin with one live login.
 *
 * A NEW admin per test rather than a truncate between tests: spec files run in
 * parallel, so a truncate in one would delete another's fixtures mid-assertion.
 * `admin_sessions.admin_id` and `admin_session_families.admin_id` both cascade, so
 * deleting the admin is enough to clean up.
 */
export async function seedLogin(prisma: PrismaClient): Promise<Login> {
  const adminId = uuidv7();
  const familyId = uuidv7();
  const sessionId = uuidv7();
  const email = `pg-${randomUUID()}@orebit.test`;

  await prisma.admin.create({
    data: { id: adminId, email, emailLower: email, name: 'PG Test', role: 'ADMIN' },
  });
  await prisma.adminSessionFamily.create({ data: { id: familyId, adminId } });
  await prisma.adminSession.create({ data: generation(sessionId, adminId, familyId, null) });

  return { adminId, familyId, sessionId };
}

/** A second, independent login for the same admin — for the logout-all cases. */
export async function seedExtraFamily(
  prisma: PrismaClient,
  adminId: string,
): Promise<{ familyId: string; sessionId: string }> {
  const familyId = uuidv7();
  const sessionId = uuidv7();
  await prisma.adminSessionFamily.create({ data: { id: familyId, adminId } });
  await prisma.adminSession.create({ data: generation(sessionId, adminId, familyId, null) });
  return { familyId, sessionId };
}

export function generation(
  id: string,
  adminId: string,
  familyId: string,
  parentId: string | null,
) {
  const now = new Date();
  return {
    id,
    adminId,
    familyId,
    parentId,
    mfaMethod: 'TOTP' as const,
    deviceFingerprint: 'f'.repeat(64),
    ipClass: '203.0.113.0/24',
    userAgent: 'vitest-pg',
    lastActiveAt: now,
    expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
    reauthenticateAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
  };
}

export async function dropAdmin(prisma: PrismaClient, adminId: string): Promise<void> {
  await prisma.admin.deleteMany({ where: { id: adminId } });
}

// ─── assertions ──────────────────────────────────────────────────────────────

/** Generations in a family that are still usable. The number this whole phase
 *  exists to keep at zero once a revocation has committed. */
export async function liveGenerations(
  prisma: PrismaClient,
  familyId: string,
): Promise<string[]> {
  const rows = await prisma.adminSession.findMany({
    where: { familyId, revokedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => r.id);
}

/**
 * THE invariant, asked of the database directly:
 *
 *   a revoked family must have no live generation
 *
 * Returns the offending rows, so a failure names them instead of just counting.
 */
export async function invariantViolations(
  prisma: PrismaClient,
  adminId: string,
): Promise<{ id: string }[]> {
  return prisma.$queryRaw<{ id: string }[]>`
    SELECT s.id
      FROM admin.admin_sessions s
      JOIN admin.admin_session_families f ON f.id = s.family_id
     WHERE s.admin_id = ${adminId}::uuid
       AND f.revoked_at IS NOT NULL
       AND s.revoked_at IS NULL
  `;
}
