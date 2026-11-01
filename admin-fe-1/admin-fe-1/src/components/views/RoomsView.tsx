import React, { useState } from 'react';
import { AdminRoom, RoomContentControls } from '../../types';
import { IconPlus, IconRules, IconGlobe, IconCrown, IconRooms, IconShield, IconEdit, IconMessages } from '../Icons';

interface RoomsViewProps {
  rooms: AdminRoom[];
  onToggleControl: (roomId: string, controlKey: keyof RoomContentControls, value: boolean) => void;
  onOpenCreateRoom: () => void;
  onEditRoom: (room: AdminRoom) => void;
  onOpenChat: (room: AdminRoom) => void;
  onEditRules: (roomId: string) => void;
  onDeleteRoom: (roomId: string) => void;
}

export const RoomsView: React.FC<RoomsViewProps> = ({
  rooms,
  onToggleControl,
  onOpenCreateRoom,
  onEditRoom,
  onOpenChat,
  onEditRules,
  onDeleteRoom,
}) => {
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const handleCopySlug = (slug: string, e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(slug);
    setCopiedSlug(slug);
    setTimeout(() => setCopiedSlug(null), 2000);
  };

  const renderRoomIcon = (type: string) => {
    switch (type) {
      case 'GLOBAL':
        return <IconGlobe size={18} color="var(--primary)" />;
      case 'PREMIUM':
        return <span style={{ fontSize: '11px', fontWeight: 800, color: '#a855f7' }}>PRO</span>;
      case 'VIP':
        return <IconCrown size={18} color="#ffd700" />;
      case 'CASINO':
        return <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--accent-purple)' }}>CAS</span>;
      case 'COUNTRY':
        return <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--success)' }}>REG</span>;
      case 'REGION':
        return <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--accent-purple)' }}>HUB</span>;
      case 'LANGUAGE':
        return <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--success)' }}>LNG</span>;
      case 'KYC':
        return <IconShield size={16} color="var(--primary)" />;
      case 'SO':
        return <span style={{ fontSize: '11px', fontWeight: 800, color: '#ffd700' }}>SO</span>;
      case 'STAFF':
        return <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--warning)' }}>MOD</span>;
      default:
        return <IconRooms size={18} color="var(--primary)" />;
    }
  };

  const getTypeBadgeClass = (type: string) => {
    switch (type) {
      case 'GLOBAL': return 'tag-global';
      case 'PREMIUM': return 'tag-casino';
      case 'VIP': return 'tag-vip';
      case 'CASINO': return 'tag-casino';
      case 'COUNTRY': return 'tag-country';
      case 'REGION': return 'tag-country';
      case 'LANGUAGE': return 'tag-country';
      case 'KYC': return 'tag-global';
      case 'SO': return 'tag-vip';
      case 'STAFF': return 'tag-casino';
      default: return 'tag-global';
    }
  };

  const filteredRooms = rooms.filter((r) => {
    if (filterType !== 'ALL' && r.type !== filterType) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700 }}>Chat Rooms</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
              Manage rooms, slugs, access rules, and permissions.
            </p>
          </div>
          <button className="btn-action" onClick={onOpenCreateRoom}>
            <IconPlus size={15} />
            <span>Create Room</span>
          </button>
        </div>

        {/* Filter / Search Bar */}
        <div style={{
          display: 'flex',
          gap: '12px',
          alignItems: 'center',
          justifyContent: 'space-between',
          margin: '16px 0 20px 0',
          flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {['ALL', 'GLOBAL', 'PREMIUM', 'VIP', 'CASINO', 'COUNTRY', 'REGION', 'LANGUAGE', 'KYC', 'SO', 'STAFF'].map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilterType(f)}
                style={{
                  padding: '5px 12px',
                  borderRadius: '16px',
                  fontSize: '11px',
                  fontWeight: 600,
                  border: filterType === f ? '1px solid var(--primary)' : '1px solid var(--border)',
                  background: filterType === f ? 'rgba(0, 242, 254, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                  color: filterType === f ? 'var(--primary)' : 'var(--text-secondary)',
                  cursor: 'pointer',
                  transition: 'var(--transition)',
                }}
              >
                {f === 'ALL' ? `All Rooms (${rooms.length})` : f}
              </button>
            ))}
          </div>

          <input
            type="text"
            className="form-control"
            placeholder="Search by name or slug..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ width: '240px', fontSize: '12px', padding: '6px 12px' }}
          />
        </div>

        <div className="table-responsive">
          <table className="admin-table">
            <thead>
              <tr>
                <th style={{ minWidth: '220px' }}>Room &amp; Slug</th>
                <th style={{ minWidth: '90px' }}>Category</th>
                <th style={{ minWidth: '90px' }}>Tier</th>
                <th style={{ minWidth: '100px' }}>Posture</th>
                <th style={{ textAlign: 'center' }}>Text</th>
                <th style={{ textAlign: 'center' }}>GIF</th>
                <th style={{ textAlign: 'center' }}>Image</th>
                <th style={{ textAlign: 'center' }}>Video</th>
                <th style={{ textAlign: 'center' }}>Auto-Mod</th>
                <th style={{ textAlign: 'center' }}>Rules</th>
                <th style={{ minWidth: '150px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRooms.map((r) => {
                const cc = r.contentControls || {};
                const acc = ((r as any).access || {}) as any;
                const isCopied = copiedSlug === r.slug;
                const ineligibleMode = acc.ineligibleMode || 'VIEW_ONLY';
                const isDeleted = Boolean((r as any).deletedAt);

                return (
                  <tr key={r.id}>
                    {/* Room & Prominent Slug */}
                    <td>
                      <div className="room-identity">
                        <div className="room-icon-badge">{renderRoomIcon(r.type)}</div>
                        <div className="room-names">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <h4 style={{ margin: 0 }}>{r.name}</h4>
                            {r.status === 'MAINTENANCE' && (
                              <span style={{ fontSize: '9px', background: 'rgba(255, 170, 0, 0.2)', color: 'var(--warning)', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                                MAINTENANCE
                              </span>
                            )}
                            {(isDeleted || r.status === 'DISABLED') && (
                              <span style={{ fontSize: '9px', background: 'rgba(255, 71, 87, 0.2)', color: 'var(--danger)', padding: '2px 6px', borderRadius: '4px', fontWeight: 700 }}>
                                {isDeleted ? 'DELETED' : 'DISABLED'}
                              </span>
                            )}
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px' }}>
                            <button
                              type="button"
                              onClick={(e) => handleCopySlug(r.slug, e)}
                              title="Click to copy slug"
                              style={{
                                background: isCopied ? 'rgba(0, 242, 254, 0.25)' : 'rgba(0, 242, 254, 0.08)',
                                border: '1px solid rgba(0, 242, 254, 0.2)',
                                borderRadius: '4px',
                                padding: '1px 6px',
                                color: 'var(--primary)',
                                fontSize: '11px',
                                fontFamily: 'monospace',
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                              }}
                            >
                              <span>/{r.slug}</span>
                              <span style={{ fontSize: '9px' }}>{isCopied ? 'copied' : 'copy'}</span>
                            </button>
                            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                              &bull; {r.language || 'EN'} &bull; {r.continent || 'GLOBAL'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Category */}
                    <td>
                      <span className={`tag-badge ${getTypeBadgeClass(r.type)}`}>
                        {r.type}
                      </span>
                    </td>

                    {/* Premium Tier Gate */}
                    <td>
                      {(() => {
                        const tier = acc.requirePremium || r.type === 'PREMIUM'
                          ? ((acc.allowedPlanIds || []).length > 0 ? 'TOP' : 'BASIC')
                          : 'ALL';
                        const tierStyle: Record<string, { bg: string; color: string; label: string }> = {
                          ALL: { bg: 'rgba(255, 255, 255, 0.04)', color: 'var(--text-muted)', label: 'Any' },
                          BASIC: { bg: 'rgba(0, 242, 254, 0.08)', color: 'var(--primary)', label: 'Premium' },
                          MEDIUM: { bg: 'rgba(255, 170, 0, 0.1)', color: 'var(--warning)', label: 'Medium+' },
                          TOP: { bg: 'rgba(255, 215, 0, 0.12)', color: '#ffd700', label: 'Selected plans' },
                        };
                        const s = tierStyle[tier] || tierStyle.ALL!;
                        return (
                          <span style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '4px', background: s.bg, color: s.color, fontWeight: 700 }}>
                            {s.label}
                          </span>
                        );
                      })()}
                    </td>

                    {/* Ineligible Posture */}
                    <td>
                      <span style={{
                        fontSize: '11px',
                        padding: '3px 8px',
                        borderRadius: '4px',
                        background: ineligibleMode === 'VIEW_ONLY'
                          ? 'rgba(0, 242, 254, 0.08)'
                          : ineligibleMode === 'HIDE'
                          ? 'rgba(255, 71, 87, 0.08)'
                          : 'rgba(255, 215, 0, 0.08)',
                        color: ineligibleMode === 'VIEW_ONLY'
                          ? 'var(--primary)'
                          : ineligibleMode === 'HIDE'
                          ? 'var(--danger)'
                          : '#ffd700',
                        fontWeight: 600,
                      }}>
                        {ineligibleMode === 'VIEW_ONLY' ? 'View-Only' : ineligibleMode === 'HIDE' ? 'Hidden' : 'Promo Teaser'}
                      </span>
                    </td>

                    {/* Content Toggles */}
                    <td style={{ textAlign: 'center' }}>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={cc.allowText !== false}
                          onChange={(e) => onToggleControl(r.id, 'allowText', e.target.checked)}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={cc.allowGif !== false}
                          onChange={(e) => onToggleControl(r.id, 'allowGif', e.target.checked)}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={cc.allowImage !== false}
                          onChange={(e) => onToggleControl(r.id, 'allowImage', e.target.checked)}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={!!cc.allowVideo}
                          onChange={(e) => onToggleControl(r.id, 'allowVideo', e.target.checked)}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={cc.autoModeration !== false}
                          onChange={(e) => onToggleControl(r.id, 'autoModeration', e.target.checked)}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </td>

                    {/* Rules Count Badge */}
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        className="btn-secondary"
                        style={{ padding: '4px 8px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                        onClick={() => onEditRoom(r)}
                        title="Click to view and edit rules"
                      >
                        <IconRules size={12} />
                        <span>{r.rules ? r.rules.length : 0} Rules</span>
                      </button>
                    </td>

                    {/* Actions */}
                    <td>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <button
                          className="btn-secondary"
                          style={{
                            padding: '6px 11px',
                            fontSize: '11px',
                            fontWeight: 600,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                            borderColor: 'rgba(99,102,241,0.35)',
                            color: '#818cf8',
                            background: 'rgba(99,102,241,0.08)',
                          }}
                          onClick={() => onOpenChat(r)}
                          title={`Open ${r.name} Chat & Moderate`}
                        >
                          <IconMessages size={13} />
                          <span>Chat</span>
                        </button>

                        <button
                          className="btn-secondary"
                          style={{
                            padding: '6px 9px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderColor: 'var(--border)',
                            color: 'var(--text-secondary)',
                          }}
                          onClick={() => onEditRoom(r)}
                          disabled={isDeleted}
                          title={isDeleted ? 'This room was deleted' : 'Edit Room Settings & Rules'}
                        >
                          <IconEdit size={13} />
                        </button>

                        <button
                          className="btn-danger"
                          style={{ padding: '6px 9px', fontSize: '11px' }}
                          onClick={() => onDeleteRoom(r.id)}
                          disabled={isDeleted}
                          title="Delete the room permanently (messages are kept). To hide it for a while, edit it and set status Disabled."
                        >
                          {isDeleted ? 'Deleted' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};
