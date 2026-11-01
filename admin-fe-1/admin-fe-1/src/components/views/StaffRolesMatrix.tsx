import React from 'react';
import { AdminRoom } from '../../types';
import { CHAT_COMMANDS } from '../../services/modulesApi';

/**
 * Chat SETTINGS "Moderation Role Permissions": for each chat role, each permission is ACT (do it), REPORT (ask a
 * higher role) or NONE, plus the role's limits — maximum ban, whose penalties it may change, history days, the rooms
 * where it pins and edits rules, the commands it may restrict, group privilege and the user stats it sees.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the role documents are settings JSON */

export const STAFF_PERMISSIONS: { key: string; label: string }[] = [
  { key: 'WARN', label: 'Warn users' },
  { key: 'BAN', label: 'Ban / mute users' },
  { key: 'ROOM_ACCESS', label: 'Add / remove users from rooms' },
  { key: 'RESTRICT_COMMANDS', label: 'Restrict commands of a user' },
  { key: 'RESTRICT_EMOJI', label: 'Restrict emoji' },
  { key: 'RESTRICT_GIF', label: 'Restrict GIFs' },
  { key: 'RESTRICT_ADS', label: 'Restrict ads' },
  { key: 'RESTRICT_GIFTS', label: 'Restrict sending / receiving money' },
  { key: 'RESTRICT_DM', label: 'Restrict DMs to strangers' },
  { key: 'PIN', label: 'Pin messages' },
  { key: 'ROOM_STATUS', label: 'Disable / enable rooms' },
  { key: 'DISABLE_COMMANDS', label: 'Disable commands chat-wide' },
  { key: 'SENDING_MONEY', label: 'Disable / enable sending money' },
  { key: 'RESTRICT_RAIN', label: 'Restrict raining ability of a user' },
  { key: 'RESTRICT_RAIN_RECEIVE', label: 'Disable user from receiving rains' },
  { key: 'DISABLE_RAINPOOL_RAINS', label: 'Disable Rainpool rains' },
  { key: 'DISABLE_USER_RAINS', label: 'Disable user rains' },
  { key: 'DISABLE_OVERALL_RAINS', label: 'Disable overall rains' },
  { key: 'SEE_DELETED', label: 'See deleted messages' },
  { key: 'DELETE_MESSAGES', label: 'Delete messages' },
  { key: 'JOIN_STAFF_ROOM', label: 'Join the staff room' },
  { key: 'SEE_REPORTS', label: 'See reported messages' },
  { key: 'ACT_ON_REPORTS', label: 'Act on reported messages' },
  { key: 'SEE_HISTORY', label: 'See previous chat (history)' },
  { key: 'USER_MESSAGES', label: "See a user's recent messages" },
  { key: 'USER_TAGS', label: "See a user's tags" },
  { key: 'EDIT_RULES', label: 'Edit chat rules' },
  { key: 'CHANGE_PENALTIES', label: 'Change / remove penalties' },
  { key: 'SEE_PENALISED', label: 'See penalised / banned list' },
  { key: 'SEND_PICTURES', label: 'Send pictures' },
  { key: 'MANAGE_PICTURES', label: 'Allow / restrict others sending pictures' },
  { key: 'SEND_VIDEOS', label: 'Send videos' },
  { key: 'MANAGE_VIDEOS', label: 'Allow / restrict others sending videos' },
  { key: 'SEE_USER_STATS', label: 'See user stats' },
  { key: 'BOT_LOG', label: 'Check the bot log of a user' },
  { key: 'VIEW_USER_HISTORY', label: 'View user history (features, days below)' },
];
const ROLES = ['ADMIN', 'MODERATOR', 'SUPPORT'] as const;
const USER_STATS = ['MESSAGES', 'WARNINGS', 'BANS', 'REPORTS', 'RESTRICTIONS', 'GIFTS', 'ADS'];
const MODE_COLOR: Record<string, string> = { ACT: '#4ade80', REPORT: '#fbbf24', NONE: '#64748b' };

interface Props {
  value: Record<string, any>;
  rooms: AdminRoom[];
  onChange: (next: Record<string, any>) => void;
}

