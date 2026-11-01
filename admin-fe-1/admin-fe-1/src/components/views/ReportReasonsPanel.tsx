import React, { useEffect, useState } from 'react';
import { ReportReasonItem } from '../../types';
import { AdminAPI } from '../../services/api';

/** The report reasons users choose from (D-26): the admin adds, renames, orders and switches them off. */
export const ReportReasonsPanel: React.FC = () => {
  const [reasons, setReasons] = useState<ReportReasonItem[]>([]);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => setReasons(await AdminAPI.getReportReasons());

  useEffect(() => {
    load();
  }, []);

  const save = async (reason: ReportReasonItem) => {
    const res: any = await AdminAPI.upsertReportReason(reason);
    setMessage(res?.success === false ? res.error || 'Could not save the reason' : 'Saved');
    load();
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    save({
      code: code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
      label: label.trim(),
      isActive: true,
      sortOrder: reasons.length + 1,
    });
    setCode('');
    setLabel('');
  };

  return (
    <div className="card-section" style={{ marginTop: '20px' }}>
      <h3>Report Reasons (D-26)</h3>
      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
        The list users pick from when they report a message or a user.
      </p>
      <form onSubmit={add} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '12px 0' }}>
        <input className="form-control" style={{ maxWidth: '180px' }} placeholder="CODE e.g. QA_TEST" value={code} onChange={(e) => setCode(e.target.value)} required />
        <input className="form-control" style={{ maxWidth: '280px' }} placeholder="Label users see" value={label} onChange={(e) => setLabel(e.target.value)} required />
        <button type="submit" className="btn-action">Add reason</button>
        {message && <span style={{ fontSize: '12px', alignSelf: 'center' }}>{message}</span>}
      </form>
      <table className="admin-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th>Code</th>
            <th>Label</th>
            <th>Order</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {reasons.map((r) => (
            <tr key={r.code}>
              <td style={{ fontFamily: 'monospace' }}>{r.code}</td>
              <td>{r.label}</td>
              <td>{r.sortOrder}</td>
              <td>
                <input type="checkbox" checked={r.isActive} onChange={(e) => save({ ...r, isActive: e.target.checked })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
