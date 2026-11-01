import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { AdminRoom, ChatMessage } from '../../types';
import { AdminAPI } from '../../services/api';
import { IconGavel, IconTrash } from '../Icons';

interface ChatHistoryViewProps {
  rooms: AdminRoom[];
  initialRoomId?: string;
  onClose?: () => void;
  onOpenBanModal: (user: { userId: string; username: string }) => void;
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

const TYPE_COLORS: Record<string, { bg: string; color: string; label: string }> = {
  TEXT: { bg: 'rgba(100,116,139,0.15)', color: '#94a3b8', label: 'Text' },
  ADMIN_ALERT: { bg: 'rgba(168,85,247,0.15)', color: '#c084fc', label: 'Admin Alert' },
  SYSTEM_ALERT: { bg: 'rgba(99,102,241,0.15)', color: '#818cf8', label: 'System' },
  GIF: { bg: 'rgba(16,185,129,0.15)', color: '#34d399', label: 'GIF' },
  IMAGE: { bg: 'rgba(245,158,11,0.15)', color: '#fbbf24', label: 'Image' },
  VIDEO: { bg: 'rgba(239,68,68,0.15)', color: '#f87171', label: 'Video' },
};

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

function getUserInitial(username: string): string {
  return (username || '?').charAt(0).toUpperCase();
}

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#14b8a6',
];
function getAvatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

