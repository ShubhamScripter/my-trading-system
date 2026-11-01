import { Prisma } from '@prisma/client';

/**
 * The lock every path that claims a username takes, before it does anything else.
 *
 * ─── Why the unique index is not enough ─────────────────────────────────────
 *
 * `ix_users_username_active` decides who owns a username right now, and it decides it
 * perfectly: two accounts claiming one name concurrently produce one winner and one
 * `23505`, with no lock and no cooperation. If that were the only race, this file would
 * not exist.
 *
 * The race it cannot decide spans two tables. A username is unavailable if a live
 * account holds it OR a live row in `username_reservations` reserves it, and no single
 * index can constrain a predicate over both. So a claim that reads the reservation
 * table and then inserts into `users` has a window: a reservation committing inside it
 * leaves the claim already past the only check that would have caught it, and the
 * unique index — which knows nothing about reservations — lets the insert through. The
 * released username of somebody mid-change gets handed to a stranger.
 *
 * A row lock cannot close it either, because there is no row to lock: the whole point
 * is that nobody owns the name yet. An advisory lock is the one Postgres primitive that
 * locks a VALUE rather than a tuple, which is exactly the shape of this problem.
 *
 * ─── THREE callers, ONE order ───────────────────────────────────────────────
 *
 * Signup allocation (`UserDbOperation.createAccount`), the change endpoint
 * (`UsernameReservationDbOperation.changeUsername`) and the Premium-expiry reconciler
 * (`renameForCompliance`) all claim usernames, and all three take their locks in this
 * order and no other:
 *
 *     1. lockUsernameClaim(tx, <the name being claimed>)
 *     2. SELECT ... FROM users WHERE id = ? FOR UPDATE
 *     3. reads of username_reservations
 *     4. INSERT username_reservations / UPDATE users
 *
 * The order is the entire deadlock argument. Two transactions that take the same two
 * locks in opposite orders will eventually wait on each other forever; the reconciler
 * is the one that had to be bent to fit — it computes its candidate name from an
 * UNLOCKED read precisely so it can lock the name before the row, and then re-verifies
 * everything under the row lock. See `renameForCompliance`.
 *
 * ─── Why `_xact_` ──────────────────────────────────────────────────────────
 *
 * `pg_advisory_xact_lock` is released by the transaction ending, either way. The
 * session-scoped variant would need an unlock call on every path out of the function
 * including the throwing ones, and a missed one leaks a lock for the lifetime of a
 * pooled connection — which is to say, until someone restarts the service to fix a
 * username nobody can claim.
 *
 * ─── Why two arguments ─────────────────────────────────────────────────────
 *
 * The single-argument form takes one `bigint` drawn from a space the whole database
 * shares, so any other feature that starts using advisory locks could alias these by
 * coincidence. The two-argument form makes the first key a namespace. `redis/keys.ts`
 * makes the same argument about key prefixes, for the same reason.
 *
 * `hashtext` collisions — two different usernames mapping to one `int4` — cost an
 * occasional needless serialisation between two unrelated claims. They cannot cause a
 * wrong answer, because the lock is a serialisation device and every check it protects
 * is performed again inside it.
 *
 * The parameters are bound rather than interpolated: `Prisma.sql` builds a prepared
 * statement, so a username never reaches the database as SQL text.
 *
 * ─── Why the namespace carries an explicit `::int` ─────────────────────────
 *
 * Because without it this statement does not run at all. `pg_advisory_xact_lock` has
 * exactly two overloads — `(bigint)` and `(int, int)` — and Prisma binds a JavaScript
 * number as `bigint`. So the call arrived as `(bigint, integer)`, which matches
 * NEITHER, and Postgres refused it outright:
 *
 *     42883  function pg_advisory_xact_lock(bigint, integer) does not exist
 *
 * There is no implicit narrowing from `bigint` to `int` during function resolution, so
 * the cast is the fix rather than a tidy-up. `hashtext` already returns `integer`, and
 * the namespace is `0x55534552` = 1431520594, comfortably inside `int4`.
 *
 * ─── Why `$executeRaw` and not `$queryRaw` ────────────────────────────────
 *
 * Because `pg_advisory_xact_lock` returns `void`, and `$queryRaw` deserialises the
 * result set. With the cast in place the statement resolved and then failed one step
 * later:
 *
 *     Failed to deserialize column of type 'void'
 *
 * `$executeRaw` discards the result and reports a row count, which is the honest shape
 * for a statement taken for its side effect. There was nothing to read here in the
 * first place — the lock is held by the transaction, not returned to the caller.
 *
 * ═══ THE PART WORTH REMEMBERING ════════════════════════════════════════════
 *
 * Both halves of this were total, and the whole suite was green through both: every
 * account creation returned 500 at `POST /auth/register {step:'country'}`. Nothing
 * caught it because every dboperation spec doubles the raw-query methods, so no test
 * ever asked a real Postgres to resolve the signature or hand back the result.
 *
 * tests/auth/persistence/username-claim.lock.spec.ts now pins the SQL text and the
 * method, which is a proxy rather than a proof — a statement Postgres rejects is
 * indistinguishable at that level from one it accepts. The authoritative check is
 * completing a registration against a live database.
 */

/**
 * Namespace for every username-claim advisory lock. `USER` as ASCII, chosen once and
 * never derived, so it is greppable and cannot drift.
 */
const USERNAME_LOCK_NAMESPACE = 0x5553_4552;

/**
 * Serialise every claim of `usernameLower` until this transaction ends.
 *
 * Must be the FIRST statement in the transaction — before the reservation check, not
 * merely before the write. A lock taken after the check protects the insert and leaves
 * the window the check opened.
 *
 * `usernameLower` must be normalised by `normaliseUsername`. Two callers that disagree
 * about casing would take two different locks for one name and serialise nothing.
 */
export async function lockUsernameClaim(
  tx: Prisma.TransactionClient,
  usernameLower: string,
): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(${USERNAME_LOCK_NAMESPACE}::int, hashtext(${usernameLower}))`,
  );
}
