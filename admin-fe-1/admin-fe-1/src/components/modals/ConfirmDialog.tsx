import React from 'react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** In-app replacement for `window.confirm()` on destructive admin actions —
 *  a native browser dialog blocks the whole tab (including automated test
 *  sessions) and looks out of place next to the rest of this dashboard. */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title = 'Confirm Action',
  message,
  confirmLabel = 'Confirm',
  danger = true,
  onConfirm,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-dialog"
        style={{ maxWidth: '420px', width: '92%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header" style={{ padding: '16px 20px' }}>
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>{title}</h3>
          <button className="modal-close" onClick={onCancel} aria-label="Close modal">✕</button>
        </div>
        <div className="modal-body" style={{ padding: '4px 20px 18px', fontSize: '13px', color: 'var(--text-secondary)' }}>
          {message}
        </div>
        <div
          className="modal-footer"
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
          }}
        >
          <button type="button" className="btn-secondary" onClick={onCancel} style={{ padding: '6px 14px', fontSize: '12px' }}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'btn-danger' : 'btn-primary'}
            onClick={onConfirm}
            style={{ padding: '6px 16px', fontSize: '12px' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
