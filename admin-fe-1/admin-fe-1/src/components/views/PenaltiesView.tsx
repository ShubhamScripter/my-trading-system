import React, { useCallback, useEffect, useState } from 'react';
import { AdminRoom } from '../../types';
import {
  BotLogEntry,
  CHAT_COMMANDS,
  ModulesAPI,
  RESTRICTION_KINDS,
  RESTRICTION_TARGETS,
  Restriction,
  StaffRequest,
} from '../../services/modulesApi';

/**
 * Chat Module 4 from the panel: chat-wide and room restrictions on a user or a group of users (Premium, KYC, level),
 * editing and lifting them, the staff requests lower roles filed in REPORT mode, and the bot log.
 */
interface Props {
  rooms: AdminRoom[];
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

type Tab = 'restrictions' | 'requests' | 'botlog';

const KIND_LABEL: Record<string, string> = {
  MUTE: 'Mute (cannot send)',
  RESTRICT_MEDIA: 'No pictures / videos',
  RESTRICT_EMOJI: 'No emoji',
  RESTRICT_GIF: 'No GIFs',
  RESTRICT_COMMANDS: 'No commands (choose)',
  RESTRICT_ADS: 'No ads',
  RESTRICT_DM: 'No DMs to strangers',
  RESTRICT_GIFTS: 'Cannot send money',
  RESTRICT_RECEIVE_GIFTS: 'Cannot receive money',
  RESTRICT_RAIN: 'Cannot rain',
  RESTRICT_RAIN_RECEIVE: 'Cannot receive rains',
  RESTRICT_PIN: 'Cannot pin messages',
  RESTRICT_DELETE_MESSAGES: 'Cannot delete messages',
  RESTRICT_HISTORY: 'Cannot see chat history',
  RESTRICT_STAFF_ROOM: 'Cannot enter the Staff room',
  RESTRICT_IMAGES: 'No pictures',
  RESTRICT_VIDEOS: 'No videos',
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function describePayload(r: StaffRequest): string {
  const p = r.payload ?? {};
  return Object.entries(p)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(' · ');
}

export const PenaltiesView: React.FC<Props> = ({ rooms, onShowToast }) => {
  const [tab, setTab] = useState<Tab>('restrictions');

  // Restrictions
  const [activeOnly, setActiveOnly] = useState(true);
  const [userFilter, setUserFilter] = useState('');
  const [restrictions, setRestrictions] = useState<Restriction[]>([]);
  const [form, setForm] = useState({
    targetType: 'USER' as (typeof RESTRICTION_TARGETS)[number],
    targetValue: '',
    kind: 'MUTE' as (typeof RESTRICTION_KINDS)[number],
    commands: [] as string[],
    roomId: '',
    reason: '',
    durationHours: '24',
  });

  // Requests
  const [requestStatus, setRequestStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>('PENDING');
  const [requests, setRequests] = useState<StaffRequest[]>([]);

  // Bot log
  const [botUser, setBotUser] = useState('');
  const [botLog, setBotLog] = useState<BotLogEntry[]>([]);

  const [loading, setLoading] = useState(false);

  const fail = (err: unknown) => onShowToast(err instanceof Error ? err.message : 'Request failed', 'danger');

  const loadRestrictions = useCallback(async () => {
    setLoading(true);
    try {
      setRestrictions(await ModulesAPI.restrictions({ active: activeOnly, userId: userFilter.trim() || undefined }));
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOnly, userFilter]);

  const loadRequests = useCallback(async () => {
    setLoading(true);
    try {
      setRequests(await ModulesAPI.staffRequests(requestStatus));
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestStatus]);

  const loadBotLog = useCallback(async () => {
    setLoading(true);
    try {
      setBotLog(await ModulesAPI.botLog({ userId: botUser.trim() || undefined }));
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botUser]);

  useEffect(() => {
    if (tab === 'restrictions') void loadRestrictions();
    if (tab === 'requests') void loadRequests();
    if (tab === 'botlog') void loadBotLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeOnly, requestStatus]);

  const createRestriction = async (e: React.FormEvent) => {
    e.preventDefault();
    const hours = form.durationHours.trim() ? Number(form.durationHours) : undefined;
    const res = await ModulesAPI.createRestriction({
      targetType: form.targetType,
      targetValue: form.targetValue.trim(),
      kind: form.kind,
      ...(form.kind === 'RESTRICT_COMMANDS' ? { commands: form.commands } : {}),
      roomId: form.roomId || null,
      internalReason: form.reason.trim(),
      ...(hours ? { durationHours: hours } : {}),
    });
    if (res.success) {
      onShowToast('Restriction added; the chat server applies it at once');
      setForm((f) => ({ ...f, targetValue: '', reason: '' }));
      void loadRestrictions();
    } else onShowToast(res.error || 'Could not add the restriction', 'danger');
  };

  const lift = async (r: Restriction) => {
    const note = window.prompt('Lift this restriction? Note (optional):', '');
    if (note === null) return;
    const res = await ModulesAPI.liftRestriction(r.id, note.trim() || undefined);
    if (res.success) {
      onShowToast('Restriction lifted');
      void loadRestrictions();
    } else onShowToast(res.error || 'Could not lift it', 'danger');
  };

  const change = async (r: Restriction) => {
    const hours = window.prompt('New end, in hours from now (empty = until lifted):', '24');
    if (hours === null) return;
    const reason = window.prompt('New reason (empty = keep):', r.internalReason) ?? '';
    const res = await ModulesAPI.changeRestriction(
      r.id,
      hours.trim() ? Number(hours) : null,
      reason.trim() && reason.trim() !== r.internalReason ? reason.trim() : undefined,
    );
    if (res.success) {
      onShowToast('Restriction changed');
      void loadRestrictions();
    } else onShowToast(res.error || 'Could not change it', 'danger');
  };

  const resolve = async (r: StaffRequest, approve: boolean) => {
    const note = window.prompt(`${approve ? 'Approve' : 'Reject'} this request? Note to the requester (optional):`, '');
    if (note === null) return;
    const res = await ModulesAPI.resolveStaffRequest(r.id, approve, note.trim() || undefined);
    if (res.success) {
      onShowToast(
        approve
          ? res.applied
            ? 'Approved and carried out'
            : 'Approved; this one needs a super admin to apply (roles, commands, sending money)'
          : 'Rejected',
      );
      void loadRequests();
    } else onShowToast(res.error || 'Could not resolve it', 'danger');
  };

  const tabButton = (id: Tab, label: string) => (
    <button className={tab === id ? 'btn-action' : 'btn-secondary'} onClick={() => setTab(id)}>
      {label}
    </button>
  );

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>Penalties, Staff Requests &amp; Bot Log (Module 4)</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Restrict a user or a group of users chat-wide or in one room, edit or lift penalties, decide what lower
              staff roles asked for, and see what automatic moderation did.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {tabButton('restrictions', 'Restrictions')}
            {tabButton('requests', 'Staff requests')}
            {tabButton('botlog', 'Bot log')}
          </div>
        </div>

        {tab === 'restrictions' && (
          <>
            <form
              onSubmit={createRestriction}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', margin: '16px 0' }}
            >
              <div className="form-group">
                <label>Target</label>
                <select
                  className="form-control"
                  value={form.targetType}
                  onChange={(e) => setForm({ ...form, targetType: e.target.value as typeof form.targetType })}
                >
                  <option value="USER">One user</option>
                  <option value="PREMIUM">Premium users</option>
                  <option value="KYC">KYC level ≥</option>
                  <option value="LEVEL">Level ≥</option>
                </select>
              </div>
              <div className="form-group">
                <label>{form.targetType === 'USER' ? 'Username or id' : form.targetType === 'PREMIUM' ? 'Any value' : 'Minimum'}</label>
                <input
                  className="form-control"
                  value={form.targetValue}
                  onChange={(e) => setForm({ ...form, targetValue: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>Restriction</label>
                <select
                  className="form-control"
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}
                >
                  {RESTRICTION_KINDS.map((k) => (
                    <option key={k} value={k}>{KIND_LABEL[k]}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Room</label>
                <select className="form-control" value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
                  <option value="">All of chat</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
              {form.kind === 'RESTRICT_COMMANDS' && (
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label>Commands</label>
                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    {CHAT_COMMANDS.map((c) => (
                      <label key={c} style={{ fontSize: '13px' }}>
                        <input
                          type="checkbox"
                          checked={form.commands.includes(c)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              commands: e.target.checked ? [...form.commands, c] : form.commands.filter((x) => x !== c),
                            })
                          }
                        />{' '}
                        /{c}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label>Reason (the user sees it)</label>
                <input className="form-control" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Hours (empty = until lifted)</label>
                <input
                  className="form-control"
                  type="number"
                  min={0.01}
                  step="any"
                  value={form.durationHours}
                  onChange={(e) => setForm({ ...form, durationHours: e.target.value })}
                />
              </div>
              <div className="form-group" style={{ alignSelf: 'end' }}>
                <button type="submit" className="btn-action">Add restriction</button>
              </div>
            </form>

            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px' }}>
              <label style={{ fontSize: '13px' }}>
                <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active only
              </label>
              <input
                className="form-control"
                style={{ maxWidth: '260px' }}
                placeholder="Filter by user"
                value={userFilter}
                onChange={(e) => setUserFilter(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadRestrictions()}
              />
              <button className="btn-secondary" onClick={() => loadRestrictions()}>{loading ? 'Loading…' : 'Refresh'}</button>
            </div>
            <div className="table-responsive">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Target</th><th>Restriction</th><th>Room</th><th>Reason</th><th>By</th><th>Ends</th><th />
                  </tr>
                </thead>
                <tbody>
                  {restrictions.map((r) => (
                    <tr key={r.id} style={{ opacity: r.isActive ? 1 : 0.55 }}>
                      <td>{r.targetType === 'USER' ? `@${r.targetUsername ?? r.targetValue}` : `${r.targetType} ${r.targetValue}`}</td>
                      <td>
                        {KIND_LABEL[r.kind] ?? r.kind}
                        {r.commands.length > 0 && <div style={{ fontSize: '12px', opacity: 0.7 }}>/{r.commands.join(' /')}</div>}
                      </td>
                      <td>{r.roomName ?? 'All of chat'}</td>
                      <td>{r.internalReason}</td>
                      <td>{r.createdBy}{r.createdByRole ? ` (${r.createdByRole})` : ''}</td>
                      <td>{r.liftedAt ? `lifted ${when(r.liftedAt)}` : r.expiresAt ? when(r.expiresAt) : 'until lifted'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {r.isActive && (
                          <>
                            <button className="btn-secondary" onClick={() => change(r)}>Edit</button>{' '}
                            <button className="btn-secondary" onClick={() => lift(r)}>Lift</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {restrictions.length === 0 && (
                    <tr><td colSpan={7} style={{ textAlign: 'center', opacity: 0.6 }}>No restrictions.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'requests' && (
          <>
            <div style={{ display: 'flex', gap: '8px', margin: '16px 0' }}>
              {(['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const).map((s) => (
                <button key={s} className={requestStatus === s ? 'btn-action' : 'btn-secondary'} onClick={() => setRequestStatus(s)}>
                  {s}
                </button>
              ))}
            </div>
            <div className="table-responsive">
              <table className="admin-table">
                <thead>
                  <tr><th>Asked by</th><th>Permission</th><th>Target</th><th>Details</th><th>Note</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id}>
                      <td>@{r.requesterUsername ?? '?'} <span style={{ opacity: 0.6 }}>({r.requesterRole})</span><div style={{ fontSize: '12px', opacity: 0.6 }}>{when(r.createdAt)}</div></td>
                      <td>{r.permission}</td>
                      <td>{r.targetUsername ? `@${r.targetUsername}` : ''}{r.targetRoomName ? ` in ${r.targetRoomName}` : ''}</td>
                      <td style={{ fontSize: '12px' }}>{describePayload(r)}</td>
                      <td>{r.note}</td>
                      <td>{r.status}{r.resolutionNote ? <div style={{ fontSize: '12px', opacity: 0.7 }}>{r.resolutionNote}</div> : null}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {r.status === 'PENDING' && (
                          <>
                            <button className="btn-action" onClick={() => resolve(r, true)}>Approve</button>{' '}
                            <button className="btn-secondary" onClick={() => resolve(r, false)}>Reject</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {requests.length === 0 && (
                    <tr><td colSpan={7} style={{ textAlign: 'center', opacity: 0.6 }}>No requests.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'botlog' && (
          <>
            <div style={{ display: 'flex', gap: '10px', margin: '16px 0' }}>
              <input
                className="form-control"
                style={{ maxWidth: '260px' }}
                placeholder="User (empty = everyone)"
                value={botUser}
                onChange={(e) => setBotUser(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadBotLog()}
              />
              <button className="btn-secondary" onClick={() => loadBotLog()}>{loading ? 'Loading…' : 'Search'}</button>
            </div>
            <div className="table-responsive">
              <table className="admin-table">
                <thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead>
                <tbody>
                  {botLog.map((e) => (
                    <tr key={e.id}>
                      <td>{when(e.createdAt)}</td>
                      <td>{e.username ? `@${e.username}` : '—'}</td>
                      <td>{e.action}</td>
                      <td style={{ fontSize: '12px' }}>{e.note ?? (e.detail ? JSON.stringify(e.detail) : '')}</td>
                    </tr>
                  ))}
                  {botLog.length === 0 && (
                    <tr><td colSpan={4} style={{ textAlign: 'center', opacity: 0.6 }}>Nothing in the bot log.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
};
