import { describe, expect, it, vi } from 'vitest';
import { ChatDbOperation } from '../../src/social/chat/chat.dboperation';

describe('public chat user lookup', () => {
  const build = () => {
    const findFirst = vi.fn(async () => ({ id: 'internal-user-id' }));
    const db = new ChatDbOperation({ user: { findFirst } } as never);
    return { db, findFirst };
  };

  it('only resolves a username and never queries by internal UUID', async () => {
    const { db, findFirst } = build();
    expect(await db.resolvePublicUsername('  @Alice  ')).toBe('internal-user-id');
    expect(findFirst).toHaveBeenCalledWith({
      where: { deletedAt: null, status: 'ACTIVE', usernameLower: 'alice' },
      select: { id: true },
    });
    expect(await db.resolvePublicUsername('0192f6a0-0000-7000-8000-000000000001')).toBeNull();
    expect(findFirst).toHaveBeenCalledOnce();
  });

  it('does not treat a login code as a public username lookup', async () => {
    const { db, findFirst } = build();
    expect(await db.resolvePublicUsername('OREBiTABC23456')).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
