import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { lockUsernameClaim } from '../../../auth/persistence/username-claim.lock';

/**
 * ═══ A SIGNATURE THE DATABASE HAS TO BE ABLE TO RESOLVE ════════════════════
 *
 * This file exists because of a defect that was total, trivial, and invisible to the
 * entire test suite: every account creation returned 500.
 *
 *     42883  function pg_advisory_xact_lock(bigint, integer) does not exist
 *
 * `pg_advisory_xact_lock` has exactly two overloads — `(bigint)` and `(int, int)` —
 * and Prisma binds a JavaScript number as `bigint`. The two-argument call therefore
 * arrived as `(bigint, integer)`, matching neither, and Postgres refused to resolve it.
 * There is no implicit narrowing from `bigint` to `int` in function resolution, so the
 * only fix is an explicit cast on the namespace.
 *
 * ─── Why the suite could not see it, and what this test can and cannot do ──
 *
 * Every dboperation spec doubles `$queryRaw`, so no test ever asked a real Postgres to
 * resolve this signature — the mock accepted any SQL at all and returned. That is the
 * gap, and it is not fully closable at this level: asserting the SQL TEXT is a proxy
 * for asserting that Postgres accepts it.
 *
 * So this pins the one token whose absence broke production, and says plainly that the
 * authoritative check is a live one. It would still pass if the cast were `::text` —
 * which is why `auth/persistence/username-claim.lock.ts` names the curl reproduction.
 */

function captureSql(): {
  tx: Prisma.TransactionClient;
  sql: () => { text: string; values: unknown[] };
  queryRaw: ReturnType<typeof vi.fn>;
} {
  // Both are doubled so the test can assert WHICH one was used. `$queryRaw` would
  // deserialise the result set, and this function's result is `void`.
  const executeRaw = vi.fn(async () => 0);
  const queryRaw = vi.fn(async () => []);
  return {
    tx: { $executeRaw: executeRaw, $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
    queryRaw,
    sql: () => {
      const arg = (executeRaw.mock.calls[0] as unknown[])[0] as Prisma.Sql;
      return { text: arg.sql, values: arg.values };
    },
  };
}

describe('lockUsernameClaim', () => {
  it('casts the namespace to int, so the (int, int) overload resolves', async () => {
    const { tx, sql } = captureSql();

    await lockUsernameClaim(tx, 'ada_lovelace');

    // THE assertion. Without the cast Prisma sends a bigint and Postgres answers
    // 42883 — see the header. `hashtext` already returns `integer`.
    // `Prisma.Sql.sql` renders placeholders as `?`; the driver numbers them.
    expect(sql().text).toMatch(/pg_advisory_xact_lock\(\s*\?::int\s*,\s*hashtext\(\s*\?\s*\)\s*\)/);
  });

  it('uses $executeRaw, because the function returns void', async () => {
    const { tx, sql, queryRaw } = captureSql();

    await lockUsernameClaim(tx, 'ada_lovelace');

    // `$queryRaw` deserialises the result set and cannot handle `void`:
    //   Failed to deserialize column of type 'void'
    // There is nothing to read here — the lock is held by the transaction, not
    // returned — so discarding the result is the honest shape.
    expect(sql().text).toContain('pg_advisory_xact_lock');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('takes the transaction-scoped lock, not the session-scoped one', async () => {
    const { tx, sql } = captureSql();

    await lockUsernameClaim(tx, 'ada_lovelace');

    // `_xact_` is released by the transaction ending either way. The session-scoped
    // variant would need an unlock on every path out, and a missed one leaks a lock
    // for the life of a pooled connection — a username nobody can ever claim.
    expect(sql().text).toContain('pg_advisory_xact_lock');
    expect(sql().text).not.toContain('pg_advisory_lock(');
  });

  it('binds the username rather than interpolating it', async () => {
    const { tx, sql } = captureSql();

    await lockUsernameClaim(tx, "robert'); DROP TABLE users;--");

    // A username never reaches the database as SQL text.
    expect(sql().text).not.toContain('DROP TABLE');
    expect(sql().values).toContain("robert'); DROP TABLE users;--");
  });

  it('namespaces the lock, and the namespace fits in int4', async () => {
    const { tx, sql } = captureSql();

    await lockUsernameClaim(tx, 'ada_lovelace');

    const [namespace] = sql().values as [number, string];
    // The first key is a namespace so another feature adopting advisory locks cannot
    // alias these by coincidence — the same argument redis/keys.ts makes about
    // prefixes. It has to fit in int4 or the cast above would overflow rather than
    // narrow.
    expect(namespace).toBe(0x5553_4552);
    expect(namespace).toBeLessThanOrEqual(2_147_483_647);
  });
});