export const ChatHistoryView: React.FC<ChatHistoryViewProps> = ({
  rooms,
  initialRoomId,
  onClose,
  onOpenBanModal,
  onShowToast,
}) => {
  const [selectedRoomId, setSelectedRoomId] = useState<string>(initialRoomId || '');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [retractingId, setRetractingId] = useState<string | null>(null);
  const [activeUserPopover, setActiveUserPopover] = useState<{
    userId: string;
    username: string;
    x: number;
    y: number;
  } | null>(null);

  const LIMIT = 50;

  const loadMessages = useCallback(
    async (roomId: string, cursor?: string | null, append = false) => {
      if (!roomId) return;
      setLoading(true);
      try {
        const data = await AdminAPI.getChatHistory(roomId, LIMIT, cursor || undefined);
        setMessages((prev) => (append ? [...prev, ...data.messages] : data.messages));
        setNextCursor(data.nextCursor);
      } catch {
        onShowToast('Failed to load chat history', 'danger');
      } finally {
        setLoading(false);
      }
    },
    [onShowToast],
  );

  useEffect(() => {
    if (initialRoomId) {
      setSelectedRoomId(initialRoomId);
    } else if (rooms.length > 0 && !selectedRoomId) {
      setSelectedRoomId(rooms[0]!.id);
    }
  }, [initialRoomId, rooms]);

  useEffect(() => {
    if (selectedRoomId) {
      setMessages([]);
      setNextCursor(null);
      setSearch('');
      setActiveUserPopover(null);
      loadMessages(selectedRoomId, null, false);
    }
  }, [selectedRoomId, loadMessages]);

  const selectedRoom = rooms.find((r) => r.id === selectedRoomId);

  // Derive unique participants/chatters in this room from messages
  const roomUsers = useMemo(() => {
    const map = new Map<string, { userId: string; username: string; messageCount: number; lastActive: string }>();
    messages.forEach((m) => {
      const existing = map.get(m.userId);
      if (existing) {
        existing.messageCount += 1;
        if (new Date(m.createdAt) > new Date(existing.lastActive)) {
          existing.lastActive = m.createdAt;
        }
      } else {
        map.set(m.userId, {
          userId: m.userId,
          username: m.username,
          messageCount: 1,
          lastActive: m.createdAt,
        });
      }
    });
    return Array.from(map.values()).sort((a, b) => b.messageCount - a.messageCount);
  }, [messages]);

  const filteredUsers = roomUsers.filter((u) =>
    !userSearch || u.username.toLowerCase().includes(userSearch.toLowerCase()) || u.userId.toLowerCase().includes(userSearch.toLowerCase())
  );

  const filtered = messages.filter((m) => {
    const matchSearch =
      !search ||
      m.content.toLowerCase().includes(search.toLowerCase()) ||
      m.username.toLowerCase().includes(search.toLowerCase());
    const matchType = typeFilter === 'ALL' || m.type === typeFilter;
    return matchSearch && matchType;
  });

  const handleRetract = async (msg: ChatMessage) => {
    const note = window.prompt(`Retract this message by ${msg.username}? Enter audit note (required - CH-090):`, 'Retracted by moderation administrator');
    if (!note || !note.trim()) return;
    setRetractingId(msg.id);
    try {
      const res = await AdminAPI.retractMessage(msg.id, note.trim());
      if (res.success) {
        onShowToast('Message retracted');
        setMessages((prev) =>
          prev.map((m) => (m.id === msg.id ? { ...m, retractedAt: new Date().toISOString() } : m)),
        );
      } else {
        onShowToast(res.error || 'Failed to retract', 'danger');
      }
    } catch {
      onShowToast('Network error', 'danger');
    } finally {
      setRetractingId(null);
    }
  };

  const handleUserClick = (e: React.MouseEvent, user: { userId: string; username: string }) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setActiveUserPopover({
      userId: user.userId,
      username: user.username,
      x: rect.left,
      y: rect.bottom + 6,
    });
  };

  return (
    <section
      className="tab-view"
      style={{ display: 'flex', flexDirection: 'column', gap: '14px', height: '100%' }}
      onClick={() => setActiveUserPopover(null)}
    >
      {/* Top Header Bar */}
      <div
        style={{
          background: 'var(--surface)',
          borderRadius: '14px',
          border: '1px solid var(--border)',
          padding: '14px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          {onClose && (
            <button
              className="btn-secondary"
              onClick={onClose}
              style={{
                fontSize: '12px',
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
              }}
            >
              &larr; Back to Rooms
            </button>
          )}

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 700 }}>
                {selectedRoom ? `# ${selectedRoom.name}` : 'Chat Room'}
              </h3>
              {selectedRoom && (
                <>
                  <span
                    className="tag-badge"
                    style={{
                      background: 'rgba(99,102,241,0.15)',
                      color: '#818cf8',
                      fontSize: '11px',
                    }}
                  >
                    /{selectedRoom.slug}
                  </span>
                  <span
                    className="tag-badge"
                    style={{
                      background: selectedRoom.status === 'ACTIVE' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                      color: selectedRoom.status === 'ACTIVE' ? '#34d399' : '#f87171',
                      fontSize: '11px',
                    }}
                  >
                    {selectedRoom.type}
                  </span>
                </>
              )}
            </div>
            <p style={{ margin: '3px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>
              {(selectedRoom?.messageCount ?? messages.length).toLocaleString()} total messages in room &bull; {roomUsers.length} active chatters
            </p>
          </div>
        </div>

        {/* Room Switcher */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <label style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>Switch Room:</label>
          <select
            className="form-control"
            style={{ minWidth: '180px', fontSize: '12px', height: '34px' }}
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

      {/* Main Content: Split Chat Stream & Participants Panel */}
      <div style={{ display: 'flex', gap: '16px', flex: 1, minHeight: 0 }}>
        {/* CENTER / LEFT: Message Feed */}
        <div
          style={{
            flex: '1 1 65%',
            background: 'var(--surface)',
            borderRadius: '14px',
            border: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Feed Filter Bar */}
          <div
            style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              gap: '10px',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flex: 1, maxWidth: '360px' }}>
              <input
                type="text"
                className="form-control"
                placeholder="Search messages or author..."
                style={{ fontSize: '12px', height: '32px' }}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <select
                className="form-control"
                style={{ minWidth: '110px', fontSize: '12px', height: '32px', padding: '0 8px' }}
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="ALL">All Types</option>
                {Object.entries(TYPE_COLORS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Messages List */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {loading && messages.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
                Loading room messages...
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>
                No messages found in this room.
              </div>
            ) : (
              filtered.map((msg) => {
                const typeStyle = TYPE_COLORS[msg.type] || TYPE_COLORS['TEXT']!;
                const avatarColor = getAvatarColor(msg.username);
                const isRetracted = !!msg.retractedAt;

                return (
                  <div
                    key={msg.id}
                    style={{
                      display: 'flex',
                      gap: '12px',
                      padding: '10px 12px',
                      borderRadius: '10px',
                      background: isRetracted ? 'rgba(239,68,68,0.04)' : 'rgba(255,255,255,0.015)',
                      border: isRetracted ? '1px solid rgba(239,68,68,0.15)' : '1px solid rgba(255,255,255,0.04)',
                      opacity: isRetracted ? 0.65 : 1,
                      transition: 'background 0.15s',
                    }}
                  >
                    {/* User Avatar (clickable) */}
                    <button
                      onClick={(e) => handleUserClick(e, { userId: msg.userId, username: msg.username })}
                      title="Click to moderate user"
                      style={{
                        width: '34px',
                        height: '34px',
                        borderRadius: '50%',
                        background: avatarColor,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '14px',
                        fontWeight: 700,
                        color: '#fff',
                        border: 'none',
                        cursor: 'pointer',
                        flexShrink: 0,
                        transition: 'transform 0.1s',
                      }}
                    >
                      {getUserInitial(msg.username)}
                    </button>

                    {/* Message Bubble Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                        <button
                          onClick={(e) => handleUserClick(e, { userId: msg.userId, username: msg.username })}
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            fontSize: '13px',
                            fontWeight: 700,
                            color: '#fff',
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                          title="Moderate user"
                        >
                          {msg.username}
                        </button>

                        <span
                          className="tag-badge"
                          style={{ background: typeStyle.bg, color: typeStyle.color, fontSize: '10px', padding: '1px 6px' }}
                        >
                          {typeStyle.label}
                        </span>

                        {isRetracted && (
                          <span
                            className="tag-badge"
                            style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', fontSize: '10px', padding: '1px 6px' }}
                          >
                            Retracted
                          </span>
                        )}

                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                          {formatRelativeTime(msg.createdAt)}
                        </span>
                      </div>

                      <div
                        style={{
                          fontSize: '13px',
                          color: isRetracted ? 'var(--text-muted)' : 'var(--text-primary)',
                          textDecoration: isRetracted ? 'line-through' : 'none',
                          wordBreak: 'break-word',
                          lineHeight: '1.45',
                        }}
                      >
                        {msg.content}
                      </div>

                      {/* Retract button */}
                      {!isRetracted && (
                        <div style={{ marginTop: '6px', display: 'flex', gap: '8px' }}>
                          <button
                            onClick={() => handleRetract(msg)}
                            disabled={retractingId === msg.id}
                            className="btn-secondary"
                            style={{
                              fontSize: '11px',
                              padding: '2px 8px',
                              color: 'var(--danger)',
                              borderColor: 'rgba(239,68,68,0.2)',
                            }}
                            title="Retract message"
                          >
                            <IconTrash size={11} />
                            <span>{retractingId === msg.id ? 'Retracting...' : 'Retract'}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}

            {/* Load More Pagination */}
            {Boolean(nextCursor) && (
              <div style={{ textAlign: 'center', padding: '14px 0' }}>
                <button
                  className="btn-secondary"
                  disabled={loading}
                  onClick={() => loadMessages(selectedRoomId, nextCursor, true)}
                  style={{ fontSize: '12px', padding: '6px 18px' }}
                >
                  {loading ? 'Loading...' : 'Load Older Messages (Cursor)'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT PANEL: Room Participants & User Moderation */}
        <div
          style={{
            flex: '0 0 320px',
            background: 'var(--surface)',
            borderRadius: '14px',
            border: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <h4 style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: '#fff' }}>
                👥 Room Participants ({roomUsers.length})
              </h4>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Active chatters</span>
            </div>
            <input
              type="text"
              className="form-control"
              placeholder="Search user..."
              style={{ fontSize: '11px', height: '30px' }}
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
            />
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {filteredUsers.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 10px', color: 'var(--text-muted)', fontSize: '12px' }}>
                No active chatters recorded in this room yet.
              </div>
            ) : (
              filteredUsers.map((user) => {
                const avatarColor = getAvatarColor(user.username);
                return (
                  <div
                    key={user.userId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 10px',
                      background: 'rgba(255,255,255,0.02)',
                      borderRadius: '8px',
                      border: '1px solid rgba(255,255,255,0.04)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          width: '28px',
                          height: '28px',
                          borderRadius: '50%',
                          background: avatarColor,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '12px',
                          fontWeight: 700,
                          color: '#fff',
                          flexShrink: 0,
                        }}
                      >
                        {getUserInitial(user.username)}
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            fontSize: '12px',
                            fontWeight: 600,
                            color: '#fff',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {user.username}
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                          {user.messageCount} msg{user.messageCount !== 1 ? 's' : ''} &bull; {formatRelativeTime(user.lastActive)}
                        </div>
                      </div>
                    </div>

                    {/* Quick In-Place Action Buttons */}
                    <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                      <button
                        onClick={() => onOpenBanModal({ userId: user.userId, username: user.username })}
                        className="btn-secondary"
                        style={{
                          padding: '4px 8px',
                          fontSize: '11px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          color: '#f87171',
                          borderColor: 'rgba(239,68,68,0.25)',
                          background: 'rgba(239,68,68,0.08)',
                        }}
                        title={`Ban ${user.username} from Chat`}
                      >
                        <IconGavel size={11} />
                        <span>Ban</span>
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Floating User Moderation Popover */}
      {activeUserPopover && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: `${Math.min(activeUserPopover.x, window.innerWidth - 220)}px`,
            top: `${Math.min(activeUserPopover.y, window.innerHeight - 180)}px`,
            background: '#151922',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '10px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
            padding: '12px',
            zIndex: 1000,
            width: '210px',
          }}
        >
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>USER MODERATION</div>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#fff', marginBottom: '8px' }}>
            @{activeUserPopover.username}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <button
              onClick={() => {
                onOpenBanModal({ userId: activeUserPopover.userId, username: activeUserPopover.username });
                setActiveUserPopover(null);
              }}
              className="btn-action"
              style={{
                width: '100%',
                fontSize: '11px',
                padding: '6px 10px',
                background: 'rgba(239,68,68,0.2)',
                color: '#f87171',
                borderColor: 'rgba(239,68,68,0.4)',
                justifyContent: 'flex-start',
              }}
            >
              🔨 Ban User from Chat
            </button>
            <button
              onClick={() => {
                onShowToast(`Warning issued to @${activeUserPopover.username}`);
                setActiveUserPopover(null);
              }}
              className="btn-secondary"
              style={{ width: '100%', fontSize: '11px', padding: '6px 10px', justifyContent: 'flex-start' }}
            >
              ⚠️ Issue Warning
            </button>
          </div>
        </div>
      )}
    </section>
  );
};
