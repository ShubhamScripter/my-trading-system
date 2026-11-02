import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { UserDbOperation } from '../../../auth/persistence/user.dboperation';
import { AccountPurgeSweeper } from '../../../src/settings/delete-account/delete-account.sweeper';
import { uuidv7 } from '../../../src/utils/public.utils';

/**
 * ═══ THE WHOLE LIFECYCLE, AGAINST A REAL POSTGRES ═══════════════════════════
 *
 * The rest of the suite is pure unit tests and dials nothing — see `tests/setup.ts`.
 * This file is the deliberate exception, following the precedent
 * `tests/redis/quota.integration.spec.ts` sets, and it earns it for the same reason
 * that one does: the properties that make this feature correct are properties of the
 * DATABASE, and a doubled Prisma proving things about a fake row proves nothing.
 *
 * None of these can be asserted without a real server:
 *
 *   - `DELETE FROM users` actually cascading to all twelve child tables;
 *   - the partial unique indexes RESERVING the email while the account is locked and
 *     RELEASING it once the row is gone — the single fact the recovery window rests on;
 *   - `registrations` surviving the delete via ON DELETE SET NULL, which is the one
 *     record a cascade cannot reach;
 *   - the claim and the delete committing together.
 *
 * ─── Running it ─────────────────────────────────────────────────────────────
 *
 *   TEST_DATABASE_URL=postgresql://... npx vitest run tests/settings/delete-account/
 *
 * The database must already be migrated (`npm run db:migrate`). When nothing answers,
 * every test SKIPS rather than fails — a developer without a database must not see a
 * red suite for an environment problem — but the skip is loud in the reporter, so it
 * cannot quietly become "these tests never run".
 *
 * Every row it creates is namespaced by a per-run id and removed in `afterAll`, so it
 * is safe against a database with real data in it and safe to run twice.
 */

const URL = process.env['TEST_DATABASE_URL'] ?? '';

let prisma: PrismaClient | null = null;
let users: UserDbOperation;
let sweeper: AccountPurgeSweeper;

/** Distinct per run, so an interrupted run cannot collide with the next one. */
const RUN = Date.now().toString(36);
const EMAIL = 'purge-' + RUN + '@example.invalid';
const USERNAME = 'purge_' + RUN;
const CODE = ('OREBiT' + RUN.toUpperCase()).slice(0, 14);
const REFERRAL = ('R' + RUN.toUpperCase()).slice(0, 12);

beforeAll(async () => {
  if (URL === '') return;
  const client = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    await client.$queryRaw`SELECT 1`;
    prisma = client;
    users = new UserDbOperation(client as never);
    sweeper = new AccountPurgeSweeper(users);
  } catch {
    await client.$disconnect().catch(() => undefined);
  }
});

afterAll(async () => {
  if (prisma === null) return;
  await prisma.$executeRaw`DELETE FROM chat.room_messages WHERE content = ${`purge-history ${RUN}`}`.catch(() => undefined);
  // Best effort: the happy path already deletes the user and the cascade takes the
  // children with it. This covers a run that failed partway.
  await prisma.user.deleteMany({ where: { emailLower: { contains: RUN } } }).catch(() => undefined);
  await prisma.registration
    .deleteMany({ where: { emailLower: { contains: RUN } } })
    .catch(() => undefined);
  await prisma.mailDelivery
    .deleteMany({ where: { recipient: { contains: RUN } } })
    .catch(() => undefined);
  await prisma.loginAttempt
    .deleteMany({ where: { identifierLower: { contains: RUN } } })
    .catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
});

function db(): PrismaClient {
  if (prisma === null) throw new Error('unreachable — guarded by the skip');
  return prisma;
}

/**
 * Skip this test when nothing answered.
 *
 * `ctx.skip()` per test rather than `describe.skipIf`, because the probe runs in
 * `beforeAll` and `skipIf` is evaluated at COLLECTION time, before any hook has run —
 * so it cannot see the answer. `tests/redis/quota.integration.spec.ts` documents the
 * same trap and reaches the same place this way.
 */
function skipUnlessLive(ctx: TestContext): void {
  if (prisma === null) ctx.skip();
}

