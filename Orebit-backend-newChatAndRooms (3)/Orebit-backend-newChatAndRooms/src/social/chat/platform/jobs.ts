// Claiming work so two workers (or two ticks) never take the same row (rulebook C.3; , ).
// A job table has a `claimed_at` column. A claim sets it to the database time in one statement that locks the rows
// with `FOR UPDATE SKIP LOCKED`, so a second claimer skips the rows the first has and never waits or doubles up. A row
// whose claim is older than `staleSeconds` belongs to a worker that died and is claimed again. When the work is done
// (or fails and may be tried again) the owner of the table changes the row's status and clears the claim.
// The time is `now()` of the database (B-4). The table name comes from this code, never from a request; it is checked
// anyway.
import { Prisma } from '@prisma/client';
import type { Db } from '../persistence/chat.sql';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface ClaimSpec {
  // A table in the chat schema that has `claimed_at` (a constant of the caller).
  readonly table: string;
  // The key column; `id` unless stated.
  readonly idColumn?: string;
  // The rows that are ready, as a SQL condition written by the caller (no user input).
  readonly due: Prisma.Sql;
  // An ORDER BY expression written by the caller, e.g. `created_at`.
  readonly orderBy: string;
  readonly limit: number;
  // A claim older than this is taken over (the worker that held it is gone).
  readonly staleSeconds: number;
}

function checked(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`not a table or column name: ${name}`);
  return name;
}

// Claims up to `limit` ready rows and returns their ids. Rows another worker has locked are skipped.
export async function claimBatch(db: Db, spec: ClaimSpec): Promise<string[]> {
  const table = Prisma.raw(`chat.${checked(spec.table)}`);
  const id = Prisma.raw(checked(spec.idColumn ?? 'id'));
  const order = Prisma.raw(spec.orderBy.replace(/[^a-z0-9_ ,]/gi, ''));
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE ${table} SET claimed_at = now()
    WHERE ${id} IN (
      SELECT ${id} FROM ${table}
      WHERE (${spec.due})
        AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => ${spec.staleSeconds}::int))
      ORDER BY ${order}
      FOR UPDATE SKIP LOCKED
      LIMIT ${spec.limit}
    )
    RETURNING ${id}::text AS id
  `;
  return rows.map((row) => row.id);
}

// Gives a claimed row back (a failed attempt that will be retried by the next tick).
export async function releaseClaim(db: Db, table: string, id: string, idColumn = 'id'): Promise<void> {
  await db.$executeRaw`
    UPDATE ${Prisma.raw(`chat.${checked(table)}`)} SET claimed_at = NULL
    WHERE ${Prisma.raw(checked(idColumn))}::text = ${id}
  `;
}
