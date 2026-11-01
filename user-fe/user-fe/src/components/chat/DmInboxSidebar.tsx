'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  MessageSquare,
  Plus,
  Search,
  Pin,
  Users,
  BellOff,
  MoreVertical,
  ChevronRight,
} from 'lucide-react';
import type { DmConversation, DmFolder, DmUnread } from '@/types/dm';
import * as dmApi from '@/lib/api/dm';

// ─── Avatar helpers ────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Conversation avatar ───────────────────────────────────────────────────────

function ConvAvatar({
  conv,
  size = 38,
}: {
  conv: DmConversation;
  size?: number;
}) {
  const isGroup = conv.kind === 'GROUP';
  const name = conv.displayName;
  const isOnline = !isGroup && conv.peer?.isOnline;

  return (
    <div className="dm-conv-avatar">
      {isGroup ? (
        <div
          className="group-avatar-circle"
          style={{ width: size, height: size }}
        >
          {initials(name)}
        </div>
      ) : (
        <div
          className="dm-avatar-circle"
          style={{ width: size, height: size }}
        >
          {initials(name)}
        </div>
      )}
      {isOnline && <span className="dm-avatar-online-dot" />}
    </div>
  );
}

// ─── Single conversation row ───────────────────────────────────────────────────

interface ConvItemProps {
  conv: DmConversation;
  isActive: boolean;
  isRequestsTab: boolean;
  onClick: () => void;
  onAccept?: () => void;
  onDecline?: () => void;
}

