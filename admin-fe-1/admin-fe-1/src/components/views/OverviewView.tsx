import React from 'react';
import { PlatformStats, AdminRoom } from '../../types';
import {
  IconRooms,
  IconUsers,
  IconMessages,
  IconReports,
  IconBans,
  IconCosmetics,
  IconGlobe,
  IconCrown,
  IconAlert,
  IconShield,
} from '../Icons';

interface OverviewViewProps {
  stats: PlatformStats | null;
  rooms: AdminRoom[];
  onNavigateTab: (tab: string) => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  stats,
  rooms,
  onNavigateTab,
}) => {
  const renderRoomIcon = (type: string) => {
    switch (type) {
      case 'GLOBAL':
        return <IconGlobe size={18} color="var(--primary)" />;
      case 'PREMIUM':
        return <span style={{ fontSize: '12px', fontWeight: 800, color: '#a855f7' }}>PRO</span>;
      case 'VIP':
        return <IconCrown size={18} color="#ffd700" />;
      case 'CASINO':
        return <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--accent-purple)' }}>CAS</span>;
      case 'COUNTRY':
        return <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--success)' }}>REG</span>;
      case 'REGION':
        return <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--accent-purple)' }}>HUB</span>;
      case 'LANGUAGE':
        return <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--success)' }}>LNG</span>;
      case 'KYC':
        return <IconShield size={16} color="var(--primary)" />;
      case 'SO':
        return <span style={{ fontSize: '12px', fontWeight: 800, color: '#ffd700' }}>SO</span>;
      case 'STAFF':
        return <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--warning)' }}>MOD</span>;
      default:
        return <IconRooms size={18} color="var(--primary)" />;
    }
  };

  const getTypeBadgeClass = (type: string) => {
    switch (type) {
      case 'GLOBAL':
        return 'tag-global';
      case 'PREMIUM':
        return 'tag-casino';
      case 'VIP':
        return 'tag-vip';
      case 'CASINO':
        return 'tag-casino';
      case 'COUNTRY':
        return 'tag-country';
      case 'REGION':
        return 'tag-country';
      case 'LANGUAGE':
        return 'tag-country';
      case 'KYC':
        return 'tag-global';
      case 'SO':
        return 'tag-vip';
      case 'STAFF':
        return 'tag-casino';
      default:
        return 'tag-global';
    }
  };

  return (
    <section className="tab-view">
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Active Rooms</span>
            <div className="metric-icon-box" style={{ background: 'rgba(0, 242, 254, 0.1)', color: 'var(--primary)' }}>
              <IconRooms size={20} />
            </div>
          </div>
          <div className="metric-value">{stats?.activeRooms ?? 0}</div>
          <span className="metric-trend trend-up">&bull; All channels healthy</span>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Online Members</span>
            <div className="metric-icon-box" style={{ background: 'rgba(0, 230, 118, 0.1)', color: 'var(--success)' }}>
              <IconUsers size={20} />
            </div>
          </div>
          <div className="metric-value">{stats?.totalOnlineUsers ?? 0}</div>
          <span className="metric-trend trend-up">&uarr; Real-time connected presence</span>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Messages Sent</span>
            <div className="metric-icon-box" style={{ background: 'rgba(157, 78, 221, 0.1)', color: 'var(--accent-purple)' }}>
              <IconMessages size={20} />
            </div>
          </div>
          <div className="metric-value">{(stats?.totalMessages ?? 0).toLocaleString()}</div>
          <span className="metric-trend trend-up">&uarr; Rate limits active</span>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Pending Reports</span>
            <div className="metric-icon-box" style={{ background: 'rgba(255, 51, 102, 0.1)', color: 'var(--danger)' }}>
              <IconReports size={20} />
            </div>
          </div>
          <div className="metric-value" style={{ color: 'var(--danger)' }}>{stats?.pendingReports ?? 0}</div>
          <span className="metric-trend trend-alert" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <IconAlert size={12} />
            <span>Requires moderator attention</span>
          </span>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Active Bans</span>
            <div className="metric-icon-box" style={{ background: 'rgba(255, 179, 0, 0.1)', color: 'var(--warning)' }}>
              <IconBans size={20} />
            </div>
          </div>
          <div className="metric-value">{stats?.activeBans ?? 0}</div>
          <span className="metric-trend">&bull; Auto-enforced safety</span>
        </div>

        <div className="metric-card">
          <div className="metric-header">
            <span className="metric-title">Chat Skins</span>
            <div className="metric-icon-box" style={{ background: 'rgba(255, 215, 0, 0.1)', color: '#ffd700' }}>
              <IconCosmetics size={20} />
            </div>
          </div>
          <div className="metric-value">{stats?.totalSkins ?? stats?.totalCosmetics ?? 0}</div>
          <span className="metric-trend">&bull; VIP &amp; Store skins</span>
        </div>
      </div>

      <div className="card-section" style={{ marginTop: '24px' }}>
        <div className="card-header-row">
          <div>
            <h3>Active Public Chat Rooms</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '3px' }}>
              Real-time directory of active chat rooms across the network
            </p>
          </div>
          <button className="btn-secondary" onClick={() => onNavigateTab('rooms')}>
            View All Controls &rarr;
          </button>
        </div>
        <div className="table-responsive">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Room</th>
                <th>Type</th>
                <th>Online</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rooms.slice(0, 4).map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="room-identity">
                      <div className="room-icon-badge">{renderRoomIcon(r.type)}</div>
                      <div className="room-names">
                        <h4>{r.name}</h4>
                        <span>slug: {r.slug}</span>
                      </div>
                    </div>
                  </td>
                  <td><span className={`tag-badge ${getTypeBadgeClass(r.type)}`}>{r.type}</span></td>
                  <td><strong>{r.onlineCount ?? 0}</strong> online</td>
                  <td>
                    <span style={{ color: r.status === 'ACTIVE' && !(r as any).deletedAt ? 'var(--success)' : 'var(--text-muted)', fontWeight: 600 }}>
                      {(r as any).deletedAt ? 'Deleted' : r.status === 'MAINTENANCE' ? 'Maintenance' : r.status === 'DISABLED' ? 'Disabled' : 'Active'}
                    </span>
                  </td>
                  <td>
                    <button className="btn-secondary" style={{ padding: '5px 12px', fontSize: '12px' }} onClick={() => onNavigateTab('rooms')}>
                      Configure
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};
