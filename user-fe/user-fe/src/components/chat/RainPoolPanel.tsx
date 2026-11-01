'use client';

/**
 * RainPool for users (Modules 6–7): when the next Rainpool rain falls (its pot counting up), how to start a User Rain
 * with /rain and its limits, recent rains, and the rains I sent, received or set to repeat. Refreshes when a rain
 * event arrives (`refreshKey`).
 */
import React, { useEffect, useState } from 'react';
import { CloudRain, Loader2, X } from 'lucide-react';
import * as rainApi from '@/lib/api/rain';
import type { MyRains, RainHistoryItem, RainLimits, RainResult, RainState } from '@/lib/api/rain';

type Tab = 'about' | 'recent' | 'mine';

interface Props {
  refreshKey: number;
  roomName: (roomId: string) => string;
  /** Opens the verification of a rain still waiting for me. */
  onContinue: (pending: RainResult) => void;
  onClose: () => void;
}

const when = (iso: string) => new Date(iso).toLocaleString();

export function rainCountdown(nextRainAt: string | null, now: number): string | null {
  if (!nextRainAt) return null;
  const left = Math.max(0, Math.round((new Date(nextRainAt).getTime() - now) / 1000));
  if (left === 0) return 'any moment';
  const m = Math.floor(left / 60);
  const s = left % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

const switchText = (status: string) =>
  status === 'ON' ? 'On' : status === 'MAINTENANCE' ? 'In maintenance' : 'Off';
const switchColor = (status: string) =>
  status === 'ON' ? 'var(--color-success)' : status === 'MAINTENANCE' ? '#fbbf24' : 'var(--text-muted)';
const gap = (s: number) => (s >= 3600 && s % 3600 === 0 ? `${s / 3600}h` : s >= 60 && s % 60 === 0 ? `${s / 60}m` : `${s}s`);

export default function RainPoolPanel({ refreshKey, roomName, onContinue, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('about');
  const [state, setState] = useState<RainState | null>(null);
  const [recent, setRecent] = useState<RainHistoryItem[] | null>(null);
  const [mine, setMine] = useState<MyRains | null>(null);
  const [pending, setPending] = useState<RainResult[]>([]);
  const [limits, setLimits] = useState<RainLimits[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [s, r, m, p] = await Promise.all([
          rainApi.getRainState(),
          rainApi.getRainHistory(30),
          rainApi.getMyRains(30),
          rainApi.getPendingRains().catch(() => [] as RainResult[]),
        ]);
        if (!live) return;
        setState(s);
        setRecent(r);
        setMine(m);
        setPending(p);
        setError(null);
        // The per-currency limits in that currency (converted from USD when set "same for all currencies").
        const codes = s.user.currencies.all ? s.system.currencies : s.user.currencies.codes;
        const l = await Promise.all(codes.slice(0, 8).map((c) => rainApi.getRainLimits(c).catch(() => null)));
        if (live) setLimits(l.filter((x): x is RainLimits => x !== null && x.min !== null));
      } catch (e: unknown) {
        if (live) setError(e instanceof Error ? e.message : 'Could not load RainPool');
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [refreshKey, reload]);

  const stopRepeat = async (id: string) => {
    if (!window.confirm('Stop the rest of this auto-repeat? Rains already paid stay paid.')) return;
    try {
      await rainApi.cancelRepeat(id);
      setReload((k) => k + 1);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not stop the repeat');
    }
  };

  const countdown = state ? rainCountdown(state.system.nextRainAt, now) : null;
  const tabButton = (id: Tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`btn btn-sm ${tab === id ? 'btn-primary' : 'btn-outline'}`}
      style={{ flex: 1 }}
    >
      {label}
    </button>
  );
  const forms = (s: RainState) =>
    s.user.recipients.modes
      .map((m) => (m === 'SPECIFIC' ? `${s.user.recipients.min}` : m === 'ALL' ? 'all' : '10%'))
      .join(' / ');
  const r = state?.rewards;
  const anyReward = r && [r.perRainDone.exp, r.perRainDone.stars, r.perRainReceived.exp, r.perRainReceived.stars].some((x) => x.amount > 0);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="gift-modal" id="rainpool-panel" style={{ width: 'min(520px, calc(100vw - 32px))', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="gift-modal-header">
          <div className="gift-modal-icon" style={{ background: 'rgba(56,189,248,0.12)', color: '#38bdf8' }}>
            <CloudRain size={20} />
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-main)' }}>RainPool</p>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '1px' }}>
              {!state
                ? 'Loading…'
                : state.system.status !== 'ON'
                  ? `Rainpool is ${switchText(state.system.status).toLowerCase()}`
                  : countdown
                    ? `Next rain in ${countdown}`
                    : 'The next rain is being scheduled'}
            </p>
          </div>
          <button className="dm-header-action-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: '0.4rem', padding: '0 1.25rem' }}>
          {tabButton('about', 'Rain')}
          {tabButton('recent', 'Recent')}
          {tabButton('mine', 'Mine')}
        </div>

        <div className="gift-modal-body" style={{ overflowY: 'auto' }}>
          {error && <p style={{ fontSize: '0.8rem', color: 'var(--color-danger)' }}>{error}</p>}
          {!state && !error && (
            <div style={{ textAlign: 'center', padding: '1rem' }}>
              <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
            </div>
          )}

          {state && tab === 'about' && (
            <>
              {state.status.note && (state.system.status === 'MAINTENANCE' || state.user.status === 'MAINTENANCE') && (
                <div style={{ fontSize: '0.78rem', color: '#fbbf24' }}>{state.status.note}</div>
              )}
              <Row label="Rainpool" value={switchText(state.system.status)} color={switchColor(state.system.status)}>
                {state.system.status === 'ON' && (
                  <>
                    {state.system.nextPot && <PotFilling system={state.system} now={now} />}
                    A random {state.system.currencies.join(' / ') || 'currency'} amount worth {state.system.amountUsd.min}–{state.system.amountUsd.max} USD
                    falls on people online in {roomName(state.system.roomId)}.
                  </>
                )}
              </Row>
              <Row label="User Rain" value={switchText(state.user.status)} color={switchColor(state.user.status)}>
                {state.user.status === 'ON' ? (
                  <>
                    Type <code>/rain CURRENCY AMOUNT USERS</code> in a chat room: USERS is {forms(state)}. e.g.{' '}
                    <code>/rain {limits[0]?.currency ?? 'BTC'} {limits[0]?.min ?? '0.01'} {state.user.recipients.modes.includes('ALL') ? 'all' : state.user.recipients.min}</code>.
                    The amount is the whole pot: a {state.user.feePercent}% fee is taken and the rest is shared among {state.user.recipients.min}–
                    {state.user.recipients.max} people online in that room. It never lands on people you muted or blocked, or who muted or blocked you.
                    {state.user.autoRepeat.enabled && (
                      <>
                        {' '}
                        Add <code>repeat COUNT GAP</code> (e.g. <code>repeat 3 5m</code>) to repeat it {state.user.autoRepeat.minCount}–{state.user.autoRepeat.maxCount} times,{' '}
                        {gap(state.user.autoRepeat.minGapSeconds)}–{gap(state.user.autoRepeat.maxGapSeconds)} apart (each repeat is charged when it runs).
                      </>
                    )}
                    {!state.user.channels.all && <> Only in rooms the admins chose.</>}
                  </>
                ) : state.user.status === 'MAINTENANCE' ? (
                  <>/rain is paused for maintenance. Try again later.</>
                ) : (
                  <>/rain is switched off.</>
                )}
              </Row>
              {state.user.status === 'ON' && limits.length > 0 && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Limits per rain: {limits.map((l) => `${l.min}–${l.max} ${l.currency}`).join(' · ')}
                </div>
              )}
              {r && anyReward && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Rewards: raining earns {rainApi.rewardText(r.perRainDone.exp)} EXP / {rainApi.rewardText(r.perRainDone.stars)} Stars; catching a rain earns{' '}
                  {rainApi.rewardText(r.perRainReceived.exp)} EXP / {rainApi.rewardText(r.perRainReceived.stars)} Stars.
                </div>
              )}
              {!state.walletConnected && (
                <div style={{ fontSize: '0.75rem', color: '#fbbf24' }}>Rain cannot move money right now: the wallet is not connected.</div>
              )}
            </>
          )}

          {state && tab === 'recent' && (
            <List
              empty="No rains yet."
              items={(recent ?? []).map((item) => ({
                key: item.id,
                title: `${item.pot} ${item.currency}${item.usd ? ` (~${item.usd} USD)` : ''} → ${item.recipients} people`,
                sub: `${item.kind === 'SYSTEM' ? 'Rainpool' : `@${item.initiator ?? 'someone'}`} · ${roomName(item.roomId)} · ${when(item.createdAt)}`,
                badge: item.status === 'REVERSED' ? 'reversed' : item.status === 'PARTIALLY_REVERSED' ? 'partly reversed' : null,
              }))}
            />
          )}

          {state && tab === 'mine' && mine && (
            <>
              {pending.map((p) => (
                <div
                  key={p.rainId}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.6rem', borderRadius: '8px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)' }}
                >
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-main)' }}>
                    {p.pot} {p.currency} → {p.recipients} people
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {p.verification?.stage === 'ADMIN_REQUEST' ? 'An admin asked you for more' : 'Waiting for your confirmation'}
                    </div>
                  </div>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => onContinue(p)}>Continue</button>
                </div>
              ))}
              {mine.repeats.length > 0 && (
                <>
                  <p style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-main)' }}>Auto-repeat</p>
                  {mine.repeats.map((rep) => (
                    <div key={rep.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', padding: '0.45rem 0.6rem', borderRadius: '8px', background: 'var(--bg-input)' }}>
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-main)' }}>
                        {rep.pot} {rep.currency} · {rep.remaining} left, every {gap(rep.gapSeconds)}
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>next {when(rep.nextRunAt)}</div>
                      </div>
                      <button type="button" className="btn btn-sm btn-outline" onClick={() => void stopRepeat(rep.id)}>Stop</button>
                    </div>
                  ))}
                </>
              )}
              {mine.balances.length > 0 && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Test balances (development wallet): {mine.balances.map((b) => `${b.balance} ${b.currency}`).join(' · ')}
                </div>
              )}
              <p style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-main)' }}>Received</p>
              <List
                empty="You have not caught a rain yet."
                items={mine.received.map((item) => ({
                  key: item.rainId,
                  title: `+${item.amount} ${item.currency}`,
                  sub: `${item.kind === 'SYSTEM' ? 'Rainpool' : `from @${item.from ?? 'someone'}`} · ${when(item.createdAt)}`,
                  badge: item.reversed ? 'reversed' : null,
                }))}
              />
              <p style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-main)', marginTop: '0.5rem' }}>Sent</p>
              <List
                empty="You have not started a rain yet."
                items={mine.sent.map((item) => ({
                  key: item.id,
                  title: `${item.pot} ${item.currency} → ${item.recipients} people`,
                  sub: `${roomName(item.roomId)} · ${when(item.createdAt)}${item.fee !== '0' ? ` · fee ${item.fee}` : ''}`,
                  badge: item.status === 'COMPLETED' ? null : item.status.replace(/_/g, ' ').toLowerCase(),
                }))}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** "The randomly selected amount will show filling with time (count up) till the rain time." */
