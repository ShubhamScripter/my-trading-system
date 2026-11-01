import React from 'react';
import { AdminUser } from '../types';
import { IconPlus, IconLogout, IconShield } from './Icons';

interface TopbarProps {
  onOpenCreateRoom: () => void;
  adminUser: AdminUser | null;
  onLogout: () => void;
}

export const Topbar: React.FC<TopbarProps> = ({
  onOpenCreateRoom,
  adminUser,
  onLogout,
}) => {
  return (
    <header className="topbar">
      <div className="page-title">
        <h1>Chat Administration</h1>
        <p>Room management, access rules, and safety controls</p>
      </div>

      <div className="topbar-actions">
        <div className="status-indicator">
          <span className="status-dot"></span>
          <span>Admin Service: Connected</span>
        </div>

        <button className="btn-action" onClick={onOpenCreateRoom}>
          <IconPlus size={15} />
          <span>New Chat Room</span>
        </button>

        <div className="topbar-admin-pill">
          <span className="admin-badge-icon">
            <IconShield size={14} color="var(--primary)" />
          </span>
          <span className="topbar-admin-name">{adminUser?.name || 'Super Admin'}</span>
          <button
            className="topbar-logout-btn"
            onClick={onLogout}
            title="Sign Out"
          >
            <IconLogout size={15} />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </header>
  );
};
