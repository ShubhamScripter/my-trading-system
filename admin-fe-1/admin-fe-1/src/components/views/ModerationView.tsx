import React, { useState, useEffect } from 'react';
import {
  AdminRoom,
  ModerationSettings,
  ModeratorRole,
  UserGroupRestriction,
  BotPersonaConfig,
  BotLogEntry,
  StaffPermissionSetting,
} from '../../types';
import { AdminAPI } from '../../services/api';
import { ChatWideRules } from './moderation/ChatWideRules';
import {
  IconCheck,
  IconPlus,
  IconShield,
  IconSliders,
  IconFilter,
  IconTerminal,
  IconUsers,
  IconLock,
  IconBot,
} from '../Icons';

interface ModerationViewProps {
  rooms: AdminRoom[];
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
  /** Opens another panel page (Feature Settings, Penalties). */
  onNavigateTab?: (tab: string) => void;
}

const ALL_COMMANDS = ['/rain', '/gift', '/send', '/pm', '/dm', '/ad', '/mute', '/unmute', '/block', '/unblock'];

interface PermissionDef {
  id: number;
  name: string;
  category: string;
  description: string;
  defaultAct: boolean;
  defaultReport: boolean;
  scopeType?: 'days' | 'duration' | 'level' | 'rooms';
}

const PERMISSIONS_35: PermissionDef[] = [
  { id: 1, name: 'Warn User', category: 'User Moderation', description: 'Issue official warning to a user', defaultAct: true, defaultReport: true },
  { id: 2, name: 'Ban User from Chat', category: 'User Moderation', description: 'Ban user with maximum ban duration cap', defaultAct: true, defaultReport: true, scopeType: 'duration' },
  { id: 3, name: 'Give / Change Roles', category: 'Role Management', description: 'Only for roles strictly below their own role', defaultAct: false, defaultReport: true },
  { id: 4, name: 'Change Room Access', category: 'Room Controls', description: 'Add or remove specific users from specific rooms', defaultAct: true, defaultReport: true, scopeType: 'rooms' },
  { id: 5, name: 'Restrict User Commands', category: 'Command Controls', description: 'Select which commands a specific user cannot use', defaultAct: true, defaultReport: true },
  { id: 6, name: 'Restrict User Emojis', category: 'Content Controls', description: 'Prevent user from sending emojis in chat', defaultAct: true, defaultReport: true },
  { id: 7, name: 'Restrict User GIFs', category: 'Content Controls', description: 'Prevent user from sending Tenor/Giphy GIFs', defaultAct: true, defaultReport: true },
  { id: 8, name: 'Prevent Advertising', category: 'Advertising', description: 'Disallow user from using the /ad sponsored system', defaultAct: true, defaultReport: true },
  { id: 9, name: 'Pin Messages in Rooms', category: 'Message Controls', description: 'Pin notices or announcements in selected rooms', defaultAct: true, defaultReport: true, scopeType: 'rooms' },
  { id: 10, name: 'Disable / Enable Rooms', category: 'Room Controls', description: 'Freeze or unfreeze entire chat rooms', defaultAct: false, defaultReport: true },
  { id: 11, name: 'Restrict Raining Ability', category: 'Rain Controls', description: 'Disable user from creating or receiving rains', defaultAct: true, defaultReport: true },
  { id: 12, name: 'Restrict Receiving Amounts', category: 'Transaction Controls', description: 'Auto-applied if user transfer is restricted', defaultAct: true, defaultReport: true },
  { id: 13, name: 'Disable Overall Rains', category: 'Rain Controls', description: 'Neither user nor system rainpool can rain to/from user', defaultAct: false, defaultReport: true },
  { id: 14, name: 'Disable Sending Money', category: 'Transaction Controls', description: 'Toggle user-to-user crypto gifting in chat', defaultAct: false, defaultReport: true },
  { id: 15, name: 'Disable Specific Commands (User)', category: 'Command Controls', description: 'Blacklist commands for a single user', defaultAct: true, defaultReport: true },
  { id: 16, name: 'Disable Specific Commands (Global)', category: 'Command Controls', description: 'Disable commands globally across all rooms', defaultAct: false, defaultReport: true },
  { id: 17, name: 'Disable All Commands', category: 'Command Controls', description: 'Turn off command parser completely', defaultAct: false, defaultReport: true },
  { id: 18, name: 'See Retracted Messages', category: 'Message Controls', description: 'View original content of retracted messages', defaultAct: true, defaultReport: false },
  { id: 19, name: 'Delete / Retract Messages', category: 'Message Controls', description: 'Retract inappropriate messages sent by other users', defaultAct: true, defaultReport: true },
  { id: 20, name: 'See User Stats (Private)', category: 'Auditing', description: 'Inspect hidden stats, VIP tiers, wager history', defaultAct: true, defaultReport: false },
  { id: 21, name: 'Join Staff Chat Room', category: 'Room Controls', description: 'Access private staff-only coordination room', defaultAct: true, defaultReport: false },
  { id: 22, name: 'See Reported Messages', category: 'Reports', description: 'View queue of user complaints and flagged items', defaultAct: true, defaultReport: false },
  { id: 23, name: 'Take Action on Reports', category: 'Reports', description: 'Dismiss, warn, or ban directly from report queue', defaultAct: true, defaultReport: true },
  { id: 24, name: 'Check Bot Log of User', category: 'Auditing', description: 'Audit automated bot interactions with a user', defaultAct: true, defaultReport: false },
  { id: 25, name: 'See Previous Chat History', category: 'Auditing', description: 'Search and read chat logs (capped at X days)', defaultAct: true, defaultReport: false, scopeType: 'days' },
  { id: 26, name: 'Recent Messages of User', category: 'Auditing', description: 'Filter history by specific user (capped at X days)', defaultAct: true, defaultReport: false, scopeType: 'days' },
  { id: 27, name: 'See All Tags of User', category: 'Auditing', description: 'Inspect mentions and badges assigned to user', defaultAct: true, defaultReport: false, scopeType: 'days' },
  { id: 28, name: 'Restrict DMs to Follow-backs', category: 'Content Controls', description: 'User can only DM users who follow them back', defaultAct: true, defaultReport: true },
  { id: 29, name: 'Edit Chat Rules Text', category: 'Room Controls', description: 'Modify the room guidelines displayed in sidebar', defaultAct: false, defaultReport: true, scopeType: 'rooms' },
  { id: 30, name: 'Change Other Staff Penalties', category: 'Role Management', description: 'Scope: same level, level below, or same+below', defaultAct: false, defaultReport: true, scopeType: 'level' },
  { id: 31, name: 'See Penalised Users List', category: 'Auditing', description: 'View active chat penalties and duration remaining', defaultAct: true, defaultReport: false },
  { id: 32, name: 'Allow / Restrict Pictures', category: 'Content Controls', description: 'Control image uploads and attachments', defaultAct: true, defaultReport: true },
  { id: 33, name: 'Allow / Restrict Videos', category: 'Content Controls', description: 'Control video uploads and embedded clips', defaultAct: true, defaultReport: true },
  { id: 34, name: 'View Cross-Feature History', category: 'Auditing', description: 'Cross-feature history access capped at X days', defaultAct: true, defaultReport: false, scopeType: 'days' },
  { id: 35, name: 'Assign Roles to Users', category: 'Role Management', description: 'Promote or demote members to moderation roles', defaultAct: false, defaultReport: true },
];

