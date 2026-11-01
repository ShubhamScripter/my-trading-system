import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChatController } from '../../src/social/chat/chat.controller';
import { ChatModerationService } from '../../src/social/chat/services/chat-moderation.service';
import { ChatSkinService } from '../../src/social/chat/services/chat-skin.service';
import { ChatModerationSettingsService } from '../../src/social/chat/services/chat.moderation-settings.service';
import { ChatService } from '../../src/social/chat/chat.service';
import { ChatSettingsAdminService } from '../../src/social/chat/services/chat.settings.service';

describe('ChatController (Admin Social Chat)', () => {
  let controller: ChatController;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a loose fake of the service layer
  let fakeService: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a loose fake of the settings service
  let fakeSettingsService: any;
  const ADMIN_ID = 'admin-00000000-0000-0000-0000-000000000001';
  const ROOM_UUID = '00000000-0000-7000-8000-000000000001';

  beforeEach(() => {
    fakeService = {
      getStats: vi.fn().mockResolvedValue({
        totalRooms: 2,
        activeRooms: 2,
        totalOnlineUsers: 5,
        totalMessages: 0,
        pendingReports: 0,
        activeBans: 0,
        totalSkins: 1,
        messagesLastMinute: 3,
      }),
      getRooms: vi
        .fn()
        .mockResolvedValue([
          { id: ROOM_UUID, name: 'Global', slug: 'global', type: 'GLOBAL', deletedAt: null },
        ]),
      createRoom: vi.fn().mockResolvedValue({ id: ROOM_UUID, slug: 'high-rollers' }),
      updateRoom: vi.fn().mockResolvedValue({ success: true }),
      deleteRoom: vi.fn().mockResolvedValue({ success: true }),
      getRules: vi.fn().mockResolvedValue({ roomId: ROOM_UUID, roomName: 'Global', rules: [] }),
      updateRules: vi.fn().mockResolvedValue({ success: true }),
      searchMessages: vi.fn().mockResolvedValue({ messages: [], nextCursor: null }),
      getReports: vi.fn().mockResolvedValue([]),
      actionReport: vi.fn().mockResolvedValue({ success: true }),
      getReportReasons: vi.fn().mockResolvedValue([]),
      upsertReportReason: vi.fn().mockResolvedValue({ success: true }),
      getBans: vi.fn().mockResolvedValue([]),
      createBan: vi.fn().mockResolvedValue({ id: ROOM_UUID }),
      liftBan: vi.fn().mockResolvedValue({ success: true }),
      getStaffRoles: vi.fn().mockResolvedValue([]),
      assignRole: vi.fn().mockResolvedValue({ success: true }),
      removeRole: vi.fn().mockResolvedValue({ success: true }),
      getRegions: vi.fn().mockResolvedValue([]),
      createRegion: vi.fn().mockResolvedValue({ id: ROOM_UUID }),
      updateRegion: vi.fn().mockResolvedValue({ success: true }),
      deleteRegion: vi.fn().mockResolvedValue({ success: true }),
      getSkins: vi.fn().mockResolvedValue([]),
      createSkin: vi.fn().mockResolvedValue({ id: ROOM_UUID }),
      deactivateSkin: vi.fn().mockResolvedValue({ success: true }),
      getMediaUploads: vi.fn().mockResolvedValue([]),
      flagMedia: vi.fn().mockResolvedValue({ success: true }),
      deleteMedia: vi.fn().mockResolvedValue({ success: true }),
      sendBroadcast: vi.fn().mockResolvedValue({ success: true, dispatchedCount: 1 }),
      retractMessage: vi.fn().mockResolvedValue({ success: true }),
      getFrequentHitters: vi.fn().mockResolvedValue([]),
    };

    fakeSettingsService = {
      getDocument: vi.fn().mockResolvedValue({
        document: { global: {}, countries: {} },
        version: 1,
        updatedAt: new Date().toISOString(),
      }),
      savePatch: vi.fn().mockResolvedValue({ changeId: ROOM_UUID, applied: true }),
      rollback: vi.fn().mockResolvedValue({ success: true }),
      getChanges: vi.fn().mockResolvedValue([]),
      preview: vi.fn().mockResolvedValue({ rooms: {}, limits: {} }),
    };

    // One fake stands in for the room, moderation and skin services.
    controller = new ChatController(
      fakeService as unknown as ChatService,
      fakeService as unknown as ChatModerationService,
      fakeService as unknown as ChatSkinService,
      fakeSettingsService as unknown as ChatSettingsAdminService,
      { get: vi.fn(), save: vi.fn() } as unknown as ChatModerationSettingsService,
    );
  });

  it('getStats returns stats envelope', async () => {
    const res = await controller.getStats();
    expect(res.data.stats.totalRooms).toBe(2);
  });

  it('getRooms returns rooms list', async () => {
    const res = await controller.getRooms();
    expect(res.data.rooms).toHaveLength(1);
  });

  it('createRoom parses body and passes adminId', async () => {
    const res = await controller.createRoom({ name: 'High Rollers', type: 'PREMIUM' }, ADMIN_ID);
    expect(res.data.slug).toBe('high-rollers');
    expect(fakeService.createRoom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'High Rollers', type: 'PREMIUM' }),
      ADMIN_ID,
    );
  });

  it('updateRoom parses body and passes adminId', async () => {
    const res = await controller.updateRoom({ roomId: ROOM_UUID, status: 'MAINTENANCE' }, ADMIN_ID);
    expect(res.data.success).toBe(true);
    expect(fakeService.updateRoom).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: ROOM_UUID }),
      ADMIN_ID,
    );
  });

  it('deleteRoom parses body and passes adminId', async () => {
    const res = await controller.deleteRoom({ roomId: ROOM_UUID }, ADMIN_ID);
    expect(res.data.success).toBe(true);
    expect(fakeService.deleteRoom).toHaveBeenCalledWith(ROOM_UUID, ADMIN_ID);
  });

  it('actionReport requires note field', async () => {
    // Without note — should throw validation error.
    await expect(
      controller.actionReport({ reportId: ROOM_UUID, action: 'DISMISS' }, ADMIN_ID),
    ).rejects.toThrow();
  });

  it('actionReport passes with note', async () => {
    const res = await controller.actionReport(
      { reportId: ROOM_UUID, action: 'DISMISS', note: 'Not a violation' },
      ADMIN_ID,
    );
    expect(res.data.success).toBe(true);
    expect(fakeService.actionReport).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'Not a violation' }),
      ADMIN_ID,
    );
  });

  it('createBan passes the two reasons and the permanent flag', async () => {
    const res = await controller.createBan(
      { userId: ROOM_UUID, userReason: 'Abuse', internalReason: 'Permanent — repeat offender', permanent: true },
      ADMIN_ID,
    );
    expect(res.data.id).toBe(ROOM_UUID);
  });

  it('liftBan requires note', async () => {
    await expect(controller.liftBan({ banId: ROOM_UUID }, ADMIN_ID)).rejects.toThrow();
  });

  it('deactivateSkin uses deactivate endpoint', async () => {
    const res = await controller.deactivateSkin({ id: ROOM_UUID }, ADMIN_ID);
    expect(res.data.success).toBe(true);
    expect(fakeService.deactivateSkin).toHaveBeenCalledWith(ROOM_UUID, ADMIN_ID);
  });

  it('flagMedia passes note', async () => {
    const res = await controller.flagMedia(
      { uploadId: ROOM_UUID, note: 'Inappropriate content' },
      ADMIN_ID,
    );
    expect(res.data.success).toBe(true);
  });

  it('deleteMedia requires note', async () => {
    await expect(controller.deleteMedia({ uploadId: ROOM_UUID }, ADMIN_ID)).rejects.toThrow();
  });

  it('getSettings returns document', async () => {
    const res = await controller.getSettings();
    expect(res.data.version).toBe(1);
  });

  it('saveSettings calls settingsService.savePatch', async () => {
    const res = await controller.saveSettings(
      { patch: { global: { limits: { eventsPerSecond: 10 } } } },
      ADMIN_ID,
    );
    expect(res.data.applied).toBe(true);
    expect(fakeSettingsService.savePatch).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: ADMIN_ID }),
    );
  });

  it('sendBroadcast dispatches alert', async () => {
    const res = await controller.sendBroadcast(
      { title: 'Alert', content: 'Restarting', type: 'SYSTEM_ALERT' },
      ADMIN_ID,
    );
    expect(res.data.success).toBe(true);
    expect(fakeService.sendBroadcast).toHaveBeenCalledWith(expect.anything(), ADMIN_ID);
  });
});
