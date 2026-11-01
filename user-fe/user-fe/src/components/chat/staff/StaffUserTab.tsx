'use client';

/**
 * One user: look them up, then "See User Stats", "Check Bot Log", their recent messages and tags (within the role's
 * history days), and act — warn, ban, restrict, room access, role. Each action shows ACT or ASK (REPORT mode).
 */
import React, { useState } from 'react';
import * as staffApi from '@/lib/api/staff';
import type { RoomItem } from '@/types/chat';
import { Btn, OutcomeBanner, Spinner, ui, useStaffAction } from './staffUi';
import StaffUserActions from './StaffUserActions';

type View = 'stats' | 'botlog' | 'messages' | 'tags' | 'history';

interface Props {
  perms: staffApi.StaffPermissions;
  rooms: RoomItem[];
  activeRoomId: string | null;
}

export default function StaffUserTab({ perms, rooms, activeRoomId }: Props) {
  const [handle, setHandle] = useState('');
  const [target, setTarget] = useState<{ id: string; username: string } | null>(null);
  const [view, setView] = useState<View>('stats');
  const [stats, setStats] = useState<Record<string, Record<string, number | string>> | null>(null);
  const [log, setLog] = useState<staffApi.BotLogEntry[]>([]);
  const [msgs, setMsgs] = useState<staffApi.StaffMessage[]>([]);
  const [history, setHistory] = useState<staffApi.UserHistoryEntry[]>([]);
  const [historyInfo, setHistoryInfo] = useState<{ days: number; features: string[] | 'ALL' } | null>(null);
  const [historyFeature, setHistoryFeature] = useState('');
  const [loading, setLoading] = useState(false);
  const { outcome, setOutcome } = useStaffAction();
  const can = (p: string) => (perms.permissions[p] ?? 'NONE') === 'ACT';

  const views: { id: View; label: string; show: boolean }[] = [
    { id: 'stats', label: 'Stats', show: can('SEE_USER_STATS') },
    { id: 'botlog', label: 'Bot log', show: can('BOT_LOG') },
    { id: 'messages', label: 'Messages', show: can('USER_MESSAGES') },
    { id: 'tags', label: 'Tags', show: can('USER_TAGS') },
    { id: 'history', label: 'History', show: can('VIEW_USER_HISTORY') },
  ];

  async function load(userId: string, next: View) {
    setView(next);
    setLoading(true);
    setOutcome(null);
    try {
      if (next === 'stats') setStats((await staffApi.getUserStats(userId)).stats);
      if (next === 'botlog') setLog((await staffApi.getBotLog(userId)).items);
      if (next === 'messages') setMsgs((await staffApi.getUserMessages(userId)).items);
      if (next === 'tags') setMsgs((await staffApi.getUserTags(userId)).items);
      if (next === 'history') {
        const page = await staffApi.getUserHistory(userId, historyFeature || undefined);
        setHistory(page.items);
        setHistoryInfo({ days: page.days, features: page.features });
      }
    } catch (err) {
      setOutcome({ tone: 'error', text: err instanceof Error ? err.message : 'Could not load' });
    } finally {
      setLoading(false);
    }
  }

  async function find() {
    if (!handle.trim()) return;
    setOutcome(null);
    try {
      const user = await staffApi.resolveUser(handle);
      setTarget(user);
      const first = views.find((v) => v.show);
      if (first) void load(user.id, first.id);
    } catch (err) {
      setTarget(null);
      setOutcome({ tone: 'error', text: err instanceof Error ? err.message : 'User not found' });
    }
  }

  return (
    <div>
      <OutcomeBanner outcome={outcome} />
      <div style={{ ...ui.row, marginBottom: '0.9rem' }}>
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && find()}
          placeholder="@username or login code"
          style={{ ...ui.input, flex: 1 }}
        />
        <Btn tone="primary" onClick={find}>Look up</Btn>
      </div>

      {target && (
        <>
          <div style={{ ...ui.title, fontSize: '1rem' }}>@{target.username}</div>

          <StaffUserActions perms={perms} rooms={rooms} activeRoomId={activeRoomId} target={target} />

          <div style={ui.section}>
            <div style={{ ...ui.row, marginBottom: '0.6rem' }}>
              {views.filter((v) => v.show).map((v) => (
                <Btn key={v.id} tone={view === v.id ? 'primary' : 'default'} onClick={() => load(target.id, v.id)}>
                  {v.label}
                </Btn>
              ))}
              {loading && <Spinner />}
            </div>

            {view === 'stats' && stats && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.5rem' }}>
                {Object.entries(stats).map(([name, values]) => (
                  <div key={name} style={{ ...ui.section, marginBottom: 0 }}>
                    <div style={ui.muted}>{name}</div>
                    {Object.entries(values).map(([k, v]) => (
                      <div key={k} style={{ fontSize: '0.8rem', color: '#e5e7eb' }}>
                        {k}: <b>{String(v)}</b>
                      </div>
                    ))}
                  </div>
                ))}
                {Object.keys(stats).length === 0 && <div style={ui.muted}>Your role sees no stats.</div>}
              </div>
            )}

            {view === 'botlog' && (
              <table style={ui.table}>
                <thead>
                  <tr>{['When', 'Action', 'Detail'].map((h) => <th key={h} style={ui.th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {log.map((e) => (
                    <tr key={e.id}>
                      <td style={ui.td}>{new Date(e.createdAt).toLocaleString()}</td>
                      <td style={ui.td}>{e.action}</td>
                      <td style={ui.td}>{e.note ?? (e.detail ? JSON.stringify(e.detail) : '')}</td>
                    </tr>
                  ))}
                  {log.length === 0 && !loading && (
                    <tr><td style={ui.td} colSpan={3}>Nothing in the bot log.</td></tr>
                  )}
                </tbody>
              </table>
            )}

            {(view === 'messages' || view === 'tags') && (
              <div>
                {msgs.map((m) => (
                  <div key={m.id} style={{ padding: '0.4rem 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={ui.muted}>
                      {new Date(m.createdAt).toLocaleString()} · @{m.username ?? '?'}
                      {m.isRetracted ? ' · retracted' : ''}
                    </span>
                    <div style={{ fontSize: '0.8rem', color: m.isRetracted ? '#6b7280' : '#e5e7eb' }}>
                      {m.content ?? '(no text)'}
                    </div>
                  </div>
                ))}
                {msgs.length === 0 && !loading && <div style={ui.muted}>No messages in your history window.</div>}
              </div>
            )}

            {view === 'history' && (
              <div>
                <div style={{ ...ui.row, marginBottom: '0.5rem' }}>
                  <select
                    value={historyFeature}
                    onChange={(e) => setHistoryFeature(e.target.value)}
                    style={ui.input}
                  >
                    <option value="">All features</option>
                    {Array.isArray(historyInfo?.features) &&
                      historyInfo.features.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <Btn onClick={() => load(target.id, 'history')}>Show</Btn>
                  {historyInfo && <span style={ui.muted}>Last {historyInfo.days} days</span>}
                </div>
                <table style={ui.table}>
                  <thead>
                    <tr>{['When', 'Feature', 'What'].map((h) => <th key={h} style={ui.th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {history.map((e, i) => (
                      <tr key={`${e.at}-${i}`}>
                        <td style={ui.td}>{new Date(e.at).toLocaleString()}</td>
                        <td style={ui.td}>{e.feature}</td>
                        <td style={ui.td}>{e.summary}</td>
                      </tr>
                    ))}
                    {history.length === 0 && !loading && (
                      <tr><td style={ui.td} colSpan={3}>Nothing in this period.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