function PotFilling({ system, now }: { system: RainState['system']; now: number }) {
  const shown = rainApi.rainCountUp(system, now);
  const end = system.nextRainAt ? new Date(system.nextRainAt).getTime() : now;
  const start = system.scheduledAt ? new Date(system.scheduledAt).getTime() : end;
  const progress = end <= start ? 1 : Math.min(1, Math.max(0, (now - start) / (end - start)));
  return (
    <div style={{ margin: '0.2rem 0 0.45rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 700, color: '#38bdf8' }}>
        <span>{shown} {system.nextCurrency}</span>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 400 }}>
          of {system.nextPot}{system.nextPotUsd ? ` (~${system.nextPotUsd} USD)` : ''}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--border-color)', overflow: 'hidden', marginTop: '0.3rem' }}>
        <div style={{ width: `${(progress * 100).toFixed(1)}%`, height: '100%', background: 'linear-gradient(90deg, #38bdf8, #6366f1)', transition: 'width 1s linear' }} />
      </div>
    </div>
  );
}

function Row({ label, value, color, children }: { label: string; value: string; color: string; children?: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: '9px', padding: '0.65rem 0.85rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-main)' }}>
        <span>{label}</span>
        <span style={{ color }}>{value}</span>
      </div>
      {children && <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '0.3rem', lineHeight: 1.45 }}>{children}</div>}
    </div>
  );
}

function List({ items, empty }: { items: { key: string; title: string; sub: string; badge: string | null }[]; empty: string }) {
  if (items.length === 0) return <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{empty}</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      {items.map((item) => (
        <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.45rem 0.6rem', borderRadius: '8px', background: 'var(--bg-input)' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-main)', fontWeight: 600 }}>{item.title}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{item.sub}</div>
          </div>
          {item.badge && <span style={{ fontSize: '0.68rem', color: '#fbbf24', whiteSpace: 'nowrap' }}>{item.badge}</span>}
        </div>
      ))}
    </div>
  );
}
