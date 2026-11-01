import React, { useState, useEffect } from 'react';
import { SettingsChange } from '../../types';
import { AdminAPI } from '../../services/api';
import { TestUsersPanel } from './TestUsersPanel';

interface SettingsViewProps {
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onShowToast }) => {
  const [settingsDoc, setSettingsDoc] = useState<any>(null);
  const [version, setVersion] = useState<number>(1);
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const [changes, setChanges] = useState<SettingsChange[]>([]);
  const [loading, setLoading] = useState(false);

  // Form states for editable settings
  const [eventsPerSec, setEventsPerSec] = useState(10);
  const [eventsBurst, setEventsBurst] = useState(20);
  const [connectionsPerAccount, setConnectionsPerAccount] = useState(5);
  const [gifProvider, setGifProvider] = useState<'TENOR' | 'GIPHY'>('TENOR');
  const [allowedDomains, setAllowedDomains] = useState('');
  const [testProvidersEnabled, setTestProvidersEnabled] = useState(false);
  const [allowImagesDefault, setAllowImagesDefault] = useState(false);
  const [allowVideosDefault, setAllowVideosDefault] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState('');
  // The effective settings as the server applies them (defaults included); a save sends only what differs (CH-083).
  const [effective, setEffective] = useState<any>(null);
  const [draft, setDraft] = useState<any>({ limits: {}, defaultRoom: {}, casino: {} });
  const setDraftValue = (section: string, key: string, value: unknown) =>
    setDraft((prev: any) => ({ ...prev, [section]: { ...(prev[section] || {}), [key]: value } }));

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const data = await AdminAPI.getSettings();
      if (data?.document) {
        setSettingsDoc(data.document);
        setVersion(data.version || 1);
        setUpdatedAt(data.updatedAt || '');

        const global = data.document.global || {};
        if (global.limits) {
          setEventsPerSec(global.limits.eventsPerSecond ?? 10);
          setEventsBurst(global.limits.eventsBurst ?? 20);
          setConnectionsPerAccount(global.limits.connectionsPerAccount ?? 5);
        }
        setAllowedDomains((global.links?.allowedDomains ?? []).join(', '));
        if (global.media) {
          setGifProvider(global.media.gifProvider || 'TENOR');
        }
        // The stored document is { global, countries }; testProviders lives under global (NEW-2).
        setTestProvidersEnabled(Boolean(global.testProviders?.enabled));
      }
      const preview = await AdminAPI.previewSettings();
      const full = (preview as any)?.settings ?? preview;
      if (full && full.limits) {
        setEffective(full);
        setDraft({ limits: { ...full.limits }, defaultRoom: { ...full.defaultRoom }, casino: { ...full.casino } });
      }
      const changeHistory = await AdminAPI.getSettingsChanges();
      setChanges(changeHistory);
    } catch {
      onShowToast('Failed to load chat settings', 'danger');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    // SettingsPatchSchema: chat-wide values go under `global` (CH-083, CH-084).
    const desired: any = {
      limits: {
        eventsPerSecond: Number(eventsPerSec),
        eventsBurst: Number(eventsBurst),
        connectionsPerAccount: Number(connectionsPerAccount),
      },
      media: {
        gifProvider,
      },
      links: {
        allowedDomains: allowedDomains
          .split(',')
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
      },
      testProviders: {
        enabled: testProvidersEnabled,
      },
    };
    for (const section of ['limits', 'defaultRoom', 'casino']) {
      desired[section] = { ...(draft[section] || {}), ...(desired[section] || {}) };
    }
    const global: any = {};
    for (const [section, values] of Object.entries(desired) as [string, any][]) {
      for (const [key, value] of Object.entries(values)) {
        if (JSON.stringify(effective?.[section]?.[key]) !== JSON.stringify(value)) {
          global[section] = { ...(global[section] || {}), [key]: value };
        }
      }
    }
    if (Object.keys(global).length === 0) {
      onShowToast('Nothing changed');
      return;
    }
    const patch = { global };

    try {
      const res = await AdminAPI.saveSettings(patch, effectiveDate ? new Date(effectiveDate).toISOString() : undefined);
      if (res.success) {
        onShowToast(res.applied ? 'Settings applied immediately!' : 'Settings change scheduled!');
        setEffectiveDate('');
        fetchSettings();
      } else {
        onShowToast(res.error || 'Failed to save settings (Super Admin required)', 'danger');
      }
    } catch {
      onShowToast('Network error saving settings', 'danger');
    }
  };

  const handleRollback = async (changeId: string) => {
    if (!window.confirm('Rollback this settings version?')) return;
    try {
      const res = await AdminAPI.rollbackSettings(changeId);
      if (res.success) {
        onShowToast('Settings successfully rolled back!');
        fetchSettings();
      } else {
        onShowToast(res.error || 'Failed to rollback settings', 'danger');
      }
    } catch {
      onShowToast('Network error rolling back settings', 'danger');
    }
  };

  // A change still waiting for its time (settings or a room) is called off; nothing was applied yet.
  const handleCancelScheduled = async (changeId: string) => {
    if (!window.confirm('Cancel this scheduled change?')) return;
    const res = await AdminAPI.rollbackSettings(changeId);
    if (res.success) {
      onShowToast('Scheduled change cancelled');
      fetchSettings();
    } else {
      onShowToast(res.error || 'Failed to cancel the scheduled change', 'danger');
    }
  };

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>Chat Platform Settings &amp; Version History (CH-083, NEW-2, NEW-3)</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Configure system limits, media providers, and audit scheduled patches. Current Version: <strong>v{version}</strong> (Last updated: {updatedAt ? new Date(updatedAt).toLocaleString() : 'Initial'})
            </p>
          </div>
        </div>

        <form onSubmit={handleSaveSettings} style={{ marginTop: '20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
            {/* Rate Limits & Flood Protection */}
            <div style={{ background: 'var(--surface-elevated, #1e293b)', padding: '18px', borderRadius: '10px', border: '1px solid var(--border)' }}>
              <h4 style={{ margin: '0 0 14px 0', fontSize: '14px', color: '#fff' }}>⚡ Rate Limits &amp; Sockets (CH-020, CH-088)</h4>
              <div className="form-group">
                <label>Max Events / Second per Connection</label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  className="form-control"
                  value={eventsPerSec}
                  onChange={(e) => setEventsPerSec(Number(e.target.value))}
                  required
                />
              </div>
              <div className="form-group">
                <label>Token Burst Bucket</label>
                <input
                  type="number"
                  min="1"
                  max="200"
                  className="form-control"
                  value={eventsBurst}
                  onChange={(e) => setEventsBurst(Number(e.target.value))}
                  required
                />
              </div>
              <div className="form-group">
                <label>Max Simultaneous Connections per Account</label>
                <input
                  type="number"
                  min="1"
                  max="20"
                  className="form-control"
                  value={connectionsPerAccount}
                  onChange={(e) => setConnectionsPerAccount(Number(e.target.value))}
                  required
                />
              </div>
            </div>

            {/* Media & GIF Providers */}
            <div style={{ background: 'var(--surface-elevated, #1e293b)', padding: '18px', borderRadius: '10px', border: '1px solid var(--border)' }}>
              <h4 style={{ margin: '0 0 14px 0', fontSize: '14px', color: '#fff' }}>🎨 Media &amp; GIF Provider (NEW-3, D-29)</h4>
              <div className="form-group">
                <label>GIF Provider Engine</label>
                <select
                  className="form-control"
                  value={gifProvider}
                  onChange={(e) => setGifProvider(e.target.value as any)}
                >
                  <option value="TENOR">Tenor (media.tenor.com)</option>
                  <option value="GIPHY">Giphy (media.giphy.com)</option>
                </select>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Only verified https GIF hosts from this provider will be allowed in messages.
                </span>
              </div>
              <div className="form-group">
                <label>"OREBiT links only" — allowed domains (comma separated)</label>
                <input
                  className="form-control"
                  value={allowedDomains}
                  onChange={(e) => setAllowedDomains(e.target.value)}
                  placeholder="orebit.io, orebit.com"
                />
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Rooms with link policy "OREBiT only" accept these hosts and their subdomains, nothing else (CH-030).
                </span>
              </div>

              <div style={{ marginTop: '20px' }}>
                <h4 style={{ margin: '0 0 10px 0', fontSize: '13px', color: '#fff' }}>🧪 Test-Only Stand-In Providers (NEW-2, D-13)</h4>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' }}>
                  <input
                    type="checkbox"
                    checked={testProvidersEnabled}
                    onChange={(e) => setTestProvidersEnabled(e.target.checked)}
                  />
                  <span>Enable Demo Stand-In Facts (Non-production only)</span>
                </label>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  Allows chat to read test entitlements for Casino, Premium, KYC, and Site-Owner facts outside production.
                </p>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px', marginTop: '20px' }}>
            <div style={{ background: 'var(--surface-elevated, #1e293b)', padding: '18px', borderRadius: '10px', border: '1px solid var(--border)' }}>
              <h4 style={{ margin: '0 0 14px 0', fontSize: '14px', color: '#fff' }}>🐢 Slow Mode &amp; Limits (D-25)</h4>
                <div className="form-group">
                  <label>Messages allowed per window</label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    className="form-control"
                    value={draft.limits?.messagesPerWindow ?? ''}
                    onChange={(e) => setDraftValue('limits', 'messagesPerWindow', Number(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label>Window length (seconds)</label>
                  <input
                    type="number"
                    min="1"
                    max="600"
                    className="form-control"
                    value={draft.limits?.messageWindowSeconds ?? ''}
                    onChange={(e) => setDraftValue('limits', 'messageWindowSeconds', Number(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label>Cooldown after the limit (seconds)</label>
                  <input
                    type="number"
                    min="1"
                    max="3600"
                    className="form-control"
                    value={draft.limits?.cooldownSeconds ?? ''}
                    onChange={(e) => setDraftValue('limits', 'cooldownSeconds', Number(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label>Seconds between media messages / uploads</label>
                  <input
                    type="number"
                    min="0"
                    max="3600"
                    className="form-control"
                    value={draft.limits?.mediaCooldownSeconds ?? ''}
                    onChange={(e) => setDraftValue('limits', 'mediaCooldownSeconds', Number(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label>Retract own message within (seconds, 0 = any time)</label>
                  <input
                    type="number"
                    min="0"
                    max="2592000"
                    className="form-control"
                    value={draft.limits?.retractWindowSeconds ?? ''}
                    onChange={(e) => setDraftValue('limits', 'retractWindowSeconds', Number(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label>Longest ban allowed (hours)</label>
                  <input
                    type="number"
                    min="1"
                    max="87600"
                    className="form-control"
                    value={draft.limits?.maxBanHours ?? ''}
                    onChange={(e) => setDraftValue('limits', 'maxBanHours', Number(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label>Reports per user per hour</label>
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    className="form-control"
                    value={draft.limits?.reportsPerHour ?? ''}
                    onChange={(e) => setDraftValue('limits', 'reportsPerHour', Number(e.target.value))}
                  />
                </div>
            </div>

            <div style={{ background: 'var(--surface-elevated, #1e293b)', padding: '18px', borderRadius: '10px', border: '1px solid var(--border)' }}>
              <h4 style={{ margin: '0 0 14px 0', fontSize: '14px', color: '#fff' }}>🚪 Default Room (D-17)</h4>
              <div className="form-group">
                <label>Room that opens for a user with no last room</label>
                <select
                  className="form-control"
                  value={draft.defaultRoom?.base ?? 'GLOBAL'}
                  onChange={(e) => setDraftValue('defaultRoom', 'base', e.target.value)}
                >
                  <option value="GLOBAL">Global chat</option>
                  <option value="COUNTRY">The user's country room</option>
                </select>
              </div>
              <label style={{ display: 'flex', gap: '8px', fontSize: '13px', marginBottom: '8px' }}>
                <input type="checkbox" checked={Boolean(draft.defaultRoom?.premiumFirst)} onChange={(e) => setDraftValue('defaultRoom', 'premiumFirst', e.target.checked)} />
                Premium users open the premium room first
              </label>
              <label style={{ display: 'flex', gap: '8px', fontSize: '13px' }}>
                <input type="checkbox" checked={Boolean(draft.defaultRoom?.kycFirst)} onChange={(e) => setDraftValue('defaultRoom', 'kycFirst', e.target.checked)} />
                KYC users open the KYC room first (premium wins)
              </label>

              <h4 style={{ margin: '20px 0 14px 0', fontSize: '14px', color: '#fff' }}>🎰 Casino Room (D-10)</h4>
                <div className="form-group">
                  <label>Wager counted over the last N days</label>
                  <input
                    type="number"
                    min="1"
                    max="365"
                    className="form-control"
                    value={draft.casino?.wagerWindowDays ?? ''}
                    onChange={(e) => setDraftValue('casino', 'wagerWindowDays', Number(e.target.value))}
                  />
                </div>
              <label style={{ display: 'flex', gap: '8px', fontSize: '13px', marginBottom: '8px' }}>
                <input type="checkbox" checked={Boolean(draft.casino?.autoSwitch)} onChange={(e) => setDraftValue('casino', 'autoSwitch', e.target.checked)} />
                Auto-switch to the casino room when OREBiT Play opens
              </label>
            </div>
          </div>

          <div style={{ marginTop: '20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button type="submit" className="btn-action">
              Save Chat Settings
            </button>
          </div>
        </form>

        {/* Change History & Rollback (CH-083) */}
        <div style={{ marginTop: '36px' }}>
          <h4 style={{ fontSize: '15px', color: '#fff', marginBottom: '12px' }}>
            📜 Settings Change Log &amp; Rollback History (CH-083)
          </h4>
          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Created At</th>
                  <th>Applied / Scheduled</th>
                  <th>Created By</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {changes.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                      No settings patches recorded yet.
                    </td>
                  </tr>
                ) : (
                  changes.map((ch) => (
                    <tr key={ch.id}>
                      <td>
                        <strong>#{changes.length - changes.indexOf(ch)}</strong>
                      </td>
                      <td>
                        <span
                          className="tag-badge"
                          style={{
                            background:
                              ch.status === 'APPLIED'
                                ? 'rgba(16,185,129,0.2)'
                                : ch.status === 'SCHEDULED'
                                ? 'rgba(245,158,11,0.2)'
                                : 'rgba(239,68,68,0.2)',
                            color:
                              ch.status === 'APPLIED'
                                ? '#34d399'
                                : ch.status === 'SCHEDULED'
                                ? '#fbbf24'
                                : '#f87171',
                          }}
                        >
                          {ch.status}
                        </span>
                      </td>
                      <td>{new Date(ch.createdAt).toLocaleString()}</td>
                      <td>
                        {ch.appliedAt
                          ? `Applied: ${new Date(ch.appliedAt).toLocaleString()}`
                          : (ch as any).effectiveAt
                          ? `Scheduled: ${new Date((ch as any).effectiveAt).toLocaleString()}`
                          : '—'}
                      </td>
                      <td>
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                          {(ch as any).actorId ? 'Super Admin' : 'System'}
                        </span>
                      </td>
                      <td>
                        {ch.status === 'APPLIED' && (
                          <button
                            className="btn-secondary"
                            style={{ fontSize: '11px', padding: '4px 8px' }}
                            onClick={() => handleRollback(ch.id)}
                          >
                            Rollback to this
                          </button>
                        )}
                        {ch.status === 'SCHEDULED' && (
                          <button
                            className="btn-secondary"
                            style={{ fontSize: '11px', padding: '4px 8px' }}
                            onClick={() => handleCancelScheduled(ch.id)}
                          >
                            Cancel {ch.target === 'ROOM' ? 'room change' : 'scheduled'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <TestUsersPanel onShowToast={onShowToast} />
    </section>
  );
};
