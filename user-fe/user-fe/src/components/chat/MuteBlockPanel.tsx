'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { VolumeX, ShieldAlert, X, UserMinus, UserPlus, Loader2, Search, AlertTriangle } from 'lucide-react';
import * as socialApi from '@/lib/api/social';
import { getMyWarnings, type MyWarning } from '@/lib/api/messages';
import type { RelationUser } from '@/types/dm';

interface MuteBlockPanelProps {
  onClose: () => void;
}

export default function MuteBlockPanel({ onClose }: MuteBlockPanelProps) {
  const [activeTab, setActiveTab] = useState<'mutes' | 'blocks' | 'warnings'>('mutes');
  // Module 4: the warnings I received from moderators or auto-moderation (never who issued them).
  const [warnings, setWarnings] = useState<MyWarning[]>([]);
  const [mutedUsers, setMutedUsers] = useState<RelationUser[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<RelationUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [inputHandle, setInputHandle] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  const fetchLists = useCallback(async () => {
    setLoading(true);
    try {
      const [mutesRes, blocksRes, myWarnings] = await Promise.all([
        socialApi.getMutedUsers({ limit: 50 }).catch(() => ({ items: [] })),
        socialApi.getBlockedUsers({ limit: 50 }).catch(() => ({ items: [] })),
        getMyWarnings().catch(() => [] as MyWarning[]),
      ]);
      setMutedUsers(mutesRes.items || []);
      setBlockedUsers(blocksRes.items || []);
      setWarnings(myWarnings);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLists();
  }, [fetchLists]);

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    const handle = inputHandle.trim().replace(/^@/, '');
    if (!handle) return;
    setInputError(null);
    setActionLoading(`add-${handle}`);
    try {
      if (activeTab === 'mutes') {
        await socialApi.muteUser(handle);
      } else {
        await socialApi.blockUser(handle);
      }
      setInputHandle('');
      await fetchLists();
    } catch (err: any) {
      setInputError(err?.message || `Failed to ${activeTab === 'mutes' ? 'mute' : 'block'} user`);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRemove(handle: string) {
    setActionLoading(handle);
    try {
      if (activeTab === 'mutes') {
        await socialApi.unmuteUser(handle);
      } else {
        await socialApi.unblockUser(handle);
      }
      await fetchLists();
    } catch (err: any) {
      alert(err?.message || 'Action failed');
    } finally {
      setActionLoading(null);
    }
  }

  const currentList = activeTab === 'mutes' ? mutedUsers : blockedUsers;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '480px',
          background: 'var(--bg-card, #11141c)',
          border: '1px solid var(--border-color, #232734)',
          borderRadius: '14px',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '85vh',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '1.25rem 1.5rem',
            borderBottom: '1px solid var(--border-color, #232734)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            {activeTab === 'mutes' ? (
              <VolumeX size={20} style={{ color: '#f59e0b' }} />
            ) : (
              <ShieldAlert size={20} style={{ color: '#ef4444' }} />
            )}
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
              Privacy & Moderation
            </h3>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted, #94a3b8)',
              cursor: 'pointer',
              padding: '0.25rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab selection */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-color, #232734)',
            padding: '0 1rem',
            background: 'rgba(0,0,0,0.15)',
          }}
        >
          <button
            onClick={() => setActiveTab('mutes')}
            style={{
              padding: '0.85rem 1.25rem',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'mutes' ? '2px solid #f59e0b' : '2px solid transparent',
              color: activeTab === 'mutes' ? '#fff' : 'var(--text-muted, #94a3b8)',
              fontWeight: activeTab === 'mutes' ? 600 : 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.875rem',
            }}
          >
            <VolumeX size={16} />
            Muted Users ({mutedUsers.length})
          </button>
          <button
            onClick={() => setActiveTab('blocks')}
            style={{
              padding: '0.85rem 1.25rem',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'blocks' ? '2px solid #ef4444' : '2px solid transparent',
              color: activeTab === 'blocks' ? '#fff' : 'var(--text-muted, #94a3b8)',
              fontWeight: activeTab === 'blocks' ? 600 : 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.875rem',
            }}
          >
            <ShieldAlert size={16} />
            Blocked Users ({blockedUsers.length})
          </button>
          <button
            onClick={() => setActiveTab('warnings')}
            style={{
              padding: '0.85rem 1.25rem',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'warnings' ? '2px solid #fbbf24' : '2px solid transparent',
              color: activeTab === 'warnings' ? '#fff' : 'var(--text-muted, #94a3b8)',
              fontWeight: activeTab === 'warnings' ? 600 : 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.875rem',
            }}
          >
            <AlertTriangle size={16} />
            My Warnings ({warnings.length})
          </button>
        </div>

        {/* Add user form */}
        {activeTab !== 'warnings' && (
        <form
          onSubmit={handleAddUser}
          style={{
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--border-color, #232734)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                background: 'var(--bg-input, #0d0f15)',
                border: '1px solid var(--border-color, #232734)',
                borderRadius: '8px',
                padding: '0 0.75rem',
              }}
            >
              <Search size={15} style={{ color: 'var(--text-muted, #94a3b8)' }} />
              <input
                type="text"
                value={inputHandle}
                onChange={(e) => setInputHandle(e.target.value)}
                placeholder={`Enter username to ${activeTab === 'mutes' ? 'mute' : 'block'}...`}
                style={{
                  width: '100%',
                  padding: '0.6rem 0',
                  background: 'none',
                  border: 'none',
                  color: '#fff',
                  fontSize: '0.875rem',
                  outline: 'none',
                }}
              />
            </div>
            <button
              type="submit"
              disabled={!inputHandle.trim() || !!actionLoading}
              style={{
                padding: '0.6rem 1rem',
                background: activeTab === 'mutes' ? '#d97706' : '#dc2626',
                border: 'none',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: !inputHandle.trim() || !!actionLoading ? 'not-allowed' : 'pointer',
                opacity: !inputHandle.trim() || !!actionLoading ? 0.6 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              {actionLoading?.startsWith('add-') ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <UserPlus size={15} />
              )}
              {activeTab === 'mutes' ? 'Mute' : 'Block'}
            </button>
          </div>
          {inputError && (
            <span style={{ fontSize: '0.775rem', color: '#ef4444' }}>{inputError}</span>
          )}
        </form>
        )}

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem 1.25rem', minHeight: '220px' }}>
          {loading ? (
            <div
              style={{
                padding: '2.5rem',
                textAlign: 'center',
                color: 'var(--text-muted, #94a3b8)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <Loader2 size={24} className="animate-spin" />
              <span style={{ fontSize: '0.85rem' }}>Loading users...</span>
            </div>
          ) : activeTab === 'warnings' ? (
            warnings.length === 0 ? (
              <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-muted, #94a3b8)', fontSize: '0.875rem' }}>
                You have no warnings.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {warnings.map((w) => (
                  <div
                    key={w.id}
                    style={{
                      padding: '0.65rem 0.85rem',
                      background: 'rgba(251,191,36,0.06)',
                      borderRadius: '8px',
                      border: '1px solid rgba(251,191,36,0.25)',
                    }}
                  >
                    <div style={{ fontSize: '0.85rem', color: '#fde68a' }}>{w.reason}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted, #94a3b8)' }}>
                      {new Date(w.createdAt).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : currentList.length === 0 ? (
            <div
              style={{
                padding: '3rem 1rem',
                textAlign: 'center',
                color: 'var(--text-muted, #94a3b8)',
                fontSize: '0.875rem',
              }}
            >
              No {activeTab === 'mutes' ? 'muted' : 'blocked'} users found.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {currentList.map((user) => (
                <div
                  key={user.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.65rem 0.85rem',
                    background: 'var(--bg-input, #161922)',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color, #232734)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div
                      style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '50%',
                        background: 'linear-gradient(135deg, #4f46e5, #06b6d4)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 700,
                        fontSize: '0.8rem',
                        color: '#fff',
                      }}
                    >
                      {user.username.slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.875rem', color: '#fff' }}>
                        @{user.username}
                      </div>
                      {user.createdAt && (
                        <div style={{ fontSize: '0.725rem', color: 'var(--text-muted, #94a3b8)' }}>
                          Since {new Date(user.createdAt).toLocaleDateString()}
                        </div>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => handleRemove(user.username)}
                    disabled={actionLoading === user.username}
                    style={{
                      padding: '0.45rem 0.75rem',
                      background: 'rgba(255, 255, 255, 0.06)',
                      border: '1px solid var(--border-color, #232734)',
                      borderRadius: '6px',
                      color: '#fff',
                      fontSize: '0.8rem',
                      cursor: actionLoading === user.username ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {actionLoading === user.username ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <UserMinus size={13} />
                    )}
                    {activeTab === 'mutes' ? 'Unmute' : 'Unblock'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer info */}
        <div
          style={{
            padding: '0.75rem 1.25rem',
            background: 'rgba(0,0,0,0.25)',
            borderTop: '1px solid var(--border-color, #232734)',
            fontSize: '0.75rem',
            color: 'var(--text-muted, #94a3b8)',
          }}
        >
          {activeTab === 'warnings'
            ? 'Repeated rule breaks move you up the penalty sequence (warning, then timed bans); a level resets after the time the admin set.'
            : activeTab === 'mutes'
            ? 'Muted users can still see your messages, but you will not receive their chat messages.'
            : 'Blocked users cannot see your profile, send you direct messages, or message you in chat.'}
        </div>
      </div>
    </div>
  );
}
