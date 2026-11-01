'use client';

import React, { useState } from 'react';
import { Users, X, Loader2, Globe, Lock, Image as ImageIcon } from 'lucide-react';
import * as dmApi from '@/lib/api/dm';
import GroupLogoPicker from './GroupLogoPicker';
import type { DmConversation, GroupType } from '@/types/dm';

interface CreateGroupModalProps {
  onClose: () => void;
  onCreated: (conv: DmConversation) => void;
}

export default function CreateGroupModal({ onClose, onCreated }: CreateGroupModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<GroupType>('PUBLIC');
  const [isChannel, setIsChannel] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [invites, setInvites] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please provide a group name');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const created = await dmApi.createGroup({
        name: name.trim(),
        description: description.trim() || undefined,
        type,
        isChannel,
        imageUrl: imageUrl.trim() || undefined,
        inviteUserIds: invites
          .split(/[\s,]+/)
          .map((h) => h.trim().replace(/^@/, ''))
          .filter(Boolean),
      });

      // Open the new group at once.
      const conv: DmConversation = {
        id: created.groupId,
        kind: 'GROUP',
        folder: 'GROUPS',
        displayName: name.trim(),
        group: {
          id: created.groupId,
          name: name.trim(),
          imageUrl: imageUrl.trim() || null,
          memberCount: 1,
          visibility: type,
        },
        unreadCount: 0,
        isPinned: false,
        notificationsOff: false,
        updatedAt: new Date().toISOString(),
      };

      onCreated(conv);
    } catch (err: any) {
      setError(err?.message || 'Failed to create group');
    } finally {
      setSubmitting(false);
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
          maxWidth: '460px',
          background: 'var(--bg-card, #11141c)',
          border: '1px solid var(--border-color, #232734)',
          borderRadius: '14px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
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
              Create New Group
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

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', marginBottom: '0.4rem' }}>
              Group Name *
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Crypto Traders, Gaming Lounge..."
              maxLength={64}
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
              placeholder="What is this group about?"
              rows={2}
              maxLength={256}
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
              Group Image (Optional)
            </label>
            <GroupLogoPicker value={imageUrl} onChange={setImageUrl} />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', marginBottom: '0.4rem' }}>
              Invite people (Optional)
            </label>
            <input
              value={invites}
              onChange={(e) => setInvites(e.target.value)}
              placeholder="@alice, @bob"
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
              Privacy & Access
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <button
                type="button"
                onClick={() => setType('PUBLIC')}
                style={{
                  padding: '0.75rem',
                  borderRadius: '8px',
                  border: type === 'PUBLIC' ? '1px solid #06b6d4' : '1px solid var(--border-color, #232734)',
                  background: type === 'PUBLIC' ? 'rgba(6, 182, 212, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                  color: type === 'PUBLIC' ? '#22d3ee' : 'var(--text-muted, #94a3b8)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.25rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600, fontSize: '0.85rem' }}>
                  <Globe size={15} /> Public Group
                </div>
                <span style={{ fontSize: '0.725rem', opacity: 0.8 }}>Anyone can search and join freely</span>
              </button>

              <button
                type="button"
                onClick={() => setType('PRIVATE')}
                style={{
                  padding: '0.75rem',
                  borderRadius: '8px',
                  border: type === 'PRIVATE' ? '1px solid #a855f7' : '1px solid var(--border-color, #232734)',
                  background: type === 'PRIVATE' ? 'rgba(168, 85, 247, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                  color: type === 'PRIVATE' ? '#c084fc' : 'var(--text-muted, #94a3b8)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.25rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600, fontSize: '0.85rem' }}>
                  <Lock size={15} /> Private Group
                </div>
                <span style={{ fontSize: '0.725rem', opacity: 0.8 }}>Join by invite or admin approval only</span>
              </button>
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', fontSize: '0.82rem', color: '#e2e8f0' }}>
            <input type="checkbox" checked={isChannel} onChange={(e) => setIsChannel(e.target.checked)} />
            <span>
              <strong style={{ color: '#fff' }}>Make it a channel</strong>
              <br />
              Only admins can post; members read.
            </span>
          </label>

          {error && (
            <div
              style={{
                padding: '0.65rem 0.85rem',
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '8px',
                color: '#ef4444',
                fontSize: '0.8rem',
              }}
            >
              {error}
            </div>
          )}

          {/* Footer buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.65rem', marginTop: '0.5rem' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '0.6rem 1rem',
                borderRadius: '8px',
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid var(--border-color, #232734)',
                color: 'var(--text-muted, #94a3b8)',
                fontSize: '0.85rem',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              style={{
                padding: '0.6rem 1.35rem',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
                border: 'none',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: submitting || !name.trim() ? 'not-allowed' : 'pointer',
                opacity: submitting || !name.trim() ? 0.6 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              {submitting && <Loader2 size={15} className="animate-spin" />}
              Create Group
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
