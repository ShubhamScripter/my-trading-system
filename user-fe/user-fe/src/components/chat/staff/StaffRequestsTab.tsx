'use client';

/**
 * Requests filed in REPORT mode ("the action goes to a higher role"): the ones this member may decide, and their own.
 * Approving carries the action out with the approver's own permissions and limits.
 */
import React, { useCallback, useEffect, useState } from 'react';
import * as staffApi from '@/lib/api/staff';
import { Btn, OutcomeBanner, Spinner, ui, useStaffAction, when } from './staffUi';

function describe(r: staffApi.StaffRequest): string {
  const p = r.payload ?? {};
  const bits = [
    r.targetUsername ? `@${r.targetUsername}` : null,
    typeof p.action === 'string' ? String(p.action) : null,
    typeof p.durationHours === 'number' ? `${p.durationHours} h` : null,
    p.permanent === true ? 'permanent' : null,
    typeof p.status === 'string' ? String(p.status) : null,
    typeof p.role === 'string' ? `role ${p.role}` : null,
    typeof p.enabled === 'boolean' ? (p.enabled ? 'turn on' : 'turn off') : null,
    p.change === true ? 'change' : null,
    typeof p.reason === 'string' ? `“${p.reason}”` : null,
  ];
  return bits.filter(Boolean).join(' · ');
}

export default function StaffRequestsTab() {
  const [scope, setScope] = useState<'TO_RESOLVE' | 'MINE'>('TO_RESOLVE');
  const [items, setItems] = useState<staffApi.StaffRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const { busy, outcome, setOutcome, run } = useStaffAction();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems((await staffApi.getRequests(scope)).items);
    } catch (err) {
      setOutcome({ tone: 'error', text: err instanceof Error ? err.message : 'Could not load requests' });
    } finally {
      setLoading(false);
    }
  }, [scope, setOutcome]);

  useEffect(() => {
    let live = true;
    staffApi
      .getRequests(scope)
      .then((page) => live && setItems(page.items))
      .catch((err: Error) => live && setOutcome({ tone: 'error', text: err.message }))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [scope, setOutcome]);

  const resolve = async (r: staffApi.StaffRequest, approve: boolean) => {
    const done = await run(r.id, () => staffApi.resolveRequest(r.id, approve, notes[r.id]?.trim() || undefined), approve ? 'Approved and carried out' : 'Rejected');
    if (done) void load();
  };

  return (
    <div>
      <OutcomeBanner outcome={outcome} />
      <div style={{ ...ui.row, marginBottom: '0.75rem' }}>
        {(['TO_RESOLVE', 'MINE'] as const).map((s) => (
          <Btn
            key={s}
            tone={scope === s ? 'primary' : 'default'}
            onClick={() => {
              setLoading(true);
              setScope(s);
            }}
          >
            {s === 'MINE' ? 'Mine' : 'To decide'}
          </Btn>
        ))}
        {loading && <Spinner />}
      </div>
      {!loading && items.length === 0 && <div style={ui.muted}>No requests.</div>}
      {items.map((r) => (
        <div key={r.id} style={ui.section}>
          <div style={{ ...ui.row, justifyContent: 'space-between' }}>
            <div style={{ fontSize: '0.82rem', color: '#e5e7eb' }}>
              <b>{r.permission}</b> {describe(r)}
            </div>
            <span style={ui.muted}>
              {r.status} · {when(r.createdAt)}
            </span>
          </div>
          <div style={ui.muted}>
            From @{r.requesterUsername ?? '?'} ({r.requesterRole ?? 'staff'}){r.note ? ` — ${r.note}` : ''}
          </div>
          {r.resolutionNote && <div style={ui.muted}>Answer: {r.resolutionNote}</div>}
          {scope === 'TO_RESOLVE' && r.status === 'PENDING' && (
            <div style={{ ...ui.row, marginTop: '0.5rem' }}>
              <input
                value={notes[r.id] ?? ''}
                onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                placeholder="Note to the requester (optional)"
                style={{ ...ui.input, flex: 1 }}
              />
              <Btn tone="primary" disabled={busy === r.id} onClick={() => resolve(r, true)}>Approve</Btn>
              <Btn tone="danger" disabled={busy === r.id} onClick={() => resolve(r, false)}>Reject</Btn>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
