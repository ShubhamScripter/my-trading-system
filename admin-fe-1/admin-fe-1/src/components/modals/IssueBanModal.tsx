import React, { useState } from 'react';

interface IssueBanModalProps {
  isOpen: boolean;
  targetUser?: { userId: string; username: string } | null;
  onClose: () => void;
  onIssueBan: (data: {
    userId: string;
    username: string;
    durationHours?: number;
    permanent?: boolean;
    reason: string;
    note: string;
    roomId?: string | null;
  }) => void;
}

export const IssueBanModal: React.FC<IssueBanModalProps> = ({
  isOpen,
  targetUser,
  onClose,
  onIssueBan,
}) => {
  const [userId, setUserId] = useState('');
  const [username, setUsername] = useState('');
  const [durationHours, setDurationHours] = useState(24);
  const [isPermanent, setIsPermanent] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  React.useEffect(() => {
    if (targetUser) {
      setUserId(targetUser.userId);
      setUsername(targetUser.username);
    } else {
      setUserId('');
      setUsername('');
    }
    setNote('');
  }, [targetUser, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim() || !reason.trim()) return;
    onIssueBan({
      userId: userId.trim(),
      username: username.trim() || `user_${userId.slice(0, 6)}`,
      durationHours: isPermanent ? undefined : durationHours,
      permanent: isPermanent ? true : undefined,
      reason: reason.trim(),
      note: note.trim() || reason.trim(),
    });
    setUserId('');
    setUsername('');
    setReason('');
    setNote('');
    setIsPermanent(false);
  };

  return (
    <div className="modal-overlay">
      <div className="modal-dialog">
        <div className="modal-header">
          <h3>Issue User Chat Ban</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label>Target User ID</label>
              <input
                type="text"
                className="form-control"
                placeholder="User UUID or username (live accounts only)"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>Username</label>
              <input
                type="text"
                className="form-control"
                placeholder="Display username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="form-group">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <label style={{ margin: 0 }}>Ban Duration</label>
                <label style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={isPermanent}
                    onChange={(e) => setIsPermanent(e.target.checked)}
                  />
                  Permanent Ban (D-27)
                </label>
              </div>
              {!isPermanent && (
                <select
                  className="form-control"
                  value={durationHours}
                  onChange={(e) => setDurationHours(Number(e.target.value))}
                >
                  <option value={1}>1 Hour</option>
                  <option value={12}>12 Hours</option>
                  <option value={24}>24 Hours (Standard)</option>
                  <option value={72}>3 Days (72 Hours)</option>
                  <option value={168}>7 Days</option>
                  <option value={720}>30 Days</option>
                </select>
              )}
            </div>
            <div className="form-group">
              <label>Reason shown to user</label>
              <textarea
                rows={2}
                className="form-control"
                placeholder="Explain the policy violation..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              ></textarea>
            </div>
            <div className="form-group">
              <label>Internal Audit Note (Required - CH-090)</label>
              <input
                type="text"
                className="form-control"
                placeholder="Audit explanation for moderation logs..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-danger">
              Confirm & Enforce Ban
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
