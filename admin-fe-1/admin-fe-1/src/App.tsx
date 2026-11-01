import React, { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { OverviewView } from './components/views/OverviewView';
import { RoomsView } from './components/views/RoomsView';
import { RulesView } from './components/views/RulesView';
import { ReportsView } from './components/views/ReportsView';
import { BansView } from './components/views/BansView';
import { CosmeticsView } from './components/views/CosmeticsView';
import { BroadcastView } from './components/views/BroadcastView';
import { ChatHistoryView } from './components/views/ChatHistoryView';
import { ModerationView } from './components/views/ModerationView';
import { MediaView } from './components/views/MediaView';
import { RegionsView } from './components/views/RegionsView';
import { StaffRolesView } from './components/views/StaffRolesView';
import { SettingsView } from './components/views/SettingsView';
import { LoginView } from './components/views/LoginView';
import { PenaltiesView } from './components/views/PenaltiesView';
import { MoneyView } from './components/views/MoneyView';
import { DmOversightView } from './components/views/DmOversightView';
import { SupportView } from './components/views/SupportView';
import { FeatureSettingsView } from './components/views/FeatureSettingsView';
import { RainView } from './components/views/RainView';
import { CreateRoomModal } from './components/modals/CreateRoomModal';
import { EditRoomModal } from './components/modals/EditRoomModal';
import { CreateCosmeticModal } from './components/modals/CreateCosmeticModal';
import { IssueBanModal } from './components/modals/IssueBanModal';
import { ConfirmDialog } from './components/modals/ConfirmDialog';
import { AdminAPI } from './services/api';
import { IconCheck, IconAlert } from './components/Icons';
import {
  AdminRoom,
  PlatformStats,
  ChatReport,
  UserBan,
  ChatCosmetic,
  BroadcastPayload,
  RoomContentControls,
  RoomType,
  AdminUser,
} from './types';

export const App: React.FC = () => {
  const [admin, setAdmin] = useState<AdminUser | null>(() => AdminAPI.getCurrentAdmin());
  const [currentTab, setCurrentTab] = useState('overview');
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [reports, setReports] = useState<ChatReport[]>([]);
  const [bans, setBans] = useState<UserBan[]>([]);
  const [cosmetics, setCosmetics] = useState<ChatCosmetic[]>([]);
  const [selectedRuleRoomId, setSelectedRuleRoomId] = useState('');

  // Modals & In-Place Overlays
  const [isCreateRoomOpen, setIsCreateRoomOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<AdminRoom | null>(null);
  const [activeChatRoom, setActiveChatRoom] = useState<AdminRoom | null>(null);
  const [banTargetUser, setBanTargetUser] = useState<{ userId: string; username: string } | null>(null);
  const [isCreateCosmeticOpen, setIsCreateCosmeticOpen] = useState(false);
  const [isIssueBanOpen, setIsIssueBanOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);

  const requestConfirm = (message: string, onConfirm: () => void) => {
    setConfirmDialog({ message, onConfirm });
  };

  // Toast
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'danger' } | null>(null);

  const showToast = (message: string, type: 'success' | 'danger' = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 3500);
  };

  const refreshAllData = async () => {
    try {
      const [statsData, roomsData, reportsData, bansData, cosmData] = await Promise.all([
        AdminAPI.getStats(),
        AdminAPI.getRooms(),
        AdminAPI.getReports(),
        AdminAPI.getBans(),
        AdminAPI.getCosmetics(),
      ]);
      setStats(statsData);
      setRooms(roomsData);
      setReports(reportsData);
      setBans(bansData);
      setCosmetics(cosmData);

      if (roomsData.length > 0 && !selectedRuleRoomId) {
        setSelectedRuleRoomId(roomsData[0]!.id);
      }
    } catch {
      showToast('Could not reach backend API — using cached state', 'danger');
    }
  };

  useEffect(() => {
    if (!admin) return;
    refreshAllData();
    const timer = window.setInterval(() => refreshAllData(), 15_000);
    return () => window.clearInterval(timer);
  }, [admin]);

  const handleLogout = async () => {
    await AdminAPI.logout();
    setAdmin(null);
    showToast('Admin session terminated successfully', 'success');
  };

  // Room Content Toggle Handler (FSD 3.2.1)
  const handleToggleControl = async (roomId: string, controlKey: keyof RoomContentControls, value: boolean) => {
    try {
      const res = await AdminAPI.updateRoom({ roomId, contentControls: { [controlKey]: value } });
      if (res.success) {
        showToast(`Updated ${controlKey} to ${value ? 'Allowed' : 'Restricted'}`);
        setRooms(
          rooms.map((r) =>
            r.id === roomId ? { ...r, contentControls: { ...r.contentControls, [controlKey]: value } } : r,
          ),
        );
      } else {
        showToast(res.error || 'Failed to update control', 'danger');
      }
    } catch {
      showToast('Failed to connect to admin backend', 'danger');
    }
  };

  // Room creation
  const handleCreateRoom = async (data: any) => {
    try {
      const res = await AdminAPI.createRoom(data);
      if (res.success) {
        showToast(`Room "${data.name}" created successfully!`);
        setIsCreateRoomOpen(false);
        refreshAllData();
      } else {
        showToast(res.error || 'Failed to create room', 'danger');
      }
    } catch {
      showToast('Network error creating room', 'danger');
    }
  };

  // Room update (Edit all settings & rules in-place)
  const handleUpdateRoom = async (data: any) => {
    try {
      const res = await AdminAPI.updateRoom(data);
      if (res.success) {
        showToast(
          res.scheduled
            ? `Room change scheduled for ${new Date(res.effectiveAt).toLocaleString()}`
            : `Room settings saved successfully!`,
        );
        setEditingRoom(null);
        refreshAllData();
      } else {
        showToast(res.error || 'Failed to update room', 'danger');
      }
    } catch {
      showToast('Network error updating room', 'danger');
    }
  };

  // Room deletion
  const handleDeleteRoom = (roomId: string) => {
    requestConfirm('Are you sure you want to deactivate this chat room?', async () => {
      try {
        const res = await AdminAPI.deleteRoom(roomId);
        if (res.success) {
          showToast('Room deactivated');
          refreshAllData();
        }
      } catch {
        showToast('Failed to deactivate room', 'danger');
      }
    });
  };

  // Moderation action
  const handleActionReport = async (reportId: string, action: 'DISMISS' | 'RETRACT_MESSAGE' | 'WARN' | 'BAN') => {
    const reason = window.prompt(`Reason note for ${action} (required - CH-090):`, 'Processed by moderation administrator');
    if (!reason || !reason.trim()) return;
    try {
      const res = await AdminAPI.actionReport(reportId, action, reason.trim());
      if (res.success) {
        showToast(`Report action '${action}' recorded!`);
        refreshAllData();
      } else {
        showToast(res.error || 'Failed to action report', 'danger');
      }
    } catch {
      showToast('Failed to action report', 'danger');
    }
  };

  // User ban issue
  const handleIssueBan = async (data: {
    userId: string;
    username: string;
    durationHours?: number;
    permanent?: boolean;
    reason: string;
    note: string;
  }) => {
    try {
      const res = await AdminAPI.createBan(data);
      if (res.success) {
        showToast(`User ${data.username} ban enforced`);
        setIsIssueBanOpen(false);
        refreshAllData();
      } else {
        showToast(res.error || 'Failed to issue ban', 'danger');
      }
    } catch {
      showToast('Failed to issue ban', 'danger');
    }
  };

  // User unban
  const handleUnbanUser = (banId: string, note?: string) => {
    requestConfirm('Unban this user immediately?', async () => {
      try {
        const res = await AdminAPI.unbanUser(banId, note);
        if (res.success) {
          showToast('User unbanned');
          refreshAllData();
        } else {
          showToast(res.error || 'Failed to unban user', 'danger');
        }
      } catch {
        showToast('Failed to unban user', 'danger');
      }
    });
  };

  // Cosmetic create
  const handleCreateCosmetic = async (data: Partial<ChatCosmetic>) => {
    try {
      const res = await AdminAPI.createCosmetic(data);
      if (res.success) {
        showToast(`Chat Skin "${data.name}" created!`);
        setIsCreateCosmeticOpen(false);
        refreshAllData();
      }
    } catch {
      showToast('Failed to create skin', 'danger');
    }
  };

  // Cosmetic delete
  const handleDeleteCosmetic = (id: string) => {
    requestConfirm('Deactivate this skin? Messages that use it keep showing it; it can no longer be chosen.', () => deleteCosmeticConfirmed(id));
  };

  const deleteCosmeticConfirmed = async (id: string) => {
    try {
      const res = await AdminAPI.deleteCosmetic(id);
      if (res.success) {
        showToast('Skin deactivated');
        refreshAllData();
      }
    } catch {
      showToast('Failed to delete cosmetic', 'danger');
    }
  };

  // Live Broadcast
  const handleSendBroadcast = async (payload: BroadcastPayload) => {
    try {
      const res = await AdminAPI.sendBroadcast(payload);
      if (res.success) {
        showToast('Announcement broadcast sent to chat!');
      } else {
        showToast(res.error || 'Broadcast failed', 'danger');
      }
    } catch {
      showToast('Network error sending broadcast', 'danger');
    }
  };

  // If unauthenticated, show the Login View
  if (!admin) {
    return (
      <>
        <LoginView
          onLoginSuccess={(user) => {
            setAdmin(user);
            showToast(`Welcome, ${user.name}`);
          }}
        />
        {toast && (
          <div className="toast-container">
            <div className={`toast toast-${toast.type}`}>
              <span className="toast-icon">
                {toast.type === 'success' ? <IconCheck size={16} /> : <IconAlert size={16} />}
              </span>
              <span>{toast.message}</span>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="app-container">
      <Sidebar
        currentTab={currentTab}
        onTabChange={(tab) => {
          setActiveChatRoom(null);
          setCurrentTab(tab);
        }}
        pendingReportsCount={stats?.pendingReports ?? 0}
        adminUser={admin}
        onLogout={handleLogout}
      />

      <main className="main-content">
        <Topbar
          onOpenCreateRoom={() => setIsCreateRoomOpen(true)}
          adminUser={admin}
          onLogout={handleLogout}
        />

        <div className="page-container">
          {currentTab === 'overview' && (
            <OverviewView
              stats={stats}
              rooms={rooms}
              onNavigateTab={setCurrentTab}
            />
          )}

          {currentTab === 'rooms' && (
            activeChatRoom ? (
              <ChatHistoryView
                rooms={rooms}
                initialRoomId={activeChatRoom.id}
                onClose={() => setActiveChatRoom(null)}
                onOpenBanModal={(user) => {
                  setBanTargetUser(user);
                  setIsIssueBanOpen(true);
                }}
                onShowToast={showToast}
              />
            ) : (
              <RoomsView
                rooms={rooms}
                onToggleControl={handleToggleControl}
                onOpenCreateRoom={() => setIsCreateRoomOpen(true)}
                onEditRoom={(room) => setEditingRoom(room)}
                onOpenChat={(room) => setActiveChatRoom(room)}
                onEditRules={(roomId) => {
                  const target = rooms.find((r) => r.id === roomId);
                  if (target) {
                    setEditingRoom(target);
                  } else {
                    setSelectedRuleRoomId(roomId);
                    setCurrentTab('rules');
                  }
                }}
                onDeleteRoom={handleDeleteRoom}
              />
            )
          )}

          {currentTab === 'rules' && (
            <RulesView
              rooms={rooms}
              selectedRoomId={selectedRuleRoomId}
              onRoomSelect={setSelectedRuleRoomId}
              onShowToast={showToast}
            />
          )}

          {currentTab === 'reports' && (
            <ReportsView
              reports={reports}
              onActionReport={handleActionReport}
              onFilterChange={(status) => AdminAPI.getReports(status).then(setReports)}
            />
          )}

          {currentTab === 'bans' && (
            <BansView
              bans={bans}
              onOpenIssueBan={() => {
                setBanTargetUser(null);
                setIsIssueBanOpen(true);
              }}
              onUnbanUser={handleUnbanUser}
              onBansChanged={refreshAllData}
              onShowToast={showToast}
            />
          )}

          {currentTab === 'cosmetics' && (
            <CosmeticsView
              cosmetics={cosmetics}
              onOpenCreateCosmetic={() => setIsCreateCosmeticOpen(true)}
              onDeleteCosmetic={handleDeleteCosmetic}
              onActivateCosmetic={async (id) => {
                const res = await AdminAPI.activateCosmetic(id);
                if (res.success) {
                  showToast('Skin activated');
                  refreshAllData();
                } else {
                  showToast(res.error || 'Could not activate the skin', 'danger');
                }
              }}
            />
          )}

          {currentTab === 'broadcast' && (
            <BroadcastView onSendBroadcast={handleSendBroadcast} rooms={rooms} />
          )}

          {currentTab === 'media' && (
            <MediaView onShowToast={showToast} />
          )}

          {currentTab === 'regions' && (
            <RegionsView onShowToast={showToast} />
          )}

          {currentTab === 'staff' && (
            <StaffRolesView onShowToast={showToast} />
          )}

          {currentTab === 'settings' && (
            <SettingsView onShowToast={showToast} />
          )}

          {currentTab === 'moderation' && (
            <ModerationView
              rooms={rooms}
              onShowToast={showToast}
              onNavigateTab={setCurrentTab}
            />
          )}

          {currentTab === 'penalties' && <PenaltiesView rooms={rooms} onShowToast={showToast} />}

          {currentTab === 'money' && <MoneyView rooms={rooms} onShowToast={showToast} />}

          {currentTab === 'rain' && <RainView rooms={rooms} onShowToast={showToast} />}

          {currentTab === 'dms' && <DmOversightView onShowToast={showToast} />}

          {currentTab === 'support' && <SupportView onShowToast={showToast} />}

          {currentTab === 'features' && <FeatureSettingsView rooms={rooms} onShowToast={showToast} />}
        </div>
      </main>

      {/* MODALS */}
      <CreateRoomModal
        key={isCreateRoomOpen ? 'create-open' : 'create-closed'}
        isOpen={isCreateRoomOpen}
        onClose={() => setIsCreateRoomOpen(false)}
        onCreate={handleCreateRoom}
      />

      <EditRoomModal
        isOpen={!!editingRoom}
        room={editingRoom}
        onClose={() => setEditingRoom(null)}
        onSave={handleUpdateRoom}
      />

      <CreateCosmeticModal
        isOpen={isCreateCosmeticOpen}
        onClose={() => setIsCreateCosmeticOpen(false)}
        onCreate={handleCreateCosmetic}
      />

      <IssueBanModal
        isOpen={isIssueBanOpen}
        targetUser={banTargetUser}
        onClose={() => {
          setIsIssueBanOpen(false);
          setBanTargetUser(null);
        }}
        onIssueBan={handleIssueBan}
      />

      <ConfirmDialog
        isOpen={!!confirmDialog}
        message={confirmDialog?.message || ''}
        onCancel={() => setConfirmDialog(null)}
        onConfirm={() => {
          confirmDialog?.onConfirm();
          setConfirmDialog(null);
        }}
      />

      {/* TOAST CONTAINER */}
      {toast && (
        <div className="toast-container">
          <div className={`toast toast-${toast.type}`}>
            <span className="toast-icon">
              {toast.type === 'success' ? <IconCheck size={16} /> : <IconAlert size={16} />}
            </span>
            <span>{toast.message}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
