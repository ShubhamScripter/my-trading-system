import React from 'react';

/**
 * Edits one chat-wide settings section by the shape of its current value: a switch for yes/no, a number box, a text
 * box (empty = none for values that may be none), a choice for known enums, a comma list for lists of words, nested
 * boxes for fixed objects, and JSON for lists of objects or keyed maps (badges, skins, per-currency limits). The
 * server validates every save against the shared chat settings contract.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- settings values are free-form JSON */

const STATUSES = ['ACTIVE', 'MAINTENANCE', 'DISABLED'];

const ENUMS: Record<string, string[]> = {
  kind: ['USD', 'PERCENT'],
  mode: ['FIXED', 'DYNAMIC'],
  status: STATUSES,
  chat: STATUSES,
  publicChat: STATUSES,
  skins: STATUSES,
  giftsInChat: STATUSES,
  ads: STATUSES,
  // "ADS — When Turning to Maintain / Off Choose" and "After Maintenance (if ads were paused)".
  adsOnStop: ['FINISH', 'PAUSE', 'REFUND_PENDING', 'REFUND_FULL'],
  adsOnResume: ['RESUME', 'RESET_RESUME', 'REFUND_PENDING', 'REFUND_FULL'],
  autoModLinks: STATUSES,
  autoModWords: STATUSES,
  autoModSpam: STATUSES,
  lastSeenDefault: ['ALL', 'FRIENDS', 'NOBODY'],
  commonGroupsDefault: ['ALL', 'FRIENDS', 'NOBODY'],
  quietModeDefault: ['OFF', 'AUTO_NIGHT'],
};

/** Keys whose value is a keyed map or a list of objects: edited as JSON. */
const JSON_KEYS = new Set(['perCurrency', 'badges', 'skins', 'style']);

const label = (key: string) =>
  key
    .replace(/([A-Z])/g, ' $1')
    .replace(/Usd\b/, 'USD')
    .replace(/^./, (c) => c.toUpperCase());

interface Props {
  value: Record<string, any>;
  onChange: (next: Record<string, any>) => void;
  /** Short explanations per key. */
  hints?: Record<string, string>;
}

function Field({ name, value, onChange, hint }: { name: string; value: any; onChange: (v: any) => void; hint?: string }) {
  const title = (
    <label title={hint} style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
      {label(name)}
      {hint ? ' ⓘ' : ''}
    </label>
  );

  if (JSON_KEYS.has(name) || (Array.isArray(value) && value.some((v) => v && typeof v === 'object'))) {
    return (
      <div className="form-group" style={{ gridColumn: '1 / -1' }}>
        {title}
        <textarea
          className="form-control"
          rows={Math.min(10, JSON.stringify(value, null, 2).split('\n').length + 1)}
          defaultValue={JSON.stringify(value, null, 2)}
          style={{ fontFamily: 'monospace', fontSize: '12px' }}
          onBlur={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
              e.target.style.borderColor = '';
            } catch {
              e.target.style.borderColor = '#ef4444';
            }
          }}
        />
      </div>
    );
  }
  if (typeof value === 'boolean') {
    return (
      <div className="form-group">
        <label style={{ fontSize: '13px', color: '#e2e8f0' }} title={hint}>
          <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} /> {label(name)}
        </label>
      </div>
    );
  }
  if (typeof value === 'number') {
    return (
      <div className="form-group">
        {title}
        <input className="form-control" type="number" step="any" value={value} onChange={(e) => onChange(Number(e.target.value))} />
      </div>
    );
  }
  if (Array.isArray(value)) {
    return (
      <div className="form-group" style={{ gridColumn: 'span 2' }}>
        {title}
        <input
          className="form-control"
          defaultValue={value.join(', ')}
          placeholder="comma separated (empty = none)"
          onBlur={(e) => onChange(e.target.value.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean))}
        />
      </div>
    );
  }
  if (value && typeof value === 'object') {
    return (
      <div style={{ gridColumn: '1 / -1', border: '1px solid var(--border)', borderRadius: '8px', padding: '10px' }}>
        <div style={{ fontSize: '12px', fontWeight: 700, color: '#e2e8f0', marginBottom: '6px' }}>{label(name)}</div>
        <SectionEditor value={value} onChange={onChange} />
      </div>
    );
  }
  if (ENUMS[name]) {
    return (
      <div className="form-group">
        {title}
        <select className="form-control" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          {ENUMS[name].map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </div>
    );
  }
  // A string, or null (a value that may be none).
  return (
    <div className="form-group">
      {title}
      <input
        className="form-control"
        value={value ?? ''}
        placeholder={value === null ? 'none' : ''}
        onChange={(e) => onChange(e.target.value === '' && value === null ? null : e.target.value)}
        onBlur={(e) => e.target.value === '' && onChange(null)}
      />
    </div>
  );
}

export const SectionEditor: React.FC<Props> = ({ value, onChange, hints }) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '10px' }}>
    {Object.entries(value).map(([key, v]) => (
      <Field key={key} name={key} value={v} hint={hints?.[key]} onChange={(next) => onChange({ ...value, [key]: next })} />
    ))}
  </div>
);
