import { ERR } from '../../../contracts';
import type { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import { refuse } from '../chat.moderation.service';
import type { RoomControl } from '../chat.contract';
import type { ChatSettings } from '../chat.settings.contract';
import type { RoomRecord } from '../chat.types';

export type AvailabilityArea = 'chat' | 'publicChat' | 'skins' | 'giftsInChat' | 'ads';

const LABELS: Readonly<Record<AvailabilityArea, string>> = {
  chat: 'Chat',
  publicChat: 'Public chat',
  skins: 'Chat skins',
  giftsInChat: 'Sending money from chat',
  ads: 'Chat ads',
};

/** OFF refuses everything; MAINTENANCE still lets users read but refuses writes. */
export function availabilityRefusal(
  settings: ChatSettings,
  area: AvailabilityArea,
  write: boolean,
): ProblemException | null {
  const { maintenance } = settings;
  const status = maintenance[area];
  if (status === 'ACTIVE' || (status === 'MAINTENANCE' && !write)) return null;
  const label = LABELS[area];
  if (status === 'MAINTENANCE') {
    return refuse(
      ERR.FORBIDDEN,
      CHAT_REFUSAL_REASONS.FEATURE_MAINTENANCE,
      maintenance.note ?? `${label} is under maintenance`,
      { area, status },
    );
  }
  return refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.FEATURE_DISABLED, `${label} is off`, {
    area,
    status,
  });
}

export function assertAvailable(
  settings: ChatSettings,
  area: AvailabilityArea,
  write: boolean,
): void {
  const refusal = availabilityRefusal(settings, area, write);
  if (refusal) throw refusal;
}

const CONTROL_LABELS: Readonly<Record<RoomControl, string>> = {
  TEXT: 'Text messages',
  EMOJI: 'Emoji',
  GIF: 'GIFs',
  IMAGE: 'Images',
  VIDEO: 'Videos',
  COMMANDS: 'Commands',
  ADS: 'Ads',
};

/**
 * Chat SETTINGS "ON / OFF / MAINTENANCE: Chat Room Controls": a control under maintenance in the room refuses with the
 * maintenance text (the room's, else chat's), whatever its ON / OFF switch says.
 */
export function roomControlRefusal(
  room: RoomRecord,
  settings: ChatSettings,
  control: RoomControl,
): ProblemException | null {
  if (!room.config.controlsMaintenance.includes(control)) return null;
  return refuse(
    ERR.FORBIDDEN,
    CHAT_REFUSAL_REASONS.FEATURE_MAINTENANCE,
    room.config.statusNote ?? settings.maintenance.note ?? `${CONTROL_LABELS[control]} are under maintenance in this room`,
    { control, roomId: room.id },
  );
}

export function assertRoomControl(room: RoomRecord, settings: ChatSettings, control: RoomControl): void {
  const refusal = roomControlRefusal(room, settings, control);
  if (refusal) throw refusal;
}

/** A public-chat read or write needs both the whole of chat and public chat to be open. */
export function assertPublicChatOpen(settings: ChatSettings, write: boolean): void {
  assertAvailable(settings, 'chat', write);
  assertAvailable(settings, 'publicChat', write);
}

/** An automatic moderation check runs only while its switch is ACTIVE. */
export function autoModerationActive(
  settings: ChatSettings,
  check: 'autoModLinks' | 'autoModWords' | 'autoModSpam',
): boolean {
  return settings.maintenance[check] === 'ACTIVE';
}
