import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';
import { SuperAdminGuard } from '../../auth/security/guards';
import { ChatRoutes } from '../../src/social/chat/chat.routes';
import { ChatAuthorityService } from '../../src/social/chat/services/chat-authority.service';
import { UpdateRoomAccessSchema, UpdateRoomSchema } from '../../src/social/chat/chat.dto';
import { ChatModerationSettingsService } from '../../src/social/chat/services/chat.moderation-settings.service';

/**
 * Who may do what in admin chat. Any signed-in admin may moderate; only a super admin may assign chat roles, change
 * chat-wide settings, write a room's access rule, use the test-only tools or broadcast to every room (FR-002, FR-160).
 * The role is read from the database on every call, so a demoted admin loses these powers at once. These tests fail if
 * a guard is taken off a route.
 *
 * The guard's own role check is the platform's (auth tests); here we pin that every such route carries it.
 * Sign-in and 2FA belong to the platform (auth, 2fa) and are not repeated here.
 */

// The platform AuthGuard puts the principal on the request; chat only reads it through requirePrincipal.
const session = vi.hoisted(() => ({
  principal: undefined as { adminId: string; role: string; familyId: string } | undefined,
  production: false,
}));
vi.mock('../../auth/security/guards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/security/guards')>()),
  requirePrincipal: () => {
    if (!session.principal) throw new ProblemException({ type: ERR.UNAUTHENTICATED });
    return session.principal;
  },
}));
vi.mock('../../src/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config')>();
  return {
    ...real,
    // config is frozen, so a copy with a live isProduction stands in for it.
    config: Object.defineProperty({ ...real.config }, 'isProduction', { get: () => session.production, enumerable: true }),
  };
});

/** The account's role in the database; it can differ from the role the session was issued with. */
const database = { role: 'SUPER_ADMIN', status: 'ACTIVE' as string, missing: false };
const admins = { findById: vi.fn(async () => (database.missing ? null : { role: database.role, status: database.status })) };

const signedInAs = (role: string | undefined): void => {
  session.principal = role ? { adminId: 'a-1', role, familyId: 'f-1' } : undefined;
};

const proto = ChatRoutes.prototype as unknown as Record<string, unknown>;

/** Every handler of ChatRoutes as { route: 'POST staff/assign-role', handler }. */
const routes = Object.getOwnPropertyNames(proto)
  .filter((name) => name !== 'constructor')
  .flatMap((name) => {
    const handler = proto[name] as object;
    const path = Reflect.getMetadata('path', handler) as string | undefined;
    const method = Reflect.getMetadata('method', handler) as number | undefined;
    if (path === undefined || method === undefined) return [];
    return [{ route: `${['GET', 'POST'][method] ?? method} ${path}`, handler }];
  });

const guardsOf = (handler: object): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];

const SUPER_ADMIN_ONLY = [
  'POST staff/assign-role',
  'POST staff/remove-role',
  'POST settings',
  'POST settings/rollback',
  'POST rooms/access',
  'GET test-entitlements',
  'POST test-entitlements',
  'POST test-entitlements/delete',
];

beforeEach(() => {
  database.role = 'SUPER_ADMIN';
  database.status = 'ACTIVE';
  database.missing = false;
  session.production = false;
  admins.findById.mockClear();
});

describe('routes that only a super admin may call', () => {
  it.each(SUPER_ADMIN_ONLY)('%s carries the platform SuperAdminGuard', (route) => {
    const found = routes.find((r) => r.route === route);
    expect(found, `no route ${route}`).toBeDefined();
    expect(guardsOf(found!.handler)).toContain(SuperAdminGuard);
  });

  it('no other route is limited by that guard (some room writes check current DB role in-handler)', () => {
    const guarded = routes
      .filter((r) => guardsOf(r.handler).includes(SuperAdminGuard))
      .map((r) => r.route)
      .sort();
    expect(guarded).toEqual([...SUPER_ADMIN_ONLY].sort());
  });
});

describe('ChatAuthorityService', () => {
  const authority = () => new ChatAuthorityService(admins as never);

  it('asserts a super admin from the database, not from the session', async () => {
    await expect(authority().assertSuperAdmin('a-1', 'no')).resolves.toBeUndefined();
    database.role = 'ADMIN';
    await expect(authority().assertSuperAdmin('a-1', 'Only a super admin')).rejects.toMatchObject({
      type: ERR.FORBIDDEN,
      detail: 'Only a super admin',
    });
    database.missing = true;
    await expect(authority().assertSuperAdmin('a-1', 'no')).rejects.toMatchObject({ type: ERR.UNAUTHENTICATED });
  });

  it('refuses the test-only tools in production and allows them elsewhere', () => {
    expect(() => authority().assertTestToolsAllowed()).not.toThrow();
    session.production = true;
    expect(() => authority().assertTestToolsAllowed()).toThrowError(expect.objectContaining({ type: ERR.FORBIDDEN }));
  });
});

