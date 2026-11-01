'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  MessageSquare,
  Users,
  Compass,
  Mail,
  Shield,
  X,
  Plus,
  ArrowLeft,
  Search,
} from 'lucide-react';
import type { DmConversation, DmUnread } from '@/types/dm';
import type { User as CurrentUser } from '@/types/chat';
import type { ChatSocket } from '@/lib/socket';
import * as dmApi from '@/lib/api/dm';
import DmInboxSidebar from './DmInboxSidebar';
import DmConversationView from './DmConversationView';
import DmSearchModal from './DmSearchModal';
import GiftModal from './GiftModal';
import CreateGroupModal from './CreateGroupModal';
import PublicGroupsModal from './PublicGroupsModal';
import GroupInvitesModal from './GroupInvitesModal';
import DmPrivacySettingsModal from './DmPrivacySettingsModal';

export interface DmPanelProps {
  currentUser: CurrentUser | null;
  socket: ChatSocket | null;
  onClose: () => void;
  initialConversationId?: string;
}

export default function DmPanel({
  currentUser,
  socket,
  onClose,
  initialConversationId,
}: DmPanelProps) {
  const [activeConv, setActiveConv] = useState<DmConversation | null>(null);
  const [unread, setUnread] = useState<DmUnread>({
    total: 0,
    primary: 0,
    general: 0,
    groups: 0,
    merchant: 0,
    channels: 0,
    requests: 0,
  });
  const [refreshKey, setRefreshKey] = useState(0);

  // Modals state
  const [showSearch, setShowSearch] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showPublicGroups, setShowPublicGroups] = useState(false);
  const [showGroupInvites, setShowGroupInvites] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [giftConv, setGiftConv] = useState<DmConversation | null>(null);

  // Fetch unread counts
  const refreshUnread = useCallback(async () => {
    try {
      const data = await dmApi.getUnread();
      if (data) setUnread(data);
    } catch {}
  }, []);

  useEffect(() => {
    refreshUnread();
  }, [refreshUnread]);

  // Load initial conversation if provided
  useEffect(() => {
    if (initialConversationId) {
      dmApi
        .getConversation(initialConversationId)
        .then((detail) => {
          if (detail) {
            setActiveConv({
              id: detail.id,
              kind: detail.kind,
              folder: detail.folder,
              displayName: detail.displayName,
              peer: detail.peer,
              group: detail.group,
              nickname: detail.nickname,
              unreadCount: 0,
              isPinned: detail.isPinned,
              notificationsOff: detail.notificationsOff,
              updatedAt: detail.updatedAt,
            });
          }
        })
        .catch(() => {});
    }
  }, [initialConversationId]);

  // Socket event listeners for real-time updates
  useEffect(() => {
    if (!socket) return;

    // A message, request or conversation change: badges and the open inbox tab refresh.
    const handleChange = () => {
      refreshUnread();
      setRefreshKey((k) => k + 1);
    };
    const handleDmRead = () => {
      refreshUnread();
    };

    socket.on('dm_message', handleChange);
    socket.on('dm_request', handleChange);
    socket.on('dm_conversation_updated', handleChange);
    socket.on('dm_read', handleDmRead);

    return () => {
      socket.off('dm_message', handleChange);
      socket.off('dm_request', handleChange);
      socket.off('dm_conversation_updated', handleChange);
      socket.off('dm_read', handleDmRead);
    };
  }, [socket, refreshUnread]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        background: 'var(--bg-main, #0b0d13)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Top Bar with actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.65rem 1rem',
          background: 'var(--bg-card, #11141c)',
          borderBottom: '1px solid var(--border-color, #232734)',
          flexShrink: 0,
          zIndex: 5,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          {activeConv && (
            <button
              onClick={() => setActiveConv(null)}
              className="md:hidden"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-muted, #94a3b8)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                padding: '0.25rem',
              }}
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <MessageSquare size={18} style={{ color: '#818cf8' }} />
            <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fff' }}>
              Direct Messages & Groups
            </span>
            {unread.total > 0 && (
              <span
                style={{
                  background: '#6366f1',
                  color: '#fff',
                  fontSize: '0.65rem',
                  fontWeight: 800,
                  padding: '0.15rem 0.45rem',
                  borderRadius: '10px',
                }}
              >
                {unread.total}
              </span>
            )}
          </div>
        </div>

        {/* Global Toolbar buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <button
            onClick={() => setShowPublicGroups(true)}
            title="Discover Public Groups"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border-color, #232734)',
              borderRadius: '7px',
              color: 'var(--text-muted, #94a3b8)',
              padding: '0.4rem 0.6rem',
              fontSize: '0.75rem',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            <Compass size={14} style={{ color: '#06b6d4' }} />
            <span className="hidden sm:inline">Explore Groups</span>
          </button>

          <button
            onClick={() => setShowGroupInvites(true)}
            title="Group Invites"
            style={{
              position: 'relative',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border-color, #232734)',
              borderRadius: '7px',
              color: 'var(--text-muted, #94a3b8)',
              padding: '0.4rem 0.6rem',
              fontSize: '0.75rem',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            <Mail size={14} style={{ color: '#f59e0b' }} />
            <span className="hidden sm:inline">Invites</span>
          </button>

          <button
            onClick={() => setShowPrivacy(true)}
            title="Privacy Settings"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border-color, #232734)',
              borderRadius: '7px',
              color: 'var(--text-muted, #94a3b8)',
              padding: '0.4rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Shield size={15} />
          </button>

          <button
            onClick={onClose}
            title="Close DMs"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid var(--border-color, #232734)',
              borderRadius: '7px',
              color: 'var(--text-muted, #94a3b8)',
              padding: '0.4rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginLeft: '0.25rem',
            }}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Main Split Body */}
      <div
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Sidebar */}
        <div
          style={{
            width: activeConv ? '320px' : '100%',
            maxWidth: activeConv ? '340px' : 'none',
            display: activeConv ? 'none' : 'flex',
            flexDirection: 'column',
            height: '100%',
            borderRight: '1px solid var(--border-color, #232734)',
          }}
          className={activeConv ? 'hidden md:flex' : 'flex'}
        >
          <DmInboxSidebar
            refreshKey={refreshKey}
            activeConvId={activeConv?.id ?? null}
            onSelectConversation={(conv) => {
              setActiveConv(conv);
              refreshUnread();
            }}
            onNewDm={() => setShowSearch(true)}
            unread={unread}
            onUnreadChange={setUnread}
          />
        </div>

        {/* Conversation View or Empty State */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            minWidth: 0,
            background: 'var(--bg-main, #0b0d13)',
          }}
          className={!activeConv ? 'hidden md:flex' : 'flex'}
        >
          {activeConv ? (
            <DmConversationView
              key={activeConv.id}
              conv={activeConv}
              currentUser={currentUser}
              socket={socket}
              onClose={() => setActiveConv(null)}
              onGift={(c) => setGiftConv(c)}
              onChanged={() => {
                refreshUnread();
                setRefreshKey((k) => k + 1);
              }}
            />
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                padding: '2rem',
                textAlign: 'center',
                color: 'var(--text-muted, #94a3b8)',
                gap: '1rem',
              }}
            >
              <div
                style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '50%',
                  background: 'rgba(99, 102, 241, 0.1)',
                  border: '1px solid rgba(99, 102, 241, 0.25)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#818cf8',
                }}
              >
                <MessageSquare size={30} />
              </div>

              <div>
                <h3 style={{ margin: '0 0 0.4rem', color: '#fff', fontSize: '1.1rem' }}>
                  No Conversation Selected
                </h3>
                <p style={{ margin: 0, fontSize: '0.85rem', maxWidth: '340px', lineHeight: 1.5 }}>
                  Choose a chat from the inbox list or start a new message to get connected.
                </p>
              </div>

              <div style={{ display: 'flex', gap: '0.65rem', marginTop: '0.5rem' }}>
                <button
                  onClick={() => setShowSearch(true)}
                  style={{
                    padding: '0.6rem 1.15rem',
                    background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                    border: 'none',
                    borderRadius: '8px',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '0.825rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}
                >
                  <Plus size={15} /> New Message
                </button>
                <button
                  onClick={() => setShowCreateGroup(true)}
                  style={{
                    padding: '0.6rem 1.15rem',
                    background: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid var(--border-color, #232734)',
                    borderRadius: '8px',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '0.825rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}
                >
                  <Users size={15} /> Create Group
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showSearch && (
        <DmSearchModal
          onSelect={(conv: DmConversation) => {
            setActiveConv(conv);
            setShowSearch(false);
          }}
          onClose={() => setShowSearch(false)}
        />
      )}

      {showCreateGroup && (
        <CreateGroupModal
          onClose={() => setShowCreateGroup(false)}
          onCreated={(conv) => {
            setShowCreateGroup(false);
            setActiveConv(conv);
            refreshUnread();
          }}
        />
      )}

      {showPublicGroups && (
        <PublicGroupsModal
          onClose={() => setShowPublicGroups(false)}
          onJoined={(conv) => {
            setShowPublicGroups(false);
            setActiveConv(conv);
            refreshUnread();
          }}
          onCreateNew={() => {
            setShowPublicGroups(false);
            setShowCreateGroup(true);
          }}
        />
      )}

      {showGroupInvites && (
        <GroupInvitesModal
          onClose={() => setShowGroupInvites(false)}
          onAccepted={() => {
            refreshUnread();
          }}
        />
      )}

      {showPrivacy && (
        <DmPrivacySettingsModal onClose={() => setShowPrivacy(false)} />
      )}

      {giftConv && (
        <GiftModal
          dmConversation={giftConv}
          onClose={() => setGiftConv(null)}
        />
      )}
    </div>
  );
}