export const StaffRolesMatrix: React.FC<Props> = ({ value, rooms, onChange }) => {
  const setRole = (role: string, patch: Record<string, any>) => onChange({ ...value, [role]: { ...value[role], ...patch } });
  const toggle = (list: string[], item: string, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));

  return (
    <div>
      <div className="table-responsive">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Permission</th>
              {ROLES.map((r) => <th key={r}>{r}</th>)}
            </tr>
          </thead>
          <tbody>
            {STAFF_PERMISSIONS.map((p) => (
              <tr key={p.key}>
                <td>{p.label}</td>
                {ROLES.map((role) => {
                  const mode = value[role]?.permissions?.[p.key] ?? 'NONE';
                  return (
                    <td key={role}>
                      <select
                        className="form-control"
                        style={{ color: MODE_COLOR[mode], padding: '4px 6px' }}
                        value={mode}
                        onChange={(e) =>
                          setRole(role, { permissions: { ...(value[role]?.permissions ?? {}), [p.key]: e.target.value } })
                        }
                      >
                        <option value="ACT">ACT</option>
                        <option value="REPORT">REPORT (ask)</option>
                        <option value="NONE">NONE</option>
                      </select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginTop: '16px' }}>
        {ROLES.map((role) => {
          const r = value[role] ?? {};
          return (
            <div key={role} style={{ border: '1px solid var(--border)', borderRadius: '10px', padding: '12px' }}>
              <h4 style={{ margin: '0 0 10px 0', color: '#fff', fontSize: '14px' }}>{role} limits</h4>
              <div className="form-group">
                <label>Maximum ban (hours)</label>
                <input className="form-control" type="number" min={1} value={r.maxBanHours ?? 24} onChange={(e) => setRole(role, { maxBanHours: Number(e.target.value) })} />
              </div>
              <div className="form-group">
                <label>Change penalties given by</label>
                <select className="form-control" value={r.penaltyScope ?? 'BELOW'} onChange={(e) => setRole(role, { penaltyScope: e.target.value })}>
                  <option value="BELOW">Roles below</option>
                  <option value="SAME">The same role</option>
                  <option value="SAME_AND_BELOW">The same role and below</option>
                </select>
              </div>
              <div className="form-group">
                <label>Chat history of the last (days)</label>
                <input className="form-control" type="number" min={1} value={r.historyDays ?? 30} onChange={(e) => setRole(role, { historyDays: Number(e.target.value) })} />
              </div>
              <div className="form-group">
                <label>A user's recent messages, last (days)</label>
                <input
                  className="form-control"
                  type="number"
                  min={1}
                  placeholder="same as chat history"
                  value={r.messageHistoryDays ?? ''}
                  onChange={(e) => setRole(role, { messageHistoryDays: e.target.value ? Number(e.target.value) : undefined })}
                />
              </div>
              <div className="form-group">
                <label>A user's tags, last (days)</label>
                <input
                  className="form-control"
                  type="number"
                  min={1}
                  placeholder="same as chat history"
                  value={r.tagHistoryDays ?? ''}
                  onChange={(e) => setRole(role, { tagHistoryDays: e.target.value ? Number(e.target.value) : undefined })}
                />
              </div>
              <div className="form-group">
                <label>View user history: features (empty = all features)</label>
                <input
                  className="form-control"
                  placeholder="FAUCET, SL"
                  value={(r.userHistoryFeatures ?? []).join(', ')}
                  onChange={(e) =>
                    setRole(role, {
                      userHistoryFeatures: e.target.value
                        .split(/[\s,]+/)
                        .map((x) => x.trim().toUpperCase())
                        .filter(Boolean),
                    })
                  }
                />
              </div>
              <div className="form-group">
                <label>View user history: max period (days)</label>
                <input
                  className="form-control"
                  type="number"
                  min={1}
                  placeholder="same as chat history"
                  value={r.userHistoryDays ?? ''}
                  onChange={(e) => setRole(role, { userHistoryDays: e.target.value ? Number(e.target.value) : undefined })}
                />
              </div>
              <label style={{ fontSize: '13px', display: 'block', margin: '6px 0' }}>
                <input type="checkbox" checked={!!r.groupPrivilege} onChange={(e) => setRole(role, { groupPrivilege: e.target.checked })} /> Group privilege
                (restrict Premium / KYC / level groups)
              </label>
              <div className="form-group">
                <label>Pin rooms (none = every room)</label>
                <select multiple className="form-control" value={r.pinRoomIds ?? []} onChange={(e) => setRole(role, { pinRoomIds: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
                  {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Rules rooms (none = every room)</label>
                <select multiple className="form-control" value={r.rulesRoomIds ?? []} onChange={(e) => setRole(role, { rulesRoomIds: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
                  {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Commands it may restrict (none = all)</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {CHAT_COMMANDS.map((c) => (
                    <label key={c} style={{ fontSize: '12px' }}>
                      <input
                        type="checkbox"
                        checked={(r.restrictableCommands ?? []).includes(c)}
                        onChange={(e) => setRole(role, { restrictableCommands: toggle(r.restrictableCommands ?? [], c, e.target.checked) })}
                      />{' '}
                      /{c}
                    </label>
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label>User stats it sees</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {USER_STATS.map((s) => (
                    <label key={s} style={{ fontSize: '12px' }}>
                      <input
                        type="checkbox"
                        checked={(r.visibleStats ?? []).includes(s)}
                        onChange={(e) => setRole(role, { visibleStats: toggle(r.visibleStats ?? [], s, e.target.checked) })}
                      />{' '}
                      {s.toLowerCase()}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
