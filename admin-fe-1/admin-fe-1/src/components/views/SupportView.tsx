import React, { useEffect, useState } from 'react';
import { ModulesAPI, type SupportMessage, type SupportStatus, type SupportTicket } from '../../services/modulesApi';

/**
 * Chat Module 10 from the panel: the support chat (Chat MAIN "Support Chat: works exactly the same way as support
 * tickets work, just in chat format"). Tickets by status (PENDING, OPEN, CLOSED), the conversation, an answer (the
 * first one moves a PENDING ticket to OPEN) and the close button. Answers and closes are recorded in the moderation log.
 */
interface Props {
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

const STATUSES: SupportStatus[] = ['PENDING', 'OPEN', 'CLOSED'];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export const SupportView: React.FC<Props> = ({ onShowToast }) => {
  const [status, setStatus] = useState<SupportStatus>('PENDING');
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<{ ticket: SupportTicket; messages: SupportMessage[] } | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const fail = (err: unknown) => onShowToast(err instanceof Error ? err.message : 'Request failed', 'danger');

  const load = async (cursor: string | null = null) => {
    try {
      const page = await ModulesAPI.supportTickets({ status, cursor });
      setTickets((prev) => (cursor ? [...prev, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
    } catch (err) {
      fail(err);
    }
  };

  useEffect(() => {
    setOpen(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const openTicket = async (ticketId: string) => {
    try {
      setOpen(await ModulesAPI.supportTicket(ticketId));
      setReply('');
    } catch (err) {
      fail(err);
    }
  };

  const sendReply = async () => {
    if (!open || !reply.trim()) return;
    setBusy(true);
    const res = await ModulesAPI.replyTicket(open.ticket.id, reply.trim());
    setBusy(false);
    if (!res.success) return onShowToast(res.error || 'Could not send the answer', 'danger');
    onShowToast('Answer sent');
    await openTicket(open.ticket.id);
    void load();
  };

  const closeTicket = async () => {
    if (!open || !window.confirm('Close this ticket? The user cannot write to it after this.')) return;
    setBusy(true);
    const res = await ModulesAPI.closeTicket(open.ticket.id);
    setBusy(false);
    if (!res.success) return onShowToast(res.error || 'Could not close the ticket', 'danger');
    onShowToast('Ticket closed');
    await openTicket(open.ticket.id);
    void load();
  };

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>Support Chat (Module 10)</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              A ticket is PENDING until support answers, OPEN while it is worked, and CLOSED with the close button.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {STATUSES.map((s) => (
              <button key={s} className={status === s ? 'btn-action' : 'btn-secondary'} onClick={() => setStatus(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: open ? '1fr 1.2fr' : '1fr', gap: '16px', marginTop: '16px' }}>
          <div className="table-responsive">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Subject</th>
                  <th>User</th>
                  <th>Last activity</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tickets.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                      No {status.toLowerCase()} tickets
                    </td>
                  </tr>
                )}
                {tickets.map((t) => (
                  <tr key={t.id} style={open?.ticket.id === t.id ? { background: 'var(--bg-hover, rgba(99,102,241,0.08))' } : undefined}>
                    <td>{t.subject}</td>
                    <td>{t.username ?? t.userId}</td>
                    <td>{when(t.lastMessageAt)}</td>
                    <td>
                      <button className="btn-secondary" onClick={() => openTicket(t.id)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {nextCursor && (
              <button className="btn-secondary" style={{ marginTop: '8px' }} onClick={() => load(nextCursor)}>
                Load more
              </button>
            )}
          </div>

          {open && (
            <div className="card-section" style={{ margin: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                <div>
                  <h4 style={{ margin: 0 }}>{open.ticket.subject}</h4>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {open.ticket.username ?? open.ticket.userId} · {open.ticket.status} · opened {when(open.ticket.createdAt)}
                  </span>
                </div>
                {open.ticket.status !== 'CLOSED' && (
                  <button className="btn-danger" disabled={busy} onClick={closeTicket}>Close ticket</button>
                )}
              </div>

              <div style={{ maxHeight: '420px', overflowY: 'auto', margin: '12px 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {open.messages.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      alignSelf: m.fromSupport ? 'flex-end' : 'flex-start',
                      maxWidth: '80%',
                      padding: '8px 12px',
                      borderRadius: '10px',
                      background: m.fromSupport ? 'rgba(99,102,241,0.18)' : 'var(--bg-secondary, rgba(255,255,255,0.06))',
                    }}
                  >
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '2px' }}>
                      {m.fromSupport ? 'Support' : (m.senderUsername ?? 'User')} · {when(m.createdAt)}
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</div>
                  </div>
                ))}
              </div>

              {open.ticket.status === 'CLOSED' ? (
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Closed {when(open.ticket.closedAt)}.</p>
              ) : (
                <div style={{ display: 'flex', gap: '8px' }}>
                  <textarea
                    className="form-control"
                    rows={2}
                    maxLength={4000}
                    placeholder="Write an answer"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                  />
                  <button className="btn-action" disabled={busy || !reply.trim()} onClick={sendReply}>Send</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
