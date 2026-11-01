'use client';

/**
 * "See Penalised / Banned Users List" with "Change / Remove Penalties": lift a ban or restriction, or give it a new
 * end (counted from now) and reason. The role's penalty scope and ban maximum are checked by the server.
 */
import React, { useCallback, useEffect, useState } from 'react';
import * as staffApi from '@/lib/api/staff';
import { Btn, ModeBadge, OutcomeBanner, Spinner, ui, useStaffAction, when } from './staffUi';

type Editing = { kind: 'ban' | 'restriction'; id: string } | null;

export default function StaffPenaltiesTab({ perms }: { perms: staffApi.StaffPermissions }) {
  const [filter, setFilter] = useState('');
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [data, setData] = useState<{ bans: staffApi.StaffBan[]; restrictions: staffApi.StaffRestriction[] } | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [hours, setHours] = useState('24');
  const [permanent, setPermanent] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, outcome, setOutcome, run } = useStaffAction();
  const changeMode = perms.permissions.CHANGE_PENALTIES;
  const canSee = perms.permissions.SEE_PENALISED === 'ACT';

  const load = useCallback(async () => {
    if (!canSee) return;
    try {
      setData(await staffApi.getPenalties(userId));
    } catch (err) {
      setOutcome({ tone: 'error', text: err instanceof Error ? err.message : 'Could not load penalties' });
    }
  }, [userId, canSee, setOutcome]);

  useEffect(() => {
    if (!canSee) return;
    let live = true;
    staffApi
      .getPenalties(userId)
      .then((d) => live && setData(d))
      .catch((err: Error) => live && setOutcome({ tone: 'error', text: err.message }));
    return () => {
      live = false;
    };
  }, [userId, canSee, setOutcome]);

  const findUser = async () => {
    if (!filter.trim()) return setUserId(undefined);
    try {
      setUserId((await staffApi.resolveUser(filter)).id);
    } catch (err) {
      setOutcome({ tone: 'error', text: err instanceof Error ? err.message : 'User not found' });
    }
  };

  const startEdit = (next: Editing) => {
    setEditing(next);
    setHours('24');
    setPermanent(false);
    setReason('');
  };

  const saveEdit = async () => {
    if (!editing) return;
    const h = hours.trim() === '' ? null : Number(hours);
    const done =
      editing.kind === 'ban'
        ? await run('edit', () =>
            staffApi.changeBan(editing.id, {
              ...(permanent ? { permanent: true as const } : { durationHours: Math.round(h ?? 24) }),
              ...(reason.trim() ? { internalReason: reason.trim() } : {}),
            }),
          'Ban changed')
        : await run('edit', () =>
            staffApi.changeRestriction(editing.id, {
              durationHours: h,
              ...(reason.trim() ? { internalReason: reason.trim() } : {}),
            }),
          'Restriction changed');
    if (done) {
      setEditing(null);
      void load();
    }
  };

  const lift = async (kind: 'ban' | 'restriction', id: string) => {
    const done = await run(`lift-${id}`, () =>
      kind === 'ban' ? staffApi.liftBan(id) : staffApi.liftRestriction(id),
      'Lifted');
    if (done) void load();
  };

  const editor = (kind: 'ban' | 'restriction', id: string) =>
    editing?.kind === kind && editing.id === id ? (
      <tr>
        <td style={ui.td} colSpan={6}>
          <div style={ui.row}>
            <span style={ui.muted}>New end from now:</span>
            <input
              type="number"
              min={1}
              disabled={permanent}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              placeholder={kind === 'restriction' ? 'empty = until lifted' : ''}
              style={{ ...ui.input, width: '7.5rem' }}
            />
            <span style={ui.muted}>hours</span>
            {kind === 'ban' && perms.role === 'ADMIN' && (
              <label style={ui.muted}>
                <input type="checkbox" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} /> permanent
              </label>
            )}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="New reason (optional)"
              style={{ ...ui.input, flex: 1 }}
            />
            <Btn tone="primary" onClick={saveEdit} disabled={busy === 'edit'}>Save</Btn>
            <Btn onClick={() => setEditing(null)}>Cancel</Btn>
          </div>
        </td>
      </tr>
    ) : null;

  const actions = (kind: 'ban' | 'restriction', id: string) =>
    changeMode && changeMode !== 'NONE' ? (
      <div style={ui.row}>
        <Btn onClick={() => startEdit({ kind, id })}>Edit<ModeBadge mode={changeMode} /></Btn>
        <Btn tone="danger" onClick={() => lift(kind, id)} disabled={busy === `lift-${id}`}>
          Lift<ModeBadge mode={changeMode} />
        </Btn>
      </div>
    ) : null;

  if (!canSee) return <div style={ui.muted}>Your role cannot see the penalised list.</div>;

  return (
    <div>
      <OutcomeBanner outcome={outcome} />
      <div style={{ ...ui.row, marginBottom: '0.75rem' }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && findUser()}
          placeholder="Filter by @username (empty = everyone)"
          style={{ ...ui.input, flex: 1 }}
        />
        <Btn onClick={findUser}>Filter</Btn>
      </div>
      {!data && <Spinner />}
      {data && (
        <>
          <div style={ui.section}>
            <div style={ui.title}>Active bans ({data.bans.length})</div>
            <table style={ui.table}>
              <thead>
                <tr>
                  {['User', 'Room', 'Reason', 'By', 'Ends', ''].map((h) => <th key={h} style={ui.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.bans.map((b) => (
                  <React.Fragment key={b.id}>
                    <tr>
                      <td style={ui.td}>@{b.username ?? b.userId.slice(0, 8)}</td>
                      <td style={ui.td}>{b.roomId ? b.roomId.slice(0, 8) : 'all chat'}</td>
                      <td style={ui.td}>{b.internalReason}</td>
                      <td style={ui.td}>{b.by}</td>
                      <td style={ui.td}>{b.expiresAt ? when(b.expiresAt) : 'permanent'}</td>
                      <td style={ui.td}>{actions('ban', b.id)}</td>
                    </tr>
                    {editor('ban', b.id)}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div style={ui.section}>
            <div style={ui.title}>Active restrictions ({data.restrictions.length})</div>
            <table style={ui.table}>
              <thead>
                <tr>
                  {['Target', 'Kind', 'Reason', 'By', 'Ends', ''].map((h) => <th key={h} style={ui.th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.restrictions.map((r) => (
                  <React.Fragment key={r.id}>
                    <tr>
                      <td style={ui.td}>
                        {r.targetType === 'USER' ? `@${r.username ?? r.targetValue.slice(0, 8)}` : `${r.targetType} ${r.targetValue}`}
                      </td>
                      <td style={ui.td}>
                        {r.kind}
                        {r.commands.length > 0 && <div style={ui.muted}>/{r.commands.join(' /')}</div>}
                      </td>
                      <td style={ui.td}>{r.internalReason}</td>
                      <td style={ui.td}>{r.by}</td>
                      <td style={ui.td}>{r.expiresAt ? when(r.expiresAt) : 'until lifted'}</td>
                      <td style={ui.td}>{actions('restriction', r.id)}</td>
                    </tr>
                    {editor('restriction', r.id)}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
