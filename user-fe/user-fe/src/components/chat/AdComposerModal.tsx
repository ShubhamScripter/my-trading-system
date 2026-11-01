'use client';

/**
 * Creating an ad (Module 5, Chat SETTINGS "/Ad"): text (links inside it, beyond the free ones are paid), the current
 * room or all rooms, pinned minutes, repeats with their gap, a badge and a skin, and countries that must not see it.
 * The server prices it (quote) before it is paid and posted. Every limit comes from GET /social/chat/ads/options.
 */
import React, { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import type { AdOptions, AdQuote } from '@/types/dm';
import * as socialApi from '@/lib/api/social';

type AdStep = 'compose' | 'quote' | 'done';

interface AdComposerModalProps {
  /** The room the ad goes to when "All rooms" is not chosen. */
  roomId?: string;
  onClose: () => void;
  onDone: () => void;
}

const field: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-input, #0d0f15)',
  border: '1px solid var(--border-color, #232734)',
  borderRadius: '8px',
  padding: '0.5rem 0.7rem',
  color: 'var(--text-main, #fff)',
  fontSize: '0.83rem',
  boxSizing: 'border-box',
};
const label: React.CSSProperties = { fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.3rem' };

export default function AdComposerModal({ roomId, onClose, onDone }: AdComposerModalProps) {
  const [options, setOptions] = useState<AdOptions | null>(null);
  const [step, setStep] = useState<AdStep>('compose');
  const [content, setContent] = useState('');
  const [allRooms, setAllRooms] = useState(!roomId);
  const [pinMinutes, setPinMinutes] = useState(0);
  const [repeatCount, setRepeatCount] = useState(0);
  const [repeatGap, setRepeatGap] = useState(30);
  const [badgeId, setBadgeId] = useState<string | null>(null);
  const [skinId, setSkinId] = useState<string | null>(null);
  const [hidden, setHidden] = useState('');
  const [quote, setQuote] = useState<AdQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    socialApi
      .getAdOptions()
      .then((o) => {
        setOptions(o);
        if (o.allRoomsByDefault) setAllRooms(true);
        if (o.repeat.enabled) setRepeatGap(Math.max(o.repeat.minGapMinutes, Math.min(30, o.repeat.maxGapMinutes)));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const input = (): socialApi.AdInput => ({
    content: content.trim(),
    ...(allRooms ? { allRooms: true } : { roomIds: roomId ? [roomId] : [] }),
    ...(pinMinutes > 0 ? { pinMinutes } : {}),
    ...(repeatCount > 0 ? { repeatCount, repeatGapMinutes: repeatGap } : {}),
    ...(badgeId ? { badgeId } : {}),
    ...(skinId ? { skinId } : {}),
    hiddenCountries: hidden
      .split(/[\s,]+/)
      .map((c) => c.trim().toUpperCase())
      .filter((c) => /^[A-Z]{2}$/.test(c)),
  });

  async function getQuote() {
    if (!content.trim()) {
      setError('Write your ad first');
      return;
    }
    if (!allRooms && !roomId) {
      setError('Open a room first, or choose all rooms');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      setQuote(await socialApi.quoteAd(input()));
      setStep('quote');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to get a price');
    } finally {
      setBusy(false);
    }
  }

  async function createAd() {
    setError(null);
    setBusy(true);
    try {
      await socialApi.createAd(input());
      setStep('done');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create the ad');
      setStep('compose');
    } finally {
      setBusy(false);
    }
  }

  const maxChars = options?.maxChars ?? 300;

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
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="ad-composer-modal" id="ad-composer-modal">
        <div className="ad-composer-header">
          <div>
            <p style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-main)' }}>
              {step === 'done' ? '🎉 Ad published' : step === 'quote' ? 'Confirm your ad' : 'Create an ad'}
            </p>
            <p style={{ fontSize: '0.73rem', color: 'var(--text-muted)', marginTop: '1px' }}>
              {step === 'done'
                ? 'Your ad is posted in the chat.'
                : step === 'quote'
                  ? 'Check the price before paying'
                  : 'Shown in the chat feed, never hidden by mute or block'}
            </p>
          </div>
          <button className="dm-header-action-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="ad-composer-body">
          {options && !options.enabled && (
            <p style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>Ads are switched off right now.</p>
          )}

          {step === 'compose' && options && (
            <>
              <div>
                <label style={label}>
                  Ad text ({content.length}/{maxChars}) — links count: {options.maxFreeLinks} free,{' '}
                  {options.maxPaidLinks} more paid
                </label>
                <textarea
                  value={content}
                  maxLength={maxChars}
                  rows={4}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Visit orebit.io/shop for 20% off today!"
                  style={{ ...field, resize: 'vertical' }}
                />
              </div>

              <div>
                <label style={label}>Where</label>
                <div style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem', color: 'var(--text-main)' }}>
                  <label>
                    <input type="radio" checked={!allRooms} disabled={!roomId || options.allRoomsByDefault} onChange={() => setAllRooms(false)} />{' '}
                    This room
                  </label>
                  <label>
                    <input type="radio" checked={allRooms} onChange={() => setAllRooms(true)} /> All rooms
                  </label>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                {options.pinned.enabled && (
                  <div>
                    <label style={label}>
                      Pin on top (minutes, {options.pinned.minMinutes}–{options.pinned.maxMinutes}; 0 = no)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={options.pinned.maxMinutes}
                      value={pinMinutes}
                      onChange={(e) => setPinMinutes(Math.max(0, Number(e.target.value) || 0))}
                      style={field}
                    />
                  </div>
                )}
                {options.repeat.enabled && (
                  <>
                    <div>
                      <label style={label}>
                        Repeats (up to {options.repeat.maxCount}, {options.repeat.discountPercent}% off each)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={options.repeat.maxCount}
                        value={repeatCount}
                        onChange={(e) => setRepeatCount(Math.max(0, Number(e.target.value) || 0))}
                        style={field}
                      />
                    </div>
                    {repeatCount > 0 && (
                      <div>
                        <label style={label}>
                          Minutes between posts ({options.repeat.minGapMinutes}–{options.repeat.maxGapMinutes})
                        </label>
                        <input
                          type="number"
                          min={options.repeat.minGapMinutes}
                          max={options.repeat.maxGapMinutes}
                          value={repeatGap}
                          onChange={(e) => setRepeatGap(Number(e.target.value) || options.repeat.minGapMinutes)}
                          style={field}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>

              {options.badges.length > 0 && (
                <div>
                  <label style={label}>Badge (optional)</label>
                  <div className="ad-badge-grid">
                    {options.badges.map((b) => (
                      <div
                        key={b.id}
                        className={`ad-badge-option${badgeId === b.id ? ' selected' : ''}`}
                        onClick={() => setBadgeId(badgeId === b.id ? null : b.id)}
                      >
                        {b.emoji ? `${b.emoji} ` : ''}
                        {b.text ?? ''}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {options.skins.length > 0 && (
                <div>
                  <label style={label}>Skin (optional, paid once)</label>
                  <div className="ad-badge-grid">
                    {options.skins.map((k) => (
                      <div
                        key={k.id}
                        className={`ad-badge-option${skinId === k.id ? ' selected' : ''}`}
                        onClick={() => setSkinId(skinId === k.id ? null : k.id)}
                        style={{ borderColor: k.style.border ?? k.style.color, color: k.style.color }}
                      >
                        {k.style.icon ? `${k.style.icon} ` : ''}
                        {k.name} · ${k.priceUsd}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label style={label}>Hide from countries (optional, e.g. US, GB)</label>
                <input value={hidden} onChange={(e) => setHidden(e.target.value)} style={field} />
              </div>
            </>
          )}

          {step === 'quote' && quote && (
            <div className="ad-quote-card">
              {quote.price.lines.map((line, i) => (
                <div key={i} className="ad-quote-row">
                  <span>{line.label}</span>
                  <span>${Number(line.usd).toFixed(2)}</span>
                </div>
              ))}
              <div className="ad-quote-row ad-quote-total">
                <span>Total</span>
                <span style={{ color: '#fbbf24' }}>${Number(quote.price.totalUsd).toFixed(2)} USD</span>
              </div>
              <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                {quote.allRooms ? 'All rooms' : quote.rooms.map((r) => r.name).join(', ')}
                {quote.pinMinutes ? ` · pinned ${quote.pinMinutes} min` : ''}
                {quote.repeatCount ? ` · ${quote.repeatCount} repeats every ${quote.repeatGapMinutes} min` : ''}
              </p>
            </div>
          )}

          {step === 'done' && (
            <p style={{ fontSize: '0.85rem', color: 'var(--text-main)' }}>
              If you cancel it later, posts not made and pinned minutes not shown are refunded.
            </p>
          )}

          {error && <p style={{ fontSize: '0.78rem', color: 'var(--color-danger)' }}>{error}</p>}
        </div>

        <div className="ad-composer-footer">
          {step === 'done' ? (
            <button className="gift-confirm-btn" onClick={onDone}>Done</button>
          ) : (
            <>
              <button
                onClick={() => (step === 'quote' ? setStep('compose') : onClose())}
                style={{
                  padding: '0.6rem 1rem',
                  borderRadius: '8px',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-muted)',
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                }}
              >
                {step === 'quote' ? 'Back' : 'Cancel'}
              </button>
              <button
                className="gift-confirm-btn"
                disabled={busy || !options?.enabled}
                onClick={() => void (step === 'compose' ? getQuote() : createAd())}
              >
                {busy ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : step === 'compose' ? 'Get price' : 'Pay & publish'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
