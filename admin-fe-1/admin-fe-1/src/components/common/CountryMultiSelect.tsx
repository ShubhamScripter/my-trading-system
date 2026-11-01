import React, { useEffect, useRef, useState } from 'react';

interface CountryOption {
  code: string;
  name: string;
}

interface CountryMultiSelectProps {
  options: CountryOption[];
  value: string[];
  onChange: (codes: string[]) => void;
  placeholder?: string;
}

/**
 * A closed-by-default multi-select. `<select multiple>` was tried first, but
 * unlike every other field on this form it never closes — it's always a full
 * open listbox, which read as "the dropdown isn't working" next to the
 * Language/Country fields that ARE normal closed dropdowns. This renders the
 * same way those do: a closed control showing a count, opening a checkbox
 * panel (with search, since the country list runs to ~115 entries) on click.
 */
export const CountryMultiSelect: React.FC<CountryMultiSelectProps> = ({
  options,
  value,
  onChange,
  placeholder = 'All countries (no restriction)',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const toggle = (code: string) => {
    if (value.includes(code)) {
      onChange(value.filter((c) => c !== code));
    } else {
      onChange([...value, code]);
    }
  };

  const filtered = options.filter(
    (o) => o.name.toLowerCase().includes(query.toLowerCase()) || o.code.toLowerCase().includes(query.toLowerCase()),
  );

  const summary =
    value.length === 0
      ? placeholder
      : value.length <= 3
        ? value.join(', ')
        : `${value.length} countries selected`;

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="form-control"
        onClick={() => setIsOpen((v) => !v)}
        style={{
          width: '100%',
          textAlign: 'left',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          color: value.length === 0 ? 'var(--text-muted)' : 'var(--text-primary)',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <span style={{ fontSize: '10px', marginLeft: '8px', flexShrink: 0 }}>{isOpen ? '▲' : '▼'}</span>
      </button>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 50,
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            maxHeight: '260px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ padding: '6px', borderBottom: '1px solid var(--border)' }}>
            <input
              type="text"
              autoFocus
              placeholder="Search countries..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: '100%',
                padding: '5px 8px',
                fontSize: '12px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                color: 'var(--text-primary)',
                outline: 'none',
              }}
            />
          </div>

          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: '1px solid var(--border)',
                color: 'var(--danger)',
                fontSize: '11px',
                padding: '6px 10px',
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              Clear all ({value.length})
            </button>
          )}

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filtered.length === 0 && (
              <div style={{ padding: '10px', fontSize: '12px', color: 'var(--text-muted)' }}>No matches</div>
            )}
            {filtered.map((o) => {
              const checked = value.includes(o.code);
              return (
                <label
                  key={o.code}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '6px 10px',
                    fontSize: '12px',
                    cursor: 'pointer',
                    background: checked ? 'rgba(0, 242, 254, 0.08)' : 'transparent',
                  }}
                >
                  <input type="checkbox" checked={checked} onChange={() => toggle(o.code)} style={{ cursor: 'pointer' }} />
                  <span style={{ color: checked ? 'var(--primary)' : 'var(--text-secondary)' }}>
                    {o.name} ({o.code})
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