const DEFAULT_STAFF_ROLES: ModeratorRole[] = [
  {
    id: 'role-head-mod',
    name: 'Head Moderator',
    level: 3,
    groupPrivilege: true,
    permissions: Object.fromEntries(
      PERMISSIONS_35.map((p) => [p.id, { act: true, report: true, scope: 'ALL' }])
    ),
  },
  {
    id: 'role-senior-mod',
    name: 'Senior Moderator',
    level: 2,
    groupPrivilege: true,
    permissions: Object.fromEntries(
      PERMISSIONS_35.map((p) => [
        p.id,
        {
          act: ![10, 14, 16, 17, 30].includes(p.id),
          report: true,
          scope: p.scopeType === 'days' ? '30_DAYS' : p.scopeType === 'duration' ? '7_DAYS' : 'ALL',
        },
      ])
    ),
  },
  {
    id: 'role-chat-mod',
    name: 'Chat Moderator',
    level: 1,
    groupPrivilege: false,
    permissions: Object.fromEntries(
      PERMISSIONS_35.map((p) => [
        p.id,
        {
          act: [1, 5, 6, 7, 8, 9, 11, 15, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33].includes(p.id),
          report: true,
          scope: p.scopeType === 'days' ? '7_DAYS' : p.scopeType === 'duration' ? '24_HOURS' : 'ASSIGNED_ROOMS',
        },
      ])
    ),
  },
];

const DEFAULT_BOT_CONFIG: BotPersonaConfig = {
  botName: 'OREBiT Assistant',
  botUserId: 'system-bot-01',
  botAvatar: 'BOT',
  isActive: true,
  welcomeTemplate: 'Welcome to {room}, @{user}! Please abide by our chat community guidelines.',
};