describe('routes that check the body', () => {
  const build = () => {
    const controller = {
      sendBroadcast: vi.fn(async () => ({ data: { success: true } })),
      createRoom: vi.fn(async () => ({ data: { id: 'r', slug: 's' } })),
      updateRoom: vi.fn(async () => ({ data: { success: true } })),
      deleteRoom: vi.fn(async () => ({ data: { success: true } })),
      createRegion: vi.fn(async () => ({ data: { id: 'region' } })),
      updateRegion: vi.fn(async () => ({ data: { success: true } })),
      deleteRegion: vi.fn(async () => ({ data: { success: true } })),
      upsertTestEntitlement: vi.fn(async () => ({ data: { success: true } })),
    };
    return { controller, routes: new ChatRoutes(controller as never, new ChatAuthorityService(admins as never)) };
  };
  const req = {} as never;

  it('a broadcast to every room needs a super admin in the database; one room does not', async () => {
    const { controller, routes: chatRoutes } = build();
    signedInAs('SUPER_ADMIN');
    database.role = 'ADMIN'; // demoted since sign-in
    await expect(chatRoutes.sendBroadcast({ message: 'hi' }, req)).rejects.toMatchObject({ type: ERR.FORBIDDEN });
    expect(controller.sendBroadcast).not.toHaveBeenCalled();
    await chatRoutes.sendBroadcast({ roomId: 'room-1', message: 'hi' }, req);
    database.role = 'SUPER_ADMIN';
    signedInAs('ADMIN'); // promoted since sign-in
    await chatRoutes.sendBroadcast({ message: 'hi' }, req);
    expect(controller.sendBroadcast).toHaveBeenCalledTimes(2);
  });

  it('room creation and deletion require super admin; scoped moderation changes remain separate', async () => {
    const { controller, routes: chatRoutes } = build();
    signedInAs('ADMIN');
    database.role = 'ADMIN';
    await expect(chatRoutes.createRoom({ name: 'Plain' }, req)).rejects.toMatchObject({
      type: ERR.FORBIDDEN,
    });
    expect(controller.createRoom).not.toHaveBeenCalled();
    database.role = 'SUPER_ADMIN';
    await chatRoutes.createRoom({ name: 'Gated', access: { minLevel: 5 } }, req);
    expect(controller.createRoom).toHaveBeenCalledTimes(1);
    await expect(chatRoutes.deleteRoom({ roomId: 'r' }, req)).resolves.toBeDefined();
    database.role = 'ADMIN';
    await expect(chatRoutes.deleteRoom({ roomId: 'r' }, req)).rejects.toMatchObject({ type: ERR.FORBIDDEN });
    expect(controller.deleteRoom).toHaveBeenCalledTimes(1);
  });

  it('room metadata and all region mutations require super admin', async () => {
    const { controller, routes: chatRoutes } = build();
    signedInAs('ADMIN');
    database.role = 'ADMIN';
    await expect(chatRoutes.updateRoom({ roomId: 'r', name: 'New name' }, req)).rejects.toMatchObject({ type: ERR.FORBIDDEN });
    await expect(chatRoutes.createRegion({ name: 'Region', countries: ['IN'] }, req)).rejects.toMatchObject({ type: ERR.FORBIDDEN });
    await expect(chatRoutes.updateRegion({ regionId: 'r', name: 'Region' }, req)).rejects.toMatchObject({ type: ERR.FORBIDDEN });
    await expect(chatRoutes.deleteRegion({ regionId: 'r' }, req)).rejects.toMatchObject({ type: ERR.FORBIDDEN });
    expect(controller.updateRoom).not.toHaveBeenCalled();
    expect(controller.createRegion).not.toHaveBeenCalled();
    expect(controller.updateRegion).not.toHaveBeenCalled();
    expect(controller.deleteRegion).not.toHaveBeenCalled();
    database.role = 'SUPER_ADMIN';
    await chatRoutes.updateRoom({ roomId: 'r', name: 'New name' }, req);
    await chatRoutes.createRegion({ name: 'Region', countries: ['IN'] }, req);
    await chatRoutes.updateRegion({ regionId: 'r', name: 'Region' }, req);
    await chatRoutes.deleteRegion({ regionId: 'r' }, req);
    expect(controller.updateRoom).toHaveBeenCalledOnce();
    expect(controller.createRegion).toHaveBeenCalledOnce();
    expect(controller.updateRegion).toHaveBeenCalledOnce();
    expect(controller.deleteRegion).toHaveBeenCalledOnce();
  });

  it('the test-only tools are refused in production before anything is read or written', async () => {
    const { controller, routes: chatRoutes } = build();
    signedInAs('SUPER_ADMIN');
    session.production = true;
    await expect(chatRoutes.upsertTestEntitlement({}, req)).rejects.toMatchObject({ type: ERR.FORBIDDEN });
    expect(controller.upsertTestEntitlement).not.toHaveBeenCalled();
  });
});

