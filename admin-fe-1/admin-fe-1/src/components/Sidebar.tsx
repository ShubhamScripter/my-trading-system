import React from 'react';
import { AdminUser } from '../types';
import {
  IconLogo,
  IconDashboard,
  IconRooms,
  IconRules,
  IconReports,
  IconBans,
  IconCosmetics,
  IconBroadcast,
  IconLogout,
  IconHistory,
  IconShieldCheck,
  IconGavel,
  IconSparkles,
  IconMessages,
  IconSliders,
} from './Icons';

interface SidebarProps {
  currentTab: string;
  onTabChange: (tab: string) => void;
  pendingReportsCount: number;
  adminUser: AdminUser | null;
  onLogout: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onTabChange,
  pendingReportsCount,
  adminUser,
  onLogout,
}) => {
  const adminInitial = adminUser?.name ? adminUser.name.charAt(0).toUpperCase() : 'A';

  return (
    <aside className="sidebar">
      {/* Brand Header */}
      <div className="brand-header">
        <div className="brand-logo-icon">
          <IconLogo size={22} color="#07090e" />
        </div>
        <div className="brand-info">
          <h2>OREBiT Admin</h2>
          <span className="brand-badge">Chat & Safety Studio</span>
        </div>
      </div>

      {/* Navigation Links */}
      <div className="nav-section-label">Management</div>
      <ul className="nav-links">
        <li>
          <button
            className={`nav-item ${currentTab === 'overview' ? 'active' : ''}`}
            onClick={() => onTabChange('overview')}
          >
            <span className="nav-icon">
              <IconDashboard size={18} />
            </span>
            <span>Live Overview</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'rooms' ? 'active' : ''}`}
            onClick={() => onTabChange('rooms')}
          >
            <span className="nav-icon">
              <IconRooms size={18} />
            </span>
            <span>Rooms & Controls</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'rules' ? 'active' : ''}`}
            onClick={() => onTabChange('rules')}
          >
            <span className="nav-icon">
              <IconRules size={18} />
            </span>
            <span>Chat Rules Studio</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'reports' ? 'active' : ''}`}
            onClick={() => onTabChange('reports')}
          >
            <span className="nav-icon">
              <IconReports size={18} />
            </span>
            <span>Reports & Queue</span>
            {pendingReportsCount > 0 && (
              <span className="nav-counter">{pendingReportsCount}</span>
            )}
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'bans' ? 'active' : ''}`}
            onClick={() => onTabChange('bans')}
          >
            <span className="nav-icon">
              <IconBans size={18} />
            </span>
            <span>User Bans & Safety</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'cosmetics' ? 'active' : ''}`}
            onClick={() => onTabChange('cosmetics')}
          >
            <span className="nav-icon">
              <IconCosmetics size={18} />
            </span>
            <span>Chat Skins Studio</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'broadcast' ? 'active' : ''}`}
            onClick={() => onTabChange('broadcast')}
          >
            <span className="nav-icon">
              <IconBroadcast size={18} />
            </span>
            <span>Alerts &amp; Broadcast</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'media' ? 'active' : ''}`}
            onClick={() => onTabChange('media')}
          >
            <span className="nav-icon">
              <IconHistory size={18} />
            </span>
            <span>Media &amp; Takedown</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'regions' ? 'active' : ''}`}
            onClick={() => onTabChange('regions')}
          >
            <span className="nav-icon">
              <IconRooms size={18} />
            </span>
            <span>Custom Regions</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'staff' ? 'active' : ''}`}
            onClick={() => onTabChange('staff')}
          >
            <span className="nav-icon">
              <IconShieldCheck size={18} />
            </span>
            <span>Staff Roles &amp; RBAC</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'settings' ? 'active' : ''}`}
            onClick={() => onTabChange('settings')}
          >
            <span className="nav-icon">
              <IconRules size={18} />
            </span>
            <span>Platform Settings</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'penalties' ? 'active' : ''}`}
            onClick={() => onTabChange('penalties')}
          >
            <span className="nav-icon">
              <IconGavel size={18} />
            </span>
            <span>Penalties &amp; Requests</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'money' ? 'active' : ''}`}
            onClick={() => onTabChange('money')}
          >
            <span className="nav-icon">
              <IconSparkles size={18} />
            </span>
            <span>Ads, Gifts &amp; Commands</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'rain' ? 'active' : ''}`}
            onClick={() => onTabChange('rain')}
          >
            <span className="nav-icon">
              <IconSparkles size={18} />
            </span>
            <span>RainPool</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'dms' ? 'active' : ''}`}
            onClick={() => onTabChange('dms')}
          >
            <span className="nav-icon">
              <IconMessages size={18} />
            </span>
            <span>DMs &amp; Groups</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'support' ? 'active' : ''}`}
            onClick={() => onTabChange('support')}
          >
            <span className="nav-icon">
              <IconMessages size={18} />
            </span>
            <span>Support Chat</span>
          </button>
        </li>
        <li>
          <button
            className={`nav-item ${currentTab === 'features' ? 'active' : ''}`}
            onClick={() => onTabChange('features')}
          >
            <span className="nav-icon">
              <IconSliders size={18} />
            </span>
            <span>Feature Settings</span>
          </button>
        </li>
        <li>
          <button
            id="nav-moderation"
            className={`nav-item ${currentTab === 'moderation' ? 'active' : ''}`}
            onClick={() => onTabChange('moderation')}
          >
            <span className="nav-icon">
              <IconShieldCheck size={18} />
            </span>
            <span>Moderation Studio</span>
          </button>
        </li>
      </ul>

      {/* Footer Profile & Logout */}
      <div className="sidebar-footer">
        <div className="sidebar-profile-card">
          <div className="admin-avatar">{adminInitial}</div>
          <div className="admin-meta">
            <h4>{adminUser?.name || 'Super Admin'}</h4>
            <p>{adminUser?.email || 'admin@orebit.io'}</p>
          </div>
          <button
            className="sidebar-logout-btn"
            onClick={onLogout}
            title="Sign out of Admin Studio"
          >
            <IconLogout size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
};
