import React, { useEffect, useState } from 'react';
import { FrequentHitter } from '../../types';
import { AdminAPI } from '../../services/api';

/** Users who keep hitting the chat limits (CH-088), and whether they are paused right now. */
export const FrequentHittersPanel: React.FC = () => {
  const [hitters, setHitters] = useState<FrequentHitter[]>([]);

  useEffect(() => {
    const load = async () => setHitters(await AdminAPI.getFrequentHitters(50));
    load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="card-section" style={{ marginTop: '20px' }}>
      <h3>Frequent Hitters (CH-088)</h3>
      <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
        Users who hit the rate limits most often. Over the threshold in one minute, chat pauses them for a while.
      </p>
      <table className="admin-table" style={{ width: '100%', marginTop: '12px' }}>
        <thead>
          <tr>
            <th>User</th>
            <th>Limit hits</th>
            <th>Last IP</th>
            <th>Last hit</th>
            <th>Paused until</th>
          </tr>
        </thead>
        <tbody>
          {hitters.length === 0 ? (
            <tr>
              <td colSpan={5}>No one has hit the limits yet.</td>
            </tr>
          ) : (
            hitters.map((h) => (
              <tr key={h.userId}>
                <td>{h.username ? `@${h.username}` : h.userId}</td>
                <td>{h.hits}</td>
                <td style={{ fontFamily: 'monospace' }}>{h.lastIp ?? '—'}</td>
                <td>{new Date(h.lastHitAt).toLocaleString()}</td>
                <td>{h.blockedUntil && new Date(h.blockedUntil) > new Date() ? new Date(h.blockedUntil).toLocaleString() : '—'}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
};
