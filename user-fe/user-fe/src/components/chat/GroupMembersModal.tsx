'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Users,
  X,
  UserPlus,
  Shield,
  ShieldCheck,
  MoreVertical,
  Clock,
  UserX,
  Ban,
  Loader2,
  Search,
} from 'lucide-react';
import * as dmApi from '@/lib/api/dm';
import type { DmConversation, GroupMember, GroupRole } from '@/types/dm';

interface GroupMembersModalProps {
  conv: DmConversation;
  onClose: () => void;
  onMemberChanged?: () => void;
}

export default function GroupMembersModal({
  conv,
  onClose,
  onMemberChanged,
}: GroupMembersModalProps) {
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [memberCount, setMemberCount] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [inviteInput, setInviteInput] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Selected member for sub-action menu
  const [activeMenuMemberId, setActiveMenuMemberId] = useState<string | null>(null);
  const [timeoutModalMember, setTimeoutModalMember] = useState<GroupMember | null>(null);
  const [timeoutMinutes, setTimeoutMinutes] = useState(15);

  const loadMembers = useCallback(async () => {
    setLoading(true);
    try {
      const page = await dmApi.getGroupMembers(conv.id);
      setMembers(page.items);
      setNextCursor(page.nextCursor);
      setMemberCount(page.memberCount);
    } catch {
      setMembers([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [conv.id]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await dmApi.getGroupMembers(conv.id, { cursor: nextCursor });
      setMembers((prev) => [...prev, ...page.items.filter((m) => !prev.some((p) => p.userId === m.userId))]);
      setNextCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const target = inviteInput.trim().replace(/^@/, '');
    if (!target) return;
    setInviting(true);
    setInviteSuccess(false);
    try {
      await dmApi.inviteToGroup(conv.id, [target]);
      setInviteInput('');
      setInviteSuccess(true);
      setTimeout(() => setInviteSuccess(false), 2500);
      loadMembers();
    } catch (err: any) {
      alert(err?.message || 'Failed to send invite');
    } finally {
      setInviting(false);
    }
  }

  async function handleRoleChange(userId: string, role: GroupRole) {
    setActionLoading(userId);
    try {
      if (role === 'OWNER') throw new Error('Ownership moves only by transfer (group settings)');
      await dmApi.setMemberRole(conv.id, userId, role);
      setActiveMenuMemberId(null);
      await loadMembers();
      onMemberChanged?.();
    } catch (err: any) {
      alert(err?.message || 'Failed to update member role');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRemoveMember(userId: string) {
    if (!confirm('Are you sure you want to remove this member?')) return;
    setActionLoading(userId);
    try {
      await dmApi.removeMember(conv.id, userId);
      setActiveMenuMemberId(null);
      await loadMembers();
      onMemberChanged?.();
    } catch (err: any) {
      alert(err?.message || 'Failed to remove member');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleApplyTimeout() {
    if (!timeoutModalMember) return;
    setActionLoading(timeoutModalMember.userId);
    try {
      await dmApi.timeoutMember(conv.id, timeoutModalMember.userId, timeoutMinutes);
      setTimeoutModalMember(null);
      await loadMembers();
      onMemberChanged?.();
    } catch (err: any) {
      alert(err?.message || 'Failed to timeout member');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleBanMember(userId: string) {
    if (!confirm('Are you sure you want to ban this member from the group?')) return;
    setActionLoading(userId);
    try {
      await dmApi.banMember(conv.id, userId, { banned: true, reason: 'Banned by a group admin' });
      setActiveMenuMemberId(null);
      await loadMembers();
      onMemberChanged?.();
    } catch (err: any) {
      alert(err?.message || 'Failed to ban member');
    } finally {
      setActionLoading(null);
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
            <Users size={20} style={{ color: '#06b6d4' }} />
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
              Group Members ({memberCount || members.length})
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

        {/* Invite input row */}
        <form
          onSubmit={handleInvite}
          style={{
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--border-color, #232734)',
            display: 'flex',
            gap: '0.5rem',
          }}
        >
          <input
            type="text"
            value={inviteInput}
            onChange={(e) => setInviteInput(e.target.value)}
            placeholder="Invite user by username or ID..."
            style={{
              flex: 1,
              background: 'var(--bg-input, #0d0f15)',
              border: '1px solid var(--border-color, #232734)',
              borderRadius: '8px',
              padding: '0.6rem 0.85rem',
              color: '#fff',
              fontSize: '0.85rem',
              outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={inviting || !inviteInput.trim()}
            style={{
              padding: '0.6rem 1rem',
              background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
              border: 'none',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: inviting || !inviteInput.trim() ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            {inviting ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            Invite
          </button>
        </form>

        {inviteSuccess && (
          <div
            style={{
              padding: '0.5rem 1.25rem',
              background: 'rgba(34, 197, 94, 0.15)',
              color: '#4ade80',
              fontSize: '0.8rem',
            }}
          >
            Invitation sent successfully!
          </div>
        )}

        {/* Member list */}
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
              <span style={{ fontSize: '0.85rem' }}>Loading group members...</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {members.map((m) => {
                const isMenuOpen = activeMenuMemberId === m.userId;
                return (
                  <div
                    key={m.userId}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.65rem 0.85rem',
                      background: 'var(--bg-input, #161922)',
                      border: '1px solid var(--border-color, #232734)',
                      borderRadius: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '50%',
                          background:
                            m.role === 'OWNER'
                              ? 'linear-gradient(135deg, #f59e0b, #d97706)'
                              : m.role === 'ADMIN'
                              ? 'linear-gradient(135deg, #06b6d4, #3b82f6)'
                              : 'linear-gradient(135deg, #6366f1, #4f46e5)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 700,
                          fontSize: '0.8rem',
                          color: '#fff',
                        }}
                      >
                        {m.username.slice(0, 2).toUpperCase()}
                      </div>

                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#fff' }}>
                            @{m.username}
                          </span>
                          <span
                            style={{
                              fontSize: '0.675rem',
                              padding: '0.15rem 0.4rem',
                              borderRadius: '4px',
                              fontWeight: 700,
                              background:
                                m.role === 'OWNER'
                                  ? 'rgba(245, 158, 11, 0.2)'
                                  : m.role === 'ADMIN'
                                  ? 'rgba(6, 182, 212, 0.2)'
                                  : 'rgba(255, 255, 255, 0.08)',
                              color:
                                m.role === 'OWNER'
                                  ? '#fbbf24'
                                  : m.role === 'ADMIN'
                                  ? '#22d3ee'
                                  : 'var(--text-muted, #94a3b8)',
                            }}
                          >
                            {m.role}
                          </span>
                          {m.timedOutUntil && (
                            <span
                              style={{
                                fontSize: '0.675rem',
                                color: '#f87171',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.2rem',
                              }}
                            >
                              <Clock size={11} /> Muted
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Action trigger */}
                    <div style={{ position: 'relative' }}>
                      <button
                        onClick={() =>
                          setActiveMenuMemberId((prev) => (prev === m.userId ? null : m.userId))
                        }
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--text-muted, #94a3b8)',
                          cursor: 'pointer',
                          padding: '0.35rem',
                          borderRadius: '4px',
                        }}
                      >
                        <MoreVertical size={16} />
                      </button>

                      {/* Dropdown Menu */}
                      {isMenuOpen && (
                        <div
                          style={{
                            position: 'absolute',
                            right: 0,
                            top: '100%',
                            marginTop: '4px',
                            width: '180px',
                            background: '#1a1e29',
                            border: '1px solid var(--border-color, #2e3446)',
                            borderRadius: '8px',
                            boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
                            zIndex: 10,
                            padding: '0.35rem',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.2rem',
                          }}
                        >
                          {m.role !== 'ADMIN' && m.role !== 'OWNER' && (
                            <button
                              onClick={() => handleRoleChange(m.userId, 'ADMIN')}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: '#22d3ee',
                                textAlign: 'left',
                                padding: '0.45rem 0.6rem',
                                fontSize: '0.775rem',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.4rem',
                              }}
                            >
                              <ShieldCheck size={14} /> Promote to Admin
                            </button>
                          )}
                          {m.role === 'ADMIN' && (
                            <button
                              onClick={() => handleRoleChange(m.userId, 'MEMBER')}
                              style={{
                                background: 'none',
                                border: 'none',
                                color: 'var(--text-muted, #94a3b8)',
                                textAlign: 'left',
                                padding: '0.45rem 0.6rem',
                                fontSize: '0.775rem',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.4rem',
                              }}
                            >
                              <Shield size={14} /> Demote to Member
                            </button>
                          )}

                          <button
                            onClick={() => {
                              setActiveMenuMemberId(null);
                              setTimeoutModalMember(m);
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: '#fbbf24',
                              textAlign: 'left',
                              padding: '0.45rem 0.6rem',
                              fontSize: '0.775rem',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.4rem',
                            }}
                          >
                            <Clock size={14} /> Timeout / Mute
                          </button>

                          <button
                            onClick={() => handleRemoveMember(m.userId)}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: '#ef4444',
                              textAlign: 'left',
                              padding: '0.45rem 0.6rem',
                              fontSize: '0.775rem',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.4rem',
                            }}
                          >
                            <UserX size={14} /> Remove Member
                          </button>

                          {conv.group?.visibility === 'PUBLIC' && (
                          <button
                            onClick={() => handleBanMember(m.userId)}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: '#dc2626',
                              textAlign: 'left',
                              padding: '0.45rem 0.6rem',
                              fontSize: '0.775rem',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.4rem',
                            }}
                          >
                            <Ban size={14} /> Ban from Group
                          </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {nextCursor && (
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={{ padding: '0.6rem', borderRadius: '8px', border: '1px solid var(--border-color, #232734)', background: 'rgba(255,255,255,0.04)', color: '#e2e8f0', cursor: 'pointer', fontSize: '0.85rem' }}
                >
                  {loadingMore ? 'Loading…' : 'Load more members'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Timeout Submodal */}
        {timeoutModalMember && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 10000,
              background: 'rgba(0,0,0,0.7)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '1rem',
            }}
          >
            <div
              style={{
                width: '100%',
                maxWidth: '360px',
                background: '#161922',
                border: '1px solid var(--border-color, #232734)',
                borderRadius: '12px',
                padding: '1.25rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.85rem',
              }}
            >
              <h4 style={{ margin: 0, color: '#fff', fontSize: '0.95rem' }}>
                Timeout @{timeoutModalMember.username}
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                {[5, 15, 60, 1440].map((mins) => (
                  <button
                    key={mins}
                    type="button"
                    onClick={() => setTimeoutMinutes(mins)}
                    style={{
                      padding: '0.5rem',
                      borderRadius: '6px',
                      border:
                        timeoutMinutes === mins
                          ? '1px solid #fbbf24'
                          : '1px solid var(--border-color, #232734)',
                      background:
                        timeoutMinutes === mins
                          ? 'rgba(251, 191, 36, 0.15)'
                          : 'rgba(255, 255, 255, 0.05)',
                      color: timeoutMinutes === mins ? '#fbbf24' : '#fff',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                    }}
                  >
                    {mins < 60 ? `${mins} minutes` : `${mins / 60} hour(s)`}
                  </button>
                ))}
              </div>


              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setTimeoutModalMember(null)}
                  style={{
                    flex: 1,
                    padding: '0.5rem',
                    borderRadius: '6px',
                    background: 'none',
                    border: '1px solid var(--border-color, #232734)',
                    color: 'var(--text-muted, #94a3b8)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApplyTimeout}
                  disabled={!!actionLoading}
                  style={{
                    flex: 1,
                    padding: '0.5rem',
                    borderRadius: '6px',
                    background: '#d97706',
                    border: 'none',
                    color: '#fff',
                    fontWeight: 600,
                    cursor: actionLoading ? 'not-allowed' : 'pointer',
                  }}
                >
                  Confirm Timeout
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
