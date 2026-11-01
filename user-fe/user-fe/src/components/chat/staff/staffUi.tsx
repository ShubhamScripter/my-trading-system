'use client';

/** Small shared pieces of the Staff Tools panel: styles, buttons, inputs and the action-result banner. */
import React, { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { isRequested, type PermissionMode } from '@/lib/api/staff';

export const ui = {
  section: {
    border: '1px solid var(--border-color, #232734)',
    borderRadius: '10px',
    padding: '0.9rem 1rem',
    marginBottom: '0.9rem',
    background: 'rgba(255,255,255,0.02)',
  } as React.CSSProperties,
  title: { fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.6rem', color: '#e5e7eb' } as React.CSSProperties,
  row: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' } as React.CSSProperties,
  input: {
    background: 'var(--bg-input, #0b0d13)',
    border: '1px solid var(--border-color, #232734)',
    borderRadius: '8px',
    color: '#e5e7eb',
    padding: '0.45rem 0.6rem',
    fontSize: '0.8rem',
    minWidth: 0,
  } as React.CSSProperties,
  muted: { color: '#9ca3af', fontSize: '0.75rem' } as React.CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' } as React.CSSProperties,
  th: { textAlign: 'left', color: '#9ca3af', fontWeight: 600, padding: '0.35rem 0.4rem', borderBottom: '1px solid #232734' } as React.CSSProperties,
  td: { padding: '0.4rem', borderBottom: '1px solid rgba(255,255,255,0.05)', verticalAlign: 'top', color: '#d1d5db' } as React.CSSProperties,
};

export function Btn({
  children,
  onClick,
  tone = 'default',
  disabled,
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  tone?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const colors = {
    default: { border: '#374151', color: '#d1d5db', bg: 'transparent' },
    primary: { border: '#6366f1', color: '#fff', bg: '#4f46e5' },
    danger: { border: '#ef4444', color: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  }[tone];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        border: `1px solid ${colors.border}`,
        background: colors.bg,
        color: colors.color,
        borderRadius: '8px',
        padding: '0.4rem 0.7rem',
        fontSize: '0.75rem',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

/** ACT / REPORT badge next to an action: REPORT means a higher role must approve it. */
export function ModeBadge({ mode }: { mode: PermissionMode | undefined }) {
  if (!mode || mode === 'NONE') return null;
  return (
    <span
      title={mode === 'REPORT' ? 'Your role asks a higher role, who decides' : 'Your role does this directly'}
      style={{
        fontSize: '0.6rem',
        fontWeight: 700,
        padding: '0.1rem 0.35rem',
        borderRadius: '4px',
        marginLeft: '0.35rem',
        background: mode === 'ACT' ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)',
        color: mode === 'ACT' ? '#4ade80' : '#fbbf24',
      }}
    >
      {mode === 'ACT' ? 'ACT' : 'ASK'}
    </span>
  );
}

export interface Outcome {
  tone: 'ok' | 'asked' | 'error';
  text: string;
}

export function OutcomeBanner({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  const color = { ok: '#4ade80', asked: '#fbbf24', error: '#f87171' }[outcome.tone];
  return (
    <div
      style={{
        border: `1px solid ${color}55`,
        background: `${color}14`,
        color,
        borderRadius: '8px',
        padding: '0.5rem 0.75rem',
        fontSize: '0.75rem',
        marginBottom: '0.75rem',
      }}
    >
      {outcome.text}
    </div>
  );
}

/**
 * Runs a staff action and turns its answer into a banner: done, sent to a higher role (REPORT mode), or the error.
 * `busy` names the running action so its button can show a spinner.
 */
export function useStaffAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const run = useCallback(
    async <T,>(name: string, work: () => Promise<T>, done = 'Done'): Promise<T | null> => {
      setBusy(name);
      setOutcome(null);
      try {
        const result = await work();
        setOutcome(
          isRequested(result)
            ? { tone: 'asked', text: 'Sent to a higher role for approval. You can follow it under Requests → Mine.' }
            : { tone: 'ok', text: done },
        );
        return result;
      } catch (err) {
        setOutcome({ tone: 'error', text: err instanceof Error ? err.message : 'Something went wrong' });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [],
  );
  return { busy, outcome, setOutcome, run };
}

export function Spinner() {
  return <Loader2 size={14} className="animate-spin" style={{ animation: 'spin 1s linear infinite' }} />;
}

export function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}
