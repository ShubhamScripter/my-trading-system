'use client';

/**
 * Conversation info (Chat MAIN "The personal (Direct) groups and chats will also have info where they can see all the
 * shared links and media (photos and videos) in the chat", and "Users can also see common groups with their friends").
 * Common groups follow the other user's privacy setting; the server answers 403 when they hide them.
 */
import React, { useEffect, useState } from 'react';
import { Image as ImageIcon, Link2, Users, X } from 'lucide-react';
import * as dmApi from '@/lib/api/dm';
import type { DmConversation } from '@/types/dm';

type Tab = 'media' | 'links' | 'groups';
type SharedItem = Awaited<ReturnType<typeof dmApi.getSharedMedia>>[number];

interface Props {
  conv: DmConversation;
  onClose: () => void;
}

const tabStyle = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: '0.45rem 0',
  background: 'none',
  border: 'none',
  borderBottom: active ? '2px solid #818cf8' : '2px solid transparent',
  color: active ? 'var(--text-main)' : 'var(--text-muted)',
  fontSize: '0.78rem',
  fontWeight: 600,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.35rem',
});

export default function DmInfoPanel({ conv, onClose }: Props) {
  const isDirect = conv.kind === 'DIRECT';
  const [tab, setTab] = useState<Tab>('media');
  const [items, setItems] = useState<SharedItem[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const switchTab = (next: Tab) => {
    if (next === tab) return;
    setLoading(true);
    setError(null);
    setTab(next);
  };

  useEffect(() => {
    let live = true;
    const load =
      tab === 'groups'
        ? dmApi.getCommonGroups(conv.peer?.id ?? '').then((g) => live && setGroups(g))
        : dmApi.getSharedMedia(conv.id, tab).then((i) => live && setItems(i));
    load
      .catch((err: Error) => live && setError(tab === 'groups' ? 'This user keeps their groups private.' : err.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [tab, conv.id, conv.peer?.id]);

  return (
    <div className="dm-pinned-panel" style={{ width: '300px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.75rem 1rem',
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>Info · {conv.displayName}</span>
        <button className="dm-header-action-btn" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)' }}>
        <button style={tabStyle(tab === 'media')} onClick={() => switchTab('media')}>
          <ImageIcon size={13} /> Media
        </button>
        <button style={tabStyle(tab === 'links')} onClick={() => switchTab('links')}>
          <Link2 size={13} /> Links
        </button>
        {isDirect && conv.peer?.id && (
          <button style={tabStyle(tab === 'groups')} onClick={() => switchTab('groups')}>
            <Users size={13} /> Groups
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0.6rem' }}>
        {loading && <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>Loading…</p>}
        {!loading && error && (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>{error}</p>
        )}

        {!loading && !error && tab === 'media' && (
          items.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>No photos or videos yet</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' }}>
              {items.map((m) =>
                m.type === 'video' ? (
                  <video key={m.messageId} src={m.url} style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '6px' }} />
                ) : (
                  <img
                    key={m.messageId}
                    src={m.url}
                    alt="Shared"
                    loading="lazy"
                    onClick={() => m.url && window.open(m.url, '_blank')}
                    style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: '6px', cursor: 'pointer' }}
                  />
                ),
              )}
            </div>
          )
        )}

        {!loading && !error && tab === 'links' && (
          items.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>No links shared yet</p>
          ) : (
            items.flatMap((m) =>
              (m.links ?? []).map((link, i) => (
                <a
                  key={`${m.messageId}-${i}`}
                  href={/^https?:\/\//i.test(link) ? link : `https://${link}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="dm-pinned-item"
                  style={{ display: 'block', textDecoration: 'none' }}
                >
                  <div className="dm-pinned-sender" style={{ wordBreak: 'break-all' }}>{link}</div>
                  <div className="dm-pinned-content" style={{ fontSize: '0.7rem' }}>
                    {new Date(m.createdAt).toLocaleDateString()}
                  </div>
                </a>
              )),
            )
          )
        )}

        {!loading && !error && tab === 'groups' && (
          groups.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem' }}>No groups in common</p>
          ) : (
            groups.map((g) => (
              <div key={g.id} className="dm-pinned-item" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div className="group-avatar-circle" style={{ width: 28, height: 28, fontSize: '0.65rem' }}>
                  {g.name.slice(0, 2).toUpperCase()}
                </div>
                <span style={{ fontSize: '0.83rem', fontWeight: 600 }}>{g.name}</span>
              </div>
            ))
          )
        )}
      </div>
    </div>
  );
}
