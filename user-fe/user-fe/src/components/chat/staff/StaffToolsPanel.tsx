'use client';

/**
 * Staff Tools (Module 4, Chat SETTINGS "Moderation Role Permissions"): what a chat ADMIN, MODERATOR or SUPPORT may
 * do from the app. Tabs appear only for what the role has (ACT or REPORT); a REPORT-mode action is sent to a higher
 * role, who approves or rejects it under Requests.
 */
import React, { useEffect, useState } from 'react';
import { Shield, X } from 'lucide-react';
import * as staffApi from '@/lib/api/staff';
import type { RoomItem } from '@/types/chat';
import { Spinner, ui } from './staffUi';
import StaffReportsTab from './StaffReportsTab';
import StaffPenaltiesTab from './StaffPenaltiesTab';
import StaffUserTab from './StaffUserTab';
import StaffRoomTab from './StaffRoomTab';
import StaffRequestsTab from './StaffRequestsTab';
import StaffChatWideTab from './StaffChatWideTab';

type Tab = 'reports' | 'penalties' | 'user' | 'room' | 'requests' | 'chat';

interface Props {
  rooms: RoomItem[];
  activeRoomId: string | null;
  onClose: () => void;
}

export default function StaffToolsPanel({ rooms, activeRoomId, onClose }: Props) {
  const [perms, setPerms] = useState<staffApi.StaffPermissions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('reports');

  useEffect(() => {
    staffApi
      .getPermissions()
      .then(setPerms)
      .catch((err: Error) => setError(err.message));
  }, []);

  const has = (...names: string[]) =>
    !!perms && names.some((n) => (perms.permissions[n] ?? 'NONE') !== 'NONE');
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'reports', label: 'Reports', show: has('SEE_REPORTS') },
    { id: 'penalties', label: 'Penalties', show: has('SEE_PENALISED', 'CHANGE_PENALTIES') },
    { id: 'user', label: 'User', show: true },
    { id: 'room', label: 'Room', show: has('SEE_HISTORY', 'ROOM_STATUS', 'EDIT_RULES') },
    { id: 'requests', label: 'Requests', show: true },
    { id: 'chat', label: 'Chat-wide', show: has('DISABLE_COMMANDS', 'SENDING_MONEY', 'DISABLE_OVERALL_RAINS', 'DISABLE_RAINPOOL_RAINS', 'DISABLE_USER_RAINS') },
  ];
  const visible = tabs.filter((t) => t.show);
  const current = visible.some((t) => t.id === tab) ? tab : visible[0]?.id;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.75)',
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
          maxWidth: '920px',
          height: '86vh',
          background: 'var(--bg-card, #11141c)',
          border: '1px solid var(--border-color, #232734)',
          borderRadius: '14px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
        }}
      >
        <div
          style={{
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--border-color, #232734)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Shield size={18} color="#818cf8" />
            <div>
              <div style={{ fontWeight: 700, color: '#f3f4f6' }}>Staff Tools</div>
              {perms && (
                <div style={ui.muted}>
                  {perms.role} · bans up to {perms.maxBanHours} h · history {perms.historyDays} days
                </div>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>

        {perms && (
          <div style={{ display: 'flex', gap: '0.25rem', padding: '0.5rem 1rem', borderBottom: '1px solid #232734' }}>
            {visible.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  background: current === t.id ? 'rgba(99,102,241,0.18)' : 'transparent',
                  color: current === t.id ? '#c7d2fe' : '#9ca3af',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '0.4rem 0.8rem',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.25rem' }}>
          {error && <div style={{ color: '#f87171', fontSize: '0.85rem' }}>{error}</div>}
          {!perms && !error && <Spinner />}
          {perms && current === 'reports' && <StaffReportsTab perms={perms} />}
          {perms && current === 'penalties' && <StaffPenaltiesTab perms={perms} />}
          {perms && current === 'user' && <StaffUserTab perms={perms} rooms={rooms} activeRoomId={activeRoomId} />}
          {perms && current === 'room' && <StaffRoomTab perms={perms} rooms={rooms} activeRoomId={activeRoomId} />}
          {perms && current === 'requests' && <StaffRequestsTab />}
          {perms && current === 'chat' && <StaffChatWideTab perms={perms} />}
        </div>
      </div>
    </div>
  );
}
