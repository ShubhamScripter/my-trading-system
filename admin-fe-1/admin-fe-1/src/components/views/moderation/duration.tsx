import React from 'react';

export function secondsToLabel(s?: number): string {
  if (!s) return '0s';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function parseDuration(val: string, unit: string): number {
  const n = parseFloat(val) || 0;
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 3600;
  if (unit === 'd') return n * 86400;
  return n;
}

/** A length of time typed as a number and a unit, held in seconds. */
export function DurationInput({ seconds, onChange }: { seconds?: number; onChange: (s: number) => void }) {
  const val = seconds ?? 0;
  const unit = val >= 86400 ? 'd' : val >= 3600 ? 'h' : val >= 60 ? 'm' : 's';
  const display = unit === 'd' ? val / 86400 : unit === 'h' ? val / 3600 : unit === 'm' ? val / 60 : val;

  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
      <input
        type="number"
        min={0}
        className="form-control"
        style={{ width: '80px', fontSize: '12px', height: '32px' }}
        value={display}
        onChange={(e) => onChange(parseDuration(e.target.value, unit))}
      />
      <select
        className="form-control"
        style={{ width: '60px', fontSize: '12px', height: '32px', padding: '0 4px' }}
        value={unit}
        onChange={(e) => onChange(parseDuration(String(display), e.target.value))}
      >
        <option value="s">sec</option>
        <option value="m">min</option>
        <option value="h">hrs</option>
        <option value="d">days</option>
      </select>
    </div>
  );
}
