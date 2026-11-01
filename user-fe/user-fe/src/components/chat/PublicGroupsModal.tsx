'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Globe, Search, Users, UserPlus, Check, Loader2, X, Plus } from 'lucide-react';
import * as dmApi from '@/lib/api/dm';
import type { DmConversation, GroupDetail } from '@/types/dm';

interface PublicGroupsModalProps {
  onClose: () => void;
  onJoined: (conv: DmConversation) => void;
  onCreateNew: () => void;
}

export default function PublicGroupsModal({
  onClose,
  onJoined,
  onCreateNew,
}: PublicGroupsModalProps) {
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<GroupDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const fetchGroups = useCallback(async (q = '') => {
    setLoading(true);
    try {
      const res = await dmApi.getPublicGroups({ q: q.trim() || undefined, limit: 30 });
      setGroups(res.items || []);
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchGroups(query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, fetchGroups]);

  async function handleJoin(group: GroupDetail) {
    setJoiningId(group.id);
    try {
      await dmApi.joinGroup(group.id);

      const conv: DmConversation = {
        id: group.id,
        kind: 'GROUP',
        folder: 'GROUPS',
        displayName: group.name,
        group: {
          id: group.id,
          name: group.name,
          imageUrl: group.imageUrl,
          memberCount: (group.memberCount ?? 0) + 1,
        },
        unreadCount: 0,
        isPinned: false,
        notificationsOff: false,
        updatedAt: new Date().toISOString(),
      };

      onJoined(conv);
    } catch (err: any) {
      alert(err?.message || 'Failed to join group');
    } finally {
      setJoiningId(null);
    }
  }

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
          maxWidth: '520px',
          background: 'var(--bg-card, #11141c)',
          border: '1px solid var(--border-color, #232734)',
          borderRadius: '14px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '85vh',
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
            <Globe size={20} style={{ color: '#06b6d4' }} />
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
              Discover Public Groups
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

        {/* Search bar & create button */}
        <div
          style={{
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--border-color, #232734)',
            display: 'flex',
            gap: '0.65rem',
          }}
        >
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
            <Search size={16} style={{ color: 'var(--text-muted, #94a3b8)' }} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search public groups by name..."
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
            onClick={onCreateNew}
            style={{
              padding: '0.6rem 0.9rem',
              background: 'rgba(6, 182, 212, 0.15)',
              border: '1px solid rgba(6, 182, 212, 0.3)',
              borderRadius: '8px',
              color: '#22d3ee',
              fontWeight: 600,
              fontSize: '0.8rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              whiteSpace: 'nowrap',
            }}
          >
            <Plus size={15} /> New Group
          </button>
        </div>

        {/* Groups list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem', minHeight: '260px' }}>
          {loading ? (
            <div
              style={{
                padding: '3rem',
                textAlign: 'center',
                color: 'var(--text-muted, #94a3b8)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <Loader2 size={24} className="animate-spin" />
              <span style={{ fontSize: '0.85rem' }}>Finding groups...</span>
            </div>
          ) : groups.length === 0 ? (
            <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-muted, #94a3b8)', fontSize: '0.875rem' }}>
              {query ? `No public groups matching "${query}"` : 'No public groups available at the moment.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              {groups.map((group) => (
                <div
                  key={group.id}
                  style={{
                    padding: '0.9rem 1rem',
                    background: 'var(--bg-input, #161922)',
                    border: '1px solid var(--border-color, #232734)',
                    borderRadius: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '1rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0, flex: 1 }}>
                    {group.imageUrl ? (
                      <img
                        src={group.imageUrl}
                        alt={group.name}
                        style={{ width: '38px', height: '38px', borderRadius: '50%', objectFit: 'cover' }}
                      />
                    ) : (
                      <div
                        style={{
                          width: '38px',
                          height: '38px',
                          borderRadius: '50%',
                          background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#fff',
                          fontWeight: 700,
                          fontSize: '0.85rem',
                          flexShrink: 0,
                        }}
                      >
                        {group.name.slice(0, 2).toUpperCase()}
                      </div>
                    )}

                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {group.name}
                      </div>
                      {group.description && (
                        <div
                          style={{
                            fontSize: '0.775rem',
                            color: 'var(--text-muted, #94a3b8)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            marginTop: '2px',
                          }}
                        >
                          {group.description}
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.725rem', color: 'var(--text-muted, #94a3b8)', marginTop: '3px' }}>
                        <Users size={12} />
                        {group.memberCount ?? 1} member{(group.memberCount ?? 1) !== 1 ? 's' : ''}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => handleJoin(group)}
                    disabled={joiningId === group.id}
                    style={{
                      padding: '0.5rem 0.9rem',
                      background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
                      border: 'none',
                      borderRadius: '7px',
                      color: '#fff',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: joiningId === group.id ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {joiningId === group.id ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <UserPlus size={13} />
                    )}
                    Join
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
