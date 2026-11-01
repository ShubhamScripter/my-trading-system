'use client';

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useLayoutEffect,
} from 'react';
import {
  Send,
  MoreVertical,
  Pin,
  BellOff,
  Bell,
  Gift,
  Users,
  Undo2,
  Flag,
  Forward,
  ChevronDown,
  Search,
  X,
  Check,
  CheckCheck,
  Folder,
  User,
  Info,
  Settings,
  Trash2,
  Paperclip,
} from 'lucide-react';
import type { DmConversation, DmConversationDetail, DmMessage, GroupRole } from '@/types/dm';
import type { User as CurrentUser } from '@/types/chat';
import type { ChatSocket } from '@/lib/socket';
import * as dmApi from '@/lib/api/dm';
import { getReportReasons, uploadMedia } from '@/lib/api/messages';
import GroupMembersModal from './GroupMembersModal';
import GroupSettingsModal from './GroupSettingsModal';
import DmInfoPanel from './DmInfoPanel';

const GROUP_RANK: Record<GroupRole, number> = { MEMBER: 0, SUB_ADMIN: 1, ADMIN: 2, OWNER: 3 };

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatMsgTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function initials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

/** The text of a group event line. */
function systemLine(msg: DmMessage): string {
  const e = msg.event;
  if (!e) return '';
  const who = `@${msg.senderUsername}`;
  switch (e.kind) {
    case 'created': return `${who} created the group`;
    case 'joined': return `${who} joined`;
    case 'left': return `${who} left`;
    case 'membership': {
      const parts = [e.joined ? `${e.joined} joined` : '', e.left ? `${e.left} left` : ''].filter(Boolean);
      return parts.join(', ');
    }
    case 'removed': return `${who} removed a member`;
    case 'banned': return `${who} banned a member`;
    case 'role': return `${who} changed a member's role to ${(e.value ?? '').toLowerCase().replace('_', '-')}`;
    case 'timeout': return `${who} timed out a member for ${e.value} min`;
    case 'timeout_ended': return `${who} ended a timeout`;
    case 'ownership': return `${who} transferred ownership`;
    case 'renamed': return `${who} renamed the group`;
    default: return `${who}: ${e.kind.replace(/_/g, ' ')}`;
  }
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator({ name }: { name: string }) {
  return (
    <div className="dm-typing-indicator">
      <div className="dm-typing-dots">
        <span />
        <span />
        <span />
      </div>
      <span>{name} is typing…</span>
    </div>
  );
}

// ─── Message bubble ──────────────────────────────────────────────────────────

interface MsgBubbleProps {
  msg: DmMessage;
  isOwn: boolean;
  canRetract: boolean;
  /** Read receipts on my own direct messages: `read` once the other member's read position reached it. */
  readState: 'sent' | 'read' | null;
  /** A group admin hiding someone else's message ("Delete Messages (only deleted on user end)"). */
  canDelete: boolean;
  onRetract: () => void;
  onDelete: () => void;
  onPin: () => void;
  onForward: () => void;
  onReport: () => void;
}

function MsgBubble({
  msg,
  isOwn,
  canRetract,
  readState,
  canDelete,
  onRetract,
  onDelete,
  onPin,
  onForward,
  onReport,
}: MsgBubbleProps) {
  const isRetracted = msg.isRetracted || msg.isHidden;

  // A group event ("X joined", "X is now an admin") is a centred line, not a bubble.
  if (msg.type === 'SYSTEM') {
    return (
      <div style={{ textAlign: 'center', fontSize: '0.7rem', color: 'var(--text-muted)', margin: '0.35rem 0' }}>
        {systemLine(msg)}
      </div>
    );
  }

  return (
    <div className={`dm-msg-row${isOwn ? ' own' : ''}`}>
      {/* Avatar — only for others */}
      {!isOwn && (
        <div
          className="dm-avatar-circle"
          style={{ width: 28, height: 28, fontSize: '0.65rem', flexShrink: 0 }}
        >
          {initials(msg.senderUsername)}
        </div>
      )}

      {/* Action buttons (appear on hover) */}
      <div className="dm-msg-actions">
        {canRetract && !isRetracted && (
          <button
            className="dm-msg-action-btn"
            onClick={onRetract}
            title="Retract message"
          >
            <Undo2 size={12} />
          </button>
        )}
        {canDelete && !isRetracted && (
          <button
            className="dm-msg-action-btn"
            onClick={onDelete}
            title="Delete for everyone (group admin)"
            style={{ color: 'var(--color-danger)' }}
          >
            <Trash2 size={12} />
          </button>
        )}
        {!isRetracted && (
          <>
            <button
              className="dm-msg-action-btn"
              onClick={onPin}
              title="Pin message"
            >
              <Pin size={12} />
            </button>
            <button
              className="dm-msg-action-btn"
              onClick={onForward}
              title="Forward message"
            >
              <Forward size={12} />
            </button>
          </>
        )}
        {!isOwn && !isRetracted && (
          <button
            className="dm-msg-action-btn"
            onClick={onReport}
            title="Report message"
            style={{ color: 'var(--color-warning)' }}
          >
            <Flag size={12} />
          </button>
        )}
      </div>

      <div
        className={`dm-msg-bubble${isOwn ? ' own' : ''}${isRetracted ? ' retracted' : ''}`}
      >
        {/* Group: show sender name */}
        {!isOwn && !isRetracted && (
          <div
            style={{
              fontSize: '0.7rem',
              fontWeight: 700,
              color: '#818cf8',
              marginBottom: '3px',
            }}
          >
            {msg.senderUsername}
          </div>
        )}

        {isRetracted ? (
          <span className="dm-msg-text" style={{ color: 'var(--text-muted)' }}>
            {msg.isHidden ? '[Message removed by a moderator]' : '[Message retracted]'}
          </span>
        ) : msg.type === 'CARD' && msg.card ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.4rem' }}>🎟️</span>
            <div>
              <div style={{ fontWeight: 700, color: '#fbbf24' }}>{msg.card.title}</div>
              <div style={{ fontSize: '0.75rem', color: '#e2e8f0' }}>
                {msg.card.amount} {msg.card.currency}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {isOwn ? `You sent a gift card to @${msg.card.receiverUsername}` : `@${msg.senderUsername} sent you a gift card`}
              </div>
            </div>
          </div>
        ) : msg.type === 'GIFT' && msg.gift ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.4rem' }}>🎁</span>
            <div>
              <div style={{ fontWeight: 700, color: '#fbbf24' }}>
                {msg.gift.amount} {msg.gift.currency}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {isOwn ? 'You sent a gift' : `@${msg.senderUsername} sent you a gift`}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Forward indicator */}
            {msg.forwarded && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  fontSize: '0.7rem',
                  color: 'var(--text-muted)',
                  marginBottom: '4px',
                }}
              >
                <Forward size={11} /> Forwarded
                {msg.forwarded.fromUsername ? ` from @${msg.forwarded.fromUsername}` : ''}
              </div>
            )}

            {msg.content && (
              <p className="dm-msg-text">{msg.content}</p>
            )}

            {/* Media */}
            {msg.media && (
              <div style={{ marginTop: '4px' }}>
                {msg.media.type === 'video' ? (
                  <video
                    controls
                    src={msg.media.url}
                    style={{
                      maxWidth: '240px',
                      borderRadius: '8px',
                      display: 'block',
                    }}
                  />
                ) : (
                  <img
                    src={msg.media.url}
                    alt={msg.media.caption ?? 'image'}
                    loading="lazy"
                    style={{
                      maxWidth: '240px',
                      borderRadius: '8px',
                      display: 'block',
                      cursor: 'pointer',
                    }}
                    onClick={() => window.open(msg.media!.url, '_blank')}
                  />
                )}
                {msg.media.caption && (
                  <p
                    style={{
                      fontSize: '0.72rem',
                      color: 'var(--text-muted)',
                      marginTop: '3px',
                    }}
                  >
                    {msg.media.caption}
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {msg.isPinned && !isRetracted && (
          <Pin
            size={10}
            style={{
              position: 'absolute',
              top: '4px',
              right: '4px',
              color: '#facc15',
              opacity: 0.8,
            }}
          />
        )}

        <div className="dm-msg-time">
          {formatMsgTime(msg.createdAt)}
          {readState === 'read' && <CheckCheck size={11} style={{ color: '#38bdf8' }} aria-label="Read" />}
          {readState === 'sent' && <Check size={11} aria-label="Sent" />}
        </div>
      </div>
    </div>
  );
}

// ─── Conversation header ───────────────────────────────────────────────────────

interface ConvHeaderProps {
  conv: DmConversation;
  typingName: string | null;
  onGift: () => void;
  onPinned: () => void;
  onSettings: () => void;
  onInfo: () => void;
  onMembers: () => void;
  onGroupSettings: () => void;
  onClose: () => void;
}

function ConvHeader({
  conv,
  typingName,
  onGift,
  onPinned,
  onSettings,
  onInfo,
  onMembers,
  onGroupSettings,
  onClose,
}: ConvHeaderProps) {
  const isGroup = conv.kind === 'GROUP';
  return (
    <div className="dm-conv-header">
      {isGroup ? (
        <div className="group-avatar-circle" style={{ width: 36, height: 36 }}>
          {conv.displayName.slice(0, 2).toUpperCase()}
        </div>
      ) : (
        <div className="dm-avatar-circle" style={{ width: 36, height: 36 }}>
          {conv.displayName.slice(0, 2).toUpperCase()}
        </div>
      )}

      <div className="dm-conv-header-name">
        <div className="dm-conv-header-title">{conv.displayName}</div>
        <div className="dm-conv-header-sub">
          {typingName
            ? `${typingName} is typing…`
            : isGroup
            ? `${conv.group?.memberCount ?? ''} members`
            : conv.peer?.isOnline
            ? 'Online'
            : conv.peer?.lastSeenAt
            ? `Last seen ${new Date(conv.peer.lastSeenAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
            : 'Offline'}
        </div>
      </div>

      <div className="dm-conv-header-actions">
        {!isGroup && (
          <button
            className="dm-header-action-btn"
            onClick={onGift}
            title="Send gift"
            id="dm-gift-btn"
            style={{ color: '#fbbf24' }}
          >
            <Gift size={16} />
          </button>
        )}
        <button
          className="dm-header-action-btn"
          onClick={onPinned}
          title="Pinned messages"
          id="dm-pinned-btn"
        >
          <Pin size={16} />
        </button>
        <button className="dm-header-action-btn" onClick={onInfo} title="Shared media, links and common groups" id="dm-info-btn">
          <Info size={16} />
        </button>
        {isGroup && (
          <>
            <button className="dm-header-action-btn" onClick={onMembers} title="Members" id="dm-group-members-btn">
              <Users size={16} />
            </button>
            <button className="dm-header-action-btn" onClick={onGroupSettings} title="Group settings" id="dm-group-settings-btn">
              <Settings size={16} />
            </button>
          </>
        )}
        <button
          className="dm-header-action-btn"
          onClick={onSettings}
          title="Conversation settings"
          id="dm-conv-settings-btn"
        >
          <MoreVertical size={16} />
        </button>
        <button
          className="dm-header-action-btn"
          onClick={onClose}
          title="Close"
          id="dm-close-btn"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

// ─── Conversation settings dropdown ──────────────────────────────────────────

interface ConvSettingsMenuProps {
  conv: DmConversation;
  onClose: () => void;
  onRefresh: () => void;
}

function ConvSettingsMenu({ conv, onClose, onRefresh }: ConvSettingsMenuProps) {
  const [nicknameModal, setNicknameModal] = useState(false);
  const [nicknameText, setNicknameText] = useState(conv.nickname ?? '');
  const [submitting, setSubmitting] = useState(false);

  /** Refusals (pin limit, nickname for non-friends…) are shown, not swallowed. */
  async function run(action: () => Promise<void>) {
    try {
      await action();
      onRefresh();
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'That did not work');
    }
  }

  const togglePin = () => run(() => dmApi.pinPerson(conv.id, !conv.isPinned));
  const toggleNotifications = () => run(() => dmApi.setNotifications(conv.id, !conv.notificationsOff));
  const moveFolder = (folder: 'PRIMARY' | 'GENERAL') => run(() => dmApi.moveFolder(conv.id, folder));

  async function saveNickname() {
    setSubmitting(true);
    try {
      await run(() => dmApi.setNickname(conv.id, nicknameText.trim() || null));
      setNicknameModal(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (nicknameModal) {
    return (
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: '10px',
          padding: '1rem',
          width: '260px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        }}
      >
        <p
          style={{
            fontSize: '0.83rem',
            fontWeight: 700,
            marginBottom: '0.75rem',
            color: 'var(--text-main)',
          }}
        >
          Set nickname
        </p>
        <input
          autoFocus
          value={nicknameText}
          onChange={(e) => setNicknameText(e.target.value)}
          placeholder={conv.peer?.username ?? conv.displayName}
          style={{
            width: '100%',
            background: 'var(--bg-input)',
            border: '1px solid var(--border-color)',
            borderRadius: '7px',
            padding: '0.45rem 0.6rem',
            color: 'var(--text-main)',
            fontSize: '0.85rem',
            outline: 'none',
            marginBottom: '0.75rem',
          }}
          onKeyDown={(e) => e.key === 'Enter' && void saveNickname()}
        />
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => setNicknameModal(false)}
            style={{
              flex: 1,
              padding: '0.4rem',
              borderRadius: '6px',
              background: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '0.8rem',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => void saveNickname()}
            disabled={submitting}
            style={{
              flex: 1,
              padding: '0.4rem',
              borderRadius: '6px',
              background: 'var(--color-primary)',
              border: 'none',
              color: 'white',
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
              fontSize: '0.8rem',
              fontWeight: 600,
            }}
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  const menuItem = (icon: React.ReactNode, label: string, fn: () => void, danger = false) => (
    <button
      onClick={fn}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        width: '100%',
        padding: '0.55rem 0.875rem',
        background: 'none',
        border: 'none',
        color: danger ? 'var(--color-danger)' : 'var(--text-main)',
        fontSize: '0.82rem',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 0.1s',
      }}
      onMouseEnter={(e) =>
        ((e.currentTarget as HTMLElement).style.background =
          'rgba(255,255,255,0.04)')
      }
      onMouseLeave={(e) =>
        ((e.currentTarget as HTMLElement).style.background = 'none')
      }
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: '10px',
        overflow: 'hidden',
        width: '220px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      }}
    >
      {menuItem(<Pin size={14} />, conv.isPinned ? 'Unpin' : 'Pin', () => void togglePin())}
      {menuItem(
        conv.notificationsOff ? <Bell size={14} /> : <BellOff size={14} />,
        conv.notificationsOff ? 'Unmute notifications' : 'Mute notifications',
        () => void toggleNotifications(),
      )}
      {conv.kind === 'DIRECT' && conv.folder !== 'PRIMARY' &&
        menuItem(<Folder size={14} />, 'Move to Primary', () => void moveFolder('PRIMARY'))}
      {conv.kind === 'DIRECT' && conv.folder !== 'GENERAL' &&
        menuItem(<Folder size={14} />, 'Move to General', () => void moveFolder('GENERAL'))}
      {conv.kind === 'DIRECT' &&
        menuItem(
          <User size={14} />,
          'Set nickname',
          () => setNicknameModal(true),
        )}
    </div>
  );
}

// ─── Pinned messages panel ─────────────────────────────────────────────────────

function PinnedPanel({
  convId,
  onClose,
}: {
  convId: string;
  onClose: () => void;
}) {
  const [msgs, setMsgs] = useState<DmMessage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    dmApi
      .getPinnedMessages(convId)
      .then(setMsgs)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [convId]);

  return (
    <div className="dm-pinned-panel">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.75rem 1rem',
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>
          Pinned messages
        </span>
        <button
          className="dm-header-action-btn"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            Loading…
          </div>
        )}
        {!loading && msgs.length === 0 && (
          <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
            No pinned messages
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className="dm-pinned-item">
            <div className="dm-pinned-sender">@{m.senderUsername}</div>
            <div className="dm-pinned-content">{m.content}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Forward modal ────────────────────────────────────────────────────────────

function ForwardModal({
  messageId,
  onClose,
  onDone,
}: {
  messageId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [conversations, setConversations] = useState<DmConversation[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    dmApi
      .getConversations('PRIMARY', { limit: 30 })
      .then((r) => setConversations(r.items))
      .catch(() => {});
  }, []);

  async function forward() {
    if (selected.length === 0) return;
    setSending(true);
    try {
      await dmApi.forwardDmMessage(messageId, selected);
      onDone();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="dm-search-modal">
      <div className="dm-search-input-row">
        <Forward size={16} style={{ color: 'var(--text-muted)' }} />
        <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>
          Forward to…
        </span>
        <button
          className="dm-header-action-btn"
          onClick={onClose}
          style={{ marginLeft: 'auto' }}
        >
          <X size={16} />
        </button>
      </div>
      <div className="dm-search-results">
        {conversations.map((c) => (
          <div
            key={c.id}
            className="dm-search-result-item"
            onClick={() =>
              setSelected((prev) =>
                prev.includes(c.id)
                  ? prev.filter((id) => id !== c.id)
                  : [...prev, c.id],
              )
            }
          >
            <div
              className="dm-avatar-circle"
              style={{
                width: 32,
                height: 32,
                fontSize: '0.7rem',
                background: selected.includes(c.id)
                  ? '#6366f1'
                  : undefined,
              }}
            >
              {selected.includes(c.id) ? (
                <Check size={14} />
              ) : (
                c.displayName.slice(0, 2).toUpperCase()
              )}
            </div>
            <span
              style={{
                fontSize: '0.85rem',
                fontWeight: 600,
                color: 'var(--text-main)',
              }}
            >
              {c.displayName}
            </span>
          </div>
        ))}
      </div>
      <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border-color)' }}>
        <button
          onClick={() => void forward()}
          disabled={selected.length === 0 || sending}
          style={{
            width: '100%',
            padding: '0.6rem',
            borderRadius: '8px',
            background: 'var(--color-primary)',
            border: 'none',
            color: 'white',
            fontWeight: 700,
            fontSize: '0.875rem',
            cursor: selected.length === 0 || sending ? 'not-allowed' : 'pointer',
            opacity: selected.length === 0 || sending ? 0.5 : 1,
          }}
        >
          Forward to {selected.length} conversation{selected.length !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}

// ─── DmConversationView ────────────────────────────────────────────────────────

export interface DmConversationViewProps {
  conv: DmConversation;
  currentUser: CurrentUser | null;
  socket: ChatSocket | null;
  onClose: () => void;
  onGift: (conv: DmConversation) => void;
  /** Something the inbox shows changed (pin, nickname, folder, group info): the inbox reloads. */
  onChanged?: () => void;
}

export default function DmConversationView({
  conv: initialConv,
  currentUser,
  socket,
  onClose,
  onGift,
  onChanged,
}: DmConversationViewProps) {
  // The full detail (my group role, permissions, read positions) replaces the inbox row once loaded.
  const [detail, setDetail] = useState<DmConversationDetail | null>(null);
  const conv: DmConversation = detail ?? initialConv;
  const [peerReadId, setPeerReadId] = useState<string | null>(initialConv.peerLastReadMessageId ?? null);
  const [showInfo, setShowInfo] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showGroupSettings, setShowGroupSettings] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reloadDetail = useCallback(() => {
    dmApi
      .getConversation(initialConv.id)
      .then((d) => {
        setDetail(d);
        if (d.peerLastReadMessageId) setPeerReadId(d.peerLastReadMessageId);
      })
      .catch(() => {});
  }, [initialConv.id]);

  useEffect(() => {
    reloadDetail();
  }, [reloadDetail]);

  const refreshAll = () => {
    reloadDetail();
    onChanged?.();
  };
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [typingName, setTypingName] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPinned, setShowPinned] = useState(false);
  const [forwardingMsgId, setForwardingMsgId] = useState<string | null>(null);
  const [reportingMsgId, setReportingMsgId] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState('SPAM');
  const [reportReasons, setReportReasons] = useState<string[]>(['SPAM', 'HARASSMENT', 'INAPPROPRIATE', 'SCAM', 'HATE_SPEECH', 'OTHER']);
  useEffect(() => {
    getReportReasons()
      .then((items) => items.length && setReportReasons(items.map((i) => i.code)))
      .catch(() => {});
  }, []);
  const [reportSubmitting, setReportSubmitting] = useState(false);

  const feedRef = useRef<HTMLDivElement>(null);
  const feedEndRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isOwnMsg = (m: DmMessage) =>
    detail?.me.userId ? m.senderId === detail.me.userId : currentUser?.username === m.senderUsername;

  // Group roles: "Delete Messages" goes to the lowest role the owner allowed (sub-admins by default), above the sender.
  const myRole = detail?.me.role ?? null;
  const roleOf = (userId: string): GroupRole => detail?.members.find((m) => m.userId === userId)?.role ?? 'MEMBER';
  const deleteRole = detail?.groupInfo?.permissions.DELETE_MESSAGES ?? 'SUB_ADMIN';
  const mayDelete = (m: DmMessage) =>
    conv.kind === 'GROUP' &&
    !!myRole &&
    !isOwnMsg(m) &&
    GROUP_RANK[myRole] >= GROUP_RANK[deleteRole] &&
    GROUP_RANK[myRole] > GROUP_RANK[roleOf(m.senderId)];

  // Read receipts (direct chats): my messages up to the other member's read position are read.
  const readIndex = peerReadId ? messages.findIndex((m) => m.id === peerReadId) : -1;
  const readStateOf = (m: DmMessage, index: number): 'sent' | 'read' | null => {
    if (conv.kind !== 'DIRECT' || !isOwnMsg(m) || m.type === 'SYSTEM') return null;
    return readIndex >= index ? 'read' : 'sent';
  };

  // "Group Admin can set if the members can text in the group or not", and timeouts.
  const timedOutUntil = detail?.me.timeoutUntil && new Date(detail.me.timeoutUntil) > new Date() ? detail.me.timeoutUntil : null;
  const textOff = conv.kind === 'GROUP' && detail?.groupInfo?.membersCanText === false && myRole === 'MEMBER';
  const composerBlocked = timedOutUntil
    ? `You are timed out until ${new Date(timedOutUntil).toLocaleString()}`
    : textOff
      ? 'Only admins can send messages in this group'
      : null;

  // Load history
  const loadHistory = useCallback(
    async (reset = false) => {
      if (loadingHistory) return;
      setLoadingHistory(true);
      try {
        const cursor = reset ? null : nextCursor;
        const page = await dmApi.getDmHistory(conv.id, { limit: 50, cursor });
        setMessages((prev) =>
          reset ? page.messages : [...page.messages, ...prev],
        );
        setNextCursor(page.nextCursor);
        // Read receipts: my read position moves to the newest message.
        const newest = page.messages.at(-1);
        if (reset && newest) dmApi.markRead(conv.id, newest.id).catch(() => {});
        if (reset) {
          // Scroll to bottom after initial load
          requestAnimationFrame(() => {
            feedEndRef.current?.scrollIntoView({ behavior: 'instant' });
          });
        }
      } catch {
        // silently ignore
      } finally {
        setLoadingHistory(false);
      }
    },
    [conv.id, loadingHistory, nextCursor],
  );

  useEffect(() => {
    setMessages([]);
    setNextCursor(null);
    void loadHistory(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id]);

  // Infinite scroll (load older on scroll-to-top)
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const handler = () => {
      if (el.scrollTop < 80 && nextCursor) void loadHistory(false);
    };
    el.addEventListener('scroll', handler, { passive: true });
    return () => el.removeEventListener('scroll', handler);
  }, [loadHistory, nextCursor]);

  // Socket: new DM messages
  useEffect(() => {
    if (!socket) return;
    function onDmMessage(data: { conversationId: string; message: unknown }) {
      if (data.conversationId !== conv.id) return;
      const message = dmApi.toMessage(data.message);
      // My own sends come back over the socket too: keep one copy.
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
      requestAnimationFrame(() =>
        feedEndRef.current?.scrollIntoView({ behavior: 'smooth' }),
      );
      dmApi.markRead(conv.id, message.id).catch(() => {});
    }
    // A line that grew in place (people joining or leaving close together): swap in the new version.
    function onDmUpdated(data: { conversationId: string; message: unknown }) {
      if (data.conversationId !== conv.id) return;
      const message = dmApi.toMessage(data.message);
      setMessages((prev) => prev.map((m) => (m.id === message.id ? message : m)));
    }
    function onDmRetract(data: { conversationId: string; messageId: string }) {
      if (data.conversationId !== conv.id) return;
      setMessages((prev) => prev.map((m) => (m.id === data.messageId ? { ...m, isRetracted: true } : m)));
    }
    function onDmHidden(data: { conversationId: string; messageId: string }) {
      if (data.conversationId !== conv.id) return;
      setMessages((prev) => prev.map((m) => (m.id === data.messageId ? { ...m, isHidden: true } : m)));
    }
    function onDmPin(pinned: boolean) {
      return (data: { conversationId: string; messageId: string }) => {
        if (data.conversationId !== conv.id) return;
        setMessages((prev) => prev.map((m) => (m.id === data.messageId ? { ...m, isPinned: pinned } : m)));
      };
    }
    function onDmTyping(data: { conversationId: string; username: string; typing: boolean }) {
      if (data.conversationId !== conv.id) return;
      setTypingName(data.typing ? data.username : null);
    }
    // Read receipts: the other member read up to `messageId`.
    function onDmRead(data: { conversationId: string; userId: string; messageId: string }) {
      if (data.conversationId !== conv.id || data.userId === detail?.me.userId) return;
      if (conv.kind === 'DIRECT') setPeerReadId(data.messageId);
    }
    const onPinned = onDmPin(true);
    const onUnpinned = onDmPin(false);

    socket.on('dm_message', onDmMessage);
    socket.on('dm_request', onDmMessage);
    socket.on('dm_message_updated', onDmUpdated);
    socket.on('dm_message_retracted', onDmRetract);
    socket.on('dm_message_hidden', onDmHidden);
    socket.on('dm_message_pinned', onPinned);
    socket.on('dm_message_unpinned', onUnpinned);
    socket.on('dm_typing', onDmTyping);
    socket.on('dm_read', onDmRead);
    return () => {
      socket.off('dm_message', onDmMessage);
      socket.off('dm_request', onDmMessage);
      socket.off('dm_message_updated', onDmUpdated);
      socket.off('dm_message_retracted', onDmRetract);
      socket.off('dm_message_hidden', onDmHidden);
      socket.off('dm_message_pinned', onPinned);
      socket.off('dm_message_unpinned', onUnpinned);
      socket.off('dm_typing', onDmTyping);
      socket.off('dm_read', onDmRead);
    };
  }, [socket, conv.id, conv.kind, detail?.me.userId]);

  // Send message
  async function sendMessage() {
    if (!text.trim() || sending) return;
    const content = text.trim();
    setText('');
    setSending(true);
    setSendError(null);
    try {
      const msg = await dmApi.sendDmMessage(conv.id, content, { clientMessageId: crypto.randomUUID() });
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      requestAnimationFrame(() =>
        feedEndRef.current?.scrollIntoView({ behavior: 'smooth' }),
      );
    } catch (err) {
      setText(content); // restore on failure
      // Links to non-friends, the new-DM limit, group text off, a timeout…: the server says why.
      setSendError(err instanceof Error ? err.message : 'Your message could not be sent');
    } finally {
      setSending(false);
    }
  }

  // A photo or video: uploaded through chat first (the server accepts only its own upload URLs).
  async function sendAttachment(file: File) {
    setUploading(true);
    setSendError(null);
    try {
      const uploaded = await uploadMedia('', file);
      const msg = await dmApi.sendDmMessage(conv.id, text.trim(), {
        mediaUrl: uploaded.url,
        mediaType: uploaded.mediaType,
        clientMessageId: crypto.randomUUID(),
      });
      setText('');
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      requestAnimationFrame(() => feedEndRef.current?.scrollIntoView({ behavior: 'smooth' }));
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  // Group admins: hide a member's message for everyone (it stays for chat staff).
  async function deleteGroupMsg(msg: DmMessage) {
    if (!confirm('Delete this message for everyone in the group?')) return;
    try {
      await dmApi.deleteGroupMessage(conv.id, msg.id);
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, isHidden: true } : m)));
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not delete the message');
    }
  }

  // Emit typing indicator
  function handleTextChange(value: string) {
    setText(value);
    if (!socket) return;
    socket.emit('dm_typing', { conversationId: conv.id, typing: true });
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      socket.emit('dm_typing', { conversationId: conv.id, typing: false });
    }, 2000);
  }

  // Retract
  async function retractMsg(msgId: string) {
    try {
      await dmApi.retractDmMessage(msgId);
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, isRetracted: true } : m)),
      );
    } catch {
      // ignore
    }
  }

  // Pin
  async function pinMsg(msg: DmMessage) {
    try {
      await dmApi.pinDmMessage(msg.id, !msg.isPinned);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id ? { ...m, isPinned: !m.isPinned } : m,
        ),
      );
    } catch (err) {
      // e.g. the admin's "Maximum Number of Pinned Messages (per DM)".
      setSendError(err instanceof Error ? err.message : 'Could not pin the message');
    }
  }

  // Report
  async function submitReport() {
    if (!reportingMsgId) return;
    setReportSubmitting(true);
    try {
      await dmApi.reportDmMessage(reportingMsgId, reportReason);
      setReportingMsgId(null);
    } finally {
      setReportSubmitting(false);
    }
  }

  return (
    <div className="dm-conv-view">
      <ConvHeader
        conv={conv}
        typingName={typingName}
        onGift={() => onGift(conv)}
        onPinned={() => {
          setShowInfo(false);
          setShowPinned((v) => !v);
        }}
        onSettings={() => setShowSettings((v) => !v)}
        onInfo={() => {
          setShowPinned(false);
          setShowInfo((v) => !v);
        }}
        onMembers={() => setShowMembers(true)}
        onGroupSettings={() => setShowGroupSettings(true)}
        onClose={onClose}
      />

      {/* Settings dropdown */}
      {showSettings && (
        <div
          style={{
            position: 'absolute',
            top: '54px',
            right: '1rem',
            zIndex: 100,
          }}
        >
          <ConvSettingsMenu
            conv={conv}
            onClose={() => setShowSettings(false)}
            onRefresh={refreshAll}
          />
        </div>
      )}

      {/* Shared media / links / common groups */}
      {showInfo && (
        <div style={{ position: 'absolute', top: '54px', right: '1rem', zIndex: 100 }}>
          <DmInfoPanel conv={conv} onClose={() => setShowInfo(false)} />
        </div>
      )}

      {/* Pinned panel overlay */}
      {showPinned && (
        <div
          style={{
            position: 'absolute',
            top: '54px',
            right: '1rem',
            zIndex: 100,
          }}
        >
          <PinnedPanel
            convId={conv.id}
            onClose={() => setShowPinned(false)}
          />
        </div>
      )}

      {/* Message feed */}
      <div className="dm-message-feed" ref={feedRef}>
        {loadingHistory && nextCursor === null && (
          <div
            style={{
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: '0.8rem',
              padding: '0.5rem',
            }}
          >
            Loading messages…
          </div>
        )}
        {loadingHistory && nextCursor !== null && (
          <div
            style={{
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: '0.75rem',
              padding: '0.4rem',
            }}
          >
            Loading older messages…
          </div>
        )}
        {messages.map((msg, index) => (
          <MsgBubble
            key={msg.id}
            msg={msg}
            isOwn={isOwnMsg(msg)}
            canRetract={isOwnMsg(msg)}
            readState={readStateOf(msg, index)}
            canDelete={mayDelete(msg)}
            onDelete={() => void deleteGroupMsg(msg)}
            onRetract={() => void retractMsg(msg.id)}
            onPin={() => void pinMsg(msg)}
            onForward={() => setForwardingMsgId(msg.id)}
            onReport={() => {
              setReportingMsgId(msg.id);
              setReportReason('SPAM');
            }}
          />
        ))}
        {typingName && <TypingIndicator name={typingName} />}
        <div ref={feedEndRef} />
      </div>

      {sendError && (
        <div
          role="alert"
          style={{
            margin: '0 1rem',
            padding: '0.45rem 0.7rem',
            borderRadius: '8px',
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#fca5a5',
            fontSize: '0.78rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.5rem',
          }}
        >
          <span>{sendError}</span>
          <button className="dm-header-action-btn" onClick={() => setSendError(null)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Composer */}
      <div className="dm-composer">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void sendAttachment(file);
          }}
        />
        <button
          className="dm-header-action-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || !!composerBlocked}
          title={uploading ? 'Uploading…' : 'Send a photo or video'}
          id="dm-attach-btn"
        >
          <Paperclip size={16} />
        </button>
        <div className="dm-composer-input-wrap">
          <textarea
            id="dm-composer-textarea"
            className="dm-composer-textarea"
            value={text}
            disabled={!!composerBlocked}
            placeholder={composerBlocked ?? `Message ${conv.displayName}…`}
            onChange={(e) => handleTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendMessage();
              }
            }}
            rows={1}
          />
        </div>
        <button
          className="dm-send-btn"
          onClick={() => void sendMessage()}
          disabled={!text.trim() || sending}
          id="dm-send-btn"
        >
          <Send size={16} />
        </button>
      </div>

      {/* Group management (Module 9): members, roles, timeouts, bans, invites; info, permissions, ownership */}
      {showMembers && conv.kind === 'GROUP' && (
        <GroupMembersModal conv={conv} onClose={() => setShowMembers(false)} onMemberChanged={refreshAll} />
      )}
      {showGroupSettings && conv.kind === 'GROUP' && (
        <GroupSettingsModal
          conv={conv}
          onClose={() => setShowGroupSettings(false)}
          onUpdated={refreshAll}
          onLeftGroup={() => {
            setShowGroupSettings(false);
            onChanged?.();
            onClose();
          }}
        />
      )}

      {/* Forward modal */}
      {forwardingMsgId && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 200,
          }}
          onClick={() => setForwardingMsgId(null)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <ForwardModal
              messageId={forwardingMsgId}
              onClose={() => setForwardingMsgId(null)}
              onDone={() => setForwardingMsgId(null)}
            />
          </div>
        </div>
      )}

      {/* Report modal */}
      {reportingMsgId && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 200,
          }}
          onClick={() => setReportingMsgId(null)}
        >
          <div
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
              padding: '1.25rem',
              width: '360px',
              boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p
              style={{
                fontWeight: 700,
                marginBottom: '1rem',
                color: 'var(--text-main)',
              }}
            >
              Report message
            </p>
            <select
              id="dm-report-reason-select"
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              style={{
                width: '100%',
                background: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                borderRadius: '7px',
                padding: '0.5rem 0.6rem',
                color: 'var(--text-main)',
                fontSize: '0.85rem',
                outline: 'none',
                marginBottom: '1rem',
              }}
            >
              {reportReasons.map((r) => (
                <option key={r} value={r}>
                  {r.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => setReportingMsgId(null)}
                style={{
                  flex: 1,
                  padding: '0.5rem',
                  borderRadius: '7px',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '0.83rem',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => void submitReport()}
                disabled={reportSubmitting}
                style={{
                  flex: 1,
                  padding: '0.5rem',
                  borderRadius: '7px',
                  background: 'var(--color-danger)',
                  border: 'none',
                  color: 'white',
                  cursor: reportSubmitting ? 'not-allowed' : 'pointer',
                  opacity: reportSubmitting ? 0.6 : 1,
                  fontSize: '0.83rem',
                  fontWeight: 700,
                }}
              >
                Report
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
