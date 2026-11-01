import { io, Socket } from "socket.io-client";
import { API_BASE } from "./api/client";
import type { Message, OnlineUser, RoomAccessEvaluation, RoomItem } from "@/types/chat";

/**
 * The ack payload for `send_message`, `retract_message`, `join_room`, `leave_room`.
 * Every handler returns one of these two shapes.
 */
export interface AckSuccess<T> {
  ok: true;
  data: T;
}

export interface AckError {
  type: string;
  title: string;
  detail?: string;
  extra?: Record<string, unknown>;
  errors?: { path: string; message: string }[];
  retryAfterSeconds?: number;
}

export interface AckFailure {
  ok: false;
  error: AckError;
}

export type AckResponse<T = Record<string, unknown>> = AckSuccess<T> | AckFailure;

/**
 * Server to client events emitted by the /chat namespace gateway
 */
export interface ServerToClientEvents {
  connect: () => void;
  disconnect: (reason: string) => void;
  connect_error: (error: Error) => void;
  new_message: (msg: Message) => void;
  new_messages: (data: { messages: Message[] } | Message[]) => void;
  rate_limit_cooldown: (data: { remainingSeconds: number; reason: string }) => void;
  message_retracted: (data: {
    messageId: string;
    roomId: string;
    retractedAt: string;
  }) => void;
  message_pinned: (data: {
    messageId: string;
    roomId: string;
  }) => void;
  /** Module 4: a lower staff role asked me to act (REPORT mode). Only to staff who may approve it. */
  staff_request: (data: {
    requestId: string;
    permission: string;
    requesterId: string;
    requesterUsername: string;
    targetUserId: string | null;
    targetRoomId: string | null;
    note: string;
    createdAt: string;
  }) => void;
  message_unpinned: (data: {
    messageId: string;
    roomId: string;
  }) => void;
  user_tagged: (data: {
    roomId: string;
    messageId: string;
    senderUsername: string;
    taggedUsernames: string[];
    content: string;
  }) => void;
  online_users: (data: { roomId?: string; count?: number; users?: OnlineUser[] }) => void;
  online_users_updated: (data: {
    roomId?: string;
    count?: number;
    users?: OnlineUser[];
  }) => void;
  online_count_updated: (data: { roomId: string; count: number }) => void;
  user_presence: (data: { userId: string; username: string; isOnline: boolean }) => void;
  room_access: (data: {
    status?: 'joined' | 'updated' | 'removed' | 'forbidden';
    roomId?: string;
    channelId?: string;
    access?: RoomAccessEvaluation | Partial<RoomItem>;
    onlineUsers?: OnlineUser[];
  }) => void;
  channel_access: (data: {
    roomId?: string;
    channelId?: string;
    access?: RoomAccessEvaluation | Partial<RoomItem>;
    onlineUsers?: OnlineUser[];
  }) => void;
  room_left: (data: { roomId?: string | null }) => void;
  leave_room: (data: unknown) => void;
  channel_left: (data: unknown) => void;
  rooms_changed: () => void;
  session_ended: (data: { reason: string }) => void;
  session_replaced: (data: { reason: string }) => void;
  // What the server sends (CH-090): the action and the moderator's note, only to the affected user.
  moderation_notice: (data: { action?: string; roomId?: string | null; messageId?: string | null; note?: string | null; expiresAt?: string | null }) => void;
  exception: (err: unknown) => void;

  // ─── DM / Groups real-time events (Modules 8–9, SERVER_EVENTS in chat.constants.ts) ───────
  /** A new message in a conversation I am in. `message` is the raw view: map it with dmApi.toMessage. */
  dm_message: (data: { conversationId: string; kind: 'DIRECT' | 'GROUP'; folder: string; message: unknown; notify: boolean }) => void;
  /** A stranger's message: a message request. */
  dm_request: (data: { conversationId: string; kind: 'DIRECT' | 'GROUP'; folder: string; message: unknown; notify: boolean }) => void;
  /** Read receipt: `userId` read up to `messageId`. */
  dm_read: (data: { conversationId: string; userId: string; messageId: string; readAt: string }) => void;
  /** "Typing…" from another member. */
  dm_typing: (data: { conversationId: string; userId: string; username: string; typing: boolean }) => void;
  /** A message changed in place (a join/leave notice that grew): `message` is the raw view. */
  dm_message_updated: (data: { conversationId: string; message: unknown }) => void;
  dm_message_retracted: (data: { conversationId: string; messageId: string; retractedAt: string | null }) => void;
  /** Hidden by a group admin or chat staff. */
  dm_message_hidden: (data: { conversationId: string; messageId: string }) => void;
  dm_message_pinned: (data: { conversationId: string; messageId: string }) => void;
  dm_message_unpinned: (data: { conversationId: string; messageId: string }) => void;
  /** My membership or the group changed (folder, removed, banned, renamed, permissions). */
  dm_conversation_updated: (data: { conversationId: string; [key: string]: unknown }) => void;
  /** Module 10: support answered or closed one of my tickets. */
  support_updated: (data: { ticketId: string; status: 'PENDING' | 'OPEN' | 'CLOSED' }) => void;