/** Maps a recorded chat action (GET /social/chat/actions) to a log row. */
function toLogEntry(a: any): BotLogEntry {
  const action = String(a.action || '');
  const type: BotLogEntry['type'] =
    a.actorType === 'SYSTEM' ? 'AUTO_MOD' : action === 'BROADCAST' ? 'ANNOUNCEMENT' : 'SECURITY';
  const who = a.targetUsername ? ` @${a.targetUsername}` : '';
  return {
    id: a.id,
    event: `${a.actorName}: ${action.replace(/[._]/g, ' ').toLowerCase()}${who}`,
    type,
    roomName: a.targetRoomName || '—',
    details: a.note || (a.newValue ? JSON.stringify(a.newValue).slice(0, 160) : ''),
    createdAt: a.createdAt,
  } as BotLogEntry;
}

const defaultSettings = (roomId: string): ModerationSettings => ({
  roomId,
  linkPolicy: 'NO_LINKS',
  bannedWords: [],
  globalDisabledCommands: [],
  allCommandsDisabled: false,
  staffRoles: DEFAULT_STAFF_ROLES,
  userRestrictions: [
    {
      id: 'res-1',
      targetType: 'USER',
      targetValue: 'spammer99',
      restriction: 'MUTE',
      reason: 'Excessive spamming in global chat',
      durationHours: 24,
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
    },
    {
      id: 'res-2',
      targetType: 'VIP',
      targetValue: 'VIP Tier 0',
      restriction: 'RESTRICT_ADS',
      reason: 'Ad posting reserved for verified tiers',
      durationHours: 168,
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    },
  ],
  botConfig: DEFAULT_BOT_CONFIG,
});

