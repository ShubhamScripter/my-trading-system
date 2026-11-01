import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../../db/client';
import {
  SessionDbOperation,
  SessionRotationConflict,
} from '../../../auth/persistence/session.dboperation';
import { SESSION } from '../../../auth/auth.constants';
import type { ClientContext } from '../../../auth/auth.types';

/**
 * The persistence layer for rotation, tested against the row it actually writes.
 *
 * ─── Why this file exists at all ───────────────────────────────────────────
 *
 * session.service.spec.ts mocks `SessionDbOperation.rotate`, and its mock
 * fabricates the child as `{ ...parent, id, expiresAt }`. Every column the real
 * `create` forgets is spread in by that mock for free — which is how a child row
 * that carried neither `rememberUntil` nor `lastUsedAt` sat under a green test
 * named "carries rememberUntil into the child UNCHANGED" for as long as it did.
 *
 * So the assertions here are on the `data` object handed to `session.create`.
 * That is the boundary the service cannot reach and the mock cannot fake.
 */

const client: ClientContext = {
  ip: '203.0.113.7',
  ipClass: '203.0.113.0/24',
  deviceId: 'device-test',
  deviceKey: 'a'.repeat(64),
  userAgent: 'vitest', country: null,
};

function parentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-parent',
    familyId: 'family-1',
    parentId: null,
    userId: 'user-1',
    deviceFingerprint: client.deviceKey,
    ipClass: client.ipClass,
    userAgent: client.userAgent,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    lastUsedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    rememberUntil: null,
    trustedDeviceId: null,
    rotatedAt: null,
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

let create: ReturnType<typeof vi.fn>;
let updateMany: ReturnType<typeof vi.fn>;
let findUnique: ReturnType<typeof vi.fn>;
let executeRaw: ReturnType<typeof vi.fn>;
let ops: SessionDbOperation;

beforeEach(() => {
  create = vi.fn().mockImplementation(async ({ data }: { data: unknown }) => data);
  updateMany = vi.fn().mockResolvedValue({ count: 1 });
  findUnique = vi.fn();
  executeRaw = vi.fn().mockResolvedValue(1);

  const tx = { session: { create, updateMany } };
  const prisma = {
    session: { create, updateMany, findUnique },
    $executeRaw: executeRaw,
    // The real transaction runs the callback against a tx client; the fake hands
    // it the same object, which is enough to observe both statements.
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };

  ops = new SessionDbOperation(prisma as unknown as PrismaService);
});

describe('SessionDbOperation.rotate — what the child row inherits', () => {
  /** The `data` object handed to `session.create`. */
  function childData(): Record<string, unknown> {
    return create.mock.calls[0]![0].data as Record<string, unknown>;
  }

  it('copies lastUsedAt from the parent instead of restarting the idle clock', async () => {
    // The column defaults to now(). Left to that default, every rotation handed the
    // child a fresh activity timestamp, so a session refreshed in the background
    // was permanently "just used" no matter how long ago a person touched it — and
    // the idle timeout could never fire. This assertion is the whole mechanism.
    const parent = parentRow();
    await ops.rotate(parent as never, client, new Date(Date.now() + 60_000));

    expect(childData().lastUsedAt).toEqual(parent.lastUsedAt);
  });

  it('writes rememberUntil and trustedDeviceId when the trust was honoured', async () => {
    const rememberUntil = new Date(Date.now() + SESSION.REMEMBER_ME_SECONDS * 1000);
    await ops.rotate(parentRow() as never, client, rememberUntil, {
      rememberUntil,
      trustedDeviceId: 'device-1',
    });

    expect(childData()).toMatchObject({ rememberUntil, trustedDeviceId: 'device-1' });
  });

  it('leaves both null when no trust was passed, even if the parent had one', async () => {
    // The downgrade path: a refresh arriving without that browser's device cookie.
    // The parent's columns must NOT be copied blindly, or a stolen refresh token
    // would inherit a week-long window it was never granted.
    const parent = parentRow({
      rememberUntil: new Date(Date.now() + SESSION.REMEMBER_ME_SECONDS * 1000),
      trustedDeviceId: 'device-1',
    });

    await ops.rotate(parent as never, client, new Date(Date.now() + 60_000), null);

    const child = childData();
    expect(child.rememberUntil).toBeUndefined();
    expect(child.trustedDeviceId).toBeUndefined();
  });

  it('refuses to create a child when the parent could not be claimed', async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(
      ops.rotate(parentRow() as never, client, new Date(Date.now() + 60_000)),
    ).rejects.toBeInstanceOf(SessionRotationConflict);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('SessionDbOperation.touch — activity moves the expiry, and only forward', () => {
  /** The SQL text of the single statement `touch` issues, whitespace-collapsed. */
  function sql(): string {
    const [strings] = executeRaw.mock.calls[0]! as [TemplateStringsArray];
    return strings.join('?').replace(/\s+/g, ' ').trim();
  }

  it('stamps lastUsedAt and extends the expiry in ONE statement', async () => {
    await ops.touch('session-1');

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(sql()).toContain('SET last_used_at = now()');
    expect(sql()).toContain('expires_at = GREATEST');
  });

  it('can only move the expiry FORWARD', async () => {
    // The bug this guards was found by curl, not by a unit test, and neither write
    // involved was wrong on its own. `touch` runs fire-and-forget from AuthGuard, so
    // it overlaps the request that triggered it: on `POST /auth/device` it read
    // `rememberUntil` as null, `applyTrustOnDevice` then wrote a seven-day window,
    // and the touch landed last with a 24-hour expiry computed from the null. The
    // user asked to be remembered for a week and was signed out the next day.
    //
    // `GREATEST(expires_at, ...)` is what makes that unrepresentable: whatever else
    // is racing, the expiry never contracts.
    await ops.touch('session-1');

    expect(sql()).toMatch(/GREATEST\(\s*expires_at,/);
  });

  it('honours a trust window by reading remember_until in the same statement', async () => {
    // Read inside the UPDATE rather than passed in, so there is no window between
    // reading it and using it — which is exactly where the race lived.
    await ops.touch('session-1');

    expect(sql()).toContain('COALESCE(remember_until');
  });

  it('cannot resurrect a session that expired between the guard and this write', async () => {
    // `touch` runs after the guard's liveness check, so it races the very expiry it
    // maintains. Without the predicate it would push a dead session's window forward
    // and undo its own enforcement.
    await ops.touch('session-1');

    expect(sql()).toContain('revoked_at IS NULL');
    expect(sql()).toContain('expires_at > now()');
  });

  it('passes the session id and the idle window as bound parameters', async () => {
    // Not interpolated. `$executeRaw` is a tagged template so the values are bound,
    // and asserting it here is what keeps someone from "simplifying" this into
    // `$executeRawUnsafe` with a template string.
    await ops.touch('session-1');

    const [, ...values] = executeRaw.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
    expect(values).toEqual([SESSION.IDLE_TIMEOUT_SECONDS, 'session-1']);
  });
});
