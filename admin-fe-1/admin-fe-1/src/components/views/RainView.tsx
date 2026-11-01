import React, { useCallback, useEffect, useState } from 'react';
import { AdminRoom } from '../../types';
import {
  AmountLimit,
  Allocation,
  BulkRevertInput,
  Duration,
  RainAPI,
  RainAudit,
  RainConfig,
  RainDetail,
  RainFilter,
  RainJob,
  RainQuestion,
  RainRepeat,
  RainRun,
  RainSettings,
  RainState,
  RainStatus,
  RecipientMode,
  RevertPolicy,
  RewardRule,
  ScheduledChange,
  Trigger,
  writeError,
} from '../../services/rainApi';

/**
 * RainPool (Modules 6–7): "RainPool Settings", "Chat Rainpool Main", Chat SETTINGS "/rain". The Rainpool rains on the
 * chat server's schedule; User Rain is `/rain` in chat. Settings save as one versioned document; ON / OFF / MAINTAIN
 * applies at once or on a schedule; approvals, reverts and the trigger are queued and the chat server carries them
 * out on its next tick (about 15 seconds), so their outcome shows in Jobs & Audit.
 */
interface Props {
  rooms: AdminRoom[];
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

type Tab = 'overview' | 'system' | 'user' | 'rewards' | 'security' | 'review' | 'bulk' | 'repeats' | 'log' | 'prices';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview & ON / OFF' },
  { id: 'system', label: 'Rainpool' },
  { id: 'user', label: 'User Rain' },
  { id: 'rewards', label: 'EXP & Stars' },
  { id: 'security', label: 'Security' },
  { id: 'review', label: 'Rains & Review' },
  { id: 'bulk', label: 'Revert rains' },
  { id: 'repeats', label: 'Auto-repeat' },
  { id: 'log', label: 'Jobs & Audit' },
  { id: 'prices', label: 'USD rates (dev)' },
];

const STATUSES: RainStatus[] = ['ON', 'MAINTENANCE', 'OFF'];
const RUN_STATUSES = ['PENDING_VERIFICATION', 'PENDING_REVIEW', 'COMPLETED', 'PARTIALLY_REVERSED', 'REVERSED', 'REJECTED', 'EXPIRED'];
const REASON_TEXT: Record<string, string> = {
  NEW_IP: 'new IP',
  NEW_COUNTRY: 'new country',
  VPN_PROXY: 'VPN / proxy',
  AMOUNT: 'amount above',
  COMMON_IP_CHECK: 'common IP check',
};
const MODE_TEXT: Record<RecipientMode, string> = {
  SPECIFIC: 'Specific number',
  ALL: 'All active users',
  PERCENT: 'x% of active users',
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined);
const codes = (text: string) => text.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
const seconds = (d: Duration) => d.value * (d.unit === 'HOURS' ? 3600 : d.unit === 'MINUTES' ? 60 : 1);
const statusColor = (status: string) =>
  status === 'ON' || status === 'COMPLETED' || status === 'DONE' || status === 'APPLIED'
    ? '#4ade80'
    : status === 'MAINTENANCE' || status.startsWith('PENDING') || status === 'RUNNING' || status === 'SCHEDULED' || status === 'PARTIALLY_REVERSED'
      ? '#fbbf24'
      : status === 'OFF' || status === 'EXPIRED' || status === 'CANCELLED'
        ? '#94a3b8'
        : '#f87171';
const ruleText = (rule: RainRun['recipientRule']) =>
  !rule ? '' : rule.mode === 'ALL' ? 'all' : rule.mode === 'PERCENT' ? `${rule.percent}%` : String(rule.count ?? '');

const Hint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>{children}</p>
);

const Pill: React.FC<{ value: string }> = ({ value }) => (
  <span style={{ color: statusColor(value), fontWeight: 600, fontSize: '12px' }}>{value}</span>
);

const NumberField: React.FC<{ label: string; value: number; min?: number; max?: number; step?: number; onChange: (n: number) => void; hint?: string }> = ({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
}) => (
  <div className="form-group">
    <label>{label}</label>
    <input className="form-control" type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
    {hint && <Hint>{hint}</Hint>}
  </div>
);

const TextField: React.FC<{ label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string }> = ({
  label,
  value,
  onChange,
  placeholder,
  hint,
}) => (
  <div className="form-group">
    <label>{label}</label>
    <input className="form-control" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    {hint && <Hint>{hint}</Hint>}
  </div>
);

/** "x Minutes / hours", "x Seconds / Minutes": the number and the unit the admin chose. */
const DurationField: React.FC<{ label: string; value: Duration; units: Duration['unit'][]; onChange: (d: Duration) => void }> = ({ label, value, units, onChange }) => (
  <div className="form-group">
    <label>{label}</label>
    <div style={{ display: 'flex', gap: '6px' }}>
      <input className="form-control" type="number" min={1} value={value.value} onChange={(e) => onChange({ ...value, value: Math.max(1, Math.round(Number(e.target.value))) })} />
      <select className="form-control" style={{ maxWidth: '110px' }} value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as Duration['unit'] })}>
        {units.map((u) => <option key={u} value={u}>{u.toLowerCase()}</option>)}
      </select>
    </div>
  </div>
);

const StatusPicker: React.FC<{ value: RainStatus; onChange: (s: RainStatus) => void }> = ({ value, onChange }) => (
  <div style={{ display: 'flex', gap: '8px' }}>
    {STATUSES.map((s) => (
      <button key={s} type="button" className={value === s ? 'btn-action' : 'btn-secondary'} onClick={() => onChange(s)}>
        {s}
      </button>
    ))}
  </div>
);

const Toggle: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <label style={{ fontSize: '13px', display: 'flex', gap: '6px', alignItems: 'center' }}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
  </label>
);

const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px', marginTop: '16px' };
const card: React.CSSProperties = {
  marginTop: '16px',
  padding: '14px',
  borderRadius: '10px',
  border: '1px solid var(--border-color, #334155)',
  background: 'rgba(255,255,255,0.02)',
};

export const RainView: React.FC<Props> = ({ rooms, onShowToast }) => {
  const [tab, setTab] = useState<Tab>('overview');
  const [settings, setSettings] = useState<RainSettings | null>(null);
  const [draft, setDraft] = useState<RainConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** `keepEdits`: a status change elsewhere refreshes the version and statuses without dropping unsaved edits. */
  const load = useCallback(async (keepEdits = false) => {
    try {
      const data = await RainAPI.settings();
      const config = data.config ?? data.defaults;
      setSettings(data);
      setDraft((prev) => (keepEdits && prev ? { ...prev, status: config.status } : structuredClone(config)));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load RainPool');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saved = settings ? (settings.config ?? settings.defaults) : null;
  const dirty = !!saved && !!draft && JSON.stringify(saved) !== JSON.stringify(draft);

  const save = async () => {
    if (!draft || !settings) return;
    setSaving(true);
    try {
      const res = await RainAPI.saveSettings(draft, settings.version);
      if (res.success) {
        onShowToast('RainPool settings saved; open apps update at once');
        await load();
      } else onShowToast(writeError(res as any), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const update = (fn: (c: RainConfig) => void) =>
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });

  if (loadError) {
    return (
      <section className="tab-view">
        <div className="card-section">
          <h3>RainPool</h3>
          <p style={{ color: '#f87171', marginTop: '8px' }}>{loadError}</p>
          <button className="btn-secondary" style={{ marginTop: '12px' }} onClick={() => load()}>Retry</button>
        </div>
      </section>
    );
  }
  if (!settings || !draft) {
    return (
      <section className="tab-view">
        <div className="card-section"><p style={{ opacity: 0.7 }}>Loading RainPool…</p></div>
      </section>
    );
  }

  const settingsTab = tab === 'system' || tab === 'user' || tab === 'rewards' || tab === 'security';

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>RainPool</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              The Rainpool rains automatically; User Rain is <code>/rain BTC 0.01 5</code> (or <code>all</code>, <code>10%</code>) in chat. Settings
              version {settings.version}, saved {when(settings.updatedAt)}. Saving the settings, ON / OFF / MAINTAIN and the USD rates need a super admin.
            </p>
            {settings.problems.length > 0 && (
              <p style={{ fontSize: '12px', color: '#f87171', marginTop: '4px' }}>
                The stored settings no longer match the contract ({settings.problems.join('; ')}); the defaults are shown and nothing rains until they are saved.
              </p>
            )}
          </div>
          {settingsTab && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn-secondary" disabled={!dirty || saving} onClick={() => setDraft(structuredClone(saved!))}>
                Discard
              </button>
              <button className="btn-action" disabled={!dirty || saving} onClick={save}>
                {saving ? 'Saving…' : dirty ? 'Save settings' : 'Saved'}
              </button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '16px' }}>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'btn-action' : 'btn-secondary'} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'overview' && <OverviewTab onShowToast={onShowToast} onStatusChanged={() => load(true)} onOpenReview={() => setTab('review')} />}
        {tab === 'system' && <SystemTab draft={draft} rooms={rooms} update={update} />}
        {tab === 'user' && <UserTab draft={draft} rooms={rooms} update={update} />}
        {tab === 'rewards' && <RewardsTab draft={draft} update={update} />}
        {tab === 'security' && <SecurityTab draft={draft} update={update} />}
        {tab === 'review' && <ReviewTab onShowToast={onShowToast} />}
        {tab === 'bulk' && <BulkTab onShowToast={onShowToast} />}
        {tab === 'repeats' && <RepeatsTab onShowToast={onShowToast} />}
        {tab === 'log' && <LogTab onShowToast={onShowToast} />}
        {tab === 'prices' && <PricesTab onShowToast={onShowToast} />}
      </div>
    </section>
  );
};

