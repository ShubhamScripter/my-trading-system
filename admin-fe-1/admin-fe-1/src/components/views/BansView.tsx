import { FrequentHittersPanel } from './FrequentHittersPanel';
import React from 'react';
import { UserBan } from '../../types';
import { IconPlus } from '../Icons';
import { ModulesAPI } from '../../services/modulesApi';

interface BansViewProps {
  bans: UserBan[];
  onOpenIssueBan: () => void;
  onUnbanUser: (banId: string, note?: string) => void;
  /** After a ban was edited (new end or reason). */
  onBansChanged?: () => void;
  onShowToast?: (msg: string, type?: 'success' | 'danger') => void;
}

export const BansView: React.FC<BansViewProps> = ({
  bans,
  onOpenIssueBan,
  onUnbanUser,
  onBansChanged,
  onShowToast,
}) => {
  /** "Check Chat Banned / Penalised Users List: Edit": a new end from now, or permanent, and a new reason. */
  const handleEdit = async (ban: UserBan) => {
    const hours = window.prompt('New end, in hours from now ("permanent" for no end):', '24');
    if (hours === null || !hours.trim()) return;
    const reason = window.prompt('New reason (empty = keep):', '') ?? '';
    const permanent = hours.trim().toLowerCase() === 'permanent';
    const res = await ModulesAPI.changeBan(ban.id, {
      ...(permanent ? { permanent: true as const } : { durationHours: Number(hours) }),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
    if (res.success) {
      onShowToast?.('Ban changed; the user was told');
      onBansChanged?.();
    } else {
      onShowToast?.(res.error || 'Could not change the ban', 'danger');
    }
  };

  const handleUnban = (banId: string) => {
    const note = window.prompt('Enter reason / audit note for lifting ban (required - CH-090):', 'Ban lifted by administrator');
    if (note && note.trim()) {
      onUnbanUser(banId, note.trim());
    }
  };

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>User Bans &amp; Penalty Enforcement</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Active temporary and permanent chat bans across all public rooms or scoped to a specific room.
            </p>
          </div>
          <button className="btn-danger" onClick={onOpenIssueBan} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <IconPlus size={15} />
            <span>Issue User Ban</span>
          </button>
        </div>

        <div className="table-responsive">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Scope / Room</th>
                <th>Reason</th>
                <th>Audit Note</th>
                <th>Date Banned</th>
                <th>Duration / Expiry</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {bans.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                    No active bans in directory.
                  </td>
                </tr>
              ) : (
                bans.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <strong>{b.username}</strong>
                      <br />
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>ID: {b.userId}</span>
                    </td>
                    <td>{b.roomName || 'Global (All Rooms)'}</td>
                    <td>{b.reason}</td>
                    <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{b.note || '—'}</td>
                    <td>{new Date(b.bannedAt).toLocaleDateString()}</td>
                    <td>
                      <span style={{ color: b.isActive ? 'var(--danger)' : 'var(--text-muted)', fontWeight: 700 }}>
                        {b.isActive
                          ? (b.expiresAt ? `Expires: ${new Date(b.expiresAt).toLocaleString()}` : 'Permanent')
                          : 'Expired / Revoked'}
                      </span>
                    </td>
                    <td>
                      {b.isActive ? (
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            className="btn-secondary"
                            style={{ padding: '6px 12px', fontSize: '11px' }}
                            onClick={() => handleEdit(b)}
                          >
                            Edit
                          </button>
                          <button
                            className="btn-secondary"
                            style={{ padding: '6px 12px', fontSize: '11px' }}
                            onClick={() => handleUnban(b.id)}
                          >
                            Lift Ban
                          </button>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <FrequentHittersPanel />
    </section>
  );
};
