import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Client } from 'pg';
import { ChatBus } from './realtime/chat.bus';
import { ChatDbOperation } from './chat.dboperation';
import { ChatRecordsDbOperation } from './persistence/chat.records.dboperation';

/** The channel the admin backend notifies, with `{ "actionId": "<chat.moderation_actions id>" }`. */
export const CHAT_EVENTS_CHANNEL = 'chat_events';

/**
 * The names the admin backend records in chat.moderation_actions, mapped to the change each one means here.
 * Used only when replaying actions after the LISTEN connection comes back; live changes arrive as `{ kind }`.
 * `WARN` is left out on purpose: a warn from a report is also recorded as `REPORT_WARN`, which is the one used.
 */
const ADMIN_ACTION_NAMES: Readonly<Record<string, string>> = {
  BAN: 'ban.create',
  BROADCAST: 'broadcast',
  CHANGE_BAN: 'ban.change',
  CHANGE_RESTRICTION: 'restrictions.change',
  UNBAN: 'ban.lift',
  RETRACT: 'message.retract',
  ASSIGN_ROLE: 'role.assign',
  REMOVE_ROLE: 'role.assign',
  CREATE_ROOM: 'room.create',
  UPDATE_ROOM: 'room.update',
  DELETE_ROOM: 'room.delete',
  UPDATE_RULES: 'room.rules',
  UPDATE_MODERATION_SETTINGS: 'room.moderation',
  CREATE_REGION: 'region.create',
  UPDATE_REGION: 'region.update',
  DELETE_REGION: 'region.delete',
  'test_providers.upsert': 'role.assign',
  'test_providers.delete': 'role.assign',
  REPORT_BAN: 'report.action',
  REPORT_WARN: 'report.action',
  REPORT_RETRACT_MESSAGE: 'report.action',
  // Modules 4–5.
  RESTRICT_USER: 'restrictions.change',
  LIFT_RESTRICTION: 'restrictions.change',
  CREATE_AD: 'ad.change',
  CANCEL_AD: 'ad.change',
  RESOLVE_STAFF_REQUEST: 'staff_request.change',
  SUPPORT_REPLY: 'support.change',
  SUPPORT_CLOSE: 'support.change',
  // Modules 6–7 (the admin panel's RainPool actions).
  RAIN_SETTINGS: 'rain.change',
  RAIN_STATUS: 'rain.change',
  RAIN_SCHEDULE_STATUS: 'rain.change',
  RAIN_DEV_PRICES: 'rain.change',
  RAIN_REQUEST_VERIFICATION: 'rain.request',
};

type AdminAction = NonNullable<Awaited<ReturnType<ChatRecordsDbOperation['moderationActionById']>>>;

