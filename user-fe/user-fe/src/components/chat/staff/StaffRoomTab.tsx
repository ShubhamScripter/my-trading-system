'use client';

/**
 * One room: "Disable / Enable Chat Rooms" (status with a note), "Edit Chat Rules (Text)" for the rooms the role
 * covers, and "See Previous Chat (chat history)" with retracted messages, within the role's history days.
 */
import React, { useState } from 'react';
import * as staffApi from '@/lib/api/staff';
import type { RoomItem } from '@/types/chat';
import { Btn, ModeBadge, OutcomeBanner, Spinner, ui, useStaffAction } from './staffUi';

interface Props {
  perms: staffApi.StaffPermissions;
  rooms: RoomItem[];
  activeRoomId: string | null;
}

export default function StaffRoomTab({ perms, rooms, activeRoomId }: Props) {
  const [roomId, setRoomId] = useState(activeRoomId ?? rooms[0]?.id ?? '');
  const room = rooms.find((r) => r.id === roomId);
  const [statusNote, setStatusNote] = useState(room?.statusNote ?? '');
  const [rules, setRules] = useState((room?.rules ?? []).join('\n'));
  const [history, setHistory] = useState<staffApi.StaffMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { busy, outcome, setOutcome, run } = useStaffAction();
  const mode = (p: string) => perms.permissions[p] ?? 'NONE';
  // Rules: the role's rooms only, when the role has a list ("for specific rooms").
  const rulesAllowed = perms.rulesRoomIds.length === 0 || perms.rulesRoomIds.includes(roomId);

  /** Another room: its own status note and rules, no history yet. */
  function pickRoom(id: string) {
    const next = rooms.find((r) => r.id === id);
    setRoomId(id);
    setRules((next?.rules ?? []).join('\n'));
    setStatusNote(next?.statusNote ?? '');
    setHistory([]);
    setCursor(null);
  }

  async function loadHistory(more: boolean) {
    setLoading(true);
    try {
      const page = await staffApi.getRoomHistory(roomId, more ? cursor : null);
      setHistory((prev) => (more ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (err) {
      setOutcome({ tone: 'error', text: err instanceof Error ? err.message : 'Could not load history' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <OutcomeBanner outcome={outcome} />
      <div style={{ ...ui.row, marginBottom: '0.9rem' }}>
        <select value={roomId} onChange={(e) => pickRoom(e.target.value)} style={{ ...ui.input, flex: 1 }}>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} {r.status && r.status !== 'ACTIVE' ? `(${r.status})` : ''}
            </option>
          ))}
        </select>
      </div>

      {mode('ROOM_STATUS') !== 'NONE' && roomId && (
        <div style={ui.section}>
          <div style={ui.title}>
            Room status: {room?.status ?? 'ACTIVE'}
            <ModeBadge mode={mode('ROOM_STATUS')} />
          </div>
          <div style={ui.row}>
            <input
              value={statusNote}
              onChange={(e) => setStatusNote(e.target.value)}
              placeholder="Note shown to users (optional)"
              style={{ ...ui.input, flex: 1 }}
            />
            {(['ACTIVE', 'MAINTENANCE', 'DISABLED'] as const).map((status) => (
              <Btn
                key={status}
                tone={status === 'DISABLED' ? 'danger' : 'default'}
                disabled={!!busy}
                onClick={() => run(`status-${status}`, () => staffApi.setRoomStatus(roomId, status, statusNote.trim() || undefined), `Room is now ${status.toLowerCase()}`)}
              >
                {status === 'ACTIVE' ? 'Open' : status === 'MAINTENANCE' ? 'Maintenance' : 'Disable'}
              </Btn>
            ))}
          </div>
        </div>
      )}

      {mode('EDIT_RULES') !== 'NONE' && roomId && (
        <div style={ui.section}>
          <div style={ui.title}>
            Rules (one per line)
            <ModeBadge mode={mode('EDIT_RULES')} />
          </div>
          {rulesAllowed ? (
            <>
              <textarea
                value={rules}
                onChange={(e) => setRules(e.target.value)}
                rows={5}
                style={{ ...ui.input, width: '100%', resize: 'vertical', boxSizing: 'border-box' }}
              />
              <div style={{ marginTop: '0.5rem' }}>
                <Btn
                  tone="primary"
                  disabled={!!busy}
                  onClick={() =>
                    run('rules', () => staffApi.setRoomRules(roomId, rules.split('\n').map((r) => r.trim()).filter(Boolean)), 'Rules saved')
                  }
                >
                  Save rules
                </Btn>
              </div>
            </>
          ) : (
            <div style={ui.muted}>Your role edits rules only in its own rooms.</div>
          )}
        </div>
      )}

      {mode('SEE_HISTORY') === 'ACT' && roomId && (
        <div style={ui.section}>
          <div style={{ ...ui.row, justifyContent: 'space-between' }}>
            <div style={ui.title}>History (last {perms.historyDays} days, retracted included)</div>
            <Btn onClick={() => loadHistory(false)}>{history.length ? 'Reload' : 'Load'}</Btn>
          </div>
          {history.map((m) => (
            <div key={m.id} style={{ padding: '0.35rem 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <span style={ui.muted}>
                {new Date(m.createdAt).toLocaleString()} · @{m.username ?? '?'}
                {m.isRetracted ? ' · retracted' : ''}
              </span>
              <div style={{ fontSize: '0.8rem', color: m.isRetracted ? '#6b7280' : '#e5e7eb' }}>{m.content ?? '(no text)'}</div>
            </div>
          ))}
          {loading && <Spinner />}
          {cursor && !loading && <Btn onClick={() => loadHistory(true)}>Older</Btn>}
        </div>
      )}
    </div>
  );
}
