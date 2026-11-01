import { ReportReasonsPanel } from './ReportReasonsPanel';
import React, { useState } from 'react';
import { ChatReport } from '../../types';

interface ReportsViewProps {
  reports: ChatReport[];
  onActionReport: (reportId: string, action: 'DISMISS' | 'RETRACT_MESSAGE' | 'WARN' | 'BAN') => void;
  onFilterChange: (status: string) => void;
}

export const ReportsView: React.FC<ReportsViewProps> = ({
  reports,
  onActionReport,
  onFilterChange,
}) => {
  const [selectedFilter, setSelectedFilter] = useState('ALL');

  const handleFilter = (status: string) => {
    setSelectedFilter(status);
    onFilterChange(status);
  };

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>Reported Messages & User Moderation Queue</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Review complaints submitted by users for spam, scams, harassment, or abusive content.
            </p>
          </div>
          <div className="filter-bar">
            <button
              className={`btn-secondary ${selectedFilter === 'ALL' ? 'active' : ''}`}
              onClick={() => handleFilter('ALL')}
            >
              All
            </button>
            <button
              className={`btn-secondary ${selectedFilter === 'PENDING' ? 'active' : ''}`}
              style={{ color: 'var(--warning)' }}
              onClick={() => handleFilter('PENDING')}
            >
              Pending
            </button>
            <button
              className={`btn-secondary ${selectedFilter === 'ACTIONED' ? 'active' : ''}`}
              style={{ color: 'var(--success)' }}
              onClick={() => handleFilter('ACTIONED')}
            >
              Actioned
            </button>
          </div>
        </div>

        <div className="table-responsive">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Message Snippet</th>
                <th>Offender / Reporter</th>
                <th>Room</th>
                <th>Status</th>
                <th>Moderator Action</th>
              </tr>
            </thead>
            <tbody>
              {reports.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                    No reports found in this queue.
                  </td>
                </tr>
              ) : (
                reports.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span
                        className="tag-badge"
                        style={{
                          background: 'rgba(255, 51, 102, 0.15)',
                          color: '#ff3366',
                          border: '1px solid rgba(255, 51, 102, 0.3)',
                        }}
                      >
                        {r.reason}
                      </span>
                    </td>
                    <td>
                      <div
                        style={{
                          maxWidth: '260px',
                          fontSize: '13px',
                          color: '#fff',
                          background: 'rgba(0,0,0,0.3)',
                          padding: '8px 12px',
                          borderRadius: '6px',
                          borderLeft: '2px solid var(--danger)',
                        }}
                      >
                        "{r.messageContent}"
                      </div>
                      {r.details && (
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginTop: '4px' }}>
                          Context: {r.details}
                        </span>
                      )}
                    </td>
                    <td>
                      <strong>{r.reportedUsername}</strong>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block' }}>
                        by {r.reporterUsername}
                      </span>
                    </td>
                    <td>{r.roomName}</td>
                    <td>
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          color:
                            r.status === 'PENDING'
                              ? 'var(--warning)'
                              : r.status === 'ACTIONED'
                              ? 'var(--success)'
                              : 'var(--text-muted)',
                        }}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td>
                      {r.status === 'PENDING' ? (
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button className="btn-success" onClick={() => onActionReport(r.id, 'DISMISS')}>
                            Dismiss
                          </button>
                          <button className="btn-secondary" onClick={() => onActionReport(r.id, 'RETRACT_MESSAGE')}>
                            Retract
                          </button>
                          <button className="btn-secondary" onClick={() => onActionReport(r.id, 'WARN')}>
                            Warn
                          </button>
                          <button className="btn-danger" onClick={() => onActionReport(r.id, 'BAN')}>
                            Ban 24h
                          </button>
                        </div>
                      ) : (
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {r.actionTaken || 'Closed'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <ReportReasonsPanel />
    </section>
  );
};
