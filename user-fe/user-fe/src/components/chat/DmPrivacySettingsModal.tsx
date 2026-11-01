'use client';

import React, { useState, useEffect } from 'react';
import { Shield, X, Loader2, Check, Bell, Eye, Moon, Users } from 'lucide-react';
import * as dmApi from '@/lib/api/dm';
import type { DmPrivacy, QuietMode, VisibilityChoice } from '@/types/dm';

interface DmPrivacySettingsModalProps {
  onClose: () => void;
}

const box: React.CSSProperties = {
  padding: '1rem',
  background: 'var(--bg-input, #161922)',
  border: '1px solid var(--border-color, #232734)',
  borderRadius: '10px',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.6rem',
};
const input: React.CSSProperties = {
  background: 'var(--bg-input, #0d0f15)',
  border: '1px solid var(--border-color, #232734)',
  borderRadius: '6px',
  color: '#fff',
  padding: '0.4rem 0.5rem',
  fontSize: '0.8rem',
};

export default function DmPrivacySettingsModal({ onClose }: DmPrivacySettingsModalProps) {
  const [privacy, setPrivacy] = useState<DmPrivacy>({
    lastSeenVisibility: 'ALL',
    commonGroupsVisibility: 'ALL',
    notifyPrimary: true,
    notifyGeneral: true,
    notifyGroups: true,
    quietMode: 'OFF',
    quietStart: null,
    quietEnd: null,
    timeZone: null,
    typingReceiptsEnabled: true,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    dmApi
      .getDmPrivacy()
      .then((data) => {
        if (data) setPrivacy(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    setSuccess(false);
    try {
      const updated = await dmApi.updateDmPrivacy({
        ...privacy,
        // Custom quiet hours need both times; the account time zone places them.
        ...(privacy.quietMode === 'CUSTOM'
          ? {
              quietStart: privacy.quietStart ?? '22:00',
              quietEnd: privacy.quietEnd ?? '07:00',
            }
          : {}),
      });
      if (updated) setPrivacy(updated);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2500);
    } catch (err: any) {
      alert(err?.message || 'Failed to update privacy settings');
    } finally {
      setSaving(false);
    }
  }

  const renderOption = (
    title: string,
    description: string,
    icon: React.ReactNode,
    field: 'lastSeenVisibility' | 'commonGroupsVisibility',
  ) => {
    const currentValue = privacy[field];
    const options: { label: string; value: VisibilityChoice }[] = [
      { label: 'Everyone', value: 'ALL' },
      { label: 'Friends Only', value: 'FRIENDS' },
      { label: 'Nobody', value: 'NOBODY' },
    ];

    return (
      <div
        style={{
          padding: '1rem',
          background: 'var(--bg-input, #161922)',
          border: '1px solid var(--border-color, #232734)',
          borderRadius: '10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
          <div style={{ color: '#818cf8', marginTop: '2px' }}>{icon}</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fff' }}>{title}</div>
            <div style={{ fontSize: '0.775rem', color: 'var(--text-muted, #94a3b8)', marginTop: '2px' }}>
              {description}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginTop: '0.25rem' }}>
          {options.map((opt) => {
            const isSelected = currentValue === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setPrivacy((prev) => ({ ...prev, [field]: opt.value }))}
                style={{
                  padding: '0.5rem',
                  borderRadius: '7px',
                  border: isSelected ? '1px solid #6366f1' : '1px solid var(--border-color, #232734)',
                  background: isSelected ? 'rgba(99, 102, 241, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                  color: isSelected ? '#a5b4fc' : 'var(--text-muted, #94a3b8)',
                  fontSize: '0.8rem',
                  fontWeight: isSelected ? 600 : 500,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

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
          display: 'flex',
          flexDirection: 'column',
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
            <Shield size={20} style={{ color: '#818cf8' }} />
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#fff' }}>
              DM Privacy Settings
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

        {/* Content */}
        <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
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
              <span style={{ fontSize: '0.85rem' }}>Loading settings...</span>
            </div>
          ) : (
            <>
              {renderOption(
                'Last seen & online status',
                'Control who can see your online presence and last active timestamp in DMs.',
                <Eye size={18} />,
                'lastSeenVisibility',
              )}
              {renderOption(
                'Shared / Common groups',
                'Control who can see mutual groups you both belong to on your profile card.',
                <Users size={18} />,
                'commonGroupsVisibility',
              )}

              <div style={box}>
                <label style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', fontSize: '0.85rem', color: '#e2e8f0' }}>
                  <span>
                    <strong style={{ color: '#fff' }}>Typing indicator &amp; read receipts</strong>
                    <br />
                    When off, you neither show nor see them.
                  </span>
                  <input
                    type="checkbox"
                    checked={privacy.typingReceiptsEnabled}
                    onChange={(e) => setPrivacy((p) => ({ ...p, typingReceiptsEnabled: e.target.checked }))}
                  />
                </label>
              </div>

              <div style={box}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', color: '#fff', fontWeight: 600, fontSize: '0.9rem' }}>
                  <Bell size={18} color="#818cf8" /> Notifications per folder
                </div>
                {([
                  ['notifyPrimary', 'Primary'],
                  ['notifyGeneral', 'General'],
                  ['notifyGroups', 'Groups'],
                ] as const).map(([key, name]) => (
                  <label key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: '#e2e8f0' }}>
                    {name}
                    <input
                      type="checkbox"
                      checked={privacy[key]}
                      onChange={(e) => setPrivacy((p) => ({ ...p, [key]: e.target.checked }))}
                    />
                  </label>
                ))}
              </div>

              <div style={box}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', color: '#fff', fontWeight: 600, fontSize: '0.9rem' }}>
                  <Moon size={18} color="#818cf8" /> Quiet mode
                  {privacy.inQuietHoursNow && <span style={{ fontSize: '0.7rem', color: '#fbbf24' }}>(on now)</span>}
                </div>
                <select
                  value={privacy.quietMode}
                  onChange={(e) => setPrivacy((p) => ({ ...p, quietMode: e.target.value as QuietMode }))}
                  style={input}
                >
                  <option value="OFF">Off</option>
                  <option value="AUTO_NIGHT">Automatic at night</option>
                  <option value="CUSTOM" disabled={privacy.canChangeQuietTimes === false}>
                    Custom hours{privacy.canChangeQuietTimes === false ? ' (not allowed by admin)' : ''}
                  </option>
                </select>
                {privacy.quietMode === 'CUSTOM' && (
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.8rem', color: '#e2e8f0' }}>
                    From
                    <input
                      type="time"
                      value={privacy.quietStart ?? '22:00'}
                      onChange={(e) => setPrivacy((p) => ({ ...p, quietStart: e.target.value }))}
                      style={input}
                    />
                    to
                    <input
                      type="time"
                      value={privacy.quietEnd ?? '07:00'}
                      onChange={(e) => setPrivacy((p) => ({ ...p, quietEnd: e.target.value }))}
                      style={input}
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '1rem 1.25rem',
            borderTop: '1px solid var(--border-color, #232734)',
            background: 'rgba(0,0,0,0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            {success && (
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  color: '#4ade80',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                }}
              >
                <Check size={14} /> Saved successfully
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.65rem' }}>
            <button
              onClick={onClose}
              style={{
                padding: '0.55rem 1rem',
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
              onClick={handleSave}
              disabled={loading || saving}
              style={{
                padding: '0.55rem 1.25rem',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #6366f1, #4f46e5)',
                border: 'none',
                color: '#fff',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: loading || saving ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : null}
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
