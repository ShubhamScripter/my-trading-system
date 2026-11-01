'use client';

/** "See Reported Messages" and "Take Action on Reported Messages": public-room and DM reports. */
import React, { useCallback, useEffect, useState } from 'react';
import * as staffApi from '@/lib/api/staff';
import { Btn, ModeBadge, OutcomeBanner, Spinner, ui, useStaffAction, when } from './staffUi';

const STATUSES = ['PENDING', 'ACTIONED', 'DISMISSED', 'ALL'] as const;

export default function StaffReportsTab({ perms }: { perms: staffApi.StaffPermissions }) {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('PENDING');
  const [items, setItems] = useState<staffApi.StaffReport[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [banHours, setBanHours] = useState(24);
  const { busy, outcome, setOutcome, run } = useStaffAction();
  const mode = (p: string) => perms.permissions[p];
  const canAct = mode('ACT_ON_REPORTS') !== 'NONE';

  const load = useCallback(
    async (more = false) => {
      setLoading(true);
      try {
        const page = await staffApi.getReports(status, more ? cursor : null);
        setItems((prev) => (more ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (err) {
        setOutcome({ tone: 'error', text: err instanceof Error ? err.message : 'Could not load reports' });
      } finally {
        setLoading(false);
      }
    },
    [status, cursor, setOutcome],
  );

  useEffect(() => {
    let live = true;
    staffApi
      .getReports(status)
      .then((page) => {
        if (!live) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((err: Error) => live && setOutcome({ tone: 'error', text: err.message }))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [status, setOutcome]);

  const act = async (report: staffApi.StaffReport, action: 'DISMISS' | 'WARN' | 'BAN' | 'RETRACT_MESSAGE') => {
    const done = await run(
      `${report.id}-${action}`,
      () =>
        staffApi.actOnReport(report.id, {
          action,
          ...(action === 'BAN' ? { durationHours: banHours } : {}),
        }),
      `Report ${action === 'DISMISS' ? 'dismissed' : 'actioned'}`,
    );
    if (done) setItems((prev) => prev.filter((r) => r.id !== report.id || status === 'ALL'));
  };

  return (
    <div>
      <OutcomeBanner outcome={outcome} />
      <div style={{ ...ui.row, marginBottom: '0.75rem' }}>
        {STATUSES.map((s) => (
          <Btn
            key={s}
            tone={status === s ? 'primary' : 'default'}
            onClick={() => {
              setLoading(true);
              setStatus(s);
            }}
          >
            {s}
          </Btn>
        ))}
        {canAct && (
          <span style={{ ...ui.muted, marginLeft: 'auto' }}>
            Ban length{' '}
            <input
              type="number"
              min={1}
              max={perms.maxBanHours}
              value={banHours}
              onChange={(e) => setBanHours(Number(e.target.value) || 1)}
              style={{ ...ui.input, width: '4.5rem' }}
            />{' '}
            h
          </span>
        )}
      </div>

      {items.length === 0 && !loading && <div style={ui.muted}>No reports.</div>}
      {items.map((r) => (
        <div key={r.id} style={ui.section}>
          <div style={{ ...ui.row, justifyContent: 'space-between' }}>
            <div style={{ fontSize: '0.8rem', color: '#e5e7eb' }}>
              <b>@{r.reportedUsername ?? 'unknown'}</b> reported by @{r.reporterUsername ?? 'unknown'} ·{' '}
              <span style={{ color: '#fbbf24' }}>{r.userReason || r.internalReason || r.reason || 'No reason specified'}</span>
              {r.dmMessageId && <span style={{ ...ui.muted, marginLeft: '0.4rem' }}>(direct message)</span>}
            </div>
            <span style={ui.muted}>
              {r.status}
              {r.action ? ` · ${r.action}` : ''} · {when(r.createdAt)}
            </span>
          </div>
          <div
            style={{
              margin: '0.5rem 0',
              padding: '0.5rem 0.65rem',
              borderRadius: '8px',
              background: 'rgba(0,0,0,0.25)',
              fontSize: '0.8rem',
              color: r.messageContent === null ? '#6b7280' : '#d1d5db',
              whiteSpace: 'pre-wrap',
            }}
          >
            {r.messageContent ?? (r.messageRetracted ? '(retracted — needs "See Deleted Messages")' : '(no text)')}
          </div>
          {r.details && <div style={ui.muted}>“{r.details}”</div>}
          {canAct && r.status === 'PENDING' && (
            <div style={{ ...ui.row, marginTop: '0.5rem' }}>
              <Btn onClick={() => act(r, 'DISMISS')} disabled={!!busy}>Dismiss</Btn>
              <Btn onClick={() => act(r, 'WARN')} disabled={!!busy}>
                Warn<ModeBadge mode={mode('WARN')} />
              </Btn>
              <Btn tone="danger" onClick={() => act(r, 'BAN')} disabled={!!busy}>
                Ban {banHours} h<ModeBadge mode={mode('BAN')} />
              </Btn>
              {!r.dmMessageId && (
                <Btn onClick={() => act(r, 'RETRACT_MESSAGE')} disabled={!!busy}>
                  Retract message<ModeBadge mode={mode('DELETE_MESSAGES')} />
                </Btn>
              )}
              {busy?.startsWith(r.id) && <Spinner />}
            </div>
          )}
        </div>
      ))}
      {loading && <Spinner />}
      {cursor && !loading && <Btn onClick={() => load(true)}>Load more</Btn>}
    </div>
  );
}
