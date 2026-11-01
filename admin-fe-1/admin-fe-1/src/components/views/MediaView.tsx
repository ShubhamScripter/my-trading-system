import React, { useState, useEffect } from 'react';
import { MediaUpload } from '../../types';
import { AdminAPI } from '../../services/api';
import { IconTrash, IconAlert } from '../Icons';

interface MediaViewProps {
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

export const MediaView: React.FC<MediaViewProps> = ({ onShowToast }) => {
  const [uploads, setUploads] = useState<MediaUpload[]>([]);
  const [loading, setLoading] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  const fetchUploads = async () => {
    setLoading(true);
    try {
      const data = await AdminAPI.getMediaUploads({ flaggedOnly, limit: 50 });
      setUploads(data);
    } catch {
      onShowToast('Failed to load media uploads', 'danger');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUploads();
  }, [flaggedOnly]);

  const handleFlag = async (upload: MediaUpload) => {
    const note = window.prompt(`Flag media uploaded by ${upload.uploaderUsername}? Reason note:`, 'Flagged for content review');
    if (!note || !note.trim()) return;
    try {
      const res = await AdminAPI.flagMedia(upload.id, note.trim());
      if (res.success) {
        onShowToast('Media flagged for review');
        fetchUploads();
      } else {
        onShowToast(res.error || 'Failed to flag media', 'danger');
      }
    } catch {
      onShowToast('Network error flagging media', 'danger');
    }
  };

  const handleDelete = async (upload: MediaUpload) => {
    const note = window.prompt(
      `Audited soft-delete for media (${upload.originalFilename})? Enter legal/audit reason (required - D-32, CH-090):`,
      'Removed under content violation policy',
    );
    if (!note || !note.trim()) return;
    try {
      const res = await AdminAPI.deleteMedia(upload.id, note.trim());
      if (res.success) {
        onShowToast('Media removed under legal hold (uploader ID preserved)');
        fetchUploads();
      } else {
        onShowToast(res.error || 'Failed to remove media', 'danger');
      }
    } catch {
      onShowToast('Network error removing media', 'danger');
    }
  };

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>Media Uploads &amp; Legal Hold Takedown (CH-089, D-32)</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Audited gallery of all user media attachments. Deletion soft-deletes media while preserving the uploader record for legal hold.
            </p>
          </div>
          <div className="filter-bar">
            <button
              className={`btn-secondary ${!flaggedOnly ? 'active' : ''}`}
              onClick={() => setFlaggedOnly(false)}
            >
              All Uploads
            </button>
            <button
              className={`btn-secondary ${flaggedOnly ? 'active' : ''}`}
              style={{ color: 'var(--warning)' }}
              onClick={() => setFlaggedOnly(true)}
            >
              Flagged Only
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading media records...</div>
        ) : uploads.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
            No {flaggedOnly ? 'flagged' : ''} media files recorded in database.
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '16px',
              marginTop: '16px',
            }}
          >
            {uploads.map((up) => (
              <div
                key={up.id}
                style={{
                  background: 'var(--surface-elevated, #1a202c)',
                  borderRadius: '10px',
                  border: up.isFlagged ? '1px solid #ef4444' : '1px solid var(--border)',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div style={{ height: '160px', background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  {up.mimeType.startsWith('image/') ? (
                    <img
                      src={up.url}
                      alt={up.originalFilename}
                      style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }}
                      onError={(e) => {
                        (e.target as HTMLElement).style.display = 'none';
                      }}
                    />
                  ) : up.mimeType.startsWith('video/') ? (
                    <video src={up.url} controls style={{ maxHeight: '100%', maxWidth: '100%' }} />
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>Media Preview</span>
                  )}
                </div>
                <div style={{ padding: '12px', flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: '13px', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {up.originalFilename}
                    </strong>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {(up.sizeBytes / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Uploaded by: <strong>@{up.uploaderUsername}</strong>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {new Date(up.createdAt).toLocaleString()}
                  </div>
                  {up.isFlagged && (
                    <div style={{ fontSize: '11px', color: '#f87171', background: 'rgba(239,68,68,0.1)', padding: '4px 6px', borderRadius: '4px' }}>
                      Flag: {up.flagNote || 'Marked by administrator'}
                    </div>
                  )}
                  {up.isDeleted && (
                    <div style={{ fontSize: '11px', color: '#94a3b8', fontStyle: 'italic' }}>
                      Status: Soft-deleted (Legal hold kept)
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '8px' }}>
                    {!up.isFlagged && !up.isDeleted && (
                      <button
                        className="btn-secondary"
                        style={{ fontSize: '11px', padding: '4px 8px', flex: 1 }}
                        onClick={() => handleFlag(up)}
                      >
                        <IconAlert size={12} /> Flag
                      </button>
                    )}
                    {!up.isDeleted && (
                      <button
                        className="btn-danger"
                        style={{ fontSize: '11px', padding: '4px 8px', flex: 1 }}
                        onClick={() => handleDelete(up)}
                      >
                        <IconTrash size={12} /> Takedown
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
