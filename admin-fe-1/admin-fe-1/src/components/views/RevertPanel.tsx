import React, { useState } from 'react';
import { ModulesAPI } from '../../services/modulesApi';

/**
 * Chat SETTINGS "MODERATION Actions": "Revert ALL Advertisements / Transfers for a Specific Time Frame [for specific
 * users / group of users] [for specific Currencies] [for a specific amount range]". A dry run first shows how many
 * would be reverted; the real run asks for confirmation.
 */
interface Props {
  kind: 'ads' | 'gifts';
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
  onDone: () => void;
}

const toIso = (local: string) => (local ? new Date(local).toISOString() : '');
const split = (text: string) => text.split(/[\s,]+/).map((t) => t.trim().replace(/^@/, '')).filter(Boolean);

export const RevertPanel: React.FC<Props> = ({ kind, onShowToast, onDone }) => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [users, setUsers] = useState('');
  const [minUsd, setMinUsd] = useState('');
  const [maxUsd, setMaxUsd] = useState('');
  const [currencies, setCurrencies] = useState('');
  const [adIds, setAdIds] = useState('');
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [refundFees, setRefundFees] = useState(false);
  const [note, setNote] = useState('');
  const [group, setGroup] = useState<'' | 'PREMIUM' | 'KYC' | 'LEVEL'>('');
  const [groupLevel, setGroupLevel] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (dryRun: boolean) => {
    if (!from || !to) {
      onShowToast('Choose the time frame', 'danger');
      return;
    }
    const base = {
      from: toIso(from),
      to: toIso(to),
      userIds: split(users),
      ...(minUsd ? { minUsd } : {}),
      ...(maxUsd ? { maxUsd } : {}),
      ...(group ? { group: { targetType: group, value: group === 'LEVEL' ? groupLevel.trim() : '' } } : {}),
      dryRun,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    if (!dryRun && !window.confirm(`Revert these ${kind}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const res =
        kind === 'ads'
          ? await ModulesAPI.revertAds({ ...base, adIds: split(adIds), pinnedOnly })
          : await ModulesAPI.revertGifts({ ...base, currencies: split(currencies).map((c) => c.toUpperCase()), refundFees });
      if (!res.success) {
        onShowToast(res.error || 'Revert failed', 'danger');
        return;
      }
      if (dryRun) {
        setPreview(
          (kind === 'ads'
            ? `${res.count} ad(s) match.`
            : `${res.count} completed gift(s) match, worth $${res.usdValue}.`) +
            (res.groupCheckedLater ? ' The group is checked by the chat server when it runs.' : ''),
        );
      } else if (res.queued) {
        setPreview(null);
        onShowToast(`Group revert queued (${res.candidates} candidate(s)); the chat server carries it out within a minute`);
        onDone();
      } else {
        setPreview(null);
        onShowToast(
          kind === 'ads'
            ? `${res.count} ad(s) reverted: ${res.stopped} stopped with a refund of unused views, rewards taken back on ${res.rewardsReverted}`
            : `${res.count} gift(s) queued; the chat server reverts them within a minute (failures show as REVERT_FAILED)`,
        );
        onDone();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        background: 'var(--surface-elevated, #1e293b)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        padding: '16px',
        margin: '16px 0',
      }}
    >
      <h4 style={{ margin: '0 0 6px 0', fontSize: '14px', color: '#fff' }}>
        Revert {kind === 'ads' ? 'advertisements' : 'transfers'} in a time frame
      </h4>
      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>
        {kind === 'ads'
          ? 'Running ads stop and are refunded only for pending / uncompleted views; the EXP and stars they earned are taken back.'
          : 'Each gift is moved back through the transfer module; if the receiver lacks the balance it is not reverted. EXP and universal currency earned are taken back.'}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
        <div className="form-group">
          <label>From</label>
          <input className="form-control" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="form-group">
          <label>To</label>
          <input className="form-control" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Min USD</label>
          <input className="form-control" value={minUsd} onChange={(e) => setMinUsd(e.target.value)} placeholder="any" />
        </div>
        <div className="form-group">
          <label>Max USD</label>
          <input className="form-control" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} placeholder="any" />
        </div>
        <div className="form-group" style={{ gridColumn: 'span 2' }}>
          <label>Users (empty = everyone)</label>
          <input className="form-control" value={users} onChange={(e) => setUsers(e.target.value)} placeholder="@alice, @bob" />
        </div>
        <div className="form-group">
          <label>Group of users</label>
          <select className="form-control" value={group} onChange={(e) => setGroup(e.target.value as typeof group)}>
            <option value="">No group</option>
            <option value="PREMIUM">Premium users</option>
            <option value="KYC">KYC verified</option>
            <option value="LEVEL">Level at least</option>
          </select>
        </div>
        <div className="form-group">
          <label>Level</label>
          <input
            className="form-control"
            value={groupLevel}
            disabled={group !== 'LEVEL'}
            onChange={(e) => setGroupLevel(e.target.value.replace(/\D/g, ''))}
            placeholder="e.g. 10"
          />
        </div>
        {kind === 'ads' ? (
          <>
            <div className="form-group">
              <label>Specific ad ids</label>
              <input className="form-control" value={adIds} onChange={(e) => setAdIds(e.target.value)} placeholder="optional" />
            </div>
            <div className="form-group" style={{ alignSelf: 'end' }}>
              <label style={{ fontSize: '13px' }}>
                <input type="checkbox" checked={pinnedOnly} onChange={(e) => setPinnedOnly(e.target.checked)} /> Pinned ads only
              </label>
            </div>
          </>
        ) : (
          <>
            <div className="form-group">
              <label>Currencies (empty = all)</label>
              <input className="form-control" value={currencies} onChange={(e) => setCurrencies(e.target.value)} placeholder="USDT, BTC" />
            </div>
            <div className="form-group" style={{ alignSelf: 'end' }}>
              <label style={{ fontSize: '13px' }}>
                <input type="checkbox" checked={refundFees} onChange={(e) => setRefundFees(e.target.checked)} /> Refund fees
              </label>
            </div>
          </>
        )}
        <div className="form-group" style={{ gridColumn: '1 / -1' }}>
          <label>Note (recorded)</label>
          <input className="form-control" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' }}>
        <button className="btn-secondary" disabled={busy} onClick={() => run(true)}>Preview (dry run)</button>
        <button className="btn-danger" disabled={busy} onClick={() => run(false)}>Revert</button>
        {preview && <span style={{ fontSize: '13px', color: '#fbbf24' }}>{preview}</span>}
      </div>
    </div>
  );
};
