import React, { useCallback, useEffect, useState } from 'react';
import { AdminRoom } from '../../types';
import { AdRow, GiftRow, ModulesAPI } from '../../services/modulesApi';
import { RevertPanel } from './RevertPanel';

/**
 * Chat Module 5 from the panel: every ad (cancel with a refund of the unused part or all of it, free admin ads,
 * reverting in bulk), every gift (with its transfer reference and revert outcome, reverting in bulk) and the log of
 * every command run or refused.
 */
interface Props {
  rooms: AdminRoom[];
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

type Tab = 'ads' | 'gifts' | 'commands';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export const MoneyView: React.FC<Props> = ({ rooms, onShowToast }) => {
  const [tab, setTab] = useState<Tab>('ads');
  const [adStatus, setAdStatus] = useState('ALL');
  const [ads, setAds] = useState<AdRow[]>([]);
  const [giftStatus, setGiftStatus] = useState('ALL');
  const [giftUser, setGiftUser] = useState('');
  const [gifts, setGifts] = useState<GiftRow[]>([]);
  const [cmdUser, setCmdUser] = useState('');
  const [commands, setCommands] = useState<any[]>([]);
  const [showRevert, setShowRevert] = useState(false);
  const [showAdForm, setShowAdForm] = useState(false);
  const [adForm, setAdForm] = useState({ content: '', roomIds: [] as string[], allRooms: true, pinMinutes: '', repeatCount: '0', repeatGap: '30' });

  const fail = (err: unknown) => onShowToast(err instanceof Error ? err.message : 'Request failed', 'danger');

  const load = useCallback(async () => {
    try {
      if (tab === 'ads') setAds(await ModulesAPI.ads(adStatus));
      if (tab === 'gifts') setGifts(await ModulesAPI.gifts({ status: giftStatus, userId: giftUser.trim() || undefined }));
      if (tab === 'commands') setCommands(await ModulesAPI.commandLog(cmdUser.trim() || undefined));
    } catch (err) {
      fail(err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, adStatus, giftStatus, giftUser, cmdUser]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, adStatus, giftStatus]);

  const cancelAd = async (ad: AdRow) => {
    const refund = window.prompt('Refund: UNUSED (pending views), FULL (whole price) or NONE', 'UNUSED');
    if (!refund) return;
    const choice = refund.trim().toUpperCase();
    if (!['UNUSED', 'FULL', 'NONE'].includes(choice)) {
      onShowToast('Type UNUSED, FULL or NONE', 'danger');
      return;
    }
    const note = window.prompt('Note (optional):', '') ?? '';
    const res = await ModulesAPI.cancelAd(ad.id, choice as 'UNUSED' | 'FULL' | 'NONE', note.trim() || undefined);
    if (res.success) {
      onShowToast(res.refundUsd ? `Cancelled; $${Number(res.refundUsd).toFixed(2)} will be refunded` : 'Cancelled');
      void load();
    } else onShowToast(res.error || 'Could not cancel', 'danger');
  };

  const createAd = async (e: React.FormEvent) => {
    e.preventDefault();
    const repeatCount = Number(adForm.repeatCount) || 0;
    const res = await ModulesAPI.createAd({
      content: adForm.content.trim(),
      roomIds: adForm.allRooms ? [] : adForm.roomIds,
      allRooms: adForm.allRooms,
      pinMinutes: adForm.pinMinutes ? Number(adForm.pinMinutes) : null,
      repeatCount,
      repeatGapMinutes: repeatCount > 0 ? Number(adForm.repeatGap) || 30 : null,
      badgeId: null,
      hiddenCountries: [],
    });
    if (res.success) {
      onShowToast('Admin ad created; the chat server posts it within a minute');
      setShowAdForm(false);
      setAdForm({ ...adForm, content: '' });
      void load();
    } else onShowToast(res.error || 'Could not create the ad', 'danger');
  };

  const tabButton = (id: Tab, label: string) => (
    <button
      className={tab === id ? 'btn-action' : 'btn-secondary'}
      onClick={() => {
        setShowRevert(false);
        setTab(id);
      }}
    >
      {label}
    </button>
  );

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>Ads, Gifts &amp; Commands (Module 5)</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Ads and money sent through chat, with refunds and reverts. Prices, limits and rewards are in Feature
              Settings.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {tabButton('ads', 'Ads')}
            {tabButton('gifts', 'Gifts')}
            {tabButton('commands', 'Command log')}
          </div>
        </div>

        {tab === 'ads' && (
          <>
            <div style={{ display: 'flex', gap: '8px', margin: '16px 0', flexWrap: 'wrap' }}>
              {['ALL', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED', 'REFUNDED'].map((s) => (
                <button key={s} className={adStatus === s ? 'btn-action' : 'btn-secondary'} onClick={() => setAdStatus(s)}>{s}</button>
              ))}
              <span style={{ flex: 1 }} />
              <button className="btn-secondary" onClick={() => setShowAdForm(!showAdForm)}>{showAdForm ? 'Close' : 'Free admin ad'}</button>
              <button className="btn-danger" onClick={() => setShowRevert(!showRevert)}>{showRevert ? 'Close revert' : 'Revert ads…'}</button>
            </div>
            {showRevert && <RevertPanel kind="ads" onShowToast={onShowToast} onDone={load} />}
            {showAdForm && (
              <form onSubmit={createAd} style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '16px' }}>
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label>Ad text</label>
                  <textarea className="form-control" rows={3} value={adForm.content} onChange={(e) => setAdForm({ ...adForm, content: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: '13px' }}>
                    <input type="checkbox" checked={adForm.allRooms} onChange={(e) => setAdForm({ ...adForm, allRooms: e.target.checked })} /> All rooms
                  </label>
                  {!adForm.allRooms && (
                    <select
                      multiple
                      className="form-control"
                      value={adForm.roomIds}
                      onChange={(e) => setAdForm({ ...adForm, roomIds: Array.from(e.target.selectedOptions).map((o) => o.value) })}
                    >
                      {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  )}
                </div>
                <div className="form-group">
                  <label>Pinned minutes (empty = no)</label>
                  <input className="form-control" type="number" min={1} value={adForm.pinMinutes} onChange={(e) => setAdForm({ ...adForm, pinMinutes: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Repeats</label>
                  <input className="form-control" type="number" min={0} value={adForm.repeatCount} onChange={(e) => setAdForm({ ...adForm, repeatCount: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Minutes between</label>
                  <input className="form-control" type="number" min={1} value={adForm.repeatGap} onChange={(e) => setAdForm({ ...adForm, repeatGap: e.target.value })} />
                </div>
                <div><button type="submit" className="btn-action">Post ad</button></div>
              </form>
            )}
            <div className="table-responsive">
              <table className="admin-table">
                <thead>
                  <tr><th>Advertiser</th><th>Ad</th><th>Where</th><th>Posts</th><th>Price</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {ads.map((ad) => (
                    <tr key={ad.id}>
                      <td>{ad.advertiser === 'ADMIN_PANEL' ? 'Admin' : `@${ad.advertiser}`}<div style={{ fontSize: '12px', opacity: 0.6 }}>{when(ad.createdAt)}</div></td>
                      <td style={{ maxWidth: '320px' }}>
                        {ad.content}
                        <div style={{ fontSize: '12px', opacity: 0.6 }}>
                          {ad.badgeId ? `badge ${ad.badgeId} ` : ''}{ad.skinId ? `skin ${ad.skinId}` : ''}
                        </div>
                      </td>
                      <td>{ad.allRooms ? 'All rooms' : `${ad.roomIds.length} room(s)`}{ad.pinMinutes ? ` · pinned ${ad.pinMinutes} min` : ''}</td>
                      <td>{ad.postedCount}/{ad.repeatCount + 1}</td>
                      <td>
                        ${ad.priceUsd}
                        {ad.refundUsd && <div style={{ fontSize: '12px', color: '#4ade80' }}>refund ${ad.refundUsd}{ad.refundedAt ? ' (paid)' : ' (due)'}</div>}
                      </td>
                      <td>
                        {ad.status}
                        {ad.rewardsReverted && <div style={{ fontSize: '12px', color: '#fbbf24' }}>rewards reverted</div>}
                        {ad.cancelNote && <div style={{ fontSize: '12px', opacity: 0.7 }}>{ad.cancelNote}</div>}
                      </td>
                      <td>
                        {(ad.status === 'ACTIVE' || ad.status === 'PAUSED') && (
                          <button className="btn-secondary" onClick={() => cancelAd(ad)}>Cancel</button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {ads.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', opacity: 0.6 }}>No ads.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'gifts' && (
          <>
            <div style={{ display: 'flex', gap: '8px', margin: '16px 0', flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="form-control" style={{ maxWidth: '220px' }} value={giftStatus} onChange={(e) => setGiftStatus(e.target.value)}>
                {['ALL', 'PENDING_VERIFICATION', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REVERT_PENDING', 'REVERTED', 'REVERT_FAILED'].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <input
                className="form-control"
                style={{ maxWidth: '220px' }}
                placeholder="Sender or recipient"
                value={giftUser}
                onChange={(e) => setGiftUser(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && load()}
              />
              <button className="btn-secondary" onClick={() => load()}>Search</button>
              <span style={{ flex: 1 }} />
              <button className="btn-danger" onClick={() => setShowRevert(!showRevert)}>{showRevert ? 'Close revert' : 'Revert transfers…'}</button>
            </div>
            {showRevert && <RevertPanel kind="gifts" onShowToast={onShowToast} onDone={load} />}
            <div className="table-responsive">
              <table className="admin-table">
                <thead>
                  <tr><th>When</th><th>From</th><th>To</th><th>Amount</th><th>Where</th><th>Status</th><th>Reference</th></tr>
                </thead>
                <tbody>
                  {gifts.map((g) => (
                    <tr key={g.id}>
                      <td>{when(g.createdAt)}</td>
                      <td>@{g.sender ?? '?'}</td>
                      <td>@{g.recipient ?? '?'}</td>
                      <td>{g.amount} {g.currency}{g.usdValue ? <div style={{ fontSize: '12px', opacity: 0.6 }}>${g.usdValue}</div> : null}</td>
                      <td>{g.conversationId ? 'DM' : g.roomId ? 'Room' : '—'}</td>
                      <td>
                        {g.status}
                        {g.failureReason && <div style={{ fontSize: '12px', color: '#f87171' }}>{g.failureReason}</div>}
                        {g.revertedAt && <div style={{ fontSize: '12px', opacity: 0.6 }}>reverted {when(g.revertedAt)}</div>}
                      </td>
                      <td style={{ fontSize: '12px' }}>{g.transferReference ?? '—'}</td>
                    </tr>
                  ))}
                  {gifts.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', opacity: 0.6 }}>No gifts.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'commands' && (
          <>
            <div style={{ display: 'flex', gap: '8px', margin: '16px 0' }}>
              <input
                className="form-control"
                style={{ maxWidth: '240px' }}
                placeholder="User (empty = everyone)"
                value={cmdUser}
                onChange={(e) => setCmdUser(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && load()}
              />
              <button className="btn-secondary" onClick={() => load()}>Search</button>
            </div>
            <div className="table-responsive">
              <table className="admin-table">
                <thead><tr><th>When</th><th>User</th><th>Command</th><th>Arguments</th><th>Result</th></tr></thead>
                <tbody>
                  {commands.map((c) => (
                    <tr key={c.id}>
                      <td>{when(c.createdAt)}</td>
                      <td>@{c.username ?? '?'}</td>
                      <td>/{c.command}</td>
                      <td style={{ fontSize: '12px' }}>{c.args ? JSON.stringify(c.args) : ''}</td>
                      <td>{c.result}{c.reason ? <div style={{ fontSize: '12px', opacity: 0.7 }}>{c.reason}</div> : null}</td>
                    </tr>
                  ))}
                  {commands.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', opacity: 0.6 }}>No commands.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
};
