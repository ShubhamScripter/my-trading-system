import React, { useState } from 'react';
import { AdminRoom, BroadcastPayload } from '../../types';
import { IconBroadcast } from '../Icons';

interface BroadcastViewProps {
  onSendBroadcast: (payload: BroadcastPayload) => void;
  rooms: AdminRoom[];
}

export const BroadcastView: React.FC<BroadcastViewProps> = ({ onSendBroadcast, rooms }) => {
  const [type, setType] = useState<'ADMIN_ALERT' | 'SYSTEM_ALERT' | 'MAINTENANCE' | 'PROMO'>('ADMIN_ALERT');
  const [roomId, setRoomId] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    onSendBroadcast({
      type,
      roomId: roomId || undefined,
      title: title || 'Admin Announcement',
      content: content.trim(),
    });
    setContent('');
    setTitle('');
  };

  return (
    <section className="tab-view">
      <div className="card-section" style={{ maxWidth: '720px' }}>
        <div className="card-header-row">
          <div>
            <h3>System Announcement &amp; Live Alert Broadcaster</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Instantly publish high-priority alerts, maintenance notices, or system announcements across chat.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '10px' }}>
          <div className="form-group">
            <label>Alert Category</label>
            <select
              className="form-control"
              value={type}
              onChange={(e) => setType(e.target.value as any)}
            >
              <option value="ADMIN_ALERT">[ADMIN] Official Admin Announcement</option>
              <option value="SYSTEM_ALERT">[SYSTEM] Platform Event / Winner Alert</option>
              <option value="MAINTENANCE">[NOTICE] Scheduled Maintenance</option>
              <option value="PROMO">[EVENT] Special Promotional Event</option>
            </select>
          </div>

          <div className="form-group">
            <label>Target Chat Room</label>
            <select
              className="form-control"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
            >
              <option value="">Every room (super admin only)</option>
              {rooms
                .filter((r) => !(r as any).deletedAt)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} only
                  </option>
                ))}
            </select>
          </div>

          <div className="form-group">
            <label>Announcement Headline</label>
            <input
              type="text"
              className="form-control"
              placeholder="e.g. Scheduled Platform Upgrade"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label>Message Content</label>
            <textarea
              rows={4}
              className="form-control"
              placeholder="Enter full announcement text to broadcast to users..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
            ></textarea>
          </div>

          <button
            type="submit"
            className="btn-action"
            style={{ alignSelf: 'flex-start', padding: '12px 24px', display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            <IconBroadcast size={17} />
            <span>Dispatch Broadcast Live</span>
          </button>
        </form>
      </div>
    </section>
  );
};
