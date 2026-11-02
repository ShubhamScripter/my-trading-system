import { describe, expect, it, vi } from 'vitest';
import { ChatSettingsService } from '../../src/social/chat/chat.settings';
import { ChatBus } from '../../src/social/chat/realtime/chat.bus';

/**
 * Chat-wide settings: read through one resolver, cached for a short time, dropped when the admin
 * signals a change, and scheduled changes applied once, on the database clock.
 */
function make(document: unknown = {}, version = 1) {
  const bus = new ChatBus();
  const db = {
    settingsRow: vi.fn(async () => ({ document, version })),
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})),
    savepoint: vi.fn(async () => 0),
    rollbackSavepoint: vi.fn(async () => 0),
    releaseSavepoint: vi.fn(async () => 0),
    dueChanges: vi.fn(async () => [] as unknown[]),
    lockSettingsDocument: vi.fn(async () => ({ global: {}, countries: {} })),
    cancelChange: vi.fn(async () => undefined),
    writeSettingsDocument: vi.fn(async () => undefined),
    finishChange: vi.fn(async () => undefined),
    applyRoomPatch: vi.fn(async () => ({ room: {} })),
  };
  const service = new ChatSettingsService(db as never, bus);
  return { service, db, bus };
}

describe('reading the settings', () => {
  it('uses the defaults for an empty document', async () => {
    const { service } = make({});
    const settings = await service.global();
    expect(settings.limits.messagesPerWindow).toBe(5);
    expect(settings.testProviders.enabled).toBe(false);
  });

  it('layers a country exception over the global values', async () => {
    const { service } = make({
      global: { minLevel: { global: 2 } },
      countries: { IN: { minLevel: { global: 5 } } },
    });
    expect((await service.global()).minLevel.global).toBe(2);
    expect((await service.forCountry('IN')).minLevel.global).toBe(5);
    expect((await service.forCountry('US')).minLevel.global).toBe(2);
  });

  it('reads the database once inside the cache window, and again after a change signal', async () => {
    const { service, db, bus } = make({});
    await service.global();
    await service.global();
    expect(db.settingsRow).toHaveBeenCalledTimes(1);

    bus.publish({ kind: 'settings' });
    await service.global();
    expect(db.settingsRow).toHaveBeenCalledTimes(2);
  });

  it('falls back to the defaults, without throwing, when the stored document is invalid', async () => {
    const { service } = make({ global: { limits: { eventsPerSecond: 'many' } } }, 7);
    const settings = await service.global();
    expect(settings.limits.eventsPerSecond).toBe(10);
  });

  it('fills an empty link allow-list with the web app host', async () => {
    const { service } = make({});
    expect((await service.global()).links.allowedDomains.length).toBeGreaterThan(0);
  });
});

describe('applying due changes', () => {
  const change = (over: Record<string, unknown>) => ({
    id: 'c1',
    target: 'SETTINGS',
    room_id: null,
    actor_id: 'admin-1',
    patch: {},
    ...over,
  });

  it('writes a valid settings change and records the document it replaced', async () => {
    const { service, db } = make();
    db.dueChanges.mockResolvedValueOnce([
      change({ patch: { global: { limits: { cooldownSeconds: 30 } } } }),
    ]);

    const result = await service.applyDueChanges();

    expect(result).toEqual({ settings: true, roomIds: [] });
    expect(db.writeSettingsDocument).toHaveBeenCalledTimes(1);
    expect(db.finishChange).toHaveBeenCalledWith({}, 'c1', { global: {}, countries: {} });
    expect(db.cancelChange).not.toHaveBeenCalled();
  });

  it('cancels a settings change that fails the contract instead of applying it', async () => {
    const { service, db } = make();
    db.dueChanges.mockResolvedValueOnce([
      change({ patch: { global: { limits: { cooldownSeconds: -1 } } } }),
    ]);

    const result = await service.applyDueChanges();

    expect(result.settings).toBe(false);
    expect(db.cancelChange).toHaveBeenCalledWith({}, 'c1');
    expect(db.writeSettingsDocument).not.toHaveBeenCalled();
  });

  it('applies a room change and reports the room so open sockets are re-checked', async () => {
    const { service, db } = make();
    db.dueChanges.mockResolvedValueOnce([
      change({
        id: 'c2',
        target: 'ROOM',
        room_id: 'room-1',
        patch: { room: { name: 'New name' } },
      }),
    ]);

    const result = await service.applyDueChanges();

    expect(result.roomIds).toEqual(['room-1']);
    expect(db.applyRoomPatch).toHaveBeenCalledWith({}, 'room-1', { room: { name: 'New name' } });
  });

  it('does nothing when no change is due', async () => {
    const { service, db } = make();
    expect(await service.applyDueChanges()).toEqual({ settings: false, roomIds: [] });
    expect(db.writeSettingsDocument).not.toHaveBeenCalled();
  });

  it('rolls back and cancels one failed change, then continues with later changes', async () => {
    const { service, db } = make();
    db.dueChanges.mockResolvedValueOnce([
      change({ id: 'bad', patch: { global: { limits: { cooldownSeconds: 30 } } } }),
      change({ id: 'good', patch: { global: { limits: { cooldownSeconds: 45 } } } }),
    ]);
    db.writeSettingsDocument.mockRejectedValueOnce(new Error('room slug conflict'));

    const result = await service.applyDueChanges();

    expect(result.settings).toBe(true);
    expect(db.rollbackSavepoint).toHaveBeenCalledTimes(1);
    expect(db.cancelChange).toHaveBeenCalledWith({}, 'bad');
    expect(db.finishChange).toHaveBeenCalledWith({}, 'good', { global: {}, countries: {} });
  });
});
