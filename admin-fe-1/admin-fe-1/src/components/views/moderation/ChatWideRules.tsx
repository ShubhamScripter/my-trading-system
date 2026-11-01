import React, { useEffect, useState } from 'react';
import { AutoBanTier } from '../../../types';
import { AdminAPI } from '../../../services/api';
import { IconPlus, IconTrash } from '../../Icons';
import { DurationInput, secondsToLabel } from './duration';

interface SpamRule {
  enabled: boolean;
  repeatCount: number;
  windowSeconds: number;
}

interface Props {
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

/** Shown while the admin has not set a spam rule: off, with the usual starting numbers. */
const NO_SPAM_RULE: SpamRule = { enabled: false, repeatCount: 3, windowSeconds: 30 };

const label = { fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '6px' } as const;

/**
 * Chat SETTINGS "Spam Protection" and "Auto Moderation, Banning Sequence": ONE rule and ONE ladder for the whole chat,
 * offences counted across rooms (V2-30, FR-098). A room can only switch auto-moderation off. Both are saved in the
 * chat settings (`moderation`); an empty ladder means an offence is refused and no penalty follows.
 */
export const ChatWideRules: React.FC<Props> = ({ onShowToast }) => {
  const [spam, setSpam] = useState<SpamRule>(NO_SPAM_RULE);
  const [ladder, setLadder] = useState<AutoBanTier[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    AdminAPI.getSettings()
      .then((res) => {
        if (!live) return;
        const moderation = res?.document?.global?.moderation;
        setSpam(moderation?.spamProtection ?? NO_SPAM_RULE);
        setLadder(moderation?.autoBanSequence ?? []);
      })
      .catch(() => onShowToast('Could not load the chat-wide rules', 'danger'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [onShowToast]);

  const updateTier = (index: number, key: keyof AutoBanTier, value: unknown) =>
    setLadder(ladder.map((tier, i) => (i === index ? { ...tier, [key]: value } : tier)));
  const addTier = () =>
    setLadder([
      ...ladder,
      ladder.length === 0
        ? { tier: 1, action: 'WARNING', resetWindowHours: 24 }
        : { tier: ladder.length + 1, action: 'BAN', durationSeconds: 3600, resetWindowHours: 48 },
    ]);
  const removeTier = (index: number) =>
    setLadder(ladder.filter((_, i) => i !== index).map((tier, i) => ({ ...tier, tier: i + 1 })));

  const save = async () => {
    setSaving(true);
    try {
      const res = (await AdminAPI.saveSettings({ moderation: { spamProtection: spam, autoBanSequence: ladder } })) as {
        success?: boolean;
      };
      const failed = res?.success === false;
      onShowToast(failed ? 'Failed to save' : 'Chat-wide rules saved', failed ? 'danger' : 'success');
    } catch {
      onShowToast('Network error', 'danger');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="card-section">Loading…</div>;

  return (
    <div className="card-section">
      <h4 style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 700 }}>Spam rule and ban ladder (whole chat)</h4>
      <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 20px' }}>
        One rule and one ladder for every room. A user who offends in room A and then in room B climbs the same ladder. A
        room can only switch auto-moderation off. With no ladder, an offence is refused and recorded, and nobody is
        penalised automatically.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '640px' }}>
        <label style={{ ...label, display: 'flex', gap: '10px', alignItems: 'center' }}>
          <input
            id="spam-toggle"
            type="checkbox"
            checked={spam.enabled}
            onChange={(e) => setSpam({ ...spam, enabled: e.target.checked })}
          />
          Spam protection: the same message sent X times in a row within Y seconds is an offence
        </label>
        {spam.enabled && (
          <div style={{ display: 'flex', gap: '16px' }}>
            <div style={{ flex: 1 }}>
              <span style={label}>Times in a row (2 to 20)</span>
              <input
                id="spam-repeat-count"
                type="number"
                min={2}
                max={20}
                className="form-control"
                value={spam.repeatCount}
                onChange={(e) => setSpam({ ...spam, repeatCount: parseInt(e.target.value) || 2 })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <span style={label}>Within seconds (1 to 3600)</span>
              <input
                id="spam-window-seconds"
                type="number"
                min={1}
                max={3600}
                className="form-control"
                value={spam.windowSeconds}
                onChange={(e) => setSpam({ ...spam, windowSeconds: parseInt(e.target.value) || 1 })}
              />
            </div>
          </div>
        )}

        {ladder.length === 0 && (
          <div style={{ fontSize: '12px', color: '#fbbf24' }}>No ladder set: no automatic penalty is applied.</div>
        )}
        {ladder.map((tier, idx) => (
          <div
            key={idx}
            style={{
              display: 'grid',
              gridTemplateColumns: '40px 1fr 1fr 1fr auto',
              gap: '12px',
              alignItems: 'center',
              padding: '14px 16px',
              background: 'rgba(255,255,255,0.03)',
              borderRadius: '10px',
              border: '1px solid var(--border)',
            }}
          >
            <strong>{tier.tier}</strong>
            <select
              className="form-control"
              value={tier.action}
              onChange={(e) => updateTier(idx, 'action', e.target.value)}
            >
              <option value="WARNING">Warning</option>
              <option value="BAN">Ban</option>
            </select>
            {tier.action === 'BAN' ? (
              <DurationInput seconds={tier.durationSeconds} onChange={(s) => updateTier(idx, 'durationSeconds', s)} />
            ) : (
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>—</span>
            )}
            <input
              type="number"
              min={1}
              className="form-control"
              title="Reset window (hours)"
              value={tier.resetWindowHours}
              onChange={(e) => updateTier(idx, 'resetWindowHours', parseInt(e.target.value) || 1)}
            />
            <button onClick={() => removeTier(idx)} title="Remove tier" className="btn-secondary">
              <IconTrash size={13} />
            </button>
          </div>
        ))}
        <button className="btn-secondary" onClick={addTier} style={{ alignSelf: 'flex-start', display: 'flex', gap: '6px' }}>
          <IconPlus size={13} /> Add tier
        </button>
        {ladder.length > 0 && (
          <div style={{ fontSize: '12px', color: '#fbbf24' }}>
            Escalation:{' '}
            {ladder
              .map((t) => (t.action === 'WARNING' ? 'Warning' : `Ban (${t.permanent ? 'permanent' : secondsToLabel(t.durationSeconds)})`))
              .join(' → ')}
          </div>
        )}
        <button className="btn-primary" onClick={save} disabled={saving} style={{ alignSelf: 'flex-start' }}>
          {saving ? 'Saving…' : 'Save chat-wide rules'}
        </button>
      </div>
    </div>
  );
};