  // ─── Module 5 ───────────────────────────────────────────────────────────────
  gift_received: (data: { giftId: string; amount: string; currency: string; senderId: string; senderUsername: string; roomId: string | null; conversationId: string | null }) => void;
  ad_pinned: (data: { roomId: string; adId: string; [key: string]: unknown }) => void;
  ad_unpinned: (data: { roomId: string; adId: string }) => void;

  // ─── RainPool (Modules 6–7): sent only after the money moved ─────────────────
  /** A rain was paid in a room I am viewing. */
  rain_completed: (data: RainCompletedEvent) => void;
  /** My own share of a rain. */
  rain_received: (data: { rainId: string; kind: 'SYSTEM' | 'USER'; currency: string; amount: string }) => void;
  /** A rain I paid for or received from was reversed (or partly) by an admin. */
  rain_reversed: (data: { rainId: string; currency: string; reason: string; reclaimed?: string; partial?: boolean }) => void;
  /** The next Rainpool rain or a status changed. */
  rain_state: (data: {
    systemStatus: 'ON' | 'OFF' | 'MAINTENANCE';
    userStatus?: 'ON' | 'OFF' | 'MAINTENANCE';
    note?: string | null;
    nextRainAt: string | null;
    scheduledAt: string | null;
    nextCurrency: string | null;
    nextPot: string | null;
    nextPotUsd?: string | null;
  }) => void;
  /** An admin reviewing my rain asked for the questionnaire or a KYC check. */
  rain_verification_requested: (data: { rainId: string }) => void;
  /** An admin approved or rejected my rain under manual verification. */
  rain_reviewed: (data: { rainId: string; decision: 'APPROVE' | 'REJECT'; reason?: string | null }) => void;
  /** The RainPool settings or status changed: reload GET /social/rain/state. */
  rain_config_changed: () => void;
}

export interface RainCompletedEvent {
  rainId: string;
  kind: 'SYSTEM' | 'USER';
  roomId: string;
  currency: string;
  pot: string;
  usd: string | null;
  distributed: string;
  recipients: number;
  messageId: string | null;
}

/** A stored message, or what a command answered ("/mute @bob", "/help"…, Module 5). */
export interface SendMessageAckData {
  messageId?: string;
  createdAt?: string;
  command?: string;
  roomId?: string;
  result?: unknown;
}

export interface RetractMessageAckData {
  messageId: string;
  roomId: string;
  retractedAt: string;
}

export interface JoinRoomAckData {
  roomId: string;
  access?: RoomAccessEvaluation | Partial<RoomItem>;
  onlineCount: number;
}

export interface LeaveRoomAckData {
  roomId: string | null;
}

export interface SendMessagePayload {
  roomId?: string;
  content?: string;
  skinId?: string;
  clientMessageId?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'gif' | 'video';
  thumbnailUrl?: string;
}

export interface RetractMessagePayload {
  messageId: string;
  note?: string;
}

export interface ClientToServerEvents {
  send_message: (
    payload: SendMessagePayload,
    ack: (response: AckResponse<SendMessageAckData>) => void,
  ) => void;
  retract_message: (
    payload: RetractMessagePayload,
    ack: (response: AckResponse<RetractMessageAckData>) => void,
  ) => void;
  join_room: (
    payload: { roomId: string },
    ack: (response: AckResponse<JoinRoomAckData>) => void,
  ) => void;
  leave_room: (
    payload: { roomId?: string },
    ack: (response: AckResponse<LeaveRoomAckData>) => void,
  ) => void;
  get_online_users: (
    payload: { roomId?: string; limit?: number; cursor?: string; prefix?: string },
    ack: (response: AckResponse<unknown>) => void,
  ) => void;
  /** DM typing indicator (Module 8): at most one "typing" every 2 s per conversation. */
  dm_typing: (payload: { conversationId: string; typing: boolean }) => void;
}

export type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Connects to the /chat namespace gateway.
 * Accepts cookie session auth via withCredentials: true.
 * Optional token and lastRoomHint can be provided.
 */
export function createChatSocket(token?: string | null, lastRoomHint?: string | null): ChatSocket {
  const socketBase = API_BASE.replace(/\/social\/chat\/?$/, '').replace(/\/api\/?$/, '');
  return io(`${socketBase}/chat`, {
    // The session cookie is the only login (D-06); no token is ever sent. `token` is kept in the signature only so
    // existing callers compile.
    auth: {
      ...(lastRoomHint ? { lastRoomId: lastRoomHint } : {}),
    },
    withCredentials: true,
    transports: ["websocket", "polling"],
    autoConnect: true,
    reconnectionAttempts: 5,
  });
}
