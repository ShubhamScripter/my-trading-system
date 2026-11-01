'use client';

/**
 * A /rain the security policy asked to verify (RainPool, Modules 6–7): the 2FA code and/or the emailed code, the
 * questionnaire and the KYC check, before anything is debited. Also what an admin reviewing the rain asks for later
 * (stage ADMIN_REQUEST). Closing it leaves the rain waiting until it expires; "Cancel rain" drops it at once.
 */
import React, { useEffect, useState } from 'react';
import { CloudRain, Loader2, X } from 'lucide-react';
import * as rainApi from '@/lib/api/rain';
import type { RainResult } from '@/lib/api/rain';

const REASONS: Record<string, string> = {
  NEW_IP: 'you are on a new network',
  NEW_COUNTRY: 'you are in a country we have not seen on your account',
  VPN_PROXY: 'your connection looks like a VPN / proxy',
  AMOUNT: 'the amount is above the verification limit',
  COMMON_IP_CHECK: 'every rain is verified',
};

interface Props {
  pending: RainResult;
  onDone: (result: RainResult) => void;
  onClose: () => void;
}

const secondsLeft = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));

export default function RainVerifyModal({ pending, onDone, onClose }: Props) {
  const verification = pending.verification!;
  const adminRequest = verification.stage === 'ADMIN_REQUEST';
  const [totpCode, setTotpCode] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [answers, setAnswers] = useState<(number | null)[]>(verification.questions.map(() => null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(verification.email ? 'We emailed you a 6-digit code.' : null);
  const [left, setLeft] = useState(() => secondsLeft(verification.expiresAt));

  useEffect(() => {
    const timer = window.setInterval(() => setLeft(secondsLeft(verification.expiresAt)), 1000);
    return () => window.clearInterval(timer);
  }, [verification.expiresAt]);

  async function confirm() {
    const hasTotp = /^\d{6}$/.test(totpCode.trim());
    const hasEmail = /^\d{6}$/.test(emailCode.trim());
    if (verification.require === 'BOTH') {
      if (verification.twoFa && !hasTotp) return setError('Enter the 6-digit code from your authenticator');
      if (verification.email && !hasEmail) return setError('Enter the 6-digit code from your email');
    } else if ((verification.twoFa || verification.email) && !hasTotp && !hasEmail) {
      return setError('Enter your 2FA code or the code we emailed you');
    }
    if (answers.some((a) => a === null)) return setError('Answer every question to continue');
    setError(null);
    setLoading(true);
    try {
      const result = await rainApi.confirmRain({
        rainId: pending.rainId,
        ...(verification.twoFa && hasTotp ? { totpCode: totpCode.trim() } : {}),
        ...(verification.email && hasEmail ? { emailCode: emailCode.trim() } : {}),
        ...(verification.questions.length ? { answers: answers as number[] } : {}),
      });
      onDone(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not confirm the rain');
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    try {
      await rainApi.resendRainCode(pending.rainId);
      setInfo('A new code is on its way.');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not send a new code');
    }
  }

  async function cancel() {
    if (!adminRequest) {
      try {
        await rainApi.cancelRain(pending.rainId);
      } catch {
        // It may already have expired; either way nothing was debited.
      }
    }
    onClose();
  }

  const reasons = verification.reasons.map((r) => REASONS[r] ?? r).join(', ');
  const labelStyle: React.CSSProperties = { fontSize: '0.78rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem' };
  const hh = Math.floor(left / 3600);
  const mm = Math.floor((left % 3600) / 60);
  const ss = String(left % 60).padStart(2, '0');

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="gift-modal" id="rain-verify-modal" style={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div className="gift-modal-header">
          <div className="gift-modal-icon" style={{ background: 'rgba(56,189,248,0.12)', color: '#38bdf8' }}>
            <CloudRain size={20} />
          </div>
          <div style={{ flex: 1 }}>
            <p style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-main)' }}>
              {adminRequest ? 'An admin needs more from you' : 'Confirm your rain'}
            </p>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '1px' }}>
              {left > 0 ? `Expires in ${hh > 0 ? `${hh}h ` : ''}${mm}:${ss}` : 'Expired'}
            </p>
          </div>
          <button className="dm-header-action-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="gift-modal-body" style={{ overflowY: 'auto' }}>
          <div
            style={{
              background: 'rgba(56,189,248,0.08)',
              border: '1px solid rgba(56,189,248,0.25)',
              borderRadius: '9px',
              padding: '0.75rem 1rem',
              fontSize: '0.83rem',
              color: 'var(--text-main)',
            }}
          >
            Rain <strong style={{ color: '#38bdf8' }}>{pending.pot} {pending.currency}</strong>
            {pending.usd && <> (~{pending.usd} USD)</>} across {pending.recipients} people
            {pending.fee !== '0' && <> (fee {pending.fee})</>}. Nothing is taken from your balance until it is approved.
            {!adminRequest && reasons && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>Asked because {reasons}.</div>}
            {verification.manual && (
              <div style={{ fontSize: '0.72rem', color: '#fbbf24', marginTop: '4px' }}>After this, an admin reviews the rain before it is paid.</div>
            )}
          </div>

          {(verification.twoFa || verification.email) && verification.require === 'ONE' && (
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Either code is enough.</p>
          )}

          {verification.twoFa && (
            <div>
              <label style={labelStyle}>2FA code from your authenticator</label>
              <input
                className="gift-pin-input"
                inputMode="numeric"
                maxLength={6}
                placeholder="••••••"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                autoFocus
              />
            </div>
          )}

          {verification.email && (
            <div>
              <label style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between' }}>
                <span>Code from your email</span>
                <button type="button" onClick={() => void resend()} style={{ background: 'none', border: 'none', color: '#38bdf8', cursor: 'pointer', fontSize: '0.72rem' }}>
                  Send a new code
                </button>
              </label>
              <input
                className="gift-pin-input"
                inputMode="numeric"
                maxLength={6}
                placeholder="••••••"
                value={emailCode}
                onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))}
                autoFocus={!verification.twoFa}
              />
            </div>
          )}

          {verification.questions.length > 0 && (
            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Answer every question. Answers that are not accepted reject the rain.</p>
          )}
          {verification.questions.map((question, i) => (
            <div key={i}>
              <label style={labelStyle}>{question.text}</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {question.options.map((option, k) => (
                  <label key={k} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.8rem', color: 'var(--text-main)' }}>
                    <input
                      type="radio"
                      name={`rain-q-${i}`}
                      checked={answers[i] === k}
                      onChange={() => setAnswers((prev) => prev.map((a, j) => (j === i ? k : a)))}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}

          {verification.kycLevel !== null && (
            <p style={{ fontSize: '0.78rem', color: '#fbbf24' }}>
              A KYC check is needed: your account must have KYC level {verification.kycLevel}. Complete KYC first if it is not done.
            </p>
          )}

          {info && !error && <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{info}</p>}
          {error && <p style={{ fontSize: '0.78rem', color: 'var(--color-danger)' }}>{error}</p>}
        </div>

        <div className="gift-modal-footer">
          <button
            onClick={() => void cancel()}
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
            {adminRequest ? 'Later' : 'Cancel rain'}
          </button>
          <button className="gift-confirm-btn" onClick={() => void confirm()} disabled={loading || left === 0}>
            {loading ? <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> : adminRequest ? 'Send' : 'Confirm & Rain'}
          </button>
        </div>
      </div>
    </div>
  );
}
