import { describe, expect, it, vi } from 'vitest';
import { ChatBus, type ChatChange } from '../../src/social/chat/realtime/chat.bus';
import { ChatEventsListener } from '../../src/social/chat/chat.events.listener';
import type { ChatDbOperation } from '../../src/social/chat/chat.dboperation';

function harness() {
  const bus = new ChatBus();
  const changes: ChatChange[] = [];
  bus.subscribe((c) => void changes.push(c));
  const db = { broadcastMessages: vi.fn(async () => [{ id: 'a1' }, { id: 'a2' }]) };
  const listener = new ChatEventsListener(db as unknown as ChatDbOperation, {} as never, bus);
  const action = (overrides: Record<string, unknown>) => ({
    id: `act-${Math.random()}`,
    action: 'x',
    target_user_id: null,
    target_room_id: null,
    target_message_id: null,
    new_value: null,
    note: null,
    created_at: new Date('2026-09-28T12:00:00Z'),
    ...overrides,
  });
  return { listener, changes, action };
}

describe('ChatEventsListener.dispatch', () => {
  it('an admin broadcast becomes alerts delivered to the rooms', async () => {
    const { listener, changes, action } = harness();
    listener.dispatch(action({ action: 'broadcast', new_value: { broadcastId: 'b1' } }) as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(changes).toContainEqual({ kind: 'alert', messageIds: ['a1', 'a2'] });
  });

  it('an admin retract reaches the room without the actor, and the note only the author', () => {
    const { listener, changes, action } = harness();
    listener.dispatch(
      action({
        action: 'message.retract',
        target_message_id: 'm1',
        target_room_id: 'r1',
        target_user_id: 'u1',
        note: 'Rule 2',
        new_value: { retractedAt: '2026-09-28T12:00:00Z' },
      }) as never,
    );
    expect(changes).toContainEqual({
      kind: 'retract',
      messageId: 'm1',
      roomId: 'r1',
      retractedAt: '2026-09-28T12:00:00Z',
    });
    expect(changes).toContainEqual({
      kind: 'notice',
      userId: 'u1',
      notice: { action: 'retract', roomId: 'r1', messageId: 'm1', note: 'Rule 2' },
    });
  });

  it('a ban bumps the ban version and tells the banned user', () => {
    const { listener, changes, action } = harness();
    listener.dispatch(
      action({
        action: 'ban.create',
        target_user_id: 'u1',
        note: 'Spam',
        new_value: { expiresAt: null },
      }) as never,
    );
    expect(changes.map((c) => c.kind)).toEqual(['ban', 'notice']);
  });

  it('room, settings and role changes re-check the affected sockets', () => {
    const { listener, changes, action } = harness();
    listener.dispatch(action({ action: 'room.update', target_room_id: 'r1' }) as never);
    listener.dispatch(action({ action: 'settings.update' }) as never);
    listener.dispatch(action({ action: 'role.assign', target_user_id: 'u9' }) as never);
    expect(changes).toEqual([
      { kind: 'room', roomId: 'r1' },
      { kind: 'settings' },
      { kind: 'user', userId: 'u9' },
    ]);
  });

  it('a replayed action is dispatched once', () => {
    const { listener, changes, action } = harness();
    const once = action({ action: 'room.update', target_room_id: 'r1' });
    listener.dispatch(once as never);
    listener.dispatch(once as never);
    expect(changes).toHaveLength(1);
  });
});

describe('ChatEventsListener: admin backend names and live signals', () => {
  it('replays the admin backend action names (BAN, UPDATE_ROOM, REPORT_WARN)', () => {
    const { listener, changes, action } = harness();
    listener.dispatch(action({ action: 'BAN', target_user_id: 'u1', note: 'audit' }) as never);
    listener.dispatch(action({ action: 'UPDATE_ROOM', target_room_id: 'r1' }) as never);
    listener.dispatch(
      action({ action: 'REPORT_WARN', target_user_id: 'u2', note: 'be kind' }) as never,
    );
    expect(changes).toContainEqual({ kind: 'ban', userId: 'u1' });
    expect(changes).toContainEqual({ kind: 'room', roomId: 'r1' });
    expect(changes).toContainEqual({
      kind: 'notice',
      userId: 'u2',
      notice: { action: 'warn', roomId: null, note: 'be kind' },
    });
  });

  it('applies a live { kind } signal from the admin backend directly', () => {
    const { listener, changes } = harness();
    listener.dispatchChange({ kind: 'user', userId: 'u3' });
    listener.dispatchChange({
      kind: 'notice',
      userId: 'u3',
      notice: { action: 'BAN', note: 'spam' },
    });
    expect(changes).toContainEqual({ kind: 'user', userId: 'u3' });
    expect(changes).toContainEqual({
      kind: 'notice',
      userId: 'u3',
      notice: { action: 'ban', roomId: null, messageId: null, note: 'spam', expiresAt: null },
    });
  });
});
