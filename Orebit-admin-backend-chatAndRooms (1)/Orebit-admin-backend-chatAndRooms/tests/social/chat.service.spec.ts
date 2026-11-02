import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChatService } from '../../src/social/chat/chat.service';
import { ChatModerationService } from '../../src/social/chat/services/chat-moderation.service';
import { ChatSkinService } from '../../src/social/chat/services/chat-skin.service';
import { ERR } from '../../src/contracts';
import { ProblemException } from '../../src/http';

describe('ChatService (Admin Social Chat)', () => {
  let service: ChatService;
  let moderation: ChatModerationService;
  let skins: ChatSkinService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a loose fake of the database layer
  let fakeDb: any;

  beforeEach(() => {
    fakeDb = {
      // The claim and the action are one transaction: the fake runs the action with a stand-in transaction handle.
      actOnReport: vi.fn(async (_id: string, _action: string, _admin: string, work: (tx: unknown) => Promise<unknown>) => ({
        claimed: true,
        value: await work('tx'),
      })),
      createWarning: vi.fn().mockResolvedValue(undefined),
      getPlatformStats: vi.fn().mockResolvedValue({
        totalRooms: 5,
        activeRooms: 4,
        totalOnlineUsers: 12,
        totalMessages: 0,
        pendingReports: 2,
        activeBans: 1,
        totalSkins: 3,
        messagesLastMinute: 42,
      }),
      getRooms: vi.fn().mockResolvedValue([
        {
          id: 'room-1',
          name: 'Global Chat',
          slug: 'global',
          type: 'GLOBAL',
          deletedAt: null,
          status: 'ACTIVE',
        },
      ]),
      getActiveRoomIds: vi.fn(async () =>
        (await fakeDb.getRooms()).filter((room: { deletedAt: Date | null; status: string }) =>
          room.deletedAt === null && room.status !== 'DISABLED',
        ).map((room: { id: string }) => room.id),
      ),
      getRoomBySlug: vi.fn(),
      getRoomById: vi.fn(),
      createRoom: vi.fn().mockResolvedValue(undefined),
      updateRoom: vi.fn().mockResolvedValue(undefined),
      softDeleteRoom: vi.fn().mockResolvedValue(undefined),
      getRoomRules: vi
        .fn()
        .mockResolvedValue({ roomId: 'room-1', roomName: 'Global Chat', rules: ['Be respectful'] }),
      updateRoomRules: vi.fn().mockResolvedValue(undefined),
      searchMessages: vi.fn().mockResolvedValue({ messages: [], nextCursor: null }),
      getReports: vi.fn().mockResolvedValue([]),
      getReportById: vi.fn(),
      resolveReport: vi.fn().mockResolvedValue(true),
      getReportReasons: vi.fn().mockResolvedValue([]),
      upsertReportReason: vi.fn().mockResolvedValue(undefined),
      getBans: vi.fn().mockResolvedValue([]),
      createBan: vi.fn().mockResolvedValue({ expiresAt: null }),
      maxBanHours: vi.fn().mockResolvedValue(720),
      liftBan: vi.fn().mockResolvedValue({ userId: 'u-1', roomId: null }),
      getStaffRoles: vi.fn().mockResolvedValue([]),
      setRole: vi.fn().mockResolvedValue(undefined),
      getRegions: vi.fn().mockResolvedValue([]),
      createRegion: vi.fn().mockResolvedValue(undefined),
      updateRegion: vi.fn().mockResolvedValue(true),
      deleteRegion: vi.fn().mockResolvedValue(true),
      getSkins: vi.fn().mockResolvedValue([]),
      createSkin: vi.fn().mockResolvedValue(undefined),
      deactivateSkin: vi.fn().mockResolvedValue(true),
      getMediaUploads: vi.fn().mockResolvedValue([]),
      flagMedia: vi.fn().mockResolvedValue(true),
      deleteMedia: vi.fn().mockResolvedValue(true),
      createBroadcast: vi.fn().mockResolvedValue(undefined),
      retractMessage: vi.fn().mockResolvedValue({
        roomId: 'room-1',
        userId: 'author-1',
        createdAt: new Date('2025-01-01'),
        retractedAt: new Date('2025-01-02'),
      }),
      getFrequentHitters: vi.fn().mockResolvedValue([]),
      getSettingsDocument: vi.fn().mockResolvedValue({
        document: { global: {}, countries: {} },
        version: 1,
        updatedAt: new Date().toISOString(),
      }),
      saveSettingsChange: vi.fn().mockResolvedValue(undefined),
      getSettingsChanges: vi.fn().mockResolvedValue([]),
      rollbackSettingsChange: vi.fn().mockResolvedValue(true),
      recordModerationAction: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn().mockResolvedValue(undefined),
      resolveUserId: vi.fn().mockImplementation((id: string) => Promise.resolve(id)),
    };

    service = new ChatService(fakeDb, fakeDb, fakeDb);
    moderation = new ChatModerationService(fakeDb, fakeDb);
    skins = new ChatSkinService(fakeDb, fakeDb);
  });

  // ─── Stats ────────────────────────────────────────────────────────────────

  describe('getStats', () => {
    it('returns platform stats from the RuntimeStats table', async () => {
      const stats = await service.getStats();
      expect(fakeDb.getPlatformStats).toHaveBeenCalled();
      expect(stats.totalRooms).toBe(5);
      expect(stats.messagesLastMinute).toBe(42);
    });
  });

  // ─── Rooms ────────────────────────────────────────────────────────────────

  describe('createRoom', () => {
    it('creates a room and generates slug from name when slug is absent', async () => {
      fakeDb.getRoomBySlug.mockResolvedValue(null);

      const result = await service.createRoom(
        {
          name: 'VIP Lounge',
          type: 'PREMIUM',
          status: 'ACTIVE',
          rules: [],
          bannedWords: [],
          contentControls: {},
          access: {},
        },
        'admin-1',
      );

      expect(result.slug).toBe('vip-lounge');
      expect(fakeDb.createRoom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'VIP Lounge', slug: 'vip-lounge', type: 'PREMIUM' }),
      );
      expect(fakeDb.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'room' }));
      expect(fakeDb.recordModerationAction).toHaveBeenCalled();
    });

    it('rejects when slug already exists', async () => {
      fakeDb.getRoomBySlug.mockResolvedValue({ id: 'existing-room' });

      await expect(
        service.createRoom(
          {
            name: 'Global',
            slug: 'global',
            type: 'GLOBAL',
            status: 'ACTIVE',
            rules: [],
            bannedWords: [],
            contentControls: {},
            access: {},
          },
          'admin-1',
        ),
      ).rejects.toThrowError(ProblemException);
    });

    it('uses safe defaults: images, video, ads, commands are off', async () => {
      fakeDb.getRoomBySlug.mockResolvedValue(null);

      await service.createRoom(
        {
          name: 'Casino Room',
          type: 'CASINO',
          status: 'ACTIVE',
          rules: [],
          bannedWords: [],
          contentControls: {},
          access: {},
        },
        'admin-1',
      );

      const passedToDb = fakeDb.createRoom.mock.calls[0][0];
      expect(passedToDb.contentControls.allowImage).toBe(false);
      expect(passedToDb.contentControls.allowVideo).toBe(false);
      expect(passedToDb.contentControls.allowAds).toBe(false);
      expect(passedToDb.contentControls.allowCommands).toBe(false);
    });

    it('STAFF and SO rooms get HIDE as the default ineligible mode', async () => {
      fakeDb.getRoomBySlug.mockResolvedValue(null);

      await service.createRoom(
        {
          name: 'Staff Room',
          type: 'STAFF',
          status: 'ACTIVE',
          rules: [],
          bannedWords: [],
          contentControls: {},
          access: {},
        },
        'admin-1',
      );

      const passedToDb = fakeDb.createRoom.mock.calls[0][0];
      expect(passedToDb.access.ineligibleMode).toBe('HIDE');
    });
  });

  describe('updateRoom', () => {
    it('updates a room and notifies the user BE', async () => {
      fakeDb.getRoomById.mockResolvedValue({ id: 'room-1', slug: 'global', config: {} });

      const res = await service.updateRoom({ roomId: 'room-1', status: 'MAINTENANCE' }, 'admin-1');

      expect(res.success).toBe(true);
      expect(fakeDb.updateRoom).toHaveBeenCalled();
      expect(fakeDb.notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'room', roomId: 'room-1' }),
      );
    });

    it('throws 404 when room does not exist', async () => {
      fakeDb.getRoomById.mockResolvedValue(null);

      await expect(
        service.updateRoom({ roomId: 'missing-id', status: 'ACTIVE' }, 'admin-1'),
      ).rejects.toMatchObject({ type: ERR.CHAT_ROOM_NOT_FOUND });
    });
  });

  describe('deleteRoom', () => {
    it('soft-deletes a room and notifies user BE', async () => {
      fakeDb.getRoomById.mockResolvedValue({ id: 'room-1' });

      const res = await service.deleteRoom('room-1', 'admin-1');

      expect(res.success).toBe(true);
      expect(fakeDb.softDeleteRoom).toHaveBeenCalledWith('room-1');
      expect(fakeDb.notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'room', roomId: 'room-1' }),
      );
    });
  });

  // ─── Reports ─────────────────────────────────────────────────────────────

  describe('actionReport', () => {
    it('bans reported user when action is BAN (DB clock used for ban times)', async () => {
      fakeDb.getReportById.mockResolvedValue({
        id: 'rep-1',
        status: 'PENDING',
        reported_user_id: 'user-123',
        message_id: null,
      });

      const res = await moderation.actionReport(
        {
          reportId: 'rep-1',
          action: 'BAN',
          note: 'Harassment — policy violation',
          banDurationHours: 24,
        },
        'admin-1',
      );

      expect(res.success).toBe(true);
      expect(fakeDb.createBan).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123', adminId: 'admin-1' }),
        'tx',
      );
      expect(fakeDb.actOnReport).toHaveBeenCalledWith('rep-1', 'BAN', 'admin-1', expect.any(Function));
      // Moderation audit logged.
      expect(fakeDb.recordModerationAction).toHaveBeenCalled();
    });

    it('retracts message when action is RETRACT_MESSAGE', async () => {
      fakeDb.getReportById.mockResolvedValue({
        id: 'rep-2',
        status: 'PENDING',
        message_id: 'msg-456',
        reported_user_id: 'user-789',
      });

      const res = await moderation.actionReport(
        { reportId: 'rep-2', action: 'RETRACT_MESSAGE', note: 'Spam content removed' },
        'admin-1',
      );

      expect(res.success).toBe(true);
      expect(fakeDb.retractMessage).toHaveBeenCalledWith('msg-456', 'admin-1', 'tx');
      expect(fakeDb.actOnReport).toHaveBeenCalledWith('rep-2', 'RETRACT_MESSAGE', 'admin-1', expect.any(Function));
    });

    it('keeps archived DM reports read-only', async () => {
      fakeDb.getReportById.mockResolvedValue({
        id: 'rep-archive',
        status: 'PENDING',
        reported_user_id: 'user-789',
        dm_message_id: 'dm-archive',
        dm_archived: true,
      });
      await expect(
        moderation.actionReport(
          { reportId: 'rep-archive', action: 'RETRACT_MESSAGE', note: 'old message' },
          'admin-1',
        ),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });
      expect(fakeDb.actOnReport).not.toHaveBeenCalled();
    });

    it('does not allow a system-ad report to target a user for banning', async () => {
      fakeDb.getReportById.mockResolvedValue({
        id: 'rep-ad',
        status: 'PENDING',
        reported_user_id: null,
        message_id: 'msg-ad',
      });
      await expect(
        moderation.actionReport(
          { reportId: 'rep-ad', action: 'BAN', note: 'Spam', banDurationHours: 24 },
          'admin-1',
        ),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });
      expect(fakeDb.actOnReport).not.toHaveBeenCalled();
    });

    it('a WARN is a real warning row, one audit row, and a lower-case warn notice (FR-097)', async () => {
      fakeDb.getReportById.mockResolvedValue({ id: 'rep-4', status: 'PENDING', reported_user_id: 'user-5', message_id: null });
      await moderation.actionReport({ reportId: 'rep-4', action: 'WARN', note: 'Please be kind' }, 'admin-1');
      expect(fakeDb.createWarning).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-5', internalReason: 'Please be kind', adminId: 'admin-1' }),
        'tx',
      );
      expect(fakeDb.recordModerationAction).toHaveBeenCalledTimes(1);
      expect(fakeDb.recordModerationAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'REPORT_WARN' }), 'tx');
      expect(fakeDb.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'notice', notice: expect.objectContaining({ action: 'warn' }) }));
    });

    it('the moderator who loses the claim gets 409 and nothing is written or sent (FR-094)', async () => {
      fakeDb.getReportById.mockResolvedValue({ id: 'rep-5', status: 'PENDING', reported_user_id: 'user-6', message_id: null });
      fakeDb.actOnReport.mockResolvedValueOnce({ claimed: false });
      await expect(moderation.actionReport({ reportId: 'rep-5', action: 'BAN', note: 'n', banDurationHours: 1 }, 'admin-2')).rejects.toMatchObject({
        type: ERR.CHAT_REPORT_ALREADY_RESOLVED,
      });
      expect(fakeDb.createBan).not.toHaveBeenCalled();
      expect(fakeDb.notify).not.toHaveBeenCalled();
    });

    it('throws 409 when report is already resolved', async () => {
      fakeDb.getReportById.mockResolvedValue({ id: 'rep-3', status: 'ACTIONED' });

      await expect(
        moderation.actionReport(
          { reportId: 'rep-3', action: 'DISMISS', note: 'Already handled' },
          'admin-1',
        ),
      ).rejects.toMatchObject({ type: ERR.CHAT_REPORT_ALREADY_RESOLVED });
    });
  });

  // ─── Bans ─────────────────────────────────────────────────────────────────

  describe('createBan', () => {
    it('refuses a ban of length 0', async () => {
      await expect(
        moderation.createBan(
          { userId: 'user-1', internalReason: 'Repeated abuse', durationHours: 0 },
          'admin-1',
        ),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });
      expect(fakeDb.createBan).not.toHaveBeenCalled();
    });

    it('creates a permanent ban only when asked explicitly', async () => {
      await moderation.createBan(
        { userId: 'user-1', internalReason: 'Repeated abuse', permanent: true },
        'admin-1',
      );
      expect(fakeDb.createBan.mock.calls[0][0].seconds).toBeNull();
    });

    it('creates a timed ban whose end the database computes', async () => {
      await moderation.createBan(
        { userId: 'user-2', internalReason: '24h ban', durationHours: 24 },
        'admin-1',
      );
      expect(fakeDb.createBan.mock.calls[0][0].seconds).toBe(24 * 3600);
    });

    it('refuses a ban longer than maxBanHours', async () => {
      await expect(
        moderation.createBan(
          { userId: 'user-2', internalReason: 'long', durationHours: 721 },
          'admin-1',
        ),
      ).rejects.toMatchObject({ type: ERR.VALIDATION_FAILED });
    });
  });

  // ─── Broadcast ────────────────────────────────────────────────────────────

  describe('sendBroadcast', () => {
    it('dispatches to a target room', async () => {
      fakeDb.getRoomById.mockResolvedValue({ id: 'room-1' });

      const res = await service.sendBroadcast(
        {
          roomId: 'room-1',
          title: 'Maintenance',
          content: 'Down 10min',
          type: 'ADMIN_ALERT',
          priority: 'NORMAL',
        },
        'admin-1',
      );

      expect(res.success).toBe(true);
      expect(res.dispatchedCount).toBe(1);
      expect(fakeDb.createBroadcast).toHaveBeenCalledWith(expect.objectContaining({ roomIds: ['room-1'] }));
      // The live notice carries only the broadcast id, never the list of messages (FR-058).
      expect(fakeDb.notify).toHaveBeenCalledWith({ kind: 'alert', broadcastId: expect.any(String) });
    });

    it('dispatches to all active rooms when roomId is omitted', async () => {
      fakeDb.getRooms.mockResolvedValue([
        { id: 'r1', deletedAt: null, status: 'ACTIVE' },
        { id: 'r2', deletedAt: null, status: 'ACTIVE' },
        { id: 'r3', deletedAt: null, status: 'DISABLED' }, // Disabled rooms skipped.
      ]);

      const res = await service.sendBroadcast(
        { title: 'Hello', content: 'World', type: 'SYSTEM_ALERT', priority: 'NORMAL' },
        'admin-1',
      );

      expect(res.dispatchedCount).toBe(2); // Disabled room excluded.
      expect(fakeDb.createBroadcast).toHaveBeenCalledTimes(1);
      expect(fakeDb.createBroadcast).toHaveBeenCalledWith(expect.objectContaining({ roomIds: ['r1', 'r2'] }));
    });
  });

  // ─── Skins ───────────────────────────────────────────────────────────────

  describe('deactivateSkin', () => {
    it('deactivates a skin, never deletes it', async () => {
      const res = await skins.deactivateSkin('skin-1', 'admin-1');
      expect(res.success).toBe(true);
      expect(fakeDb.deactivateSkin).toHaveBeenCalledWith('skin-1');
      // DB function is deactivateSkin not deleteSkin.
    });

    it('throws 404 when skin is not found or already inactive', async () => {
      fakeDb.deactivateSkin.mockResolvedValue(false);

      await expect(skins.deactivateSkin('missing-skin', 'admin-1')).rejects.toMatchObject({
        type: ERR.CHAT_COSMETIC_NOT_FOUND,
      });
    });
  });

  // ─── Retract ──────────────────────────────────────────────────────────────

  describe('retractMessage', () => {
    it('retracts a message and notifies user BE', async () => {
      const res = await service.retractMessage('msg-1', 'admin-1', 'Spam removed by admin');

      expect(res.success).toBe(true);
      expect(fakeDb.retractMessage).toHaveBeenCalledWith('msg-1', 'admin-1');
      // Retract notification.
      expect(fakeDb.notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'retract', messageId: 'msg-1' }),
      );
      // Audit logged.
      expect(fakeDb.recordModerationAction).toHaveBeenCalled();
    });

    it('throws 404 when message is already retracted', async () => {
      fakeDb.retractMessage.mockResolvedValue(null);

      await expect(service.retractMessage('gone', 'admin-1', 'note')).rejects.toMatchObject({
        type: ERR.NOT_FOUND,
      });
    });
  });
});