/** One account with a row in every table the purge has to reach. */
async function seedAccount(suffix: string): Promise<string> {
  const p = db();
  const userId = uuidv7();
  const email = suffix + EMAIL;

  await p.user.create({
    data: {
      id: userId,
      email,
      emailLower: email,
      username: suffix + USERNAME,
      usernameLower: suffix + USERNAME,
      publicCode: (suffix + CODE).slice(0, 14),
      publicCodeKey: (suffix + CODE).slice(0, 14).toUpperCase(),
      referralCode: (suffix + REFERRAL).slice(0, 12),
      status: 'ACTIVE',
    },
  });

  await p.credential.create({
    data: { id: uuidv7(), userId, kind: 'PASSWORD', passwordHash: 'argon2id$fake' },
  });
  await p.session.create({
    data: {
      id: uuidv7(),
      userId,
      familyId: uuidv7(),
      deviceFingerprint: 'f'.repeat(64),
      ipClass: '203.0.113.0/24',
      userAgent: 'integration-spec',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await p.trustedDevice.create({
    data: {
      id: uuidv7(),
      userId,
      tokenHash: 't' + suffix + RUN,
      ipClassAtTrust: '203.0.113.0/24',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await p.oauthLink.create({
    data: { id: uuidv7(), userId, provider: 'GOOGLE', subject: 'sub-' + suffix + RUN },
  });
  await p.verificationChallenge.create({
    data: {
      id: uuidv7(),
      userId,
      purpose: 'ACCOUNT_REACTIVATION',
      codeHash: 'hash',
      expiresAt: new Date(Date.now() + 600_000),
      ipAddress: '203.0.113.7',
    },
  });
  await p.retainedEmail.create({
    data: {
      id: uuidv7(),
      userId,
      email: 'old-' + email,
      emailLower: 'old-' + email,
      recoveryTokenHash: 'recovery-' + suffix + RUN,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await p.usernameReservation.create({
    data: {
      id: uuidv7(),
      userId,
      username: 'old_' + suffix + USERNAME,
      usernameLower: 'old_' + suffix + USERNAME,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  // The completed signup, and an ABANDONED one that never got a userId — the row a
  // cascade can never reach and `where: { userId }` alone would miss.
  await p.registration.create({
    data: {
      id: uuidv7(),
      userId,
      email,
      emailLower: email,
      ipAddress: '203.0.113.7',
      oauthAvatarUrl: 'https://lh3.googleusercontent.com/a/secret',
      oauthProvider: 'GOOGLE',
      state: 'COMPLETED',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await p.registration.create({
    data: {
      id: uuidv7(),
      email,
      emailLower: email,
      ipAddress: '203.0.113.8',
      oauthAvatarUrl: 'https://lh3.googleusercontent.com/a/abandoned',
      state: 'OTP_SENT',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  // A failed sign-in: userId NULL, identifier present. The FK does not see it.
  await p.loginAttempt.create({
    data: {
      id: uuidv7(),
      identifierLower: email,
      ipClass: '203.0.113.0/24',
      deviceFingerprint: 'f'.repeat(64),
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
  await p.mailDelivery.create({
    data: {
      id: uuidv7(),
      jobId: uuidv7(),
      kind: 'otp',
      recipient: email,
      status: 'SENT',
      subject: 'code',
    },
  });

  return userId;
}

describe('the account lifecycle, end to end', () => {
  it('ACTIVE -> DELETED -> ACTIVE -> DELETED -> hard deleted', async (ctx) => {
    skipUnlessLive(ctx);
    const p = db();
    const userId = await seedAccount('a');
    const email = 'a' + EMAIL;

    // ── ACTIVE ──────────────────────────────────────────────────────────────
    expect(await users.findByEmail(email)).not.toBeNull();

    // ── request deletion ────────────────────────────────────────────────────
    const purgeAt = new Date(Date.now() + 30 * 24 * 3_600_000);
    expect(await users.requestAccountDeletion(userId, new Date(), purgeAt)).toBe(true);

    const locked = await p.user.findUniqueOrThrow({ where: { id: userId } });
    expect(locked.status).toBe('DELETED');
    // LOCKED, not gone. `deletedAt` stays null for the whole window.
    expect(locked.deletedAt).toBeNull();
    expect(locked.purgeAt).not.toBeNull();

    // ── the identifiers are still RESERVED while locked ─────────────────────
    // The fact the recovery window rests on: `deletedAt` is null, so the partial unique
    // index still holds the address and nobody can take it out from under the owner.
    await expect(
      p.user.create({
        data: {
          id: uuidv7(),
          email,
          emailLower: email,
          username: 'other_' + RUN,
          usernameLower: 'other_' + RUN,
          publicCode: ('Z' + CODE).slice(0, 14),
          publicCodeKey: ('Z' + CODE).slice(0, 14).toUpperCase(),
          referralCode: ('Z' + REFERRAL).slice(0, 12),
        },
      }),
    ).rejects.toThrow();

    // ── reactivate inside the window ────────────────────────────────────────
    expect(await users.reactivateAccount(userId, new Date())).toBe(true);
    const restored = await p.user.findUniqueOrThrow({ where: { id: userId } });
    expect(restored.status).toBe('ACTIVE');
    expect(restored.purgeAt).toBeNull();
    expect(restored.deletionRequestedAt).toBeNull();

    // ── delete again, and make it due ───────────────────────────────────────
    expect(
      await users.requestAccountDeletion(userId, new Date(), new Date(Date.now() - 1000)),
    ).toBe(true);

    // Chat history is retained after the identity row is erased. This used to be
    // blocked by RESTRICT constraints in chat tables (and CASCADE would erase records).
    await p.$executeRaw`
      INSERT INTO chat.room_messages (id, room_id, user_id, content)
      VALUES (${uuidv7()}::uuid, '00000000-0000-0000-0000-000000000000'::uuid, ${userId}::uuid, ${`purge-history ${RUN}`})
    `;

    // Captured before the sweep so the assertions below can prove these rows were
    // SCRUBBED rather than deleted — a count of zero on the old address would be
    // satisfied by either.
    const registrationIds = (
      await p.registration.findMany({ where: { emailLower: email }, select: { id: true } })
    ).map((row) => row.id);
    const deliveryIds = (
      await p.mailDelivery.findMany({ where: { recipient: email }, select: { id: true } })
    ).map((row) => row.id);
    expect(registrationIds).toHaveLength(2);
    expect(deliveryIds).toHaveLength(1);

    // ── the sweeper runs ────────────────────────────────────────────────────
    await sweeper.sweep();

    // ── THE USER ROW IS GONE ────────────────────────────────────────────────
    expect(await p.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await users.findByEmail(email)).toBeNull();
    expect(await p.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM chat.room_messages WHERE content = ${`purge-history ${RUN}`}
    `).toEqual([{ count: 1n }]);

    // ── every cascading child went with it ──────────────────────────────────
    expect(await p.credential.count({ where: { userId } })).toBe(0);
    expect(await p.session.count({ where: { userId } })).toBe(0);
    expect(await p.trustedDevice.count({ where: { userId } })).toBe(0);
    expect(await p.oauthLink.count({ where: { userId } })).toBe(0);
    expect(await p.verificationChallenge.count({ where: { userId } })).toBe(0);
    expect(await p.retainedEmail.count({ where: { userId } })).toBe(0);
    expect(await p.usernameReservation.count({ where: { userId } })).toBe(0);
    expect(await p.loginAttempt.count({ where: { userId } })).toBe(0);

    // ── and so did the row a cascade cannot see ─────────────────────────────
    // The anonymous failed sign-in: userId NULL, so the FK never touched it.
    expect(await p.loginAttempt.count({ where: { identifierLower: email } })).toBe(0);

    // ── the SET NULL survivors are scrubbed ─────────────────────────────────
    // Both of them: the completed signup AND the abandoned attempt that never carried a
    // userId. No address, no IP, no provider photo.
    expect(await p.registration.count({ where: { emailLower: email } })).toBe(0);
    expect(
      await p.registration.count({ where: { oauthAvatarUrl: { contains: 'googleusercontent' } } }),
    ).toBe(0);

    // Still THERE, though — a registration is history and history is kept. Both rows
    // survive with their identifying columns replaced.
    const kept = await p.registration.findMany({ where: { id: { in: registrationIds } } });
    expect(kept).toHaveLength(2);
    for (const row of kept) {
      expect(row.emailLower).toBe('purged@account.invalid');
      expect(row.oauthAvatarUrl).toBeNull();
      expect(row.oauthProvider).toBeNull();
      expect(row.ipAddress).toBe('0.0.0.0');
      expect(row.pendingPasswordHash).toBeNull();
    }

    // ── the delivery log keeps the row and loses the address ────────────────
    expect(await p.mailDelivery.count({ where: { recipient: email } })).toBe(0);
    const delivery = await p.mailDelivery.findMany({ where: { id: { in: deliveryIds } } });
    expect(delivery).toHaveLength(1);
    expect(delivery[0]?.recipient).toBe('purged@account.invalid');

    // ── reactivation is now IMPOSSIBLE, not merely refused ──────────────────
    expect(await users.reactivateAccount(userId, new Date())).toBe(false);

    // ── the identifiers are free again ──────────────────────────────────────
    const reused = await p.user.create({
      data: {
        id: uuidv7(),
        email,
        emailLower: email,
        username: 'a' + USERNAME,
        usernameLower: 'a' + USERNAME,
        publicCode: ('a' + CODE).slice(0, 14),
        publicCodeKey: ('a' + CODE).slice(0, 14).toUpperCase(),
        referralCode: ('a' + REFERRAL).slice(0, 12),
      },
    });
    expect(reused.id).not.toBe(userId);
    await p.user.delete({ where: { id: reused.id } });
  });

  it('a purge and a reactivation cannot both apply at the boundary', async (ctx) => {
    skipUnlessLive(ctx);
    const p = db();
    const userId = await seedAccount('b');

    // Exactly at the deadline. `reactivate` needs `purgeAt > now`; `purge` needs
    // `purgeAt <= now`. The two are complements, so exactly one can ever match.
    const deadline = new Date();
    await users.requestAccountDeletion(userId, new Date(), deadline);

    expect(await users.reactivateAccount(userId, deadline)).toBe(false);
    expect(await users.purgeAccount(userId, deadline)).not.toBeNull();
    expect(await p.user.findUnique({ where: { id: userId } })).toBeNull();
  });

  it('a second purge of the same account is a no-op', async (ctx) => {
    skipUnlessLive(ctx);
    const userId = await seedAccount('c');
    await users.requestAccountDeletion(userId, new Date(), new Date(Date.now() - 1000));

    expect(await users.purgeAccount(userId, new Date())).not.toBeNull();
    // The row is gone, so the claim matches nothing. Safe to run on every instance.
    expect(await users.purgeAccount(userId, new Date())).toBeNull();
  });
});