/** Listens for PostgreSQL LISTEN/NOTIFY events on 'chat_events' to sync admin changes to live sockets. */
@Injectable()
export class ChatEventsListener implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ChatEventsListener');
  private client: Client | null = null;
  private stopped = false;
  private retryMs = 1_000;
  private lastProcessed: Date | null = null;
  private readonly seen = new Set<string>();

  constructor(
    private readonly db: ChatDbOperation,
    private readonly records: ChatRecordsDbOperation,
    private readonly bus: ChatBus,
  ) {}

  /** The connection string: a dedicated direct URL if configured, else the direct database URL. */
  static connectionString(): string | null {
    return (
      process.env.CHAT_LISTEN_DATABASE_URL ??
      process.env.DATABASE_DIRECT_URL ??
      process.env.DATABASE_URL ??
      null
    );
  }

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test' && !process.env.CHAT_LISTEN_DATABASE_URL) return;
    void this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const url = ChatEventsListener.connectionString();
    if (!url || this.stopped) return;
    const client = new Client({ connectionString: url });
    client.on('error', (err) => {
      this.logger.warn({ component: 'ChatEventsListener', err }, 'chat LISTEN connection error');
    });
    client.on('end', () => {
      if (this.client === client) this.client = null;
      this.scheduleReconnect();
    });
    client.on('notification', (message) => {
      if (message.channel !== CHAT_EVENTS_CHANNEL || !message.payload) return;
      void this.onNotification(message.payload);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHAT_EVENTS_CHANNEL}`);
      this.client = client;
      this.retryMs = 1_000;
      if (this.lastProcessed === null) {
        this.lastProcessed = await this.db.dbNow();
      } else {
        await this.replay();
      }
      this.logger.log({ component: 'ChatEventsListener' }, 'listening for admin chat changes');
    } catch (err: unknown) {
      this.logger.warn(
        { component: 'ChatEventsListener', err },
        'could not LISTEN for admin chat changes; retrying',
      );
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    setTimeout(() => void this.connect(), delay).unref();
  }

  private async replay(): Promise<void> {
    if (!this.lastProcessed) return;
    const actions = await this.records.adminActionsSince(this.lastProcessed);
    for (const action of actions) this.dispatch(action);
    if (actions.length > 0)
      this.logger.log(
        { component: 'ChatEventsListener', count: actions.length },
        'replayed admin chat changes',
      );
  }

  private async onNotification(payload: string): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    // The admin backend sends the change itself (`{ kind, ... }`), so it reaches open sockets at once.
    if (typeof parsed.kind === 'string') {
      this.dispatchChange(parsed);
      return;
    }
    const actionId = parsed.actionId;
    if (typeof actionId !== 'string') return;
    try {
      const action = await this.records.moderationActionById(actionId);
      if (action) this.dispatch(action);
    } catch (err: unknown) {
      this.logger.error(
        { component: 'ChatEventsListener', err, actionId },
        'could not read an admin chat change',
      );
    }
  }

  /** A change signal from the admin backend, validated field by field before it reaches the bus. */
  dispatchChange(change: Record<string, unknown>): void {
    // The replay cursor moves on live changes too, so a reconnect never sends them (and their notices) twice.
    // This process clock only orders the replay; nothing is stored or shown with it.
    this.lastProcessed = new Date();
    const str = (value: unknown): string | null =>
      typeof value === 'string' && value.length > 0 ? value : null;
    switch (change.kind) {
      case 'settings':
        this.bus.publish({ kind: 'settings' });
        return;
      case 'rain':
        this.bus.publish({ kind: 'rain' });
        return;
      case 'rain_request': {
        const userId = str(change.userId);
        const rainId = str(change.rainId);
        if (userId && rainId) this.bus.publish({ kind: 'rain_request', userId, rainId });
        return;
      }
      case 'room': {
        const roomId = str(change.roomId);
        if (roomId) this.bus.publish({ kind: 'room', roomId });
        return;
      }
      case 'user': {
        const userId = str(change.userId);
        if (userId) this.bus.publish({ kind: 'user', userId });
        return;
      }
      case 'ban': {
        const userId = str(change.userId);
        if (userId) this.bus.publish({ kind: 'ban', userId });
        return;
      }
      case 'alert': {
        const ids = Array.isArray(change.messageIds)
          ? change.messageIds.filter((id): id is string => typeof id === 'string')
          : [];
        if (ids.length > 0) this.bus.publish({ kind: 'alert', messageIds: ids });
        // A broadcast to many rooms names only its id (a database notice is small); the alerts are read by that id.
        const broadcastId = str(change.broadcastId);
        if (broadcastId) {
          void this.db
            .broadcastMessages(broadcastId)
            .then((rows) => this.bus.publish({ kind: 'alert', messageIds: rows.map((row) => row.id) }))
            .catch((err: unknown) => this.logger.warn({ err, broadcastId }, 'broadcast alert lookup failed'));
        }
        return;
      }
      case 'retract': {
        const messageId = str(change.messageId);
        const roomId = str(change.roomId);
        if (messageId && roomId) {
          this.bus.publish({
            kind: 'retract',
            messageId,
            roomId,
            retractedAt: str(change.retractedAt) ?? new Date().toISOString(),
          });
        }
        return;
      }
      case 'restrictions':
        this.bus.publish({ kind: 'restrictions' });
        return;
      case 'ad': {
        const adId = str(change.adId);
        if (adId) this.bus.publish({ kind: 'ad', adId });
        return;
      }
      case 'pin': {
        const messageId = str(change.messageId);
        const roomId = str(change.roomId);
        if (messageId && roomId) {
          this.bus.publish({ kind: 'pin', messageId, roomId, pinned: change.pinned !== false });
        }
        return;
      }
      case 'dm_hidden': {
        const conversationId = str(change.conversationId);
        const messageId = str(change.messageId);
        if (conversationId && messageId)
          this.bus.publish({ kind: 'dm_hidden', conversationId, messageId });
        return;
      }
      case 'staff_request': {
        const requestId = str(change.requestId);
        if (requestId) this.bus.publish({ kind: 'staff_request', requestId });
        return;
      }
      case 'support': {
        const userId = str(change.userId);
        const ticketId = str(change.ticketId);
        const status = str(change.status);
        if (userId && ticketId && status)
          this.bus.publish({ kind: 'support', userId, ticketId, status });
        return;
      }
      case 'notice': {
        const userId = str(change.userId);
        const notice = (change.notice ?? {}) as Record<string, unknown>;
        const action = str(notice.action);
        if (userId && action) {
          this.bus.publish({
            kind: 'notice',
            userId,
            notice: {
              action: action.toLowerCase(),
              roomId: str(notice.roomId),
              messageId: str(notice.messageId),
              note: str(notice.note),
              expiresAt: str(notice.expiresAt),
            },
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /** Turns one admin action into the changes open chats must see. */
  dispatch(action: AdminAction): void {
    if (this.seen.has(action.id)) return;
    this.seen.add(action.id);
    if (this.seen.size > 10_000) this.seen.clear();
    if (!this.lastProcessed || action.created_at > this.lastProcessed)
      this.lastProcessed = action.created_at;

    // A report action records which action it took in its name (REPORT_BAN…); the handler reads it from the value.
    const value: Record<string, unknown> = action.action.startsWith('REPORT_')
      ? { ...(action.new_value ?? {}), action: action.action.slice('REPORT_'.length) }
      : (action.new_value ?? {});
    // The admin backend records its actions as BAN, RETRACT, UPDATE_ROOM… Map them to the names below so a
    // replay after the LISTEN connection comes back applies them too.
    const name = ADMIN_ACTION_NAMES[action.action] ?? action.action;
    const [area] = name.split('.');
    switch (name) {
      case 'broadcast': {
        const broadcastId = typeof value.broadcastId === 'string' ? value.broadcastId : null;
        if (broadcastId) {
          void this.db
            .broadcastMessages(broadcastId)
            .then((rows) =>
              this.bus.publish({ kind: 'alert', messageIds: rows.map((row) => row.id) }),
            )
            .catch((err: unknown) => this.logger.warn({ err, broadcastId }, 'broadcast alert lookup failed'));
        }
        return;
      }
      case 'message.retract':
        if (action.target_message_id && action.target_room_id) {
          this.bus.publish({
            kind: 'retract',
            messageId: action.target_message_id,
            roomId: action.target_room_id,
            retractedAt:
              typeof value.retractedAt === 'string'
                ? value.retractedAt
                : action.created_at.toISOString(),
          });
          if (action.target_user_id) {
            this.bus.publish({
              kind: 'notice',
              userId: action.target_user_id,
              notice: {
                action: 'retract',
                roomId: action.target_room_id,
                messageId: action.target_message_id,
                note: null,
              },
            });
          }
        }
        return;
      case 'ban.change':
        // A ban's end or reason changed: its user's ban cache is dropped and the user told (the end is on the row).
        if (action.target_user_id) this.bus.publish({ kind: 'ban', userId: action.target_user_id });
        return;
      case 'ban.create':
      case 'ban.lift':
        if (action.target_user_id) {
          this.bus.publish({ kind: 'ban', userId: action.target_user_id });
          this.bus.publish({
            kind: 'notice',
            userId: action.target_user_id,
            notice: {
              action: name === 'ban.create' ? 'ban' : 'unban',
              roomId: action.target_room_id,
              note: null,
              expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null,
            },
          });
        }
        return;
      case 'report.action':
        this.dispatchReportAction(action, value);
        return;
      case 'role.assign':
        if (action.target_user_id)
          this.bus.publish({ kind: 'user', userId: action.target_user_id });
        return;
      case 'restrictions.change':
        this.bus.publish({ kind: 'restrictions' });
        return;
      case 'ad.change':
        if (typeof value.adId === 'string') this.bus.publish({ kind: 'ad', adId: value.adId });
        return;
      case 'staff_request.change':
        if (typeof value.requestId === 'string')
          this.bus.publish({ kind: 'staff_request', requestId: value.requestId });
        return;
      case 'rain.change':
        this.bus.publish({ kind: 'rain' });
        return;
      case 'rain.request':
        if (action.target_user_id && typeof value.rainId === 'string') {
          this.bus.publish({ kind: 'rain_request', userId: action.target_user_id, rainId: value.rainId });
        }
        return;
      case 'support.change':
        if (action.target_user_id && typeof value.ticketId === 'string') {
          this.bus.publish({
            kind: 'support',
            userId: action.target_user_id,
            ticketId: value.ticketId,
            status: typeof value.status === 'string' ? value.status : 'OPEN',
          });
        }
        return;
      default:
        break;
    }

    if (area === 'room' || area === 'excluded') {
      if (action.target_room_id) this.bus.publish({ kind: 'room', roomId: action.target_room_id });
    } else if (area === 'settings' || area === 'region' || area === 'test_providers') {
      this.bus.publish({ kind: 'settings' });
    }
  }

  private dispatchReportAction(action: AdminAction, value: Record<string, unknown>): void {
    const userId = action.target_user_id;
    if (!userId) return;
    if (value.action === 'BAN') {
      this.bus.publish({ kind: 'ban', userId });
      this.bus.publish({
        kind: 'notice',
        userId,
        notice: {
          action: 'ban',
          roomId: action.target_room_id,
          note: null,
          expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null,
        },
      });
    } else if (value.action === 'WARN') {
      this.bus.publish({
        kind: 'notice',
        userId,
        notice: { action: 'warn', roomId: action.target_room_id, note: null },
      });
    } else if (
      value.action === 'RETRACT_MESSAGE' &&
      action.target_message_id &&
      action.target_room_id
    ) {
      this.bus.publish({
        kind: 'retract',
        messageId: action.target_message_id,
        roomId: action.target_room_id,
        retractedAt:
          typeof value.retractedAt === 'string'
            ? value.retractedAt
            : action.created_at.toISOString(),
      });
      this.bus.publish({
        kind: 'notice',
        userId,
        notice: {
          action: 'retract',
          roomId: action.target_room_id,
          messageId: action.target_message_id,
          note: null,
        },
      });
    }
  }
}
