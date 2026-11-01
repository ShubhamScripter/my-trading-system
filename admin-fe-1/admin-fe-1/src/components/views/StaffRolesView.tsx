import React, { useState, useEffect } from 'react';
import { ChatStaffRole } from '../../types';
import { AdminAPI } from '../../services/api';
import { IconPlus, IconTrash } from '../Icons';

interface StaffRolesViewProps {
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

export const StaffRolesView: React.FC<StaffRolesViewProps> = ({ onShowToast }) => {
  const [roles, setRoles] = useState<ChatStaffRole[]>([]);
  const [loading, setLoading] = useState(false);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'MODERATOR' | 'SUPPORT'>('MODERATOR');
  const [note, setNote] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);

  const fetchRoles = async () => {
    setLoading(true);
    try {
      const data = await AdminAPI.getStaffRoles();
      setRoles(data);
    } catch {
      onShowToast('Failed to load chat staff roles', 'danger');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRoles();
  }, []);

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim() || !note.trim()) return;

    try {
      const res = await AdminAPI.assignStaffRole(userId.trim(), role, note.trim());
      if (res.success) {
        onShowToast(`Assigned ${role} role to user!`);
        setUserId('');
        setNote('');
        setIsAssigning(false);
        fetchRoles();
      } else {
        onShowToast(res.error || 'Failed to assign role (Super Admin required - CH-017)', 'danger');
      }
    } catch {
      onShowToast('Network error assigning staff role', 'danger');
    }
  };

  const handleRemove = async (staff: ChatStaffRole) => {
    const removeNote = window.prompt(`Remove staff role from @${staff.username}? Enter reason note:`, 'Staff role revoked by super-admin');
    if (!removeNote || !removeNote.trim()) return;
    try {
      const res = await AdminAPI.removeStaffRole(staff.userId, removeNote.trim());
      if (res.success) {
        onShowToast('Staff role removed');
        fetchRoles();
      } else {
        onShowToast(res.error || 'Failed to remove staff role', 'danger');
      }
    } catch {
      onShowToast('Network error removing staff role', 'danger');
    }
  };

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>Chat Staff Roles &amp; Permissions (CH-017, D-21)</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Assign and revoke chat moderation staff roles (ADMIN, MODERATOR, SUPPORT). Super-admin authentication required.
            </p>
          </div>
          <button className="btn-action" onClick={() => setIsAssigning(!isAssigning)}>
            <IconPlus size={15} />
            <span>{isAssigning ? 'Cancel' : 'Assign Staff Role'}</span>
          </button>
        </div>

        {isAssigning && (
          <div
            style={{
              background: 'var(--surface-elevated, #1e293b)',
              padding: '16px',
              borderRadius: '10px',
              border: '1px solid var(--border)',
              margin: '16px 0',
            }}
          >
            <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#fff' }}>Assign Chat Staff Role</h4>
            <form onSubmit={handleAssign} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div className="form-group">
                <label>Username or user ID</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. staff1"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>Role</label>
                <select
                  className="form-control"
                  value={role}
                  onChange={(e) => setRole(e.target.value as any)}
                >
                  <option value="MODERATOR">MODERATOR (Can warn, ban, retract, view reports)</option>
                  <option value="ADMIN">ADMIN (Full chat management)</option>
                  <option value="SUPPORT">SUPPORT (Staff room access only)</option>
                </select>
              </div>
              <div className="form-group">
                <label>Audit Reason Note (Required - CH-017, CH-090)</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="Audit reason for staff appointment..."
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  required
                />
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="submit" className="btn-action">
                  Confirm Role Assignment
                </button>
                <button type="button" className="btn-secondary" onClick={() => setIsAssigning(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="table-responsive" style={{ marginTop: '16px' }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Assigned Date</th>
                <th>Assigned By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                    Loading staff roles...
                  </td>
                </tr>
              ) : roles.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                    No staff roles assigned yet.
                  </td>
                </tr>
              ) : (
                roles.map((st) => (
                  <tr key={st.userId}>
                    <td>
                      <strong>@{st.username}</strong>
                      <br />
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{st.userId}</span>
                    </td>
                    <td>
                      <span
                        className="tag-badge"
                        style={{
                          background: st.role === 'ADMIN' ? 'rgba(239,68,68,0.2)' : 'rgba(59,130,246,0.2)',
                          color: st.role === 'ADMIN' ? '#f87171' : '#60a5fa',
                          fontWeight: 700,
                        }}
                      >
                        {st.role}
                      </span>
                    </td>
                    <td>{new Date(st.assignedAt).toLocaleDateString()}</td>
                    <td>
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {st.assignedBy ? 'Admin' : 'System'}
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn-danger"
                        style={{ fontSize: '11px', padding: '4px 8px' }}
                        onClick={() => handleRemove(st)}
                      >
                        <IconTrash size={12} /> Revoke Role
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};
