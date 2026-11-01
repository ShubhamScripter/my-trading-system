import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { SECURITY_COOLDOWN } from '../../../auth/auth.constants';
import { assertNoRecentEmailChangeLocked } from '../../../auth/persistence/security-cooldown.lock';
import { ERR } from '../../../src/contracts';
import { ProblemException } from '../../../src/http';

/**
 * The race-safe half of the cooldown: the row lock the protected mutations take.
 *
 * `RecentSecurityChangePolicy` runs early, where a refusal is cheapest, and that
 * placement is exactly what opens a window — between its read and the write it protects
 * there is an emailed code, an argon2 hash or a WebAuthn verification, and an email
 * change committing inside that window would leave a security setting changed moments
 * after the address moved, having passed a check that was true when it ran.
 *
 * So this is the last word, and these tests are about the two things that make it one:
 * the statement really locks, and a refusal really prevents the write.
 */

const USER_ID = '01940000-0000-7000-8000-000000000001';
const WINDOW_MS = SECURITY_COOLDOWN.AFTER_EMAIL_CHANGE_SECONDS * 1000;

let queryRaw: ReturnType<typeof vi.fn>;
let tx: Prisma.TransactionClient;

beforeEach(() => {
  queryRaw = vi.fn().mockResolvedValue([{ email_changed_at: null }]);
  tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
});

function sqlOf(): string {
  const [[statement]] = queryRaw.mock.calls as [[{ strings?: string[]; sql?: string }]];
  // `Prisma.sql` yields a template object; the text lives on `strings`/`sql` depending
  // on the driver version, so both are joined rather than reaching for one.
  return [...(statement.strings ?? []), statement.sql ?? ''].join(' ');
}

describe('the statement is what makes it race-safe', () => {
  it('locks the row rather than merely reading it', async () => {
    await assertNoRecentEmailChangeLocked(tx, USER_ID);

    // The whole mechanism. A plain `findFirst` inside a transaction blocks nothing, so
    // it would reproduce the very window this exists to close: `FOR UPDATE` is what
    // makes Postgres ORDER this transaction against the email change's `user.update`
    // instead of interleaving them.
    expect(sqlOf()).toMatch(/FOR UPDATE/);
  });

  it('reads the authoritative column on the account, and not a retained-email row', async () => {
    await assertNoRecentEmailChangeLocked(tx, USER_ID);

    const sql = sqlOf();
    expect(sql).toMatch(/"identity"\."users"/);
    expect(sql).toMatch(/email_changed_at/);
    // `retained_emails` is the reservation and the recovery ticket. Deriving the freeze
    // from it is wrong three separate ways — a `restore` deletes the row, a `replace`
    // renews `expires_at` while leaving `created_at`, and `changeEmail` deletes
    // reclaimed rows — and every one of them SHORTENS a freeze silently.
    expect(sql).not.toMatch(/retained_emails/);
  });

  it('binds the user id as a parameter rather than concatenating it', async () => {
    await assertNoRecentEmailChangeLocked(tx, USER_ID);

    // `Prisma.sql` builds a prepared statement, so the id travels in `values` and never
    // appears in the text. Asserted because this is the one place in the cooldown that
    // writes raw SQL at all.
    const [[statement]] = queryRaw.mock.calls as [[{ values: unknown[] }]];
    expect(statement.values).toContain(USER_ID);
    expect(sqlOf()).not.toContain(USER_ID);
  });

  it('excludes a soft-deleted account, so the lock and the ordinary lookups agree', async () => {
    await assertNoRecentEmailChangeLocked(tx, USER_ID);

    expect(sqlOf()).toMatch(/"deleted_at" IS NULL/);
  });
});

describe('the verdict', () => {
  it('permits an account whose address has never moved', async () => {
    await expect(assertNoRecentEmailChangeLocked(tx, USER_ID)).resolves.toBeUndefined();
  });

  it('permits an account whose window has closed', async () => {
    queryRaw.mockResolvedValue([{ email_changed_at: new Date(Date.now() - WINDOW_MS - 1000) }]);

    await expect(assertNoRecentEmailChangeLocked(tx, USER_ID)).resolves.toBeUndefined();
  });

  it('refuses inside the window, with the same slug the policy uses', async () => {
    queryRaw.mockResolvedValue([{ email_changed_at: new Date() }]);

    await expect(assertNoRecentEmailChangeLocked(tx, USER_ID)).rejects.toMatchObject({
      type: ERR.SECURITY_CHANGE_COOLDOWN,
    });
  });

  it('permits when no row came back, leaving that refusal to the caller', async () => {
    // A deleted account has no security settings for anyone to change, and the calling
    // service has already answered `unauthenticated` for it. One refusal, in one place.
    queryRaw.mockResolvedValue([]);

    await expect(assertNoRecentEmailChangeLocked(tx, USER_ID)).resolves.toBeUndefined();
  });

  it('throws rather than returning false, so the enclosing transaction rolls back', async () => {
    queryRaw.mockResolvedValue([{ email_changed_at: new Date() }]);

    // The distinction is the whole safety property. A boolean would leave it to ten
    // call sites to remember to check it; a throw unwinds `$transaction`, so a refusal
    // structurally cannot leave a partial write behind.
    const err = await assertNoRecentEmailChangeLocked(tx, USER_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemException);
  });
});