export const ModerationView: React.FC<ModerationViewProps> = ({ rooms, onShowToast, onNavigateTab }) => {
  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [settings, setSettings] = useState<ModerationSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newWord, setNewWord] = useState('');
  const [activeTab, setActiveTab] = useState<
    'spam' | 'sequence' | 'words' | 'commands' | 'roles' | 'restrictions' | 'bot'
  >('spam');

  // Staff Roles Tab state
  const [selectedRoleId, setSelectedRoleId] = useState<string>('role-head-mod');
  const [permCategoryFilter, setPermCategoryFilter] = useState<string>('ALL');
  const [permSearch, setPermSearch] = useState<string>('');

  // Restrictions Tab state
  const [newTargetType, setNewTargetType] = useState<'USER' | 'PREMIUM' | 'KYC' | 'LEVEL'>('USER');
  const [newTargetValue, setNewTargetValue] = useState('');
  const [newRestriction, setNewRestriction] = useState<
    | 'MUTE'
    | 'RESTRICT_MEDIA'
    | 'RESTRICT_EMOJI'
    | 'RESTRICT_GIF'
    | 'RESTRICT_COMMANDS'
    | 'RESTRICT_ADS'
    | 'RESTRICT_DM'
    | 'RESTRICT_GIFTS'
    | 'RESTRICT_RECEIVE_GIFTS'
    | 'RESTRICT_RAIN'
    | 'RESTRICT_RAIN_RECEIVE'
    | 'RESTRICT_PIN'
    | 'RESTRICT_DELETE_MESSAGES'
    | 'RESTRICT_HISTORY'
    | 'RESTRICT_STAFF_ROOM'
    | 'RESTRICT_IMAGES'
    | 'RESTRICT_VIDEOS'
  >('MUTE');
  const [newReason, setNewReason] = useState('');
  const [newDurationHours, setNewDurationHours] = useState(24);

  // Bot Logs state
  // The real moderation log: admin, staff and auto-moderation actions (CH-018, A-19).
  const [botLogs, setBotLogs] = useState<BotLogEntry[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const actions = await AdminAPI.getModerationActions();
      if (alive) setBotLogs(actions.map(toLogEntry));
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  const [botLogFilter, setBotLogFilter] = useState<'ALL' | 'AUTO_MOD' | 'RAIN_EVENT' | 'ANNOUNCEMENT' | 'SECURITY'>('ALL');

  useEffect(() => {
    if (rooms.length > 0 && !selectedRoomId) {
      setSelectedRoomId(rooms[0]!.id);
    }
  }, [rooms]);

  useEffect(() => {
    if (selectedRoomId) {
      loadSettings(selectedRoomId);
    }
  }, [selectedRoomId]);

  const loadSettings = async (roomId: string) => {
    setLoading(true);
    try {
      const data = await AdminAPI.getModerationSettings(roomId);
      const s = data || defaultSettings(roomId);
      // Ensure defaults if fields are missing
      if (!s.staffRoles || s.staffRoles.length === 0) s.staffRoles = DEFAULT_STAFF_ROLES;
      if (!s.userRestrictions) s.userRestrictions = [];
      if (!s.botConfig) s.botConfig = DEFAULT_BOT_CONFIG;
      setSettings(s);
    } catch {
      setSettings(defaultSettings(roomId));
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await AdminAPI.saveModerationSettings(selectedRoomId, settings);
      if (res?.success !== false) {
        onShowToast('Moderation settings saved successfully!');
      } else {
        onShowToast('Failed to save', 'danger');
      }
    } catch {
      onShowToast('Network error', 'danger');
    } finally {
      setSaving(false);
    }
  };

  const addWord = () => {
    const w = newWord.trim().toLowerCase();
    if (!w || !settings) return;
    if (!settings.bannedWords.includes(w)) {
      setSettings({ ...settings, bannedWords: [...settings.bannedWords, w] });
    }
    setNewWord('');
  };

  const removeWord = (w: string) => {
    if (!settings) return;
    setSettings({ ...settings, bannedWords: settings.bannedWords.filter((x) => x !== w) });
  };

  const toggleCommand = (cmd: string) => {
    if (!settings) return;
    const current = settings.globalDisabledCommands;
    setSettings({
      ...settings,
      globalDisabledCommands: current.includes(cmd)
        ? current.filter((c) => c !== cmd)
        : [...current, cmd],
    });
  };

  // Staff Roles handlers
  const currentRole = settings?.staffRoles?.find((r) => r.id === selectedRoleId) ?? settings?.staffRoles?.[0];

  const updatePermissionSetting = (
    roleId: string,
    permId: number,
    field: 'act' | 'report' | 'scope',
    value: any
  ) => {
    if (!settings || !settings.staffRoles) return;
    const updatedRoles = settings.staffRoles.map((role) => {
      if (role.id !== roleId) return role;
      const currentPerm = role.permissions[permId] ?? { act: false, report: false };
      return {
        ...role,
        permissions: {
          ...role.permissions,
          [permId]: { ...currentPerm, [field]: value },
        },
      };
    });
    setSettings({ ...settings, staffRoles: updatedRoles });
  };

  const toggleGroupPrivilege = (roleId: string) => {
    if (!settings || !settings.staffRoles) return;
    const updatedRoles = settings.staffRoles.map((role) =>
      role.id === roleId ? { ...role, groupPrivilege: !role.groupPrivilege } : role
    );
    setSettings({ ...settings, staffRoles: updatedRoles });
  };

  const grantAllForRole = (roleId: string, type: 'act' | 'report', state: boolean) => {
    if (!settings || !settings.staffRoles) return;
    const updatedRoles = settings.staffRoles.map((role) => {
      if (role.id !== roleId) return role;
      const updatedPerms: Record<number, StaffPermissionSetting> = {};
      PERMISSIONS_35.forEach((p) => {
        const cur = role.permissions[p.id] ?? { act: false, report: false };
        updatedPerms[p.id] = { ...cur, [type]: state };
      });
      return { ...role, permissions: updatedPerms };
    });
    setSettings({ ...settings, staffRoles: updatedRoles });
  };

  // Restrictions handlers
  const addRestriction = () => {
    if (!settings || !newTargetValue.trim() || !newReason.trim()) {
      onShowToast('Please specify target identifier and reason', 'danger');
      return;
    }
    const newRes: UserGroupRestriction = {
      id: `res-${Date.now()}`,
      targetType: newTargetType,
      targetValue: newTargetValue.trim(),
      restriction: newRestriction,
      reason: newReason.trim(),
      durationHours: newDurationHours,
      createdAt: new Date().toISOString(),
    };
    setSettings({
      ...settings,
      userRestrictions: [newRes, ...(settings.userRestrictions ?? [])],
    });
    setNewTargetValue('');
    setNewReason('');
    onShowToast(
      `Restriction added for ${newTargetType} "${newRes.targetValue}" — click "Save Moderation Settings" to apply it`,
    );
  };

  const removeRestriction = (id: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      userRestrictions: (settings.userRestrictions ?? []).filter((r) => r.id !== id),
    });
    onShowToast('Restriction removed — click "Save Moderation Settings" to apply it');
  };

  // Bot Config handler
  const updateBotConfig = (key: keyof BotPersonaConfig, value: any) => {
    if (!settings || !settings.botConfig) return;
    setSettings({
      ...settings,
      botConfig: { ...settings.botConfig, [key]: value },
    });
  };

  const selectedRoom = rooms.find((r) => r.id === selectedRoomId);

  const tabStyle = (t: string) => ({
    padding: '8px 14px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    border: 'none',
    borderRadius: '8px',
    background: activeTab === t ? 'var(--primary)' : 'rgba(255,255,255,0.03)',
    color: activeTab === t ? '#fff' : 'var(--text-secondary)',
    transition: 'all 0.15s',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    whiteSpace: 'nowrap' as const,
  });

  const categories = Array.from(new Set(PERMISSIONS_35.map((p) => p.category)));

  const filteredPermissions = PERMISSIONS_35.filter((p) => {
    const matchesCat = permCategoryFilter === 'ALL' || p.category === permCategoryFilter;
    const matchesSearch =
      !permSearch ||
      p.name.toLowerCase().includes(permSearch.toLowerCase()) ||
      p.description.toLowerCase().includes(permSearch.toLowerCase());
    return matchesCat && matchesSearch;
  });

  const filteredBotLogs = botLogs.filter((l) =>
    botLogFilter === 'ALL' ? true : l.type === botLogFilter
  );

  return (
    <section className="tab-view">
      {/* Page Header */}
      <div className="card-section" style={{ marginBottom: '16px' }}>
        <div className="card-header-row">
          <div>
            <h3>Moderation &amp; Safety Controls (FSD Module 4)</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Per-room auto-moderation, spam protection, banned words, links and room restrictions. Staff permissions and the chat bot are in Feature Settings.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Room:</label>
            <select
              id="mod-room-select"
              className="form-control"
              style={{ minWidth: '220px' }}
              value={selectedRoomId}
              onChange={(e) => setSelectedRoomId(e.target.value)}
            >
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.type})
                </option>
              ))}
            </select>
          </div>
        </div>

        {selectedRoom && (
          <div style={{ display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap' }}>
            {[
              { label: 'Link Policy', val: settings?.linkPolicy ?? selectedRoom.linksPolicy ?? 'NO_LINKS', color: '#6366f1' },
              { label: 'Banned Words', val: `${settings?.bannedWords?.length ?? 0} words`, color: '#f59e0b' },
              { label: 'Staff Roles', val: `${settings?.staffRoles?.length ?? 3} roles`, color: '#10b981' },
              { label: 'Active Restrictions', val: `${settings?.userRestrictions?.length ?? 0} active`, color: '#ec4899' },
              { label: 'Chat Bot', val: settings?.botConfig?.isActive ? 'Online' : 'Disabled', color: settings?.botConfig?.isActive ? '#10b981' : '#64748b' },
            ].map((chip) => (
              <div
                key={chip.label}
                style={{
                  display: 'flex',
                  gap: '6px',
                  alignItems: 'center',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  padding: '5px 12px',
                  fontSize: '12px',
                }}
              >
                <span style={{ color: 'var(--text-muted)' }}>{chip.label}:</span>
                <span style={{ fontWeight: 700, color: chip.color }}>{chip.val}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
          Loading moderation controls...
        </div>
      ) : settings ? (
        <>
          {/* Sub-tabs */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '16px', overflowX: 'auto', paddingBottom: '4px' }}>
            <button style={tabStyle('spam')} onClick={() => setActiveTab('spam')} id="mod-tab-spam">
              <IconShield size={14} /> Spam &amp; Links
            </button>
            <button style={tabStyle('sequence')} onClick={() => setActiveTab('sequence')} id="mod-tab-sequence">
              <IconSliders size={14} /> Auto-Ban Sequence
            </button>
            <button style={tabStyle('words')} onClick={() => setActiveTab('words')} id="mod-tab-words">
              <IconFilter size={14} /> Banned Words
            </button>
            <button style={tabStyle('commands')} onClick={() => setActiveTab('commands')} id="mod-tab-commands">
              <IconTerminal size={14} /> Command Controls
            </button>
            <button style={tabStyle('roles')} onClick={() => setActiveTab('roles')} id="mod-tab-roles">
              <IconUsers size={14} /> Staff Roles &amp; Permissions
            </button>
            <button style={tabStyle('restrictions')} onClick={() => setActiveTab('restrictions')} id="mod-tab-restrictions">
              <IconLock size={14} /> User &amp; Group Restrictions
            </button>
            <button style={tabStyle('bot')} onClick={() => setActiveTab('bot')} id="mod-tab-bot">
              <IconBot size={14} /> Bot Persona &amp; Logs
            </button>
          </div>

          {/* TAB 1: SPAM PROTECTION & LINK POLICY */}
          {activeTab === 'spam' && (
            <div className="card-section">
              <h4 style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 700 }}>
                Link Policy (FSD 4.2.2)
              </h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 20px' }}>
                What links this room accepts. The spam rule and the ban ladder are one for the whole chat (see the Banning Sequence tab).
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '560px' }}>
                {/* Link Policy */}
                <div style={{ marginTop: '8px' }}>
                  <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '8px' }}>
                    Link Policy (FSD 4.2.2)
                  </label>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    {(['ALL_LINKS', 'OREBIT_ONLY', 'NO_LINKS'] as const).map((policy) => (
                      <button
                        key={policy}
                        id={`link-policy-${policy}`}
                        onClick={() => setSettings({ ...settings, linkPolicy: policy })}
                        style={{
                          padding: '8px 18px',
                          borderRadius: '8px',
                          border: '1px solid',
                          borderColor: settings.linkPolicy === policy ? 'var(--primary)' : 'var(--border)',
                          background: settings.linkPolicy === policy ? 'rgba(99,102,241,0.15)' : 'transparent',
                          color: settings.linkPolicy === policy ? 'var(--primary)' : 'var(--text-secondary)',
                          fontSize: '12px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          transition: 'all 0.15s',
                        }}
                      >
                        {policy === 'ALL_LINKS' ? 'All Links Allowed' : policy === 'OREBIT_ONLY' ? 'OREBiT Links Only' : 'No External Links'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: AUTO-BAN SEQUENCE */}
          {activeTab === 'sequence' && <ChatWideRules onShowToast={onShowToast} />}

          {/* TAB 3: BANNED WORDS */}
          {activeTab === 'words' && (
            <div className="card-section">
              <h4 style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 700 }}>
                Inappropriate Words Blocklist (FSD 4.2.1)
              </h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 20px' }}>
                Messages containing any of these keywords will be blocked/redacted. Matching is strictly <strong>case-insensitive</strong>.
              </p>

              <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                <input
                  id="banned-word-input"
                  type="text"
                  className="form-control"
                  placeholder='Add banned keyword or phrase (e.g. "scam link")'
                  value={newWord}
                  style={{ flex: 1 }}
                  onChange={(e) => setNewWord(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') addWord(); }}
                />
                <button
                  id="banned-word-add"
                  className="btn-action"
                  onClick={addWord}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}
                >
                  <IconPlus size={13} />
                  Add Word
                </button>
              </div>

              {settings.bannedWords.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)', fontSize: '13px', background: 'rgba(255,255,255,0.02)', borderRadius: '10px', border: '1px dashed var(--border)' }}>
                  No banned words configured for this room blocklist
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {settings.bannedWords.map((word) => (
                    <div
                      key={word}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)',
                        borderRadius: '8px', padding: '5px 10px 5px 12px',
                        fontSize: '12px', color: '#fca5a5',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{word}</span>
                      <button
                        onClick={() => removeWord(word)}
                        style={{
                          background: 'none', border: 'none', color: '#f87171',
                          cursor: 'pointer', padding: '0', lineHeight: 1, fontSize: '14px',
                        }}
                        title={`Remove "${word}"`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ marginTop: '16px', fontSize: '12px', color: 'var(--text-muted)' }}>
                {settings.bannedWords.length} keyword{settings.bannedWords.length !== 1 ? 's' : ''} in room filter
              </div>
            </div>
          )}

          {/* TAB 4: COMMAND CONTROLS */}
          {activeTab === 'commands' && (
            <div className="card-section">
              <h4 style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 700 }}>Commands</h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 16px' }}>Chat-wide: switch all commands off, or only some, in Feature Settings → Commands. Per room: Rooms → Edit room → Content controls (allow commands and choose which). Restricting commands for one user or a group is under Penalties → Restrictions.</p>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-action" onClick={() => onNavigateTab?.('features')}>Open Feature Settings</button>
                <button className="btn-secondary" onClick={() => onNavigateTab?.('penalties')}>Open Penalties</button>
              </div>
            </div>
          )}

          {activeTab === 'roles' && (
            <div className="card-section">
              <h4 style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 700 }}>Staff role permissions</h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 16px' }}>Each permission is ACT, REPORT (ask a higher role) or NONE for ADMIN, MODERATOR and SUPPORT, with each role&apos;s ban maximum, penalty scope, history days, pin and rules rooms, restrictable commands, group privilege and visible user stats. Who holds a role is under Staff Roles &amp; RBAC.</p>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="btn-action" onClick={() => onNavigateTab?.('features')}>Open Feature Settings → Staff roles</button>
                <button className="btn-secondary" onClick={() => onNavigateTab?.('staff')}>Open Staff Roles</button>
              </div>
            </div>
          )}

          {activeTab === 'restrictions' && (
            <div className="card-section">
              <h4 style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 700 }}>
                User &amp; Group Restrictions (FSD 4.2.8)
              </h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 20px' }}>
                Restrictions in this room only, for a user or a group (Premium, KYC level, account level). Chat-wide restrictions, editing and lifting are under Penalties.
              </p>

              {/* Restriction creation form */}
              <div style={{
                background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
                borderRadius: '10px', padding: '16px', marginBottom: '24px',
              }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#fff', marginBottom: '12px' }}>
                  + Apply New Restriction
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 180px 140px auto', gap: '12px', alignItems: 'flex-end' }}>
                  <div>
                    <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Target Type</label>
                    <select
                      className="form-control"
                      style={{ fontSize: '12px', height: '34px' }}
                      value={newTargetType}
                      onChange={(e) => setNewTargetType(e.target.value as any)}
                    >
                      <option value="USER">Specific User</option>
                      <option value="PREMIUM">Premium Group</option>
                      <option value="KYC">KYC Level</option>
                      <option value="LEVEL">Account Level</option>
                    </select>
                  </div>

                  <div>
                    <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                      Target Identifier (Username, Tier, or Threshold)
                    </label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder={newTargetType === 'USER' ? 'e.g. username_123' : 'e.g. Tier 1, Level < 10'}
                      value={newTargetValue}
                      onChange={(e) => setNewTargetValue(e.target.value)}
                      style={{ fontSize: '12px', height: '34px' }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Restriction Penalty</label>
                    <select
                      className="form-control"
                      style={{ fontSize: '12px', height: '34px' }}
                      value={newRestriction}
                      onChange={(e) => setNewRestriction(e.target.value as any)}
                    >
                      <option value="MUTE">Mute in this room</option>
                      <option value="RESTRICT_MEDIA">No pictures / videos</option>
                      <option value="RESTRICT_EMOJI">No emoji</option>
                      <option value="RESTRICT_GIF">No GIFs</option>
                      <option value="RESTRICT_COMMANDS">Restrict commands</option>
                      <option value="RESTRICT_ADS">No /ad posting</option>
                      <option value="RESTRICT_DM">No DMs to strangers</option>
                      <option value="RESTRICT_GIFTS">Cannot send money</option>
                      <option value="RESTRICT_RECEIVE_GIFTS">Cannot receive money</option>
                      <option value="RESTRICT_RAIN">Cannot rain</option>
                      <option value="RESTRICT_RAIN_RECEIVE">Cannot receive rains</option>
                      <option value="RESTRICT_PIN">Cannot pin messages</option>
                      <option value="RESTRICT_DELETE_MESSAGES">Cannot delete messages</option>
                      <option value="RESTRICT_HISTORY">Cannot see chat history</option>
                      <option value="RESTRICT_STAFF_ROOM">Cannot enter the Staff room</option>
                      <option value="RESTRICT_IMAGES">No pictures</option>
                      <option value="RESTRICT_VIDEOS">No videos</option>
                    </select>
                  </div>

                  <div>
                    <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Duration</label>
                    <select
                      className="form-control"
                      style={{ fontSize: '12px', height: '34px' }}
                      value={newDurationHours}
                      onChange={(e) => setNewDurationHours(parseInt(e.target.value) || 24)}
                    >
                      <option value={1}>1 Hour</option>
                      <option value={24}>24 Hours</option>
                      <option value={72}>3 Days</option>
                      <option value={168}>7 Days</option>
                      <option value={720}>30 Days</option>
                      <option value={8760}>Permanent</option>
                    </select>
                  </div>

                  <button
                    className="btn-action"
                    onClick={addRestriction}
                    style={{ height: '34px', fontSize: '12px', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}
                  >
                    <IconPlus size={13} /> Apply
                  </button>
                </div>

                <div style={{ marginTop: '10px' }}>
                  <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                    Reason / Administrative Justification
                  </label>
                  <input
                    type="text"
                    className="form-control"
                    placeholder="Enter explicit reason for audit trail..."
                    value={newReason}
                    onChange={(e) => setNewReason(e.target.value)}
                    style={{ fontSize: '12px', height: '34px' }}
                  />
                </div>
              </div>

              {/* Active restrictions table */}
              <div className="table-responsive">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Target</th>
                      <th>Limitation</th>
                      <th>Reason</th>
                      <th>Duration</th>
                      <th>Applied At</th>
                      <th style={{ width: '100px', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(settings.userRestrictions ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: 'center', padding: '36px', color: 'var(--text-muted)' }}>
                          No active user or group restrictions.
                        </td>
                      </tr>
                    ) : (
                      (settings.userRestrictions ?? []).map((r) => (
                        <tr key={r.id}>
                          <td>
                            <div style={{ fontWeight: 600, color: '#fff' }}>{r.targetValue}</div>
                            <span className="tag-badge" style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8', fontSize: '10px' }}>
                              {r.targetType}
                            </span>
                          </td>
                          <td>
                            <span className="tag-badge" style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171' }}>
                              {r.restriction.replace('RESTRICT_', '')}
                            </span>
                          </td>
                          <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{r.reason}</td>
                          <td style={{ fontSize: '12px' }}>{r.durationHours ? `${r.durationHours}h` : 'Indefinite'}</td>
                          <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{new Date(r.createdAt).toLocaleString()}</td>
                          <td style={{ textAlign: 'right' }}>
                            <button
                              onClick={() => removeRestriction(r.id)}
                              className="btn-secondary"
                              style={{ color: '#f87171', borderColor: 'rgba(239,68,68,0.3)', fontSize: '11px', padding: '4px 8px' }}
                            >
                              Revoke
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 7: BOT PERSONA & LOGS */}
          {activeTab === 'bot' && (
            <div className="card-section">
              <h4 style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 700 }}>
                Chat Bot Persona &amp; Activity Log (FSD 4.2.10)
              </h4>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 20px' }}>
                Assign an official user persona as the automated Chat Bot, and inspect automated moderation &amp; event logs.
              </p>

              <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: '10px', padding: '16px', marginBottom: '24px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#fff', marginBottom: '6px' }}>Chat bot profile</div>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 10px' }}>
                  Automated alerts are posted under the account chosen in Feature Settings → Chat bot. A user&apos;s bot
                  log is under Penalties → Bot log.
                </p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="btn-action" onClick={() => onNavigateTab?.('features')}>Choose the bot account</button>
                  <button className="btn-secondary" onClick={() => onNavigateTab?.('penalties')}>Open bot log</button>
                </div>
              </div>

              {/* Bot Activity Logs */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '10px' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: '#fff' }}>Overall Bot Event &amp; Action Log</div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {(['ALL', 'AUTO_MOD', 'RAIN_EVENT', 'SECURITY', 'ANNOUNCEMENT'] as const).map((cat) => (
                      <button
                        key={cat}
                        className={`btn-secondary ${botLogFilter === cat ? 'active' : ''}`}
                        style={{ fontSize: '11px', padding: '4px 10px' }}
                        onClick={() => setBotLogFilter(cat)}
                      >
                        {cat.replace('_', ' ')}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="table-responsive">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Timestamp</th>
                        <th>Event Type</th>
                        <th>Room</th>
                        <th>Event Description / Action Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredBotLogs.map((log) => (
                        <tr key={log.id}>
                          <td style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                            {new Date(log.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </td>
                          <td>
                            <span
                              className="tag-badge"
                              style={{
                                background:
                                  log.type === 'AUTO_MOD'
                                    ? 'rgba(239,68,68,0.15)'
                                    : log.type === 'RAIN_EVENT'
                                    ? 'rgba(16,185,129,0.15)'
                                    : log.type === 'SECURITY'
                                    ? 'rgba(245,158,11,0.15)'
                                    : 'rgba(99,102,241,0.15)',
                                color:
                                  log.type === 'AUTO_MOD'
                                    ? '#f87171'
                                    : log.type === 'RAIN_EVENT'
                                    ? '#34d399'
                                    : log.type === 'SECURITY'
                                    ? '#fbbf24'
                                    : '#818cf8',
                              }}
                            >
                              {log.event}
                            </span>
                          </td>
                          <td style={{ fontSize: '12px', fontWeight: 600 }}>{log.roomName}</td>
                          <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{log.details}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Save Button */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
            <button
              id="mod-save-btn"
              className="btn-action"
              onClick={handleSave}
              disabled={saving}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 32px', fontSize: '14px', opacity: saving ? 0.7 : 1 }}
            >
              <IconCheck size={15} />
              {saving ? 'Saving...' : 'Save Moderation Settings'}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
};
