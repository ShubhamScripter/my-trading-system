'use client';

import React, { useEffect, useState } from 'react';
import {
  Settings,
  X,
  Shield,
  Loader2,
  Check,
  LogOut,
  ArrowRightLeft,
  KeyRound,
  Lock,
  Globe,
  Trash2,
} from 'lucide-react';
import * as dmApi from '@/lib/api/dm';
import type { DmConversation, GroupMember, GroupPermissionKey, GroupRole, GroupType } from '@/types/dm';
import GroupLogoPicker from './GroupLogoPicker';

const ROLE_CHOICES: { role: GroupRole; label: string }[] = [
  { role: 'MEMBER', label: 'Everyone' },
  { role: 'SUB_ADMIN', label: 'Sub-admins and above' },
  { role: 'ADMIN', label: 'Admins and above' },
  { role: 'OWNER', label: 'Owner only' },
];

interface GroupSettingsModalProps {
  conv: DmConversation;
  onClose: () => void;
  onUpdated: () => void;
  onLeftGroup: () => void;
}

const ALL_PERMISSIONS: { key: GroupPermissionKey; label: string; description: string }[] = [
  { key: 'RENAME', label: 'Rename Group', description: 'Can change the group name' },
  { key: 'CHANGE_DESCRIPTION', label: 'Edit Description', description: 'Can update the group description' },
  { key: 'CHANGE_IMAGE', label: 'Change Group Photo', description: 'Can upload or update avatar' },
  { key: 'ADD_PEOPLE', label: 'Invite Members', description: 'Can invite new participants' },
  { key: 'REMOVE_PEOPLE', label: 'Remove Members', description: 'Can kick non-admin members' },
  { key: 'CHANGE_TYPE', label: 'Change Group Type', description: 'Can switch between public and private' },
  { key: 'DELETE_MESSAGES', label: 'Delete Messages', description: 'Can delete messages sent by any member' },
  { key: 'TIMEOUT', label: 'Timeout Members', description: 'Can silence members temporarily' },
  { key: 'BAN', label: 'Ban Members', description: 'Can permanently ban disruptive users' },
];

