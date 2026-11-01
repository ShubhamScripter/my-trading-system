import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ProblemException } from '../../src/http';
import { ChatStaffGuard } from '../../src/social/chat/chat.staff.guard';
import { ChatStaffRoutes } from '../../src/social/chat/chat.staff.routes';
import type { ChatUserContext } from '../../src/social/chat/chat.types';

/**
 * FR-217: a user without a chat role gets 403 on every staff route before the body is looked at (a guard runs before
 * the body pipe, so the answer no longer depends on what they send).
 */
const user = (staffRole: ChatUserContext['staffRole']): ChatUserContext => ({ id: 'u1', username: 'ada', publicCode: 'P1', staffRole });
const guardFor = (role: ChatUserContext['staffRole']) =>
  new ChatStaffGuard({ getChatUser: async () => user(role) } as never, new Reflector());
const contextOf = (handler: (...args: never[]) => unknown): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => ChatStaffRoutes,
    switchToHttp: () => ({ getRequest: () => ({}) }),
  }) as unknown as ExecutionContext;

describe('ChatStaffGuard', () => {
  it('refuses a non-staff user with permission_denied on a route that has a body', async () => {
    const caught = await guardFor(null)
      .canActivate(contextOf(ChatStaffRoutes.prototype.restrict as never))
      .catch((e: unknown) => e as ProblemException);
    expect(caught).toBeInstanceOf(ProblemException);
    expect((caught as ProblemException).extra?.reason).toBe('permission_denied');
  });

  it('lets any staff role through', async () => {
    for (const role of ['SUPPORT', 'MODERATOR', 'ADMIN'] as const) {
      expect(await guardFor(role).canActivate(contextOf(ChatStaffRoutes.prototype.restrict as never))).toBe(true);
    }
  });

  it('leaves the permissions read open to every signed-in user (the chat screen asks it for everyone)', async () => {
    expect(await guardFor(null).canActivate(contextOf(ChatStaffRoutes.prototype.permissions as never))).toBe(true);
  });

  it('guards every other staff route, so a new route is closed unless it is marked open', () => {
    const guards = Reflect.getMetadata('__guards__', ChatStaffRoutes) as unknown[];
    expect(guards).toContain(ChatStaffGuard);
    const open = Object.getOwnPropertyNames(ChatStaffRoutes.prototype).filter(
      (name) => name !== 'constructor' && Reflect.getMetadata('chat:staff:open-to-every-user', (ChatStaffRoutes.prototype as never)[name]) === true,
    );
    expect(open).toEqual(['permissions']);
  });
});
