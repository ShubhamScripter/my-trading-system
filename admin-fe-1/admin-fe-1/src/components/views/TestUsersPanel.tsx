import React, { useEffect, useState } from 'react';
import { AdminAPI } from '../../services/api';

interface TestUsersPanelProps {
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

interface Entry {
  userId: string;
  username: string;
  onCasino: boolean;
  wagerUsd: string;
  premiumPlanIds: string[];
  kycLevel: number | null;
  isSiteOwner: boolean;
  level: number | null;
}

/**
 * Test-only stand-in facts (NEW-2, D-13): mark a user as on the casino, premium, KYC level or site owner so the
 * Module 2 demo can show eligible users. Works only while "Test providers" is ON, outside production.
 */
export const TestUsersPanel: React.FC<TestUsersPanelProps> = ({ onShowToast }) => {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [userId, setUserId] = useState('');
  const [onCasino, setOnCasino] = useState(true);
  const [wagerUsd, setWagerUsd] = useState('0');
  const [planIds, setPlanIds] = useState('');
  const [kycLevel, setKycLevel] = useState(0);
  const [isSiteOwner, setIsSiteOwner] = useState(false);
  const [level, setLevel] = useState(0);

  const load = async () => setEntries(await AdminAPI.getTestEntitlements());

  useEffect(() => {
    load();
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await AdminAPI.upsertTestEntitlement({
      userId: userId.trim(),
      onCasino,
      wagerUsd: wagerUsd.trim() || '0',
      premiumPlanIds: planIds.split(',').map((p) => p.trim()).filter(Boolean),
      kycLevel: Number(kycLevel) || 0,
      isSiteOwner,
      level: Number(level) || 0,
    });
    if (res.success) {
      onShowToast('Test user saved — their rooms update within a few seconds');
      load();
    } else {
      onShowToast(res.error || 'Failed to save test user', 'danger');
    }
  };

  const edit = (entry: Entry) => {
    setUserId(entry.username);
    setOnCasino(entry.onCasino);
    setWagerUsd(entry.wagerUsd);
    setPlanIds(entry.premiumPlanIds.join(', '));
    setKycLevel(entry.kycLevel ?? 0);
    setIsSiteOwner(entry.isSiteOwner);
    setLevel(entry.level ?? 0);
  };

  const remove = async (entry: Entry) => {
    const res = await AdminAPI.deleteTestEntitlement(entry.userId);
    if (res.success) {
      onShowToast('Test user removed');
      load();
    } else {
      onShowToast(res.error || 'Failed to remove test user', 'danger');
    }
  };

  return (
    <div className="card-section" style={{ marginTop: '20px' }}>
      <h3>🧪 Test Users — Casino / Premium / KYC / Site Owner demo (NEW-2)</h3>
      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
        Turn ON "Test providers" above and save first. Then mark a user here, e.g. <strong>On casino</strong> + wager, to
        let them write in the Casino room. Ignored in production.
      </p>

      <form onSubmit={save} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginTop: '14px' }}>
        <div className="form-group">
          <label>Username or user id</label>
          <input className="form-control" value={userId} onChange={(e) => setUserId(e.target.value)} required />
        </div>
        <div className="form-group">
          <label>Wager in window (USD)</label>
          <input className="form-control" value={wagerUsd} onChange={(e) => setWagerUsd(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Premium plan ids (comma)</label>
          <input className="form-control" value={planIds} onChange={(e) => setPlanIds(e.target.value)} placeholder="any = premium" />
        </div>
        <div className="form-group">
          <label>KYC level</label>
          <input type="number" min="0" max="10" className="form-control" value={kycLevel} onChange={(e) => setKycLevel(Number(e.target.value))} />
        </div>
        <div className="form-group">
          <label>User level</label>
          <input type="number" min="0" className="form-control" value={level} onChange={(e) => setLevel(Number(e.target.value))} />
        </div>
        <div className="form-group" style={{ display: 'flex', flexDirection: 'column', gap: '6px', justifyContent: 'center' }}>
          <label><input type="checkbox" checked={onCasino} onChange={(e) => setOnCasino(e.target.checked)} /> On casino (OREBiT Play)</label>
          <label><input type="checkbox" checked={isSiteOwner} onChange={(e) => setIsSiteOwner(e.target.checked)} /> Site owner</label>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button type="submit" className="btn btn-primary">Save test user</button>
        </div>
      </form>

      <table className="data-table" style={{ marginTop: '14px', width: '100%' }}>
        <thead>
          <tr>
            <th>User</th>
            <th>On casino</th>
            <th>Wager</th>
            <th>Premium</th>
            <th>KYC</th>
            <th>SO</th>
            <th>Level</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={8}>No test users yet.</td>
            </tr>
          ) : (
            entries.map((entry) => (
              <tr key={entry.userId}>
                <td>{entry.username}</td>
                <td>{entry.onCasino ? 'Yes' : 'No'}</td>
                <td>${entry.wagerUsd}</td>
                <td>{entry.premiumPlanIds.length > 0 ? entry.premiumPlanIds.join(', ') : '—'}</td>
                <td>{entry.kycLevel ?? 0}</td>
                <td>{entry.isSiteOwner ? 'Yes' : 'No'}</td>
                <td>{entry.level ?? 0}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button type="button" className="btn btn-sm" onClick={() => edit(entry)}>Edit</button>{' '}
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => remove(entry)}>Remove</button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
};