// ─── Overview, ON / OFF / MAINTAIN ───────────────────────────────────────────

const OverviewTab: React.FC<{
  onShowToast: Props['onShowToast'];
  onStatusChanged: () => Promise<void>;
  onOpenReview: () => void;
}> = ({ onShowToast, onStatusChanged, onOpenReview }) => {
  const [state, setState] = useState<RainState | null>(null);
  const [latest, setLatest] = useState<RainRun[]>([]);
  const [changes, setChanges] = useState<ScheduledChange[]>([]);
  const [now, setNow] = useState(Date.now());
  const [patch, setPatch] = useState<RainConfig['status'] | null>(null);
  const [applyAt, setApplyAt] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [s, r, c] = await Promise.all([RainAPI.state(), RainAPI.rains({}, 10), RainAPI.scheduled()]);
      setState(s);
      setLatest(r.rains);
      setChanges(c.changes);
      setPatch((prev) => prev ?? { overall: s.status.overall, system: s.status.system, user: s.status.user, note: s.status.note });
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : 'Could not load the RainPool state', 'danger');
    }
  }, [onShowToast]);

  useEffect(() => {
    void reload();
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => void reload(), 15_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [reload]);

  if (!state || !patch) return <p style={{ opacity: 0.7, marginTop: '16px' }}>Loading…</p>;

  const next = state.next.at ? new Date(state.next.at).getTime() : null;
  const left = next ? Math.max(0, Math.round((next - now) / 1000)) : null;
  const started = state.next.scheduledAt ? new Date(state.next.scheduledAt).getTime() : null;
  // "the randomly selected amount will show filling with time (count up) till the rain time"
  const share = next && started && next > started ? Math.min(1, Math.max(0, (now - started) / (next - started))) : null;
  const countUp = share !== null && state.next.pot ? (Number(state.next.pot) * share).toFixed(8).replace(/\.?0+$/, '') : null;

  const applyNow = async () => {
    setBusy(true);
    try {
      const res = await RainAPI.setStatus(patch);
      if (res.success) {
        onShowToast('Status changed; open apps update at once');
        await Promise.all([reload(), onStatusChanged()]);
      } else onShowToast(writeError(res as any), 'danger');
    } finally {
      setBusy(false);
    }
  };

  const schedule = async () => {
    const at = toIso(applyAt);
    if (!at) return onShowToast('Choose when the change applies', 'danger');
    setBusy(true);
    try {
      const res = await RainAPI.schedule(at, patch);
      if (res.success) {
        onShowToast(`Scheduled for ${when(at)}`);
        setApplyAt('');
        await reload();
      } else onShowToast(writeError(res as any), 'danger');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    const res = await RainAPI.cancelSchedule(id);
    if (res.success) onShowToast('Scheduled change cancelled');
    else onShowToast(writeError(res as any), 'danger');
    await reload();
  };

  const trigger = async () => {
    if (!window.confirm('Run one Rainpool rain now with the current settings?')) return;
    const res = await RainAPI.trigger();
    if (res.success) onShowToast('Queued: the chat server runs it within ~15 seconds. See Jobs & Audit for the outcome.');
    else onShowToast(writeError(res as any), 'danger');
    void reload();
  };

  return (
    <>
      <div className="metrics-grid" style={{ marginTop: '16px' }}>
        <div className="metric-card">
          <div className="metric-header"><span className="metric-title">Rainpool (system rains)</span></div>
          <div className="metric-value" style={{ color: statusColor(state.status.effective.system) }}>{state.status.effective.system}</div>
          <div className="metric-trend">
            {state.status.effective.system !== 'ON'
              ? 'Nothing rains automatically'
              : left === null
                ? 'Scheduling the next rain…'
                : `${countUp ?? '…'} / ${state.next.pot ?? '?'} ${state.next.currency ?? ''}${state.next.potUsd ? ` (~${state.next.potUsd} USD)` : ''} · ${left === 0 ? 'due now' : `in ${Math.floor(left / 60)}m ${left % 60}s`}`}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-header"><span className="metric-title">User rains</span></div>
          <div className="metric-value" style={{ color: statusColor(state.status.effective.user) }}>{state.status.effective.user}</div>
          <div className="metric-trend">Overall: {state.status.overall}</div>
        </div>
        <div className="metric-card" style={{ cursor: 'pointer' }} onClick={onOpenReview}>
          <div className="metric-header"><span className="metric-title">Waiting for admin review</span></div>
          <div className="metric-value" style={{ color: state.pendingReview ? '#fbbf24' : undefined }}>{state.pendingReview}</div>
          <div className="metric-trend">{state.waitingForUser} sent back to the user</div>
        </div>
        <div className="metric-card">
          <div className="metric-header"><span className="metric-title">Queued jobs</span></div>
          <div className="metric-value">{state.openJobs}</div>
          <div className="metric-trend">{state.activeRepeats} auto-repeat series running</div>
        </div>
      </div>

      <div style={card}>
        <label style={{ fontWeight: 600 }}>ON / OFF / MAINTAIN</label>
        <Hint>
          Overall OFF is "Disable Overall Rains" (neither user nor Rainpool can rain); overall MAINTAIN puts every side that is not OFF under
          maintenance. Users see the maintenance text.
        </Hint>
        <div style={grid}>
          <div className="form-group"><label>Overall</label><StatusPicker value={patch.overall} onChange={(v) => setPatch({ ...patch, overall: v })} /></div>
          <div className="form-group"><label>System Rains (Rainpool)</label><StatusPicker value={patch.system} onChange={(v) => setPatch({ ...patch, system: v })} /></div>
          <div className="form-group"><label>User Rains</label><StatusPicker value={patch.user} onChange={(v) => setPatch({ ...patch, user: v })} /></div>
        </div>
        <TextField label="Maintenance text" value={patch.note ?? ''} placeholder="Rains are back at 18:00 UTC" onChange={(v) => setPatch({ ...patch, note: v.trim() ? v : null })} />
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' }}>
          <button className="btn-action" disabled={busy} onClick={applyNow}>Apply now</button>
          <span style={{ fontSize: '13px', opacity: 0.7 }}>or schedule it:</span>
          <input className="form-control" style={{ maxWidth: '230px' }} type="datetime-local" value={applyAt} onChange={(e) => setApplyAt(e.target.value)} />
          <button className="btn-secondary" disabled={busy || !applyAt} onClick={schedule}>Schedule</button>
        </div>
        {changes.length > 0 && (
          <div className="table-responsive" style={{ marginTop: '12px' }}>
            <table className="admin-table">
              <thead><tr><th>Applies at</th><th>Change</th><th>State</th><th /></tr></thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.id}>
                    <td>{when(c.applyAt)}</td>
                    <td style={{ fontSize: '12px' }}>{Object.entries(c.patch).map(([k, v]) => `${k}: ${v ?? '—'}`).join(' · ')}</td>
                    <td><Pill value={c.state} />{c.error && <div style={{ fontSize: '11px', color: '#f87171' }}>{c.error}</div>}</td>
                    <td>{c.state === 'PENDING' && <button className="btn-secondary" onClick={() => cancel(c.id)}>Cancel</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '8px', marginTop: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn-action" disabled={state.status.effective.system !== 'ON'} onClick={trigger}>Rain the Rainpool now</button>
        <button className="btn-secondary" onClick={() => reload()}>Refresh</button>
        {state.status.effective.system !== 'ON' && <Hint>A manual rain needs the Rainpool ON.</Hint>}
      </div>
      <h4 style={{ marginTop: '24px' }}>Latest rains</h4>
      <div className="table-responsive">
        <table className="admin-table">
          <thead><tr><th>When</th><th>Type</th><th>By</th><th>Amount</th><th>People</th><th>Status</th></tr></thead>
          <tbody>
            {latest.map((r) => (
              <tr key={r.id}>
                <td>{when(r.createdAt)}</td>
                <td>{r.kind === 'SYSTEM' ? 'Rainpool' : 'User'}</td>
                <td>{r.username ? `@${r.username}` : '—'}</td>
                <td>{r.pot} {r.currency}{r.usd && <div style={{ fontSize: '12px', opacity: 0.6 }}>~{r.usd} USD</div>}</td>
                <td>{r.recipients}</td>
                <td><Pill value={r.status} /></td>
              </tr>
            ))}
            {latest.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', opacity: 0.6 }}>No rains yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
};

// ─── Settings tabs ───────────────────────────────────────────────────────────

type Update = (fn: (c: RainConfig) => void) => void;

const RoomPicker: React.FC<{ rooms: AdminRoom[]; value: string[]; onChange: (ids: string[]) => void }> = ({ rooms, value, onChange }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '6px' }}>
    {rooms.map((room) => (
      <label key={room.id} style={{ fontSize: '13px', display: 'flex', gap: '4px', alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={value.includes(room.id)}
          onChange={(e) => onChange(e.target.checked ? [...value, room.id] : value.filter((id) => id !== room.id))}
        />
        {room.name}
      </label>
    ))}
    {rooms.length === 0 && <Hint>No rooms loaded.</Hint>}
  </div>
);

/** "Percentage of rain to distribute to normal users: x%" and "… to Premium Users (Plan wise): x%". */
const AllocationEditor: React.FC<{ value: Allocation; onChange: (a: Allocation) => void }> = ({ value, onChange }) => {
  const total = value.normalPercent + value.plans.reduce((sum, p) => sum + p.percent, 0);
  return (
    <div style={card}>
      <label style={{ fontWeight: 600 }}>Normal / Premium split (must add up to 100% — now {total}%)</label>
      <Hint>Equal shares inside each group. A group with nobody online gives its share to the groups that have people. "*" is any other Premium plan.</Hint>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px auto', gap: '8px', marginTop: '10px', alignItems: 'center' }}>
        <span style={{ fontSize: '13px' }}>Normal users</span>
        <input className="form-control" type="number" min={0} max={100} value={value.normalPercent} onChange={(e) => onChange({ ...value, normalPercent: Number(e.target.value) })} />
        <span>%</span>
        {value.plans.map((plan, i) => (
          <React.Fragment key={i}>
            <input
              className="form-control"
              placeholder="Premium plan id (* = any other plan)"
              value={plan.planId}
              onChange={(e) => onChange({ ...value, plans: value.plans.map((p, j) => (j === i ? { ...p, planId: e.target.value } : p)) })}
            />
            <input
              className="form-control"
              type="number"
              min={0}
              max={100}
              value={plan.percent}
              onChange={(e) => onChange({ ...value, plans: value.plans.map((p, j) => (j === i ? { ...p, percent: Number(e.target.value) } : p)) })}
            />
            <button type="button" className="btn-secondary" onClick={() => onChange({ ...value, plans: value.plans.filter((_, j) => j !== i) })}>Remove</button>
          </React.Fragment>
        ))}
      </div>
      <button type="button" className="btn-secondary" style={{ marginTop: '8px' }} onClick={() => onChange({ ...value, plans: [...value.plans, { planId: '', percent: 0 }] })}>
        Add Premium plan
      </button>
    </div>
  );
};

const SystemTab: React.FC<{ draft: RainConfig; rooms: AdminRoom[]; update: Update }> = ({ draft, rooms, update }) => {
  const s = draft.system;
  const [currencyText, setCurrencyText] = useState(s.currencies.join(', '));
  return (
    <div style={{ marginTop: '16px' }}>
      <Hint>
        "Select Random Currency → Select Random Amount → Rain → Select Random Time → REPEAT". The next rain's currency, USD amount and time are chosen
        together, so apps show the amount counting up until it falls. Rains go to users online in the rain room. The status is set under Overview.
      </Hint>
      <div style={grid}>
        <TextField
          label="Currencies the Rainpool can rain"
          value={currencyText}
          placeholder="BTC, ETH, USDT"
          onChange={(v) => {
            setCurrencyText(v);
            update((c) => (c.system.currencies = codes(v)));
          }}
        />
        <TextField label="Rain amount: minimum (USD)" value={s.amountUsd.min} onChange={(v) => update((c) => (c.system.amountUsd.min = v))} />
        <TextField label="Rain amount: maximum (USD)" value={s.amountUsd.max} onChange={(v) => update((c) => (c.system.amountUsd.max = v))} />
        <DurationField label="Rain happens every: minimum" value={s.interval.min} units={['MINUTES', 'HOURS']} onChange={(d) => update((c) => (c.system.interval.min = d))} />
        <DurationField label="Rain happens every: maximum" value={s.interval.max} units={['MINUTES', 'HOURS']} onChange={(d) => update((c) => (c.system.interval.max = d))} />
        <div className="form-group">
          <label>Number of users to rain</label>
          <select className="form-control" value={s.recipients.mode} onChange={(e) => update((c) => (c.system.recipients.mode = e.target.value as RecipientMode))}>
            {(['SPECIFIC', 'ALL', 'PERCENT'] as RecipientMode[]).map((m) => <option key={m} value={m}>{MODE_TEXT[m]}</option>)}
          </select>
          <Hint>Active = online in the rain room, not banned there, allowed to receive rains.</Hint>
        </div>
        {s.recipients.mode === 'SPECIFIC' && (
          <NumberField label="Specific number" value={s.recipients.count} min={1} max={100000} onChange={(n) => update((c) => (c.system.recipients.count = n))} />
        )}
        {s.recipients.mode === 'PERCENT' && (
          <NumberField label="Percent of active users" value={s.recipients.percent} min={1} max={100} onChange={(n) => update((c) => (c.system.recipients.percent = n))} />
        )}
        <div className="form-group">
          <label>Threshold</label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input
              className="form-control"
              type="number"
              min={1}
              disabled={s.threshold === null}
              value={s.threshold ?? ''}
              onChange={(e) => update((c) => (c.system.threshold = Math.max(1, Number(e.target.value))))}
            />
            <Toggle label="On" checked={s.threshold !== null} onChange={(v) => update((c) => (c.system.threshold = v ? 1000 : null))} />
          </div>
          <Hint>If more users are online than this, a random this-many are chosen.</Hint>
        </div>
        <div className="form-group">
          <label>Rain room</label>
          <select className="form-control" value={s.roomId ?? ''} onChange={(e) => update((c) => (c.system.roomId = e.target.value || null))}>
            <option value="">Global</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
      </div>
      <AllocationEditor value={s.allocation} onChange={(a) => update((c) => (c.system.allocation = a))} />
    </div>
  );
};

/** Chat SETTINGS "/rain: Maximum (Minimum) Amount That can be Rained: Set in USD (Same for all) / Set Separately for Each Currency". */
const AmountLimitEditor: React.FC<{ label: string; value: AmountLimit; onChange: (v: AmountLimit) => void }> = ({ label, value, onChange }) => (
  <div style={card}>
    <label style={{ fontWeight: 600 }}>{label}</label>
    <div style={{ display: 'flex', gap: '16px', marginTop: '8px' }}>
      <Toggle label="In USD (same for all currencies)" checked={value.mode === 'USD'} onChange={(v) => onChange({ ...value, mode: v ? 'USD' : 'PER_CURRENCY' })} />
      <Toggle label="Separately for each currency" checked={value.mode === 'PER_CURRENCY'} onChange={(v) => onChange({ ...value, mode: v ? 'PER_CURRENCY' : 'USD' })} />
    </div>
    {value.mode === 'USD' ? (
      <div style={{ maxWidth: '260px' }}>
        <TextField label="USD" value={value.usd} onChange={(v) => onChange({ ...value, usd: v })} />
      </div>
    ) : (
      <div>
        {value.perCurrency.map((row, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '120px 1fr auto', gap: '8px', marginTop: '6px' }}>
            <input className="form-control" placeholder="BTC" value={row.code} onChange={(e) => onChange({ ...value, perCurrency: value.perCurrency.map((r, j) => (j === i ? { ...r, code: e.target.value.toUpperCase() } : r)) })} />
            <input className="form-control" placeholder="amount in that currency" value={row.amount} onChange={(e) => onChange({ ...value, perCurrency: value.perCurrency.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)) })} />
            <button type="button" className="btn-secondary" onClick={() => onChange({ ...value, perCurrency: value.perCurrency.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <button type="button" className="btn-secondary" style={{ marginTop: '8px' }} onClick={() => onChange({ ...value, perCurrency: [...value.perCurrency, { code: '', amount: '' }] })}>
          Add currency
        </button>
        <Hint>A currency with no row here cannot be rained.</Hint>
      </div>
    )}
  </div>
);

const UserTab: React.FC<{ draft: RainConfig; rooms: AdminRoom[]; update: Update }> = ({ draft, rooms, update }) => {
  const u = draft.user;
  const [currencyText, setCurrencyText] = useState(u.currencies.codes.join(', '));
  const toggleMode = (mode: RecipientMode, on: boolean) =>
    update((c) => (c.user.recipients.modes = on ? [...new Set([...c.user.recipients.modes, mode])] : c.user.recipients.modes.filter((m) => m !== mode)));
  return (
    <div style={{ marginTop: '16px' }}>
      <Hint>
        <code>/rain CURRENCY AMOUNT USERS [repeat COUNT GAP]</code>, e.g. <code>/rain BTC 0.01 5</code>, <code>/rain BTC 0.01 all</code>,{' '}
        <code>/rain BTC 0.01 10% repeat 3 5m</code>. Rains never land on people the rainer muted / blocked or who muted / blocked them. The status is
        set under Overview.
      </Hint>
      <div className="form-group" style={{ marginTop: '16px' }}>
        <label>Cryptos allowed to rain</label>
        <Toggle label="ALL" checked={u.currencies.all} onChange={(v) => update((c) => (c.user.currencies.all = v))} />
        {!u.currencies.all && (
          <input
            className="form-control"
            style={{ marginTop: '6px' }}
            value={currencyText}
            placeholder="BTC, ETH, USDT"
            onChange={(e) => {
              setCurrencyText(e.target.value);
              update((c) => (c.user.currencies.codes = codes(e.target.value)));
            }}
          />
        )}
      </div>
      <AmountLimitEditor label="Minimum amount that can be rained" value={u.minAmount} onChange={(v) => update((c) => (c.user.minAmount = v))} />
      <AmountLimitEditor label="Maximum amount that can be rained" value={u.maxAmount} onChange={(v) => update((c) => (c.user.maxAmount = v))} />
      <div style={card}>
        <label style={{ fontWeight: 600 }}>Number of users to rain</label>
        <div style={{ display: 'flex', gap: '16px', marginTop: '8px', flexWrap: 'wrap' }}>
          {(['SPECIFIC', 'ALL', 'PERCENT'] as RecipientMode[]).map((m) => (
            <Toggle key={m} label={MODE_TEXT[m]} checked={u.recipients.modes.includes(m)} onChange={(v) => toggleMode(m, v)} />
          ))}
        </div>
        <div style={grid}>
          <NumberField label="Minimum users in a single rain" value={u.recipients.min} min={1} max={10000} onChange={(n) => update((c) => (c.user.recipients.min = n))} />
          <NumberField
            label="Maximum users in a single rain"
            value={u.recipients.max}
            min={1}
            max={10000}
            onChange={(n) => update((c) => (c.user.recipients.max = n))}
            hint="'all' and 'x%' take a random maximum when more qualify."
          />
          <NumberField
            label="Fee on user rains (%)"
            value={u.feePercent}
            min={0}
            max={100}
            step={0.01}
            onChange={(n) => update((c) => (c.user.feePercent = Math.round(n * 100) / 100))}
            hint="Cut first; the rest is distributed."
          />
        </div>
      </div>
      <AllocationEditor value={u.allocation} onChange={(a) => update((c) => (c.user.allocation = a))} />
      <div className="form-group" style={{ marginTop: '16px' }}>
        <label>Channels where raining is allowed</label>
        <Toggle label="ALL" checked={u.channels.all} onChange={(v) => update((c) => (c.user.channels.all = v))} />
        {!u.channels.all && <RoomPicker rooms={rooms} value={u.channels.roomIds} onChange={(ids) => update((c) => (c.user.channels.roomIds = ids))} />}
        <Hint>/rain is a chat command: the room also needs Commands on (with /rain allowed) in Rooms &amp; Controls.</Hint>
      </div>
      <div style={card}>
        <Toggle label="Auto repeat rains option" checked={u.autoRepeat.enabled} onChange={(v) => update((c) => (c.user.autoRepeat.enabled = v))} />
        <Hint>Every repeat charges the same pot again when it runs; a failed repeat stops the series.</Hint>
        {u.autoRepeat.enabled && (
          <div style={grid}>
            <NumberField label="Minimum repeat count" value={u.autoRepeat.minCount} min={1} max={100} onChange={(n) => update((c) => (c.user.autoRepeat.minCount = n))} />
            <NumberField label="Maximum repeat count" value={u.autoRepeat.maxCount} min={1} max={100} onChange={(n) => update((c) => (c.user.autoRepeat.maxCount = n))} />
            <DurationField label="Minimum gap duration" value={u.autoRepeat.minGap} units={['SECONDS', 'MINUTES']} onChange={(d) => update((c) => (c.user.autoRepeat.minGap = d))} />
            <DurationField label="Maximum gap duration" value={u.autoRepeat.maxGap} units={['MINUTES', 'HOURS']} onChange={(d) => update((c) => (c.user.autoRepeat.maxGap = d))} />
          </div>
        )}
        {u.autoRepeat.enabled && seconds(u.autoRepeat.minGap) > seconds(u.autoRepeat.maxGap) && <Hint>The minimum gap is above the maximum.</Hint>}
      </div>
    </div>
  );
};

/** "Fixed" or "X for every y$ worth of rain" (at least 1). */
const RewardRuleEditor: React.FC<{ label: string; value: RewardRule; onChange: (r: RewardRule) => void }> = ({ label, value, onChange }) => (
  <div className="form-group">
    <label>{label}</label>
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
      <select className="form-control" style={{ maxWidth: '150px' }} value={value.mode} onChange={(e) => onChange({ ...value, mode: e.target.value as RewardRule['mode'] })}>
        <option value="FIXED">Fixed</option>
        <option value="DYNAMIC">X for every y$</option>
      </select>
      <input className="form-control" type="number" min={0} value={value.amount} onChange={(e) => onChange({ ...value, amount: Math.max(0, Math.round(Number(e.target.value))) })} />
      {value.mode === 'DYNAMIC' && (
        <>
          <span style={{ fontSize: '12px' }}>per</span>
          <input className="form-control" style={{ maxWidth: '100px' }} value={value.everyUsd} onChange={(e) => onChange({ ...value, everyUsd: e.target.value })} />
          <span style={{ fontSize: '12px' }}>USD</span>
        </>
      )}
    </div>
  </div>
);

const RewardsTab: React.FC<{ draft: RainConfig; update: Update }> = ({ draft, update }) => {
  const r = draft.rewards;
  return (
    <div style={{ marginTop: '16px' }}>
      <Hint>
        EXP and Stars, set separately, can be 0. "Per rain done" goes to the user who rained; "every rain received" to each recipient (Rainpool and user
        rains). Awarded through the rewards module once it is connected; until then rains record the reward as not awarded.
      </Hint>
      <div style={grid}>
        <RewardRuleEditor label="Per rain done: EXP" value={r.perRainDone.exp} onChange={(v) => update((c) => (c.rewards.perRainDone.exp = v))} />
        <RewardRuleEditor label="Per rain done: Stars" value={r.perRainDone.stars} onChange={(v) => update((c) => (c.rewards.perRainDone.stars = v))} />
        <RewardRuleEditor label="Every rain received: EXP" value={r.perRainReceived.exp} onChange={(v) => update((c) => (c.rewards.perRainReceived.exp = v))} />
        <RewardRuleEditor label="Every rain received: Stars" value={r.perRainReceived.stars} onChange={(v) => update((c) => (c.rewards.perRainReceived.stars = v))} />
      </div>
    </div>
  );
};

const TriggerPicker: React.FC<{ label: string; value: Trigger; onChange: (t: Trigger) => void }> = ({ label, value, onChange }) => (
  <div className="form-group">
    <label>{label}</label>
    <select className="form-control" value={value} onChange={(e) => onChange(e.target.value as Trigger)}>
      <option value="OFF">OFF</option>
      <option value="AUTO">Auto trigger (asked with the codes)</option>
      <option value="MANUAL">Manual trigger (admin asks during review)</option>
    </select>
  </div>
);

/** "OR amount above x USD": empty = the rule has no amount trigger. */
const AmountAbove: React.FC<{ value: string | null; onChange: (v: string | null) => void }> = ({ value, onChange }) => (
  <div style={{ maxWidth: '260px' }}>
    <TextField label="OR amount above (USD)" value={value ?? ''} placeholder="empty = no amount rule" onChange={(v) => onChange(v.trim() ? v.trim() : null)} />
  </div>
);

const QuestionEditor: React.FC<{ questions: RainQuestion[]; onChange: (q: RainQuestion[]) => void }> = ({ questions, onChange }) => {
  const set = (i: number, patch: Partial<RainQuestion>) => onChange(questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  return (
    <div>
      {questions.map((q, i) => (
        <div key={i} style={{ ...card, marginTop: '8px' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input className="form-control" placeholder="Question" value={q.text} onChange={(e) => set(i, { text: e.target.value })} />
            <button type="button" className="btn-secondary" onClick={() => onChange(questions.filter((_, j) => j !== i))}>Remove</button>
          </div>
          {q.options.map((option, k) => (
            <div key={k} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
              <label style={{ fontSize: '12px', whiteSpace: 'nowrap' }} title="Answers marked OK are accepted; any other answer rejects the rain">
                <input
                  type="checkbox"
                  checked={q.okOptions.includes(k)}
                  onChange={(e) => set(i, { okOptions: e.target.checked ? [...q.okOptions, k] : q.okOptions.filter((o) => o !== k) })}
                />{' '}
                OK
              </label>
              <input className="form-control" value={option} placeholder={`Option ${k + 1}`} onChange={(e) => set(i, { options: q.options.map((o, j) => (j === k ? e.target.value : o)) })} />
              {q.options.length > 2 && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    set(i, {
                      options: q.options.filter((_, j) => j !== k),
                      okOptions: q.okOptions.filter((o) => o !== k).map((o) => (o > k ? o - 1 : o)),
                    })
                  }
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {q.options.length < 6 && (
            <button type="button" className="btn-secondary" style={{ marginTop: '6px' }} onClick={() => set(i, { options: [...q.options, ''] })}>
              Add option
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary"
        style={{ marginTop: '8px' }}
        onClick={() => onChange([...questions, { text: '', options: ['Yes', 'No'], okOptions: [0] }])}
      >
        Add question
      </button>
    </div>
  );
};

const SecurityTab: React.FC<{ draft: RainConfig; update: Update }> = ({ draft, update }) => {
  const s = draft.security;
  return (
    <div style={{ marginTop: '16px' }}>
      <Hint>
        User rains only. The rule is read from the account's login history (new IP, new country) and the VPN / proxy check; the highest matching rule
        wins. Nothing is debited until the checks pass. Each rule can be switched ON / OFF.
      </Hint>

      <div style={card}>
        <Toggle label="Rain from a common login IP: nothing required" checked={s.commonIp.enabled} onChange={(v) => update((c) => (c.security.commonIp.enabled = v))} />
        <Hint>OFF: rains from a common IP also need the codes of the next rule.</Hint>
      </div>

      <div style={card}>
        <Toggle label="New IP (same country) OR amount above → EMAIL & 2FA" checked={s.newIpSameCountry.enabled} onChange={(v) => update((c) => (c.security.newIpSameCountry.enabled = v))} />
        <div style={grid}>
          <div className="form-group">
            <label>Admin setting</label>
            <select className="form-control" value={s.newIpSameCountry.require} onChange={(e) => update((c) => (c.security.newIpSameCountry.require = e.target.value as 'ONE' | 'BOTH'))}>
              <option value="ONE">Require one</option>
              <option value="BOTH">Require both</option>
            </select>
          </div>
          <AmountAbove value={s.newIpSameCountry.amountAboveUsd} onChange={(v) => update((c) => (c.security.newIpSameCountry.amountAboveUsd = v))} />
        </div>
      </div>

      <div style={card}>
        <Toggle label="New IP and different country (original IP) OR amount above → EMAIL & 2FA (both) + AUTO verification" checked={s.newCountry.enabled} onChange={(v) => update((c) => (c.security.newCountry.enabled = v))} />
        <div style={{ display: 'flex', gap: '16px', marginTop: '10px' }}>
          <Toggle label="Questionnaire (auto trigger)" checked={s.newCountry.questionnaire} onChange={(v) => update((c) => (c.security.newCountry.questionnaire = v))} />
          <Toggle label="Request KYC check (auto)" checked={s.newCountry.kycCheck} onChange={(v) => update((c) => (c.security.newCountry.kycCheck = v))} />
        </div>
        <AmountAbove value={s.newCountry.amountAboveUsd} onChange={(v) => update((c) => (c.security.newCountry.amountAboveUsd = v))} />
      </div>

      <div style={card}>
        <Toggle label="New IP and different country (VPN / proxy) OR amount above → EMAIL & 2FA (both) + MANUAL admin verification" checked={s.vpnProxy.enabled} onChange={(v) => update((c) => (c.security.vpnProxy.enabled = v))} />
        <Hint>Admins then approve, reject, or ask for the questionnaire / KYC check under Rains &amp; Review.</Hint>
        <div style={grid}>
          <TriggerPicker label="Questionnaire" value={s.vpnProxy.questionnaire} onChange={(t) => update((c) => (c.security.vpnProxy.questionnaire = t))} />
          <TriggerPicker label="Request KYC check" value={s.vpnProxy.kycCheck} onChange={(t) => update((c) => (c.security.vpnProxy.kycCheck = t))} />
          <AmountAbove value={s.vpnProxy.amountAboveUsd} onChange={(v) => update((c) => (c.security.vpnProxy.amountAboveUsd = v))} />
        </div>
      </div>

      <div style={card}>
        <label style={{ fontWeight: 600 }}>Questionnaire</label>
        <Hint>Mark the answers that are OK. The user must pick an OK answer for every question or the rain is rejected.</Hint>
        <QuestionEditor questions={s.questions} onChange={(q) => update((c) => (c.security.questions = q))} />
      </div>

      <div style={grid}>
        <NumberField
          label="KYC level the KYC check asks for"
          value={s.kycMinLevel}
          min={1}
          max={10}
          onChange={(n) => update((c) => (c.security.kycMinLevel = n))}
          hint="It must also match the account's original KYC once the KYC module tells."
        />
      </div>
    </div>
  );
};

// ─── Rains & review ──────────────────────────────────────────────────────────

const FilterBar: React.FC<{ filter: RainFilter; onChange: (f: RainFilter) => void }> = ({ filter, onChange }) => {
  const set = (patch: Partial<RainFilter>) => onChange({ ...filter, ...patch });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '8px', margin: '16px 0' }}>
      <select className="form-control" value={filter.kind ?? ''} onChange={(e) => set({ kind: (e.target.value || undefined) as RainFilter['kind'] })}>
        <option value="">Rainpool and user rains</option>
        <option value="SYSTEM">Rainpool rains</option>
        <option value="USER">User rains</option>
      </select>
      <select className="form-control" value={filter.status ?? ''} onChange={(e) => set({ status: e.target.value || undefined })}>
        <option value="">Any status</option>
        {RUN_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <input className="form-control" placeholder="Coin" value={filter.currency ?? ''} onChange={(e) => set({ currency: e.target.value.toUpperCase() || undefined })} />
      <input className="form-control" placeholder="User (rainer or recipient)" value={filter.user ?? ''} onChange={(e) => set({ user: e.target.value.trim() || undefined })} />
      <input className="form-control" type="datetime-local" title="From" onChange={(e) => set({ from: toIso(e.target.value) })} />
      <input className="form-control" type="datetime-local" title="To" onChange={(e) => set({ to: toIso(e.target.value) })} />
    </div>
  );
};

/** The two choices of "Revert Specific Rains". */
const PolicyPicker: React.FC<{ value: RevertPolicy; onChange: (p: RevertPolicy) => void; userRain: boolean }> = ({ value, onChange, userRain }) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px', marginTop: '8px' }}>
    {userRain && (
      <div className="form-group">
        <label>For user rains</label>
        <select className="form-control" value={value.payerRefund} onChange={(e) => onChange({ ...value, payerRefund: e.target.value as RevertPolicy['payerRefund'] })}>
          <option value="REFUND">Refund user to the person raining (fee not included)</option>
          <option value="NONE">Do nothing</option>
        </select>
      </div>
    )}
    <div className="form-group">
      <label>Users who do not have funds for refund</label>
      <select className="form-control" value={value.shortfall} onChange={(e) => onChange({ ...value, shortfall: e.target.value as RevertPolicy['shortfall'] })}>
        <option value="ZERO">Refund till 0</option>
        <option value="NEGATIVE">Negative balance</option>
      </select>
    </div>
  </div>
);

const RunRow: React.FC<{
  r: RainRun;
  onDetails: () => void;
  actions: React.ReactNode;
}> = ({ r, onDetails, actions }) => (
  <tr>
    <td>{when(r.createdAt)}</td>
    <td>{r.kind === 'SYSTEM' ? 'Rainpool' : 'User'}</td>
    <td>{r.username ? `@${r.username}` : r.kind === 'SYSTEM' ? 'System' : '—'}</td>
    <td>{r.roomName ?? '—'}</td>
    <td>
      {r.pot} {r.currency}
      <div style={{ fontSize: '12px', opacity: 0.6 }}>
        {r.usd ? `~${r.usd} USD` : ''}
        {r.fee !== '0' ? ` · fee ${r.fee}` : ''}
      </div>
    </td>
    <td>
      {r.recipients}
      {r.recipientRule && <div style={{ fontSize: '12px', opacity: 0.6 }}>asked: {ruleText(r.recipientRule)}</div>}
    </td>
    <td>
      <Pill value={r.status} />
      {r.security?.tier ? (
        <div style={{ fontSize: '12px', opacity: 0.7 }}>
          rule {r.security.tier}: {(r.security.reasons ?? []).map((x) => REASON_TEXT[x] ?? x).join(', ')}
          {r.security.stage === 'ADMIN_REQUEST' ? ' · asked by admin' : ''}
        </div>
      ) : null}
      {r.reverseReason && <div style={{ fontSize: '12px', opacity: 0.7 }}>{r.reverseReason}</div>}
    </td>
    <td style={{ whiteSpace: 'nowrap' }}>
      <button className="btn-secondary" onClick={onDetails}>Details</button> {actions}
    </td>
  </tr>
);

const RunHead = () => (
  <thead>
    <tr><th>When</th><th>Type</th><th>By</th><th>Room</th><th>Amount</th><th>People</th><th>Status</th><th /></tr>
  </thead>
);

const ReviewTab: React.FC<{ onShowToast: Props['onShowToast'] }> = ({ onShowToast }) => {
  const [filter, setFilter] = useState<RainFilter>({});
  const [runs, setRuns] = useState<RainRun[]>([]);
  const [queue, setQueue] = useState<{ pendingReview: RainRun[]; waitingForUser: RainRun[] }>({ pendingReview: [], waitingForUser: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<RainDetail | null>(null);
  const [reverting, setReverting] = useState<RainRun | null>(null);

  const search = async (f: RainFilter = filter) => {
    setLoading(true);
    try {
      const [list, reviews] = await Promise.all([RainAPI.rains(f), RainAPI.reviews()]);
      setRuns(list.rains);
      setQueue(reviews);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load rains');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void search({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async (id: string) => {
    try {
      setDetail(await RainAPI.detail(id));
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : 'Could not load the rain', 'danger');
    }
  };

  const review = async (run: RainRun, decision: 'APPROVE' | 'REJECT' | 'QUESTIONNAIRE' | 'KYC') => {
    const label = { APPROVE: 'Approve and pay', REJECT: 'Reject', QUESTIONNAIRE: 'Ask the payer for the questionnaire', KYC: 'Ask the payer for a KYC check' }[decision];
    const reason = window.prompt(`${label}. Note (optional):`, '');
    if (reason === null) return;
    const note = reason.trim() || undefined;
    const res =
      decision === 'APPROVE'
        ? await RainAPI.approve(run.id, note)
        : decision === 'REJECT'
          ? await RainAPI.reject(run.id, note)
          : await RainAPI.requestVerification(run.id, decision === 'QUESTIONNAIRE', decision === 'KYC', note);
    if (res.success) {
      onShowToast(
        decision === 'QUESTIONNAIRE' || decision === 'KYC'
          ? 'Sent to the payer; the rain comes back here when they answer'
          : `${decision === 'APPROVE' ? 'Approval' : 'Rejection'} queued; the chat server applies it within ~15 seconds`,
      );
    } else onShowToast(writeError(res as any), 'danger');
    void search();
  };

  const reviewActions = (r: RainRun) => (
    <>
      <button className="btn-action" onClick={() => review(r, 'APPROVE')}>Approve</button>{' '}
      <button className="btn-danger" onClick={() => review(r, 'REJECT')}>Reject</button>{' '}
      <button className="btn-secondary" onClick={() => review(r, 'QUESTIONNAIRE')}>Questionnaire</button>{' '}
      <button className="btn-secondary" onClick={() => review(r, 'KYC')}>KYC check</button>
    </>
  );

  return (
    <>
      <h4 style={{ marginTop: '16px' }}>MANUAL admin verification ({queue.pendingReview.length})</h4>
      <Hint>User rains from a VPN / proxy (or above its amount) after the user's codes. Nothing is debited until you approve.</Hint>
      <div className="table-responsive" style={{ marginTop: '8px' }}>
        <table className="admin-table">
          <RunHead />
          <tbody>
            {queue.pendingReview.map((r) => <RunRow key={r.id} r={r} onDetails={() => open(r.id)} actions={reviewActions(r)} />)}
            {queue.pendingReview.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', opacity: 0.6 }}>Nothing waiting.</td></tr>}
          </tbody>
        </table>
      </div>
      {queue.waitingForUser.length > 0 && (
        <>
          <h4 style={{ marginTop: '16px' }}>Sent back to the user ({queue.waitingForUser.length})</h4>
          <div className="table-responsive">
            <table className="admin-table">
              <RunHead />
              <tbody>
                {queue.waitingForUser.map((r) => (
                  <RunRow key={r.id} r={r} onDetails={() => open(r.id)} actions={<span style={{ fontSize: '12px', opacity: 0.7 }}>until {when(r.verifyExpiresAt)}</span>} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h4 style={{ marginTop: '24px' }}>All rains</h4>
      <FilterBar filter={filter} onChange={setFilter} />
      <div style={{ display: 'flex', gap: '8px' }}>
        <button className="btn-action" onClick={() => search()} disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
        <button className="btn-secondary" onClick={() => { setFilter({}); void search({}); }}>Clear</button>
      </div>
      {error && <p style={{ color: '#f87171', marginTop: '8px' }}>{error}</p>}
      <div className="table-responsive" style={{ marginTop: '12px' }}>
        <table className="admin-table">
          <RunHead />
          <tbody>
            {runs.map((r) => (
              <RunRow
                key={r.id}
                r={r}
                onDetails={() => open(r.id)}
                actions={
                  r.status === 'PENDING_REVIEW'
                    ? reviewActions(r)
                    : r.status === 'COMPLETED' || r.status === 'PARTIALLY_REVERSED'
                      ? <button className="btn-danger" onClick={() => setReverting(r)}>Revert</button>
                      : null
                }
              />
            ))}
            {!loading && runs.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', opacity: 0.6 }}>No rains match.</td></tr>}
          </tbody>
        </table>
      </div>
      {reverting && (
        <RevertDialog
          run={reverting}
          onClose={() => setReverting(null)}
          onDone={(msg, ok) => {
            onShowToast(msg, ok ? 'success' : 'danger');
            if (ok) {
              setReverting(null);
              void search();
            }
          }}
        />
      )}
      {detail && <DetailPanel detail={detail} onClose={() => setDetail(null)} />}
    </>
  );
};

const RevertDialog: React.FC<{ run: RainRun; onClose: () => void; onDone: (msg: string, ok: boolean) => void }> = ({ run, onClose, onDone }) => {
  const [policy, setPolicy] = useState<RevertPolicy>({ payerRefund: 'REFUND', shortfall: 'ZERO' });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (reason.trim().length < 3) return onDone('Give a reason for the audit trail', false);
    setBusy(true);
    try {
      const res = await RainAPI.revert(run.id, reason.trim(), policy);
      onDone(res.success ? 'Reversal queued; the result shows in Jobs & Audit' : writeError(res as any), res.success);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog" style={{ maxWidth: '520px', width: '92%' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ padding: '16px 20px' }}>
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 700 }}>
            Revert {run.pot} {run.currency} ({run.kind === 'SYSTEM' ? 'Rainpool' : `by @${run.username ?? '?'}`})
          </h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body" style={{ padding: '4px 20px 18px' }}>
          <Hint>Every remaining share is taken back. The original rain and its ledger rows are kept; the reversal adds compensating entries.</Hint>
          <PolicyPicker value={policy} onChange={setPolicy} userRain={run.kind === 'USER'} />
          <input
            className="form-control"
            style={{ marginTop: '8px' }}
            placeholder="Reason (required, at least 3 characters)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        </div>
        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-danger" disabled={busy} onClick={submit}>{busy ? 'Queuing…' : 'Revert'}</button>
        </div>
      </div>
    </div>
  );
};

const DetailPanel: React.FC<{ detail: RainDetail; onClose: () => void }> = ({ detail, onClose }) => {
  const r = detail.rain;
  const reversals = Array.isArray(r.reverseDetail) ? (r.reverseDetail as Record<string, any>[]) : [];
  const rewards = r.rewards as { done?: { exp: number; stars: number; awarded: boolean }; received?: { exp: number; stars: number; awarded: number; total: number } } | null;
  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h4>Rain {r.id.slice(0, 8)} · {r.kind === 'SYSTEM' ? 'Rainpool' : 'User'} · <Pill value={r.status} /></h4>
        <button className="btn-secondary" onClick={onClose}>Close</button>
      </div>
      <p style={{ fontSize: '13px', marginTop: '6px' }}>
        {r.pot} {r.currency}{r.usd ? ` (~${r.usd} USD)` : ''} · fee {r.fee} · distributed {r.distributed} in {r.roomName ?? r.roomId} · {when(r.createdAt)}
        {r.username && <> · by @{r.username}</>}
        {r.repeat && <> · repeat {r.repeat.count}×</>}
      </p>
      {reversals.map((x, i) => (
        <p key={i} style={{ fontSize: '12px', opacity: 0.8 }}>
          Reversal {when(x.at)}: {x.recipients} recipient(s), {x.reclaimed} {r.currency} taken back to the {x.creditedTo === 'PAYER' ? 'payer' : 'platform'}
          {x.missing && x.missing !== '0' ? `, ${x.missing} not recovered` : ''} · {x.shortfall === 'NEGATIVE' ? 'negative balance' : 'refund till 0'}
        </p>
      ))}
      {rewards?.done && (
        <p style={{ fontSize: '12px', opacity: 0.8 }}>
          Rewards: done {rewards.done.exp} EXP / {rewards.done.stars} Stars ({rewards.done.awarded ? 'awarded' : 'not awarded'})
          {rewards.received && <>, received {rewards.received.exp} EXP / {rewards.received.stars} Stars to {rewards.received.awarded}/{rewards.received.total}</>}
        </p>
      )}
      {r.security && (
        <p style={{ fontSize: '12px', opacity: 0.8 }}>
          Security: rule {r.security.tier} ({(r.security.reasons ?? []).map((x) => REASON_TEXT[x] ?? x).join(', ')}), stage {r.security.stage}
          {r.security.kycLevel ? `, KYC level ${r.security.kycLevel}` : ''}
          {r.security.questions?.length ? `, ${r.security.questions.length} question(s)` : ''}
          {r.security.verifiedAt ? `, verified ${when(r.security.verifiedAt)}` : ''}
        </p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginTop: '12px' }}>
        <div>
          <h5>Recipients ({detail.recipients.length})</h5>
          <table className="admin-table"><tbody>
            {detail.recipients.map((p) => (
              <tr key={p.userId}>
                <td>@{p.username ?? p.userId.slice(0, 8)}</td>
                <td>{p.amount}</td>
                <td>{p.tier}</td>
                <td style={{ fontSize: '11px' }}>{p.reversedAt ? `reverted (${p.reclaimed ?? '0'})` : ''}</td>
              </tr>
            ))}
            {detail.recipients.length === 0 && <tr><td style={{ opacity: 0.6 }}>None chosen yet.</td></tr>}
          </tbody></table>
        </div>
        <div>
          <h5>Audit</h5>
          <table className="admin-table"><tbody>
            {detail.audit.map((a) => <tr key={a.id}><td style={{ fontSize: '11px' }}>{when(a.createdAt)}</td><td>{a.action}</td><td>{a.actorType}</td></tr>)}
            {detail.audit.length === 0 && <tr><td style={{ opacity: 0.6 }}>Nothing yet.</td></tr>}
          </tbody></table>
        </div>
      </div>
    </div>
  );
};

// ─── Revert rains (bulk) ─────────────────────────────────────────────────────

const BulkTab: React.FC<{ onShowToast: Props['onShowToast'] }> = ({ onShowToast }) => {
  const [kind, setKind] = useState<BulkRevertInput['kind']>('ALL');
  const [from, setFrom] = useState<string | undefined>();
  const [to, setTo] = useState<string | undefined>();
  const [coins, setCoins] = useState('');
  const [whoOn, setWhoOn] = useState(false);
  const [role, setRole] = useState<'RAINER' | 'RECIPIENT'>('RECIPIENT');
  const [users, setUsers] = useState('');
  const [group, setGroup] = useState<'' | 'PREMIUM' | 'KYC' | 'LEVEL'>('');
  const [level, setLevel] = useState('50');
  const [reason, setReason] = useState('');
  const [policy, setPolicy] = useState<RevertPolicy>({ payerRefund: 'REFUND', shortfall: 'ZERO' });
  const [preview, setPreview] = useState<{ rains: number; potByCurrency: Record<string, string>; groupCheckedLater: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const input = (dryRun: boolean): BulkRevertInput => ({
    kind,
    from: from ?? null,
    to: to ?? null,
    currencies: codes(coins),
    who: whoOn
      ? {
          role,
          users: users.split(/[\s,]+/).map((u) => u.trim().replace(/^@/, '')).filter(Boolean),
          group: group ? { targetType: group, value: group === 'LEVEL' ? level : '' } : null,
        }
      : null,
    ...policy,
    ...(reason.trim() ? { reason: reason.trim() } : {}),
    dryRun,
  });

  const run = async (dryRun: boolean) => {
    if (reason.trim().length < 3) return onShowToast('Give a reason for the audit trail', 'danger');
    if (!dryRun && !window.confirm(`Queue a reversal of ${preview?.rains ?? 'the matching'} rain(s)? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const res = await RainAPI.bulkRevert(input(dryRun));
      if (!res.success) return onShowToast(writeError(res as any), 'danger');
      if (dryRun) setPreview({ rains: res.rains, potByCurrency: res.potByCurrency, groupCheckedLater: res.groupCheckedLater });
      else {
        setPreview(null);
        onShowToast('Bulk reversal queued; its progress shows in Jobs & Audit.');
      }
    } finally {
      setBusy(false);
    }
  };

  const changed = () => setPreview(null);

  return (
    <div style={{ marginTop: '8px' }}>
      <Hint>
        "Revert Specific Rains [all system / user rains] [specific time frame] [specific coins] [specific users / group of users]". Only paid rains match.
        Preview first: it counts the rains and sums the pots per coin without changing anything.
      </Hint>
      <div style={grid}>
        <div className="form-group">
          <label>Rains</label>
          <select className="form-control" value={kind} onChange={(e) => { setKind(e.target.value as BulkRevertInput['kind']); changed(); }}>
            <option value="ALL">All (Rainpool and user)</option>
            <option value="SYSTEM">Rainpool rains</option>
            <option value="USER">User rains</option>
          </select>
        </div>
        <div className="form-group"><label>From</label><input className="form-control" type="datetime-local" onChange={(e) => { setFrom(toIso(e.target.value)); changed(); }} /></div>
        <div className="form-group"><label>To</label><input className="form-control" type="datetime-local" onChange={(e) => { setTo(toIso(e.target.value)); changed(); }} /></div>
        <TextField label="Coins (empty = all)" value={coins} placeholder="BTC, ETH" onChange={(v) => { setCoins(v); changed(); }} />
      </div>
      <div style={card}>
        <Toggle label="Only for specific users / a group of users" checked={whoOn} onChange={(v) => { setWhoOn(v); changed(); }} />
        {whoOn && (
          <div style={grid}>
            <div className="form-group">
              <label>Those users as</label>
              <select className="form-control" value={role} onChange={(e) => { setRole(e.target.value as 'RAINER' | 'RECIPIENT'); changed(); }}>
                <option value="RECIPIENT">Recipients (take back only what they received)</option>
                <option value="RAINER">Rainers (revert their user rains in full)</option>
              </select>
            </div>
            <TextField label="Users (username, id or code)" value={users} placeholder="bob, alice" onChange={(v) => { setUsers(v); changed(); }} />
            <div className="form-group">
              <label>Or a group</label>
              <select className="form-control" value={group} onChange={(e) => { setGroup(e.target.value as typeof group); changed(); }}>
                <option value="">No group</option>
                <option value="PREMIUM">Premium users</option>
                <option value="KYC">KYC verified users</option>
                <option value="LEVEL">Level at least…</option>
              </select>
            </div>
            {group === 'LEVEL' && <TextField label="Minimum level" value={level} onChange={(v) => { setLevel(v); changed(); }} />}
          </div>
        )}
      </div>
      <PolicyPicker value={policy} onChange={setPolicy} userRain={kind !== 'SYSTEM'} />
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' }}>
        <input className="form-control" style={{ maxWidth: '360px' }} placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn-secondary" disabled={busy} onClick={() => run(true)}>Preview</button>
        <button className="btn-danger" disabled={busy || !preview || preview.rains === 0} onClick={() => run(false)}>Revert matches</button>
      </div>
      {preview && (
        <p style={{ marginTop: '12px', fontSize: '14px' }}>
          {preview.rains} paid rain(s) match
          {Object.keys(preview.potByCurrency).length ? `: ${Object.entries(preview.potByCurrency).map(([c, p]) => `${p} ${c}`).join(', ')}` : '.'}
          {preview.groupCheckedLater && ' The group is checked per person when the reversal runs, so fewer may be reverted.'}
        </p>
      )}
    </div>
  );
};

// ─── Auto-repeat ─────────────────────────────────────────────────────────────

const RepeatsTab: React.FC<{ onShowToast: Props['onShowToast'] }> = ({ onShowToast }) => {
  const [status, setStatus] = useState('SCHEDULED');
  const [user, setUser] = useState('');
  const [rows, setRows] = useState<RainRepeat[]>([]);
  const load = async () => {
    try {
      setRows((await RainAPI.repeats(status || undefined, user.trim() || undefined)).repeats);
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : 'Could not load auto-repeats', 'danger');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const cancel = async (r: RainRepeat) => {
    const reason = window.prompt(`Stop the rest of @${r.username ?? '?'}'s ${r.pot} ${r.currency} series? Reason (optional):`, '');
    if (reason === null) return;
    const res = await RainAPI.cancelRepeat(r.id, reason.trim() || undefined);
    if (res.success) onShowToast('Series stopped');
    else onShowToast(writeError(res as any), 'danger');
    void load();
  };
  return (
    <>
      <div style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap' }}>
        <select className="form-control" style={{ maxWidth: '180px' }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {['SCHEDULED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input className="form-control" style={{ maxWidth: '220px' }} placeholder="User" value={user} onChange={(e) => setUser(e.target.value)} />
        <button className="btn-secondary" onClick={() => load()}>Search</button>
      </div>
      <div className="table-responsive" style={{ marginTop: '12px' }}>
        <table className="admin-table">
          <thead><tr><th>User</th><th>Pot</th><th>Users</th><th>Left</th><th>Gap</th><th>Next</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>@{r.username ?? r.userId.slice(0, 8)}</td>
                <td>{r.pot} {r.currency}</td>
                <td>{ruleText(r.recipients)}</td>
                <td>{r.remaining}</td>
                <td>{r.gapSeconds}s</td>
                <td>{when(r.nextRunAt)}</td>
                <td><Pill value={r.status} /></td>
                <td>{r.status === 'SCHEDULED' && <button className="btn-danger" onClick={() => cancel(r)}>Stop</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} style={{ textAlign: 'center', opacity: 0.6 }}>No series.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
};

// ─── Jobs & audit ────────────────────────────────────────────────────────────

const LogTab: React.FC<{ onShowToast: Props['onShowToast'] }> = ({ onShowToast }) => {
  const [jobs, setJobs] = useState<RainJob[]>([]);
  const [audit, setAudit] = useState<RainAudit[]>([]);
  const load = async () => {
    try {
      const [j, a] = await Promise.all([RainAPI.jobs(), RainAPI.audit()]);
      setJobs(j.jobs);
      setAudit(a.entries);
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : 'Could not load the log', 'danger');
    }
  };
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <h4 style={{ marginTop: '16px' }}>Queued actions</h4>
      <div className="table-responsive">
        <table className="admin-table">
          <thead><tr><th>Queued</th><th>Action</th><th>Rain</th><th>Status</th><th>Note</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{when(j.createdAt)}</td>
                <td>
                  {j.kind === 'REVERT' && !j.rainId ? 'REVERT (bulk)' : j.kind}
                  {j.kind === 'REVERT' && (
                    <div style={{ fontSize: '11px', opacity: 0.7 }}>
                      {j.payerRefund === 'REFUND' ? 'refund payer' : 'do nothing'} · {j.shortfall === 'ZERO' ? 'till 0' : 'negative'}
                    </div>
                  )}
                  {j.progress && (
                    <div style={{ fontSize: '11px', opacity: 0.7 }}>
                      {j.progress.reverted ?? 0} reverted · {j.progress.skipped ?? 0} skipped · {j.progress.failed ?? 0} failed of {j.progress.matched ?? 0}
                    </div>
                  )}
                </td>
                <td>{j.rainId ? j.rainId.slice(0, 8) : '—'}</td>
                <td><Pill value={j.status} /></td>
                <td style={{ fontSize: '12px' }}>{j.error ?? j.reason ?? ''}</td>
              </tr>
            ))}
            {jobs.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', opacity: 0.6 }}>Nothing queued yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <h4 style={{ marginTop: '24px' }}>Audit trail</h4>
      <div className="table-responsive">
        <table className="admin-table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Rain</th><th>Reason</th></tr></thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td>{when(a.createdAt)}</td>
                <td>{a.actorType}{a.actorId && <span style={{ fontSize: '11px', opacity: 0.6 }}> {a.actorId.slice(0, 8)}</span>}</td>
                <td>{a.action}</td>
                <td>{a.rainId ? a.rainId.slice(0, 8) : '—'}</td>
                <td style={{ fontSize: '12px' }}>{a.reason ?? ''}</td>
              </tr>
            ))}
            {audit.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', opacity: 0.6 }}>No entries yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
};

// ─── Development USD rates ───────────────────────────────────────────────────

const PricesTab: React.FC<{ onShowToast: Props['onShowToast'] }> = ({ onShowToast }) => {
  const [rows, setRows] = useState<{ currency: string; usdPrice: string }[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [development, setDevelopment] = useState(true);
  const load = async () => {
    try {
      const data = await RainAPI.devPrices();
      setRows(data.prices.map((p) => ({ currency: p.currency, usdPrice: p.usdPrice })));
      setSaved(data.prices.map((p) => p.currency));
      setDevelopment(data.development);
    } catch (err) {
      onShowToast(err instanceof Error ? err.message : 'Could not load the rates', 'danger');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const save = async () => {
    const kept = rows.filter((r) => r.currency.trim());
    const removed = saved.filter((c) => !kept.some((r) => r.currency.toUpperCase() === c));
    const prices = [...kept.map((r) => ({ currency: r.currency, usdPrice: r.usdPrice.trim() })), ...removed.map((c) => ({ currency: c, usdPrice: null }))];
    if (prices.length === 0) return;
    const res = await RainAPI.setDevPrices(prices);
    if (res.success) {
      onShowToast('USD rates saved');
      void load();
    } else onShowToast(writeError(res as any), 'danger');
  };
  return (
    <div style={{ marginTop: '16px' }}>
      <Hint>
        The RainPool settings are in USD. Until the price module is connected, the chat server converts with these rates in development
        (RAIN_DEV_WALLET). Production ignores them and refuses USD rules.
      </Hint>
      {!development && <p style={{ color: '#f87171', fontSize: '13px' }}>This is production: the rates cannot be changed here.</p>}
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '120px 200px auto', gap: '8px', marginTop: '6px' }}>
          <input className="form-control" placeholder="BTC" value={row.currency} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, currency: e.target.value.toUpperCase() } : r)))} />
          <input className="form-control" placeholder="USD for 1 unit" value={row.usdPrice} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, usdPrice: e.target.value } : r)))} />
          <button type="button" className="btn-secondary" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
        <button type="button" className="btn-secondary" onClick={() => setRows([...rows, { currency: '', usdPrice: '' }])}>Add currency</button>
        <button type="button" className="btn-action" disabled={!development} onClick={save}>Save rates</button>
      </div>
    </div>
  );
};
