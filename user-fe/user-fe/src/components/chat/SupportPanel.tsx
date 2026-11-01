'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Headphones, Loader2, Plus, Send, X } from 'lucide-react';
import * as supportApi from '@/lib/api/support';
import type { SupportMessage, SupportStatus, SupportTicket } from '@/lib/api/support';
import type { ChatSocket } from '@/lib/socket';

/**
 * The support chat (Module 10, Chat MAIN "Support Chat: works exactly the same way as support tickets work, just in
 * chat format"): tickets by status (Pending, Open, Closed), a new ticket with its first message, the conversation with
 * support, and the close button. Support answers and closes arrive over the socket (`support_updated`).
 */
interface SupportPanelProps {
  socket: ChatSocket | null;
  onClose: () => void;
}

const STATUSES: { key: SupportStatus; label: string }[] = [
  { key: 'PENDING', label: 'Pending' },
  { key: 'OPEN', label: 'Open' },
  { key: 'CLOSED', label: 'Closed' },
];

const STATUS_COLOR: Record<SupportStatus, string> = {
  PENDING: '#f59e0b',
  OPEN: '#22c55e',
  CLOSED: '#94a3b8',
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

const fieldStyle: React.CSSProperties = {
  width: '100%',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid var(--border-color, #232734)',
  borderRadius: '8px',
  color: '#fff',
  padding: '0.55rem 0.75rem',
  fontSize: '0.85rem',
};

export default function SupportPanel({ socket, onClose }: SupportPanelProps) {
  const [status, setStatus] = useState<SupportStatus>('PENDING');
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [active, setActive] = useState<{ ticket: SupportTicket; messages: SupportMessage[] } | null>(null);
  const [composing, setComposing] = useState(false);
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const activeId = useRef<string | null>(null);

  useEffect(() => {
    activeId.current = active?.ticket.id ?? null;
  }, [active]);

  /** Callers that show the spinner set `loading` first; state changes here only after the request. */
  const loadTickets = useCallback(
    async (cursor: string | null = null) => {
      try {
        const page = await supportApi.listTickets(status, cursor);
        setTickets((prev) => (cursor ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load tickets');
      } finally {
        setLoading(false);
      }
    },
    [status],
  );

  const openTicket = useCallback(async (ticketId: string) => {
    try {
      const page = await supportApi.getTicket(ticketId);
      setActive({ ticket: page.ticket, messages: page.items });
      setText('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the ticket');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    supportApi
      .listTickets(status)
      .then((page) => {
        if (cancelled) return;
        setTickets(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load tickets');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  useEffect(() => {
    if (!socket) return;
    const onUpdated = (data: { ticketId: string; status: SupportStatus }) => {
      void loadTickets();
      if (activeId.current === data.ticketId) void openTicket(data.ticketId);
    };
    socket.on('support_updated', onUpdated);
    return () => {
      socket.off('support_updated', onUpdated);
    };
  }, [socket, loadTickets, openTicket]);

  async function submitTicket(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !text.trim()) return;
    setLoading(true);
    try {
      const ticket = await supportApi.openTicket(subject.trim(), text.trim());
      setComposing(false);
      setSubject('');
      setText('');
      setStatus('PENDING');
      await openTicket(ticket.id);
      await loadTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the ticket');
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!active || !text.trim()) return;
    setLoading(true);
    try {
      const message = await supportApi.sendTicketMessage(active.ticket.id, text.trim());
      setActive({ ...active, messages: [...active.messages, message] });
      setText('');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the message');
    } finally {
      setLoading(false);
    }
  }

  async function closeActive() {
    if (!active || !window.confirm('Close this ticket? You cannot write to it after this.')) return;
    setLoading(true);
    try {
      const ticket = await supportApi.closeTicket(active.ticket.id);
      setActive({ ...active, ticket });
      await loadTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not close the ticket');
    } finally {
      setLoading(false);
    }
  }

  const header = (
    <div
      style={{
        padding: '1rem 1.25rem',
        borderBottom: '1px solid var(--border-color, #232734)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.5rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
        {(active || composing) && (
          <button
            className="btn btn-sm btn-outline"
            onClick={() => {
              setActive(null);
              setComposing(false);
              setError(null);
            }}
            title="Back to tickets"
          >
            <ArrowLeft size={14} />
          </button>
        )}
        <Headphones size={20} style={{ color: '#38bdf8', flexShrink: 0 }} />
        <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {active ? active.ticket.subject : composing ? 'New ticket' : 'Support'}
        </h3>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        {active && active.ticket.status !== 'CLOSED' && (
          <button
            className="btn btn-sm btn-outline"
            style={{ borderColor: 'rgba(239,68,68,0.5)', color: '#f87171' }}
            disabled={loading}
            onClick={closeActive}
          >
            Close ticket
          </button>
        )}
        <button className="btn btn-sm btn-outline" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  );

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '560px',
          height: '80vh',
          background: 'var(--bg-card, #11141c)',
          border: '1px solid var(--border-color, #232734)',
          borderRadius: '14px',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
          overflow: 'hidden',
        }}
      >
        {header}

        {error && (
          <div style={{ padding: '0.5rem 1.25rem', color: '#f87171', fontSize: '0.8rem' }}>{error}</div>
        )}

        {composing && (
          <form onSubmit={submitTicket} style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <input
              style={fieldStyle}
              placeholder="Subject"
              maxLength={120}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
            <textarea
              style={{ ...fieldStyle, minHeight: '140px', resize: 'vertical' }}
              placeholder="Describe your issue"
              maxLength={4000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button className="btn btn-sm" type="submit" disabled={loading || !subject.trim() || !text.trim()}>
              {loading ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
              <span>Open ticket</span>
            </button>
          </form>
        )}

        {!composing && active && (
          <>
            <div style={{ padding: '0.5rem 1.25rem', fontSize: '0.75rem', color: STATUS_COLOR[active.ticket.status] }}>
              {active.ticket.status}
              {active.ticket.closedAt ? ` · closed ${when(active.ticket.closedAt)}` : ''}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {active.messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    alignSelf: m.fromSupport ? 'flex-start' : 'flex-end',
                    maxWidth: '80%',
                    padding: '0.55rem 0.8rem',
                    borderRadius: '10px',
                    background: m.fromSupport ? 'rgba(56,189,248,0.14)' : 'rgba(99,102,241,0.22)',
                    color: '#e2e8f0',
                    fontSize: '0.85rem',
                  }}
                >
                  <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: '0.15rem' }}>
                    {m.fromSupport ? 'Support' : 'You'} · {when(m.createdAt)}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>
                </div>
              ))}
            </div>
            {active.ticket.status === 'CLOSED' ? (
              <div style={{ padding: '0.9rem 1.25rem', borderTop: '1px solid var(--border-color, #232734)', color: '#94a3b8', fontSize: '0.8rem' }}>
                This ticket is closed. Open a new ticket if you need more help.
              </div>
            ) : (
              <form
                onSubmit={sendMessage}
                style={{ padding: '0.9rem 1.25rem', borderTop: '1px solid var(--border-color, #232734)', display: 'flex', gap: '0.5rem' }}
              >
                <input
                  style={fieldStyle}
                  placeholder="Type message"
                  maxLength={4000}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <button className="btn btn-sm" type="submit" disabled={loading || !text.trim()} title="Send">
                  <Send size={14} />
                </button>
              </form>
            )}
          </>
        )}

        {!composing && !active && (
          <>
            <div style={{ display: 'flex', gap: '0.4rem', padding: '0.75rem 1.25rem', alignItems: 'center' }}>
              {STATUSES.map(({ key, label }) => (
                <button
                  key={key}
                  className={`btn btn-sm ${status === key ? '' : 'btn-outline'}`}
                  onClick={() => {
                    if (key === status) return;
                    setLoading(true);
                    setStatus(key);
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                className="btn btn-sm btn-outline"
                style={{ marginLeft: 'auto' }}
                onClick={() => {
                  setComposing(true);
                  setText('');
                  setError(null);
                }}
              >
                <Plus size={14} />
                <span>New ticket</span>
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 1.25rem 1rem' }}>
              {!loading && tickets.length === 0 && (
                <p style={{ color: '#94a3b8', fontSize: '0.85rem', textAlign: 'center', marginTop: '2rem' }}>
                  No {status.toLowerCase()} tickets
                </p>
              )}
              {tickets.map((t) => (
                <button
                  key={t.id}
                  onClick={() => void openTicket(t.id)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid var(--border-color, #232734)',
                    borderRadius: '10px',
                    padding: '0.7rem 0.9rem',
                    marginBottom: '0.5rem',
                    color: '#e2e8f0',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                    <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.subject}</span>
                    <span style={{ fontSize: '0.7rem', color: STATUS_COLOR[t.status] }}>{t.status}</span>
                  </div>
                  <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '0.2rem' }}>{when(t.lastMessageAt)}</div>
                </button>
              ))}
              {nextCursor && (
                <button className="btn btn-sm btn-outline" disabled={loading} onClick={() => {
                    setLoading(true);
                    void loadTickets(nextCursor);
                  }}>
                  Load more
                </button>
              )}
              {loading && <Loader2 size={16} className="spin" style={{ display: 'block', margin: '1rem auto', color: '#94a3b8' }} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
