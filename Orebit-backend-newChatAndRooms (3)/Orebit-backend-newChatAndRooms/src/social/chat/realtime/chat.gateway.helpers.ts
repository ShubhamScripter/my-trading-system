/**
 * Small pure helpers for ChatGateway: the flood bucket, the send payload mapping and the last-room hint.
 * They hold no state of their own, so they are easy to read and to test apart from the socket.
 */
import { LIMITS } from '../chat.constants';
import type { SendMessageDto } from '../chat.dto';
import type { SendInput } from '../chat.service';

// Flood bucket
/** One socket's allowance: how many events it may still send, and when that was last worked out. */
export interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Refills the bucket for the time passed (`rate` tokens a second, never above `burst`) and takes one token.
 * Returns 0 when the event may go on, otherwise the whole seconds the sender must wait before it can.
 */
export function takeToken(bucket: Bucket, rate: number, burst: number, now: number): number {
  const secondsPassed = (now - bucket.at) / 1000;
  bucket.tokens = Math.min(burst, bucket.tokens + secondsPassed * rate);
  bucket.at = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return 0;
  }
  return Math.max(1, Math.ceil((1 - bucket.tokens) / rate));
}

// Send payload
/**
 * Turns the socket payload into what ChatService.sendMessage reads. Fields the client left out stay out of the
 * result (never `undefined`), and a media message's text becomes the media caption.
 */
export function toSendInput(payload: SendMessageDto, currentRoomId: string | null): SendInput {
  const input: SendInput = { roomRef: payload.roomId ?? currentRoomId ?? undefined };

  if (payload.content !== undefined) input.content = payload.content;

  if (payload.mediaUrl !== undefined) {
    input.media = { url: payload.mediaUrl, type: payload.mediaType ?? 'image' };
    if (payload.content !== undefined) input.media.caption = payload.content;
    if (payload.thumbnailUrl !== undefined) input.media.thumbnailUrl = payload.thumbnailUrl;
  }

  if (payload.skinId) input.skinId = payload.skinId;
  if (payload.clientMessageId) input.clientMessageId = payload.clientMessageId;
  return input;
}

// Last room
/**
 * The room to open first: the one the server remembers, else the browser's hint from the handshake.
 * Anything that is not a plain, short string is ignored.
 */
export function readLastRoomHint(serverLastRoom: unknown, handshakeAuth: unknown): string | null {
  const browserHint = (handshakeAuth as Record<string, unknown> | undefined)?.lastRoomId;
  const hint = serverLastRoom ?? browserHint;
  const usable =
    typeof hint === 'string' && hint.length > 0 && hint.length <= LIMITS.ROOM_REF_CHARS;
  return usable ? hint : null;
}