describe('room access fields', () => {
  it('the normal room update refuses access (it has its own super-admin route)', () => {
    const id = '0192f6a0-0000-7000-8000-000000000001';
    expect(UpdateRoomSchema.safeParse({ roomId: id, name: 'New name' }).success).toBe(true);
    expect(UpdateRoomSchema.safeParse({ roomId: id, access: { minLevel: 5 } }).success).toBe(false);
  });

  it('the access route needs at least one access field and nothing else', () => {
    const id = '0192f6a0-0000-7000-8000-000000000001';
    expect(UpdateRoomAccessSchema.safeParse({ roomId: id, access: {} }).success).toBe(false);
    expect(UpdateRoomAccessSchema.safeParse({ roomId: id, access: { minLevel: 5 } }).success).toBe(true);
    expect(UpdateRoomAccessSchema.safeParse({ roomId: id, access: { minLevel: 5 }, name: 'x' }).success).toBe(false);
  });
});

describe('moderation settings save (FR-100, FR-174)', () => {
  const ROOM = '0192f6a0-0000-7000-8000-000000000001';
  const entry = (extra: Record<string, unknown>) => ({
    targetType: 'USER',
    targetValue: 'ada',
    restriction: 'MUTE',
    internalReason: 'Spam',
    ...extra,
  });
  const build = (maxBanHours = 48) => {
    const saved: unknown[] = [];
    const rooms = {
      getRoomConfig: vi.fn(async () => ({ userRestrictions: [] })),
      changeRoomConfig: vi.fn(async (_id: string, fn: (c: Record<string, unknown>, now: Date) => unknown) => {
        saved.push(fn({}, new Date('2026-01-01T00:00:00Z')));
        return true;
      }),
    };
    const moderation = { resolveUserId: vi.fn(async () => 'u-1'), recordModerationAction: vi.fn(), notify: vi.fn() };
    const settings = { preview: vi.fn(async () => ({ limits: { maxBanHours } })) };
    const service = new ChatModerationSettingsService(rooms as never, moderation as never, settings as never);
    return { service, saved };
  };

  it('refuses a key it does not know', async () => {
    await expect(build().service.save({ roomId: ROOM, staffRoles: [] }, 'a-1')).rejects.toMatchObject({
      type: ERR.VALIDATION_FAILED,
    });
  });

  it.each([
    ['nothing said about duration', entry({})],
    ['0 hours', entry({ durationHours: 0 })],
    ['half an hour', entry({ durationHours: 0.5 })],
    ['permanent and a duration', entry({ permanent: true, durationHours: 5 })],
  ])('refuses %s', async (_name, row) => {
    await expect(build().service.save({ roomId: ROOM, userRestrictions: [row] }, 'a-1')).rejects.toMatchObject({
      type: ERR.VALIDATION_FAILED,
    });
  });

  it('a mute may not outlast limits.maxBanHours, but permanent and other restrictions may', async () => {
    const { service, saved } = build(48);
    await expect(
      service.save({ roomId: ROOM, userRestrictions: [entry({ durationHours: 49 })] }, 'a-1'),
    ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });
    await service.save(
      {
        roomId: ROOM,
        userRestrictions: [
          entry({ durationHours: 48 }),
          entry({ permanent: true }),
          entry({ restriction: 'RESTRICT_GIF', durationHours: 5000 }),
        ],
      },
      'a-1',
    );
    const rows = (saved[0] as { userRestrictions: { expiresAt?: string; restriction: string }[] }).userRestrictions;
    expect(rows[0]!.expiresAt).toBe('2026-01-03T00:00:00.000Z');
    expect(rows[1]!.expiresAt).toBeUndefined();
    expect(rows[2]!.restriction).toBe('RESTRICT_GIF');
  });

  it('stores a user by id, whether a username, a login code or an id was typed (FR-088)', async () => {
    const { service, saved } = build();
    await service.save({ roomId: ROOM, userRestrictions: [entry({ targetValue: 'ada', permanent: true })] }, 'a-1');
    // resolveUserId of the fake answers 'u-1' for whatever was typed
    expect((saved[0] as { userRestrictions: { targetValue: string }[] }).userRestrictions[0]!.targetValue).toBe('u-1');
  });

  it('stores No Links as itself, never as a missing key, so the chat server can count a refused link (FR-179)', async () => {
    const { service, saved } = build();
    await service.save({ roomId: ROOM, linkPolicy: 'NO_LINKS' }, 'a-1');
    expect(saved[0]).toMatchObject({ linksPolicy: 'NO_LINKS' });
  });

  it('keeps the expiry of an entry already stored', async () => {
    const { service, saved } = build();
    await service.save({ roomId: ROOM, userRestrictions: [entry({ expiresAt: '2026-02-01T00:00:00Z' })] }, 'a-1');
    expect((saved[0] as { userRestrictions: { expiresAt?: string }[] }).userRestrictions[0]!.expiresAt).toBe(
      '2026-02-01T00:00:00Z',
    );
  });
});
