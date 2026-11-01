/**
 * The one place a stored personal-chat message becomes what a member receives (history, live events, search,
 * pinned and shared lists).
 *  - A retracted message keeps its text only for its sender (admins read it in the panel with the retracted tag).
 *  - A message a group admin deleted ("only deleted on user end") shows no content to anyone in the app.
 *  - Upload links are signed for the reader, as in public chat.
 */
import { signMediaUrl } from '../chat.upload';
import type { DmMessageRow, DmMetadata } from './dm.dboperation';

export interface DmMessageView {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly senderUsername: string | null;
  readonly content: string;
  readonly type: DmMessageRow['type'];
  readonly media: DmMetadata['media'] | null;
  readonly gift: DmMetadata['gift'] | null;
  readonly card: DmMetadata['card'] | null;
  readonly forwarded: DmMetadata['forwarded'] | null;
  readonly event: DmMetadata['event'] | null;
  readonly createdAt: string;
  readonly isRetracted: boolean;
  readonly isHidden: boolean;
  readonly isPinned: boolean;
  /** Only to the sender, so a retried send can be matched. */
  readonly clientMessageId?: string;
}

export function toDmView(row: DmMessageRow, viewerId: string): DmMessageView {
  const isSender = row.senderId === viewerId;
  const isRetracted = row.retractedAt !== null;
  const isHidden = row.hiddenAt !== null;
  const blank = isHidden || (isRetracted && !isSender);
  const media = row.metadata.media;
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    senderUsername: row.senderUsername,
    content: blank ? '' : row.content,
    type: row.type,
    media:
      blank || !media
        ? null
        : {
            ...media,
            url: signMediaUrl(media.url),
            ...(media.thumbnailUrl ? { thumbnailUrl: signMediaUrl(media.thumbnailUrl) } : {}),
          },
    gift: blank ? null : (row.metadata.gift ?? null),
    card: blank ? null : (row.metadata.card ?? null),
    forwarded: row.metadata.forwarded ?? null,
    event: row.metadata.event ?? null,
    createdAt: row.createdAt.toISOString(),
    isRetracted,
    isHidden,
    isPinned: row.pinnedAt !== null,
    ...(isSender && row.clientMessageId ? { clientMessageId: row.clientMessageId } : {}),
  };
}