export default function GroupSettingsModal({
  conv,
  onClose,
  onUpdated,
  onLeftGroup,
}: GroupSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'info' | 'permissions' | 'transfer'>('info');

  // Info state
  const [name, setName] = useState(conv.group?.name || conv.displayName);
  const [description, setDescription] = useState('');
  const [type, setType] = useState<GroupType>('PUBLIC');
  const [imageUrl, setImageUrl] = useState(conv.group?.imageUrl || '');
  const [membersCanText, setMembersCanText] = useState(true);
  const [savingInfo, setSavingInfo] = useState(false);

  // Permissions: each permission → the lowest role allowed (unset = the server's default)
  const [permissions, setPermissions] = useState<Partial<Record<GroupPermissionKey, GroupRole>>>({});
  const [savingPerms, setSavingPerms] = useState(false);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [myRole, setMyRole] = useState<GroupRole | null>(null);

  // The group as it is now.
  useEffect(() => {
    dmApi
      .getConversation(conv.id)
      .then((detail) => {
        if (detail.groupInfo) {
          setDescription(detail.groupInfo.description ?? '');
          setMembersCanText(detail.groupInfo.membersCanText);
          setPermissions(detail.groupInfo.permissions);
        }
        if (detail.group?.visibility) setType(detail.group.visibility);
        if (detail.group?.imageUrl) setImageUrl(detail.group.imageUrl);
        setMyRole(detail.me.role);
      })
      .catch(() => {});
    // The people the ownership can go to: the group's members, a page at a time (a group is never sent whole).
    dmApi
      .getGroupMembers(conv.id, { limit: 100 })
      .then((page) => setMembers(page.items))
      .catch(() => {});
  }, [conv.id]);

  // Transfer state
  const [transferUserId, setTransferUserId] = useState('');
  const [transferLoading, setTransferLoading] = useState(false);

  // Leave state
  const [leaving, setLeaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  async function handleSaveInfo(e: React.FormEvent) {
    e.preventDefault();
    setSavingInfo(true);
    setMessage(null);
    try {
      await dmApi.updateGroup(conv.id, {
        name: name.trim(),
        description: description.trim() || null,
        type,
        imageUrl: imageUrl.trim() || null,
        membersCanText,
      });
      setMessage({ text: 'Group information updated successfully' });
      onUpdated();
    } catch (err: any) {
      setMessage({ text: err?.message || 'Failed to update group', error: true });
    } finally {
      setSavingInfo(false);
    }
  }

  async function handleSavePermissions() {
    setSavingPerms(true);
    setMessage(null);
    try {
      setPermissions(await dmApi.updateGroupPermissions(conv.id, permissions));
      setMessage({ text: 'Permissions updated successfully' });
      onUpdated();
    } catch (err: any) {
      setMessage({ text: err?.message || 'Failed to update permissions', error: true });
    } finally {
      setSavingPerms(false);
    }
  }

  async function handleTransfer() {
    if (!transferUserId.trim()) return;
    if (!confirm('Hand this group to the chosen member? You will become an admin.')) return;
    setTransferLoading(true);
    setMessage(null);
    try {
      await dmApi.startOwnershipTransfer(conv.id, transferUserId.trim());
      setMessage({ text: 'Ownership successfully transferred' });
      onUpdated();
      setTimeout(onClose, 1500);
    } catch (err: any) {
      setMessage({ text: err?.message || 'Failed to transfer ownership', error: true });
    } finally {
      setTransferLoading(false);
    }
  }

  async function handleLeaveGroup() {
    if (!confirm('Are you sure you want to leave this group?')) return;
    setLeaving(true);
    try {
      await dmApi.leaveGroup(conv.id);
      onLeftGroup();
      onClose();
    } catch (err: any) {
      alert(err?.message || 'Failed to leave group');
    } finally {
      setLeaving(false);
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
            <Settings size={20} style={{ color: '#06b6d4' }} />
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
              Group Settings
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

        {/* Tab buttons */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-color, #232734)',
            padding: '0 1rem',
            background: 'rgba(0,0,0,0.15)',
          }}
        >
          <button
            onClick={() => setActiveTab('info')}
            style={{
              padding: '0.85rem 1.15rem',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'info' ? '2px solid #06b6d4' : '2px solid transparent',
              color: activeTab === 'info' ? '#fff' : 'var(--text-muted, #94a3b8)',
              fontWeight: activeTab === 'info' ? 600 : 500,
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            General Info
          </button>
          <button
            onClick={() => setActiveTab('permissions')}
            style={{
              padding: '0.85rem 1.15rem',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'permissions' ? '2px solid #06b6d4' : '2px solid transparent',
              color: activeTab === 'permissions' ? '#fff' : 'var(--text-muted, #94a3b8)',
              fontWeight: activeTab === 'permissions' ? 600 : 500,
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            Permissions
          </button>
          <button
            onClick={() => setActiveTab('transfer')}
            style={{
              padding: '0.85rem 1.15rem',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === 'transfer' ? '2px solid #06b6d4' : '2px solid transparent',
              color: activeTab === 'transfer' ? '#fff' : 'var(--text-muted, #94a3b8)',
              fontWeight: activeTab === 'transfer' ? 600 : 500,
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            Ownership Transfer
          </button>
        </div>

        {/* Feedback message banner */}
        {message && (
          <div
            style={{
              padding: '0.65rem 1.25rem',
              background: message.error ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 197, 94, 0.15)',
              color: message.error ? '#ef4444' : '#4ade80',
              fontSize: '0.8rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            {message.error ? <X size={14} /> : <Check size={14} />}
            {message.text}
          </div>
        )}

        {/* Tab content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem' }}>
          {activeTab === 'info' && (
            <form onSubmit={handleSaveInfo} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', marginBottom: '0.4rem' }}>
                  Group Name
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'var(--bg-input, #0d0f15)',
                    border: '1px solid var(--border-color, #232734)',
                    borderRadius: '8px',
                    padding: '0.6rem 0.85rem',
                    color: '#fff',
                    fontSize: '0.875rem',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', marginBottom: '0.4rem' }}>
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="Tell members about this group..."
                  style={{
                    width: '100%',
                    background: 'var(--bg-input, #0d0f15)',
                    border: '1px solid var(--border-color, #232734)',
                    borderRadius: '8px',
                    padding: '0.6rem 0.85rem',
                    color: '#fff',
                    fontSize: '0.875rem',
                    outline: 'none',
                    resize: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', marginBottom: '0.4rem' }}>
                  Group Image
                </label>
                <GroupLogoPicker value={imageUrl} onChange={setImageUrl} />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', marginBottom: '0.4rem' }}>
                  Group Type
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                  <button
                    type="button"
                    onClick={() => setType('PUBLIC')}
                    style={{
                      padding: '0.6rem',
                      borderRadius: '8px',
                      border: type === 'PUBLIC' ? '1px solid #06b6d4' : '1px solid var(--border-color, #232734)',
                      background: type === 'PUBLIC' ? 'rgba(6, 182, 212, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                      color: type === 'PUBLIC' ? '#22d3ee' : 'var(--text-muted, #94a3b8)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.4rem',
                      fontSize: '0.825rem',
                      fontWeight: 600,
                    }}
                  >
                    <Globe size={15} /> Public
                  </button>
                  <button
                    type="button"
                    onClick={() => setType('PRIVATE')}
                    style={{
                      padding: '0.6rem',
                      borderRadius: '8px',
                      border: type === 'PRIVATE' ? '1px solid #a855f7' : '1px solid var(--border-color, #232734)',
                      background: type === 'PRIVATE' ? 'rgba(168, 85, 247, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                      color: type === 'PRIVATE' ? '#c084fc' : 'var(--text-muted, #94a3b8)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.4rem',
                      fontSize: '0.825rem',
                      fontWeight: 600,
                    }}
                  >
                    <Lock size={15} /> Private
                  </button>
                </div>
              </div>

              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', padding: '0.65rem 0.85rem', background: 'var(--bg-input, #0d0f15)', border: '1px solid var(--border-color, #232734)', borderRadius: '8px' }}>
                  <input
                    type="checkbox"
                    checked={membersCanText}
                    onChange={(e) => setMembersCanText(e.target.checked)}
                    style={{ width: '16px', height: '16px', accentColor: '#06b6d4', cursor: 'pointer' }}
                  />
                  <div>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff', display: 'block' }}>
                      Members Can Text
                    </span>
                    <span style={{ fontSize: '0.725rem', color: 'var(--text-muted, #94a3b8)' }}>
                      When OFF, only admins and owners can send messages (announcement mode).
                    </span>
                  </div>
                </label>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border-color, #232734)' }}>
                <button
                  type="button"
                  onClick={handleLeaveGroup}
                  disabled={leaving}
                  style={{
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    color: '#ef4444',
                    borderRadius: '8px',
                    padding: '0.55rem 0.9rem',
                    fontSize: '0.8rem',
                    cursor: leaving ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}
                >
                  {leaving ? <Loader2 size={13} className="animate-spin" /> : <LogOut size={13} />}
                  Leave Group
                </button>

                <button
                  type="submit"
                  disabled={savingInfo}
                  style={{
                    background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '0.55rem 1.25rem',
                    color: '#fff',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    cursor: savingInfo ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}
                >
                  {savingInfo && <Loader2 size={14} className="animate-spin" />}
                  Save Info
                </button>
              </div>
            </form>
          )}

          {activeTab === 'permissions' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted, #94a3b8)', marginBottom: '0.25rem' }}>
                Choose the lowest role allowed to do each thing. The admin panel decides which of these an owner may hand out.
              </div>

              {ALL_PERMISSIONS.map((perm) => (
                <div
                  key={perm.key}
                  style={{
                    padding: '0.75rem 1rem',
                    background: 'var(--bg-input, #161922)',
                    border: '1px solid var(--border-color, #232734)',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#fff' }}>{perm.label}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #94a3b8)' }}>{perm.description}</div>
                  </div>
                  <select
                    value={permissions[perm.key] ?? ''}
                    disabled={myRole !== 'OWNER'}
                    onChange={(e) =>
                      setPermissions((prev) => {
                        const next = { ...prev };
                        if (e.target.value) next[perm.key] = e.target.value as GroupRole;
                        else delete next[perm.key];
                        return next;
                      })
                    }
                    style={{
                      background: 'var(--bg-input, #0d0f15)',
                      border: '1px solid var(--border-color, #232734)',
                      borderRadius: '6px',
                      color: '#fff',
                      padding: '0.35rem 0.5rem',
                      fontSize: '0.75rem',
                    }}
                  >
                    <option value="">Default</option>
                    {ROLE_CHOICES.map((c) => (
                      <option key={c.role} value={c.role}>{c.label}</option>
                    ))}
                  </select>
                </div>
              ))}
              {myRole !== 'OWNER' && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #94a3b8)' }}>
                  Only the owner changes who may do what.
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
                <button
                  type="button"
                  onClick={handleSavePermissions}
                  disabled={savingPerms}
                  style={{
                    background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
                    border: 'none',
                    borderRadius: '8px',
                    padding: '0.6rem 1.25rem',
                    color: '#fff',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    cursor: savingPerms ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}
                >
                  {savingPerms && <Loader2 size={14} className="animate-spin" />}
                  Save Permissions
                </button>
              </div>
            </div>
          )}

          {activeTab === 'transfer' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div
                style={{
                  padding: '0.75rem 1rem',
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.25)',
                  borderRadius: '8px',
                  color: '#f87171',
                  fontSize: '0.8rem',
                  lineHeight: 1.4,
                }}
              >
                Transferring ownership gives full control to another user. You will become an admin.
              </div>

              <>
                  <div>
                    <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', marginBottom: '0.4rem' }}>
                      New owner
                    </label>
                    <select
                      value={transferUserId}
                      onChange={(e) => setTransferUserId(e.target.value)}
                      style={{
                        width: '100%',
                        background: 'var(--bg-input, #0d0f15)',
                        border: '1px solid var(--border-color, #232734)',
                        borderRadius: '8px',
                        padding: '0.6rem 0.85rem',
                        color: '#fff',
                        fontSize: '0.875rem',
                        outline: 'none',
                        boxSizing: 'border-box',
                      }}
                    >
                      <option value="">Choose a member…</option>
                      {members
                        .filter((m) => m.role !== 'OWNER')
                        .map((m) => (
                          <option key={m.userId} value={m.userId}>
                            @{m.username} ({m.role.toLowerCase().replace('_', '-')})
                          </option>
                        ))}
                    </select>
                  </div>

                  <button
                    type="button"
                    onClick={handleTransfer}
                    disabled={transferLoading || !transferUserId.trim()}
                    style={{
                      background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                      border: 'none',
                      borderRadius: '8px',
                      padding: '0.6rem 1.25rem',
                      color: '#fff',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      cursor: transferLoading || !transferUserId.trim() ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.4rem',
                      marginTop: '0.5rem',
                    }}
                  >
                    {transferLoading && <Loader2 size={14} className="animate-spin" />}
                    Transfer ownership
                  </button>
                </>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
