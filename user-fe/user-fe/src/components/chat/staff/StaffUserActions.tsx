'use client';

/** What a staff member may do to one user: warn, ban, restrict and change room access (chat roles are given in the admin panel only). */
import React, { useState } from 'react';
import * as staffApi from '@/lib/api/staff';
import type { RoomItem } from '@/types/chat';
import { Btn, ModeBadge, OutcomeBanner, ui, useStaffAction } from './staffUi';

/** The permission behind each restriction kind (chat.permissions.ts RESTRICTION_PERMISSIONS). */
const KIND_PERMISSION: Record<staffApi.RestrictionKind, string[]> = {
  MUTE: ['BAN'],
  RESTRICT_MEDIA: ['MANAGE_PICTURES', 'MANAGE_VIDEOS'],
  RESTRICT_EMOJI: ['RESTRICT_EMOJI'],
  RESTRICT_GIF: ['RESTRICT_GIF'],
  RESTRICT_COMMANDS: ['RESTRICT_COMMANDS'],
  RESTRICT_ADS: ['RESTRICT_ADS'],
  RESTRICT_DM: ['RESTRICT_DM'],
  RESTRICT_GIFTS: ['RESTRICT_GIFTS'],
  RESTRICT_RECEIVE_GIFTS: ['RESTRICT_GIFTS'],
  RESTRICT_RAIN: ['RESTRICT_RAIN'],
  RESTRICT_RAIN_RECEIVE: ['RESTRICT_RAIN_RECEIVE'],
  RESTRICT_PIN: ['PIN'],
  RESTRICT_DELETE_MESSAGES: ['DELETE_MESSAGES'],
  RESTRICT_HISTORY: ['SEE_HISTORY'],
  RESTRICT_STAFF_ROOM: ['JOIN_STAFF_ROOM'],
  RESTRICT_IMAGES: ['MANAGE_PICTURES'],
  RESTRICT_VIDEOS: ['MANAGE_VIDEOS'],
};

const KIND_LABEL: Record<staffApi.RestrictionKind, string> = {
  MUTE: 'Mute (cannot send)',
  RESTRICT_MEDIA: 'No pictures / videos',
  RESTRICT_EMOJI: 'No emoji',
  RESTRICT_GIF: 'No GIFs',
  RESTRICT_COMMANDS: 'No commands (choose)',
  RESTRICT_ADS: 'No ads',
  RESTRICT_DM: 'No DMs to strangers',
  RESTRICT_GIFTS: 'Cannot send money',
  RESTRICT_RECEIVE_GIFTS: 'Cannot receive money',
  RESTRICT_RAIN: 'Cannot rain (restrict raining ability)',
  RESTRICT_RAIN_RECEIVE: 'Cannot receive rains',
  RESTRICT_PIN: 'Cannot pin messages',
  RESTRICT_DELETE_MESSAGES: 'Cannot delete messages',
  RESTRICT_HISTORY: 'Cannot see chat history',
  RESTRICT_STAFF_ROOM: 'Cannot enter the Staff room',
  RESTRICT_IMAGES: 'No pictures',
  RESTRICT_VIDEOS: 'No videos',
};

interface Props {
  perms: staffApi.StaffPermissions;
  rooms: RoomItem[];
  activeRoomId: string | null;
  target: { id: string; username: string };
}

