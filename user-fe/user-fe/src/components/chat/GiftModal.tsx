'use client';

/**
 * Sending money through chat (Module 5, Chat SETTINGS "Sending Money / Gifts"): the amount in a currency, then the
 * payment PIN or the 2FA code the server asks for (`verification`), then the transfer. From a DM it uses the
 * conversation's gift button route; from a room, /send.
 */
import React, { useEffect, useState } from 'react';
import { Gift, X, Loader2 } from 'lucide-react';
import * as socialApi from '@/lib/api/social';
import * as dmApi from '@/lib/api/dm';
import type { DmConversation, GiftOptions } from '@/types/dm';

type GiftStep = 'amount' | 'confirm' | 'success';

interface GiftModalProps {
  /** Chat room recipient (when called from public chat). */
  recipientUsername?: string;
  /** DM conversation recipient (when called from DM). */
  dmConversation?: DmConversation;
  /** The room the gift is sent from (its notice is posted there). */
  roomId?: string;
  /** A gift already started by "/send @user amount CURRENCY": opens on the PIN / 2FA step. */
  pending?: { giftId: string; recipient: string; amount: string; currency: string; verification: 'PAYMENT_PIN' | 'TWO_FA' };
  onClose: () => void;
}

export default function GiftModal({ recipientUsername, dmConversation, roomId, pending, onClose }: GiftModalProps) {
  const fixedRecipient = pending?.recipient ?? recipientUsername ?? dmConversation?.peer?.username ?? '';
  const [recipient, setRecipient] = useState(fixedRecipient);
  const [options, setOptions] = useState<GiftOptions | null>(null);
  const [step, setStep] = useState<GiftStep>(pending ? 'confirm' : 'amount');
  const [amount, setAmount] = useState(pending?.amount ?? '');
  const [currency, setCurrency] = useState(pending?.currency ?? 'USDT');
  const [code, setCode] = useState('');
  const [giftId, setGiftId] = useState<string | null>(pending?.giftId ?? null);
  const [verification, setVerification] = useState<'PAYMENT_PIN' | 'TWO_FA'>(pending?.verification ?? 'TWO_FA');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    socialApi
      .getGiftOptions()
      .then((o) => {
        setOptions(o);
        // A started gift keeps the verification and currency the server chose for it.
        if (pending) return;
        setVerification(o.verification);
        if (o.currencies.length > 0) setCurrency(o.currencies[0]!.currency);
      })
      .catch(() => {});
  }, [pending]);

  const limits = options?.currencies.find((c) => c.currency === currency);

  async function startGift() {
    if (!recipient.trim()) {
      setError('Who is the gift for?');
      return;
    }
    if (!amount || Number(amount) <= 0) {
      setError('Enter a valid amount');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = dmConversation
        ? await dmApi.startDmGift(dmConversation.id, amount, currency)
        : await socialApi.startGift(recipient, amount, currency, roomId);
      setGiftId(res.giftId);
      setVerification(res.verification);
      setStep('confirm');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to send gift');
    } finally {
      setLoading(false);
    }
  }

  async function confirmGift() {
    if (!giftId) return;
    if (!code.trim()) {
      setError(verification === 'PAYMENT_PIN' ? 'Enter your payment PIN' : 'Enter your 2FA code');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await socialApi.confirmGift(giftId, code.trim());
      setStep('success');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to confirm gift');
    } finally {
      setLoading(false);
    }
  }

  async function cancelGift() {
    if (giftId && step === 'confirm') {
      await socialApi.cancelGift(giftId).catch(() => {});
    }
    onClose();
  }

  const shownRecipient = recipient.replace(/^@/, '') || '…';

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
      onClick={(e) => e.target === e.currentTarget && void cancelGift()}
    >
      <div className="gift-modal" id="gift-modal">
        <div className="gift-modal-header">
          <div className="gift-modal-icon">
            <Gift size={20} />
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-main)' }}>
              {step === 'success' ? 'Gift sent!' : 'Send Gift'}
            </p>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '1px' }}>
              {step === 'success' ? `Your gift to @${shownRecipient} was sent.` : `To @${shownRecipient}`}
            </p>
          </div>
          <button className="dm-header-action-btn" onClick={() => void cancelGift()}>
            <X size={16} />
          </button>
        </div>

        <div className="gift-modal-body">
          {options && !options.enabled && (
            <p style={{ fontSize: '0.8rem', color: 'var(--color-danger)' }}>
              Sending money through chat is switched off right now.
            </p>
          )}

          {step === 'amount' && (
            <>
              {!fixedRecipient && (
                <input
                  className="gift-amount-input"
                  placeholder="@username"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  style={{ width: '100%' }}
                  autoFocus
                />
              )}
              <div className="gift-amount-input-wrap">
                <input
                  id="gift-amount-input"
                  className="gift-amount-input"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && void startGift()}
                  autoFocus={!!fixedRecipient}
                />
                {options && options.currencies.length > 0 ? (
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    style={{ background: 'transparent', color: 'var(--text-main)', border: 'none', fontWeight: 600 }}
                  >
                    {options.currencies.map((c) => (
                      <option key={c.currency} value={c.currency}>{c.currency}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                    style={{ width: '4.5rem', background: 'transparent', color: 'var(--text-main)', border: 'none', fontWeight: 600 }}
                  />
                )}
              </div>
              <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                {limits && (limits.min || limits.max)
                  ? `Limits: ${limits.min ?? '—'} to ${limits.max ?? '—'} ${currency}`
                  : options && (options.minUsd || options.maxUsd)
                    ? `Limits: $${options.minUsd ?? '—'} to $${options.maxUsd ?? '—'} per gift`
                    : 'Fees and limits are checked before you confirm.'}
              </p>
              {error && <p style={{ fontSize: '0.78rem', color: 'var(--color-danger)' }}>{error}</p>}
            </>
          )}

          {step === 'confirm' && (
            <>
              <div
                style={{
                  background: 'rgba(251,191,36,0.08)',
                  border: '1px solid rgba(251,191,36,0.2)',
                  borderRadius: '9px',
                  padding: '0.75rem 1rem',
                  fontSize: '0.83rem',
                  color: 'var(--text-main)',
                }}
              >
                Sending <strong style={{ color: '#fbbf24' }}>{amount} {currency}</strong> to{' '}
                <strong>@{shownRecipient}</strong>
              </div>
              <div>
                <label style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem' }}>
                  {verification === 'PAYMENT_PIN' ? 'Payment PIN' : '2FA code from your authenticator'}
                </label>
                <input
                  id="gift-pin-input"
                  className="gift-pin-input"
                  type="password"
                  inputMode="numeric"
                  maxLength={8}
                  placeholder="••••••"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void confirmGift()}
                  autoFocus
                />
              </div>
              {error && <p style={{ fontSize: '0.78rem', color: 'var(--color-danger)' }}>{error}</p>}
            </>
          )}

          {step === 'success' && (
            <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--color-success)' }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  background: 'rgba(16,185,129,0.12)',
                  border: '1px solid rgba(16,185,129,0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 0.75rem',
                }}
              >
                <Gift size={24} />
              </div>
              <p style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-main)' }}>
                {amount} {currency} sent!
              </p>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                @{shownRecipient} has received your gift.
              </p>
            </div>
          )}
        </div>

        {step !== 'success' ? (
          <div className="gift-modal-footer">
            <button
              onClick={() => void cancelGift()}
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
              Cancel
            </button>
            <button
              id="gift-action-btn"
              className="gift-confirm-btn"
              onClick={() => void (step === 'amount' ? startGift() : confirmGift())}
              disabled={loading || (options !== null && !options.enabled)}
            >
              {loading ? (
                <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
              ) : step === 'amount' ? (
                'Continue →'
              ) : (
                'Confirm & Send'
              )}
            </button>
          </div>
        ) : (
          <div className="gift-modal-footer" style={{ justifyContent: 'center' }}>
            <button
              onClick={onClose}
              style={{
                padding: '0.6rem 2rem',
                borderRadius: '8px',
                background: 'var(--color-primary)',
                border: 'none',
                color: 'white',
                fontSize: '0.875rem',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
