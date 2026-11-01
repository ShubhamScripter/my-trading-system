import React, { useState, useEffect } from 'react';
import { ChatRegion } from '../../types';
import { AdminAPI } from '../../services/api';
import { IconPlus, IconTrash } from '../Icons';

interface RegionsViewProps {
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

export const RegionsView: React.FC<RegionsViewProps> = ({ onShowToast }) => {
  const [regions, setRegions] = useState<ChatRegion[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [countriesText, setCountriesText] = useState('US, CA, MX');
  const [isCreating, setIsCreating] = useState(false);

  const fetchRegions = async () => {
    setLoading(true);
    try {
      const data = await AdminAPI.getRegions();
      setRegions(data);
    } catch {
      onShowToast('Failed to load regions', 'danger');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRegions();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const countries = countriesText
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => /^[A-Z]{2}$/.test(c));

    if (countries.length === 0) {
      onShowToast('Please provide at least one valid 2-letter ISO country code', 'danger');
      return;
    }

    try {
      const res = await AdminAPI.createRegion(name.trim(), countries);
      if (res.success) {
        onShowToast(`Region "${name.trim()}" created successfully!`);
        setName('');
        setCountriesText('');
        setIsCreating(false);
        fetchRegions();
      } else {
        onShowToast(res.error || 'Failed to create region', 'danger');
      }
    } catch {
      onShowToast('Network error creating region', 'danger');
    }
  };

  const handleDelete = async (region: ChatRegion) => {
    if (!window.confirm(`Delete region "${region.name}"?`)) return;
    try {
      const res = await AdminAPI.deleteRegion(region.id);
      if (res.success) {
        onShowToast('Region deleted');
        fetchRegions();
      } else {
        onShowToast(res.error || 'Failed to delete region', 'danger');
      }
    } catch {
      onShowToast('Network error deleting region', 'danger');
    }
  };

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>Regions &amp; Country Groups Management (CH-084)</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Define geographical country groups used by REGION chat rooms and per-region chat settings exceptions.
            </p>
          </div>
          <button className="btn-action" onClick={() => setIsCreating(!isCreating)}>
            <IconPlus size={15} />
            <span>{isCreating ? 'Cancel' : 'Create Custom Region'}</span>
          </button>
        </div>

        {isCreating && (
          <div
            style={{
              background: 'var(--surface-elevated, #1e293b)',
              padding: '16px',
              borderRadius: '10px',
              border: '1px solid var(--border)',
              margin: '16px 0',
            }}
          >
            <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#fff' }}>Add New Region</h4>
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div className="form-group">
                <label>Region Name</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. North America, DACH, Nordic Countries"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>ISO 3166-1 Alpha-2 Country Codes (comma separated)</label>
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. US, CA, MX"
                  value={countriesText}
                  onChange={(e) => setCountriesText(e.target.value)}
                  required
                />
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Enter two-letter capital codes (e.g. US, GB, DE, FR, IN, JP)
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button type="submit" className="btn-action">
                  Save Region
                </button>
                <button type="button" className="btn-secondary" onClick={() => setIsCreating(false)}>
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
                <th>Region Name</th>
                <th>Country Codes</th>
                <th>Total Countries</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                    Loading regions...
                  </td>
                </tr>
              ) : regions.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)' }}>
                    No custom regions configured yet.
                  </td>
                </tr>
              ) : (
                regions.map((reg) => (
                  <tr key={reg.id}>
                    <td>
                      <strong>{reg.name}</strong>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', maxWidth: '400px' }}>
                        {reg.countries.map((c) => (
                          <span
                            key={c}
                            style={{
                              fontSize: '11px',
                              background: 'rgba(255,255,255,0.08)',
                              padding: '2px 6px',
                              borderRadius: '4px',
                            }}
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>{reg.countries.length}</td>
                    <td>{new Date(reg.createdAt).toLocaleDateString()}</td>
                    <td>
                      <button
                        className="btn-danger"
                        style={{ fontSize: '11px', padding: '4px 8px' }}
                        onClick={() => handleDelete(reg)}
                      >
                        <IconTrash size={12} /> Delete
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