export default function StaffUserActions({ perms, rooms, activeRoomId, target }: Props) {
  const [roomId, setRoomId] = useState<string>(activeRoomId ?? '');
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(24);
  const [kind, setKind] = useState<staffApi.RestrictionKind>('MUTE');
  const [commands, setCommands] = useState<string[]>([]);
  const { busy, outcome, setOutcome, run } = useStaffAction();
  const mode = (p: string) => perms.permissions[p] ?? 'NONE';
  const kindMode = (k: staffApi.RestrictionKind) =>
    KIND_PERMISSION[k].map(mode).find((m) => m === 'ACT') ?? KIND_PERMISSION[k].map(mode).find((m) => m === 'REPORT') ?? 'NONE';
  const kinds = staffApi.RESTRICTION_KINDS.filter((k) => kindMode(k) !== 'NONE');
  const room = roomId || undefined;

  const needReason = () => {
    if (reason.trim()) return true;
    setOutcome({ tone: 'error', text: 'Write a reason first' });
    return false;
  };

  return (
    <div style={ui.section}>
      <OutcomeBanner outcome={outcome} />
      <div style={{ ...ui.row, marginBottom: '0.6rem' }}>
        <select value={roomId} onChange={(e) => setRoomId(e.target.value)} style={ui.input}>
          <option value="">All of chat</option>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (the user sees it)"
          style={{ ...ui.input, flex: 1 }}
        />
        <input
          type="number"
          min={1}
          max={perms.maxBanHours}
          value={hours}
          onChange={(e) => setHours(Number(e.target.value) || 1)}
          style={{ ...ui.input, width: '4.5rem' }}
          title="Hours"
        />
        <span style={ui.muted}>h</span>
      </div>

      <div style={{ ...ui.row, marginBottom: '0.6rem' }}>
        {mode('WARN') !== 'NONE' && (
          <Btn
            disabled={!!busy}
            onClick={() => needReason() && run('warn', () => staffApi.warnUser({ userId: target.id, roomId: room, internalReason: reason.trim() }), 'Warning sent')}
          >
            Warn<ModeBadge mode={mode('WARN')} />
          </Btn>
        )}
        {mode('BAN') !== 'NONE' && (
          <Btn
            tone="danger"
            disabled={!!busy}
            onClick={() =>
              needReason() &&
              run('ban', () => staffApi.banUser({ userId: target.id, roomId: room, internalReason: reason.trim(), durationHours: hours }), 'Banned')
            }
          >
            Ban {hours} h<ModeBadge mode={mode('BAN')} />
          </Btn>
        )}
        {perms.role === 'ADMIN' && (
          <Btn
            tone="danger"
            disabled={!!busy}
            onClick={() =>
              needReason() &&
              confirm(`Ban @${target.username} permanently?`) &&
              run('ban', () => staffApi.banUser({ userId: target.id, roomId: room, internalReason: reason.trim(), permanent: true }), 'Banned permanently')
            }
          >
            Ban permanently
          </Btn>
        )}
      </div>

      {kinds.length > 0 && (
        <div style={{ ...ui.row, marginBottom: '0.6rem' }}>
          <select value={kind} onChange={(e) => setKind(e.target.value as staffApi.RestrictionKind)} style={ui.input}>
            {kinds.map((k) => (
              <option key={k} value={k}>{KIND_LABEL[k]}</option>
            ))}
          </select>
          {kind === 'RESTRICT_COMMANDS' &&
            (perms.restrictableCommands.length ? perms.restrictableCommands : [...staffApi.CHAT_COMMANDS]).map((c) => (
              <label key={c} style={ui.muted}>
                <input
                  type="checkbox"
                  checked={commands.includes(c)}
                  onChange={(e) => setCommands((prev) => (e.target.checked ? [...prev, c] : prev.filter((x) => x !== c)))}
                />{' '}
                /{c}
              </label>
            ))}
          <Btn
            disabled={!!busy}
            onClick={() =>
              needReason() &&
              run(
                'restrict',
                () =>
                  staffApi.restrict({
                    targetType: 'USER',
                    targetValue: target.id,
                    kind,
                    ...(kind === 'RESTRICT_COMMANDS' ? { commands } : {}),
                    roomId: room,
                    internalReason: reason.trim(),
                    durationHours: hours,
                  }),
                'Restriction added',
              )
            }
          >
            Restrict {hours} h<ModeBadge mode={kindMode(kind)} />
          </Btn>
        </div>
      )}

      <div style={ui.row}>
        {mode('ROOM_ACCESS') !== 'NONE' && roomId && (
          <>
            <span style={ui.muted}>Room access:</span>
            {(['REMOVE', 'ADD', 'RESTORE'] as const).map((action) => (
              <Btn
                key={action}
                disabled={!!busy}
                onClick={() => run(`access-${action}`, () => staffApi.setRoomAccess(roomId, target.id, action, reason.trim() || undefined), `Room access: ${action.toLowerCase()}`)}
              >
                {action === 'REMOVE' ? 'Remove from room' : action === 'ADD' ? 'Add to room' : 'Restore'}
                <ModeBadge mode={mode('ROOM_ACCESS')} />
              </Btn>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