function ConvItem({
  conv,
  isActive,
  isRequestsTab,
  onClick,
  onAccept,
  onDecline,
}: ConvItemProps) {
  const preview = conv.lastMessage
    ? conv.lastMessage.isRetracted
      ? '[Message retracted]'
      : conv.lastMessage.content
    : 'No messages yet';

  return (
    <div
      className={`dm-conv-item${isActive ? ' active' : ''}`}
      onClick={onClick}
      id={`dm-conv-${conv.id}`}
    >
      <ConvAvatar conv={conv} />

      <div className="dm-conv-body">
        <div className="dm-conv-name-row">
          <span className="dm-conv-name">{conv.displayName}</span>
          {conv.lastMessage && (
            <span className="dm-conv-time">
              {formatTime(conv.lastMessage.createdAt)}
            </span>
          )}
        </div>

        <div className="dm-conv-preview-row">
          <span
            className={`dm-conv-preview${conv.unreadCount > 0 ? ' unread' : ''}`}
          >
            {preview}
          </span>

          {/* Requests tab: inline accept/decline */}
          {isRequestsTab ? (
            <div className="dm-request-actions" onClick={(e) => e.stopPropagation()}>
              <button
                className="dm-request-accept-btn"
                onClick={onAccept}
                title="Accept request"
              >
                Accept
              </button>
              <button
                className="dm-request-decline-btn"
                onClick={onDecline}
                title="Decline request"
              >
                Decline
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              {conv.isPinned && (
                <Pin size={11} className="dm-conv-pin-icon" />
              )}
              {conv.notificationsOff && (
                <BellOff size={11} style={{ color: 'var(--text-muted)', opacity: 0.6 }} />
              )}
              {conv.unreadCount > 0 && (
                <span className="dm-conv-unread-badge">
                  {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── DmInboxSidebar ────────────────────────────────────────────────────────────

export interface DmInboxSidebarProps {
  /** Currently selected conversation id. */
  activeConvId: string | null;
  /** Called when user clicks a conversation. */
  onSelectConversation: (conv: DmConversation) => void;
  /** Open the "new DM" search modal. */
  onNewDm: () => void;
  /** Unread totals (for tab badges). Refreshed externally by socket events. */
  unread: DmUnread;
  /** Called when unread count changes (e.g. after accept/decline). */
  onUnreadChange?: (unread: DmUnread) => void;
  /** Bumped by the panel when a message or conversation change arrives over the socket. */
  refreshKey?: number;
}

const FOLDERS: { key: DmFolder; label: string }[] = [
  { key: 'PRIMARY', label: 'Primary' },
  { key: 'GENERAL', label: 'General' },
  { key: 'GROUPS', label: 'Groups' },
  { key: 'MERCHANT', label: 'Merchant' },
  { key: 'CHANNELS', label: 'Channels' },
  { key: 'REQUESTS', label: 'Requests' },
];

export default function DmInboxSidebar({
  activeConvId,
  onSelectConversation,
  onNewDm,
  unread,
  onUnreadChange,
  refreshKey = 0,
}: DmInboxSidebarProps) {
  const [folder, setFolder] = useState<DmFolder>('PRIMARY');
  const [conversations, setConversations] = useState<DmConversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The Merchant folder exists only for site owners: shown once it holds a conversation.
  const [hasMerchantFolder, setHasMerchantFolder] = useState(false);
  // "sorted separately by apps": the merchant folder's apps and the one picked (null = all).
  const [merchantApps, setMerchantApps] = useState<Awaited<ReturnType<typeof dmApi.getMerchantApps>>>([]);
  const [appId, setAppId] = useState<string | null>(null);

  useEffect(() => {
    if (folder !== 'MERCHANT') return;
    dmApi
      .getMerchantApps()
      .then(setMerchantApps)
      .catch(() => setMerchantApps([]));
  }, [folder, refreshKey]);

  useEffect(() => {
    dmApi
      .getConversations('MERCHANT', { limit: 1 })
      .then((page) => setHasMerchantFolder(page.items.length > 0))
      .catch(() => setHasMerchantFolder(false));
  }, [refreshKey]);

  const load = useCallback(
    async (reset = false) => {
      if (loading) return;
      setLoading(true);
      setError(null);
      try {
        const cursor = reset ? null : nextCursor;
        const res = await dmApi.getConversations(folder, {
          limit: 30,
          cursor,
          appId: folder === 'MERCHANT' ? appId : null,
        });
        setConversations((prev) =>
          reset ? res.items : [...prev, ...res.items],
        );
        setNextCursor(res.nextCursor);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to load conversations');
      } finally {
        setLoading(false);
      }
    },
    [folder, appId, loading, nextCursor],
  );

  // Reload when the folder or app changes, or when a message or conversation change arrives (refreshKey).
  useEffect(() => {
    if (refreshKey === 0) setConversations([]);
    setNextCursor(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, appId, refreshKey]);

  // Infinite scroll
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const handler = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80 && nextCursor) {
        void load(false);
      }
    };
    el.addEventListener('scroll', handler, { passive: true });
    return () => el.removeEventListener('scroll', handler);
  }, [load, nextCursor]);

  // Accept / decline DM requests
  async function handleAccept(conv: DmConversation) {
    try {
      await dmApi.acceptRequest(conv.id);
      setConversations((prev) => prev.filter((c) => c.id !== conv.id));
      if (onUnreadChange) {
        const u = await dmApi.getUnread();
        onUnreadChange(u);
      }
    } catch {
      // ignore
    }
  }

  async function handleDecline(conv: DmConversation) {
    try {
      await dmApi.declineRequest(conv.id);
      setConversations((prev) => prev.filter((c) => c.id !== conv.id));
    } catch {
      // ignore
    }
  }

  const tabBadge = (f: DmFolder): number => {
    switch (f) {
      case 'PRIMARY': return unread.primary;
      case 'GENERAL': return unread.general;
      case 'GROUPS': return unread.groups;
      case 'MERCHANT': return unread.merchant;
      case 'CHANNELS': return unread.channels;
      case 'REQUESTS': return unread.requests;
    }
  };

  return (
    <div className="dm-sidebar">
      {/* Header */}
      <div className="dm-sidebar-header">
        <span className="dm-sidebar-title">Messages</span>
        <button
          className="dm-new-btn"
          onClick={onNewDm}
          title="New direct message"
          id="dm-new-message-btn"
        >
          <Plus size={15} />
        </button>
      </div>

      {/* Folder tabs */}
      <div className="dm-folder-tabs">
        {FOLDERS.filter(({ key }) => key !== 'MERCHANT' || hasMerchantFolder).map(({ key, label }) => {
          const badge = tabBadge(key);
          return (
            <div
              key={key}
              className={`dm-folder-tab${folder === key ? ' active' : ''}`}
              onClick={() => setFolder(key)}
              id={`dm-folder-tab-${key.toLowerCase()}`}
            >
              {label}
              {badge > 0 && (
                <span className="dm-folder-tab-badge">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Merchant folder: one chip per app */}
      {folder === 'MERCHANT' && merchantApps.some((a) => a.appId) && (
        <div className="dm-folder-tabs" style={{ flexWrap: 'wrap' }}>
          <div className={`dm-folder-tab${appId === null ? ' active' : ''}`} onClick={() => setAppId(null)}>
            All apps
          </div>
          {merchantApps
            .filter((a): a is typeof a & { appId: string } => a.appId !== null)
            .map((a) => (
              <div
                key={a.appId}
                className={`dm-folder-tab${appId === a.appId ? ' active' : ''}`}
                onClick={() => setAppId(a.appId)}
              >
                {a.name ?? a.appId}
                {a.unread > 0 && <span className="dm-folder-tab-badge">{a.unread > 99 ? '99+' : a.unread}</span>}
              </div>
            ))}
        </div>
      )}

      {/* List */}
      <div className="dm-conv-list" ref={listRef}>
        {error && (
          <div
            style={{
              padding: '1rem',
              color: 'var(--color-danger)',
              fontSize: '0.8rem',
              textAlign: 'center',
            }}
          >
            {error}
          </div>
        )}

        {!loading && conversations.length === 0 && !error && (
          <div className="dm-empty-state">
            <div className="dm-empty-icon">
              <MessageSquare size={22} />
            </div>
            <p className="dm-empty-title">
              {folder === 'REQUESTS' ? 'No requests' : 'No messages'}
            </p>
            <p className="dm-empty-sub">
              {folder === 'REQUESTS'
                ? "DM requests from people you haven't chatted with will appear here."
                : 'Start a conversation by clicking the + button above.'}
            </p>
          </div>
        )}

        {conversations.map((conv) => (
          <ConvItem
            key={conv.id}
            conv={conv}
            isActive={activeConvId === conv.id}
            isRequestsTab={folder === 'REQUESTS'}
            onClick={() => onSelectConversation(conv)}
            onAccept={() => void handleAccept(conv)}
            onDecline={() => void handleDecline(conv)}
          />
        ))}

        {loading && (
          <div
            style={{
              padding: '0.75rem',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: '0.75rem',
            }}
          >
            Loading…
          </div>
        )}

        {nextCursor && !loading && (
          <div
            style={{
              padding: '0.5rem',
              textAlign: 'center',
            }}
          >
            <button
              style={{
                background: 'none',
                border: 'none',
                color: '#818cf8',
                fontSize: '0.75rem',
                cursor: 'pointer',
              }}
              onClick={() => void load(false)}
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
