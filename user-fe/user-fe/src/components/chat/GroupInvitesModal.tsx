'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Mail, Check, X, Loader2, Users } from 'lucide-react';
import * as dmApi from '@/lib/api/dm';
import type { GroupInvite } from '@/types/dm';

interface GroupInvitesModalProps {
  onClose: () => void;
  onAccepted?: () => void;
}

export default function GroupInvitesModal({ onClose, onAccepted }: GroupInvitesModalProps) {
  const [invites, setInvites] = useState<GroupInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [answeringId, setAnsweringId] = useState<string | null>(null);

  const fetchInvites = useCallback(async () => {
    setLoading(true);
    try {
      const res = await dmApi.getInvites();
      setInvites(res || []);
    } catch {
      setInvites([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInvites();
  }, [fetchInvites]);

  async function handleAnswer(inviteId: string, accept: boolean) {
    setAnsweringId(inviteId);
    try {
      await dmApi.answerInvite(inviteId, accept);
      await fetchInvites();
      if (accept) {
        onAccepted?.();
      }
    } catch (err: any) {
      alert(err?.message || 'Failed to answer invite');
    } finally {
      setAnsweringId(null);
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
            <Mail size={20} style={{ color: '#06b6d4' }} />
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
              Pending Group Invites
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

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem', minHeight: '220px' }}>
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
              <span style={{ fontSize: '0.85rem' }}>Loading invites...</span>
            </div>
          ) : invites.length === 0 ? (
            <div
              style={{
                padding: '3rem 1rem',
                textAlign: 'center',
                color: 'var(--text-muted, #94a3b8)',
                fontSize: '0.875rem',
              }}
            >
              No pending group invitations right now.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              {invites.map((inv) => (
                <div
                  key={inv.id}
                  style={{
                    padding: '0.85rem 1rem',
                    background: 'var(--bg-input, #161922)',
                    border: '1px solid var(--border-color, #232734)',
                    borderRadius: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fff' }}>
                      {inv.group?.name || 'Group Invite'}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #94a3b8)', marginTop: '2px' }}>
                      Invited by @{inv.invitedBy?.username || 'member'}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <button
                      onClick={() => handleAnswer(inv.id, false)}
                      disabled={answeringId === inv.id}
                      style={{
                        padding: '0.45rem 0.65rem',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.25)',
                        borderRadius: '6px',
                        color: '#ef4444',
                        fontSize: '0.75rem',
                        cursor: answeringId === inv.id ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                      }}
                    >
                      <X size={13} /> Decline
                    </button>

                    <button
                      onClick={() => handleAnswer(inv.id, true)}
                      disabled={answeringId === inv.id}
                      style={{
                        padding: '0.45rem 0.75rem',
                        background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
                        border: 'none',
                        borderRadius: '6px',
                        color: '#fff',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        cursor: answeringId === inv.id ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                      }}
                    >
                      {answeringId === inv.id ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Check size={13} />
                      )}
                      Accept
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
