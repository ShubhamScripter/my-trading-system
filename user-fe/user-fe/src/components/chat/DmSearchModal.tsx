'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  X,
  MessageSquarePlus,
  Users,
} from 'lucide-react';
import type { DmConversation } from '@/types/dm';
import * as dmApi from '@/lib/api/dm';

// ─── DmSearchModal ─────────────────────────────────────────────────────────────
// Opens a new DM, or finds a conversation by its name or by text in its messages
// ("Users can also search DMs for specific texts").

interface DmSearchModalProps {
  onClose: () => void;
  onSelect: (conv: DmConversation) => void;
}

export default function DmSearchModal({ onClose, onSelect }: DmSearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DmConversation[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const inboxRef = useRef<DmConversation[] | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /** My conversations (all tabs), loaded once, for matching by name. */
  async function inbox(): Promise<DmConversation[]> {
    if (inboxRef.current) return inboxRef.current;
    const tabs = await Promise.all(
      (['PRIMARY', 'GENERAL', 'GROUPS'] as const).map((folder) =>
        dmApi.getConversations(folder, { limit: 100 }).catch(() => ({ items: [] as DmConversation[] })),
      ),
    );
    inboxRef.current = tabs.flatMap((t) => t.items);
    return inboxRef.current;
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const q = query.trim();
        const [all, hits] = await Promise.all([
          inbox(),
          q.length >= 2 ? dmApi.searchMessages(q, { limit: 30 }).catch(() => ({ items: [] })) : { items: [] },
        ]);
        const lower = q.toLowerCase().replace(/^@/, '');
        const byName = all.filter((c) => c.displayName.toLowerCase().includes(lower));
        // Conversations whose messages contain the text, newest hit first, shown with the matching message.
        const byText: DmConversation[] = [];
        for (const hit of hits.items) {
          if (byName.some((c) => c.id === hit.conversationId) || byText.some((c) => c.id === hit.conversationId)) continue;
          const known = all.find((c) => c.id === hit.conversationId);
          if (known) byText.push({ ...known, lastMessage: { content: hit.content, createdAt: hit.createdAt } });
        }
        setResults([...byName, ...byText].slice(0, 20));
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Open a new DM with the typed username (if no results or user wants to force)
  async function openNewDm() {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const conv = await dmApi.openConversation(query.trim());
      onSelect(conv);
    } catch {
      // ignore — user may need to search more precisely
    } finally {
      setLoading(false);
    }
  }

  function initials(name: string) {
    return name.slice(0, 2).toUpperCase();
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 300,
      }}
      onClick={onClose}
    >
      <div
        className="dm-search-modal"
        onClick={(e) => e.stopPropagation()}
        id="dm-search-modal"
      >
        {/* Header */}
        <div className="dm-search-input-row">
          <Search size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            className="dm-search-input"
            placeholder="Search conversations or enter username…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && results.length === 0 && query.trim())
                void openNewDm();
            }}
            id="dm-search-input"
          />
          <button
            className="dm-header-action-btn"
            onClick={onClose}
            style={{ flexShrink: 0 }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Results */}
        <div className="dm-search-results">
          {loading && (
            <div
              style={{
                padding: '1rem',
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontSize: '0.8rem',
              }}
            >
              Searching…
            </div>
          )}

          {!loading && query.trim() && results.length === 0 && (
            <div
              style={{
                padding: '1rem',
                textAlign: 'center',
              }}
            >
              <p
                style={{
                  fontSize: '0.82rem',
                  color: 'var(--text-muted)',
                  marginBottom: '0.75rem',
                }}
              >
                No conversations found for "{query}"
              </p>
              <button
                id="dm-open-new-btn"
                onClick={() => void openNewDm()}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.4rem 0.875rem',
                  borderRadius: '7px',
                  background: 'rgba(99,102,241,0.12)',
                  border: '1px solid rgba(99,102,241,0.3)',
                  color: '#818cf8',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                <MessageSquarePlus size={14} /> Start DM with "{query}"
              </button>
            </div>
          )}

          {results.map((conv) => (
            <div
              key={conv.id}
              className="dm-search-result-item"
              onClick={() => onSelect(conv)}
              id={`dm-search-result-${conv.id}`}
            >
              {conv.kind === 'GROUP' ? (
                <div
                  className="group-avatar-circle"
                  style={{ width: 36, height: 36 }}
                >
                  {initials(conv.displayName)}
                </div>
              ) : (
                <div
                  className="dm-avatar-circle"
                  style={{ width: 36, height: 36 }}
                >
                  {initials(conv.displayName)}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    color: 'var(--text-main)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {conv.displayName}
                </p>
                {conv.lastMessage && (
                  <p
                    style={{
                      fontSize: '0.73rem',
                      color: 'var(--text-muted)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {conv.lastMessage.content}
                  </p>
                )}
              </div>
              {conv.kind === 'GROUP' && (
                <Users
                  size={14}
                  style={{ color: 'var(--text-muted)', flexShrink: 0 }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
