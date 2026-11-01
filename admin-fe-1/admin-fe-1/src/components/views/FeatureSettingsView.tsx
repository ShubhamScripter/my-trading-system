import React, { useEffect, useState } from 'react';
import { AdminRoom } from '../../types';
import { AdminAPI } from '../../services/api';
import { ModulesAPI } from '../../services/modulesApi';
import { SectionEditor } from './SectionEditor';
import { StaffRolesMatrix } from './StaffRolesMatrix';

/**
 * The chat-wide settings of Modules 4–9 (Chat SETTINGS and Chat DM Settings): staff role permissions, commands,
 * sending money, ads, rewards, the chat bot, direct messages, groups and privacy defaults. Each section saves on its
 * own, now or at a scheduled time, through the same versioned settings route as Platform Settings (rollback there).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- settings values are free-form JSON */

interface Props {
  rooms: AdminRoom[];
  onShowToast: (msg: string, type?: 'success' | 'danger') => void;
}

const SECTIONS: { key: string; label: string; about: string }[] = [
  { key: 'staffRoles', label: 'Staff roles', about: 'What ADMIN, MODERATOR and SUPPORT may do: ACT themselves, REPORT to a higher role, or neither.' },
  { key: 'commands', label: 'Commands', about: 'Switch all chat commands off, or only some. Rooms also choose their own commands.' },
  { key: 'gifts', label: 'Sending money', about: 'On / off, limits in USD and per currency, gifts to muted or blocked users, payment PIN or 2FA.' },
  { key: 'ads', label: 'Ads', about: 'Prices (+% of base or USD), links, pinned slots, badges, skins, repeats and discounts, the ad tab.' },
  { key: 'rewards', label: 'Rewards', about: 'EXP and universal currency per advert and per gift: FIXED, or DYNAMIC (amount per every X USD, at least 1).' },
  { key: 'bot', label: 'Chat bot', about: 'The account automated alerts are posted under (empty = the platform name).' },
  { key: 'dm', label: 'Direct messages', about: 'On / off / maintenance, the new-conversation rate limit, pinned people and messages.' },
  { key: 'maintenance', label: 'On / Off / Maintenance', about: 'Whole chat, public chat, skins, sending money, ads, each auto-moderation check and chosen commands: ACTIVE, MAINTENANCE (users read, cannot write) or DISABLED. Schedule a change from the settings page.' },
  { key: 'groups', label: 'Groups', about: 'How many groups users create and join (Premium separately), admins, members, ownership transfers, and what owners may delegate.' },
  { key: 'privacy', label: 'Privacy defaults', about: 'Defaults for last seen, common groups, notifications and quiet mode; whether users may set their own quiet hours.' },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FeatureSettingsView: React.FC<Props> = ({ rooms, onShowToast }) => {
  const [section, setSection] = useState('staffRoles');
  const [settings, setSettings] = useState<Record<string, any> | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [effectiveAt, setEffectiveAt] = useState('');
  const [botHandle, setBotHandle] = useState('');
  const [saving, setSaving] = useState(false);
  /** Bumped to rebuild the editors from saved values (after a load or a discard). */
  const [resetCount, setResetCount] = useState(0);

  const load = async () => {
    try {
      const preview = await AdminAPI.previewSettings();
      // The route answers the effective settings, or { settings } on older builds.
      setSettings(((preview as any)?.settings ?? preview) as Record<string, any>);
      setDraft({});
      setResetCount((n) => n + 1);
    } catch {
      onShowToast('Could not load the chat settings', 'danger');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = draft[section] ?? settings?.[section];
  const dirty = draft[section] !== undefined;

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      const res = await AdminAPI.saveSettings(
        { global: { [section]: draft[section] } },
        effectiveAt ? new Date(effectiveAt).toISOString() : undefined,
      );
      if (res.success) {
        onShowToast(effectiveAt ? 'Change scheduled' : 'Saved; the chat server applies it at once');
        setEffectiveAt('');
        await load();
      } else {
        const field = (res as any).errors?.[0];
        onShowToast(field ? `${field.path}: ${field.message}` : res.error || 'Could not save', 'danger');
      }
    } finally {
      setSaving(false);
    }
  };

  const setBot = async () => {
    const handle = botHandle.trim().replace(/^@/, '');
    if (!handle) {
      setDraft({ ...draft, bot: { profileUserId: null } });
      return;
    }
    if (UUID.test(handle)) {
      setDraft({ ...draft, bot: { profileUserId: handle } });
      return;
    }
    try {
      const found = await ModulesAPI.userConversations(handle);
      setDraft({ ...draft, bot: { profileUserId: found.userId } });
      onShowToast(`@${handle} chosen; save to apply`);
    } catch {
      onShowToast(`User '${handle}' not found`, 'danger');
    }
  };

  const about = SECTIONS.find((s) => s.key === section)?.about;

  return (
    <section className="tab-view">
      <div className="card-section">
        <div className="card-header-row">
          <div>
            <h3>Feature Settings (Modules 4–9)</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Chat-wide; none of these vary by country. Every save is versioned — roll back from Platform Settings.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '12px 0' }}>
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              className={section === s.key ? 'btn-action' : 'btn-secondary'}
              onClick={() => setSection(s.key)}
            >
              {s.label}
              {draft[s.key] !== undefined ? ' •' : ''}
            </button>
          ))}
        </div>
        {about && <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '12px' }}>{about}</p>}

        {!settings && <div style={{ opacity: 0.6 }}>Loading…</div>}

        {settings && current && section === 'staffRoles' && (
          <StaffRolesMatrix value={current} rooms={rooms} onChange={(next) => setDraft({ ...draft, staffRoles: next })} />
        )}

        {settings && current && section === 'bot' && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'end' }}>
            <div className="form-group" style={{ flex: 1, maxWidth: '360px' }}>
              <label>Bot account (username or id; empty = platform name)</label>
              <input className="form-control" value={botHandle} onChange={(e) => setBotHandle(e.target.value)} placeholder={current.profileUserId ?? 'none'} />
            </div>
            <button className="btn-secondary" onClick={setBot}>Choose</button>
            <span style={{ fontSize: '12px', opacity: 0.7 }}>Now: {current.profileUserId ?? 'platform name'}</span>
          </div>
        )}

        {settings && current && section !== 'staffRoles' && section !== 'bot' && (
          <SectionEditor
            key={`${section}-${resetCount}`}
            value={current}
            onChange={(next) => setDraft({ ...draft, [section]: next })}
          />
        )}

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '16px' }}>
          <button className="btn-action" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : effectiveAt ? 'Schedule change' : 'Save section'}
          </button>
          <button
            className="btn-secondary"
            disabled={!dirty}
            onClick={() => {
              const next = { ...draft };
              delete next[section];
              setDraft(next);
              setResetCount((n) => n + 1);
            }}
          >
            Discard
          </button>
          <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            Apply at (optional){' '}
            <input type="datetime-local" className="form-control" style={{ display: 'inline-block', width: 'auto' }} value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} />
          </label>
        </div>
      </div>
    </section>
  );
};
