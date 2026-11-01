'use client';

/**
 * Chat-wide switches: "Disable Specific / All Commands from chat", "Disable / Enable Sending Money from Chat", and
 * "Disable Overall / Rainpool / User Rains".
 */
import React, { useState } from 'react';
import * as staffApi from '@/lib/api/staff';
import { Btn, ModeBadge, OutcomeBanner, ui, useStaffAction } from './staffUi';

const RAIN_SWITCHES = [
  { scope: 'OVERALL', permission: 'DISABLE_OVERALL_RAINS', title: 'All rains (user and Rainpool)', name: 'All rains' },
  { scope: 'SYSTEM', permission: 'DISABLE_RAINPOOL_RAINS', title: 'Rainpool rains', name: 'Rainpool rains' },
  { scope: 'USER', permission: 'DISABLE_USER_RAINS', title: 'User rains (/rain)', name: 'User rains' },
] as const;

export default function StaffChatWideTab({ perms }: { perms: staffApi.StaffPermissions }) {
  const [disabled, setDisabled] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const { busy, outcome, run } = useStaffAction();
  const mode = (p: string) => perms.permissions[p] ?? 'NONE';
  const withNote = note.trim() ? { note: note.trim() } : {};

  return (
    <div>
      <OutcomeBanner outcome={outcome} />
      <div style={{ ...ui.row, marginBottom: '0.75rem' }}>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why (recorded; sent with a request to a higher role)"
          style={{ ...ui.input, flex: 1 }}
        />
      </div>

      {mode('DISABLE_COMMANDS') !== 'NONE' && (
        <div style={ui.section}>
          <div style={ui.title}>
            Commands
            <ModeBadge mode={mode('DISABLE_COMMANDS')} />
          </div>
          <div style={{ ...ui.row, marginBottom: '0.6rem' }}>
            {staffApi.CHAT_COMMANDS.map((c) => (
              <label key={c} style={ui.muted}>
                <input
                  type="checkbox"
                  checked={disabled.includes(c)}
                  onChange={(e) => setDisabled((prev) => (e.target.checked ? [...prev, c] : prev.filter((x) => x !== c)))}
                />{' '}
                /{c}
              </label>
            ))}
          </div>
          <div style={ui.row}>
            <Btn disabled={!!busy} onClick={() => run('cmds', () => staffApi.setCommands({ disabled, ...withNote }), 'Command list saved')}>
              Switch off the ticked commands
            </Btn>
            <Btn tone="danger" disabled={!!busy} onClick={() => run('cmds-off', () => staffApi.setCommands({ enabled: false, ...withNote }), 'All commands are off')}>
              All commands off
            </Btn>
            <Btn disabled={!!busy} onClick={() => run('cmds-on', () => staffApi.setCommands({ enabled: true, disabled: [], ...withNote }), 'All commands are on')}>
              All commands on
            </Btn>
          </div>
        </div>
      )}

      {RAIN_SWITCHES.filter((s) => mode(s.permission) !== 'NONE').map((s) => (
        <div key={s.scope} style={ui.section}>
          <div style={ui.title}>
            {s.title}
            <ModeBadge mode={mode(s.permission)} />
          </div>
          <div style={ui.row}>
            <Btn
              tone="danger"
              disabled={!!busy}
              onClick={() => run(`rain-${s.scope}-off`, () => staffApi.setRainStatus(s.scope, 'OFF', note.trim() || undefined), `${s.name} are off`)}
            >
              Turn off
            </Btn>
            <Btn
              disabled={!!busy}
              onClick={() => run(`rain-${s.scope}-on`, () => staffApi.setRainStatus(s.scope, 'ON', note.trim() || undefined), `${s.name} are on`)}
            >
              Turn on
            </Btn>
          </div>
        </div>
      ))}

      {mode('SENDING_MONEY') !== 'NONE' && (
        <div style={ui.section}>
          <div style={ui.title}>
            Sending money through chat
            <ModeBadge mode={mode('SENDING_MONEY')} />
          </div>
          <div style={ui.row}>
            <Btn tone="danger" disabled={!!busy} onClick={() => run('gifts-off', () => staffApi.setGiftsEnabled(false, note.trim() || undefined), 'Sending money is off')}>
              Turn off
            </Btn>
            <Btn disabled={!!busy} onClick={() => run('gifts-on', () => staffApi.setGiftsEnabled(true, note.trim() || undefined), 'Sending money is on')}>
              Turn on
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
