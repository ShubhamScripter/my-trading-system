import React, { useEffect, useState } from 'react';
import { ModulesAPI } from '../../services/modulesApi';

/**
 * Chat Modules 8–9 from the panel: a user's direct and group conversations, reading one (Chat DM Settings "UnEncrypt
 * User Conversations: Select User(s) or Group, Input: Unencrypt Reason" — the reason is kept in the moderation log),
 * and every group with its owner and size. Reported DM messages are hidden from the Reports view.
 */
interface Props {
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- rows are shown as the backend sends them */

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export const DmOversightView: React.FC<Props> = ({ onShowToast }) => {
  const [tab, setTab] = useState<'user' | 'groups'>('user');
  const [handle, setHandle] = useState('');
  const [conversations, setConversations] = useState<any[]>([]);
  const [conversationsNext, setConversationsNext] = useState<string | null>(null);
  const [reading, setReading] = useState<{ id: string; title: string; reason: string; messages: any[]; next: string | null } | null>(null);
  const [groupQuery, setGroupQuery] = useState('');
  const [groups, setGroups] = useState<any[]>([]);
  const [groupsNext, setGroupsNext] = useState<string | null>(null);

  const fail = (err: unknown) => onShowToast(err instanceof Error ? err.message : 'Request failed', 'danger');

  const findUser = async (cursor?: string | null) => {
    if (!handle.trim()) return;
    setReading(null);
    try {
      const page = await ModulesAPI.userConversations(handle.trim(), cursor);
      setConversations((prev) => (cursor ? [...prev, ...(page.conversations ?? [])] : (page.conversations ?? [])));
      setConversationsNext(page.nextCursor ?? null);
    } catch (err) {
      if (!cursor) setConversations([]);
      setConversationsNext(null);
      fail(err);
    }
  };

  const loadGroups = async (cursor?: string | null) => {
    try {
      const page = await ModulesAPI.groups(groupQuery.trim() || undefined, cursor);
      setGroups((prev) => (cursor ? [...prev, ...(page.groups ?? [])] : (page.groups ?? [])));
      setGroupsNext(page.nextCursor ?? null);
    } catch (err) {
      fail(err);
    }
  };

  useEffect(() => {
    if (tab === 'groups') void loadGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const read = async (id: string, title: string) => {
    const reason = window.prompt('Why are you reading this conversation? (recorded in the moderation log, at least 5 characters)', '');
    if (!reason || reason.trim().length < 5) return;
    const res = await ModulesAPI.readConversation(id, reason.trim());
    if (res.success) setReading({ id, title, reason: reason.trim(), messages: res.messages ?? [], next: res.nextCursor ?? null });
    else onShowToast(res.error || 'Could not open the conversation', 'danger');
  };

  // Older messages: another page, recorded again with the same reason.
  const readMore = async () => {
    if (!reading?.next) return;
    const res = await ModulesAPI.readConversation(reading.id, reading.reason, reading.next);
    if (res.success) setReading({ ...reading, messages: [...reading.messages, ...(res.messages ?? [])], next: res.nextCursor ?? null });
    else onShowToast(res.error || 'Could not load older messages', 'danger');
  };

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>Direct Messages &amp; Groups (Modules 8–9)</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Reading a private conversation needs a reason, which is recorded with your name. Retracted and hidden
              messages are shown with their tag.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className={tab === 'user' ? 'btn-action' : 'btn-secondary'} onClick={() => setTab('user')}>User conversations</button>
            <button className={tab === 'groups' ? 'btn-action' : 'btn-secondary'} onClick={() => setTab('groups')}>Groups</button>
          </div>
        </div>

        {tab === 'user' && (
          <>
            <div style={{ display: 'flex', gap: '8px', margin: '16px 0' }}>
              <input
                className="form-control"
                style={{ maxWidth: '280px' }}
                placeholder="Username, login code or id"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && findUser()}
              />
              <button className="btn-action" onClick={() => findUser()}>Find</button>
            </div>
            <div className="table-responsive">
              <table className="admin-table">
                <thead><tr><th>Conversation</th><th>Members</th><th>Their state</th><th>Size</th><th>Last message</th><th /></tr></thead>
                <tbody>
                  {conversations.map((c) => {
                    const title = c.kind === 'GROUP' ? `Group: ${c.groupName}` : `Direct with ${(c.members ?? []).filter((m: string) => m !== handle.replace(/^@/, '')).join(', ')}`;
                    return (
                      <tr key={c.id}>
                        <td>{title}</td>
                        <td style={{ fontSize: '12px' }}>{(c.members ?? []).map((m: string) => `@${m}`).join(', ')}</td>
                        <td>{c.state} · {c.folder}</td>
                        <td>{c.kind === 'GROUP' ? `${c.memberCount ?? 0} members` : '2 people'}</td>
                        <td>{when(c.lastMessageAt)}</td>
                        <td><button className="btn-secondary" onClick={() => read(c.id, title)}>Read…</button></td>
                      </tr>
                    );
                  })}
                  {conversations.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', opacity: 0.6 }}>Find a user to see their conversations.</td></tr>}
                </tbody>
              </table>
              {conversationsNext && <button className="btn-secondary" onClick={() => findUser(conversationsNext)}>Load more conversations</button>}
            </div>

            {reading && (
              <div style={{ marginTop: '16px', border: '1px solid var(--border)', borderRadius: '10px', padding: '12px', maxHeight: '480px', overflowY: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <h4 style={{ margin: 0, color: '#fff', fontSize: '14px' }}>{reading.title}</h4>
                  <button className="btn-secondary" onClick={() => setReading(null)}>Close</button>
                </div>
                {reading.messages.map((m) => (
                  <div key={m.id} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <div style={{ fontSize: '12px', opacity: 0.6 }}>
                      {when(m.createdAt)} · @{m.sender ?? '?'} · {m.type}
                      {m.retractedAt ? ' · RETRACTED' : ''}
                      {m.hiddenAt ? ' · HIDDEN' : ''}
                      {m.pinnedAt ? ' · pinned' : ''}
                    </div>
                    <div style={{ fontSize: '13px', color: m.retractedAt || m.hiddenAt ? '#94a3b8' : '#e2e8f0', whiteSpace: 'pre-wrap' }}>
                      {m.content || (m.metadata?.media ? `[${m.metadata.media.type}] ${m.metadata.media.url}` : m.metadata?.gift ? `[gift] ${m.metadata.gift.amount} ${m.metadata.gift.currency}` : '')}
                    </div>
                  </div>
                ))}
                {reading.messages.length === 0 && <div style={{ opacity: 0.6 }}>No messages.</div>}
                {reading.next && <button className="btn-secondary" style={{ marginTop: '8px' }} onClick={readMore}>Load older messages</button>}
              </div>
            )}
          </>
        )}

        {tab === 'groups' && (
          <>
            <div style={{ display: 'flex', gap: '8px', margin: '16px 0' }}>
              <input
                className="form-control"
                style={{ maxWidth: '280px' }}
                placeholder="Group name"
                value={groupQuery}
                onChange={(e) => setGroupQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadGroups()}
              />
              <button className="btn-secondary" onClick={() => loadGroups()}>Search</button>
            </div>
            <div className="table-responsive">
              <table className="admin-table">
                <thead><tr><th>Group</th><th>Type</th><th>Owner</th><th>Creator</th><th>Members</th><th>Members can text</th><th>Created</th><th /></tr></thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.id}>
                      <td>{g.name}</td>
                      <td>{g.visibility}</td>
                      <td>@{g.owner ?? '?'}</td>
                      <td>@{g.creator ?? '?'}</td>
                      <td>{g.members}</td>
                      <td>{g.membersCanText ? 'Yes' : 'No'}</td>
                      <td>{when(g.createdAt)}</td>
                      <td>
                        <button
                          className="btn-secondary"
                          onClick={() => {
                            setTab('user');
                            void read(g.id, `Group: ${g.name}`);
                          }}
                        >
                          Read…
                        </button>
                      </td>
                    </tr>
                  ))}
                  {groups.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', opacity: 0.6 }}>No groups.</td></tr>}
                </tbody>
              </table>
              {groupsNext && <button className="btn-secondary" onClick={() => loadGroups(groupsNext)}>Load more groups</button>}
            </div>
          </>
        )}
      </div>
    </section>
  );
};
