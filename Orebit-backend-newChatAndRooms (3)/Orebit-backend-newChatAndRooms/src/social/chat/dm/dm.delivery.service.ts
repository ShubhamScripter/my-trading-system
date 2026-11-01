// Delivery of personal-chat messages to their members' sockets (Modules 8–9, ).
// The members come from one cached list; the two views (the sender's, everyone else's) are built once; members who
// get the same payload share ONE emit, so a message to a 500-member group is a few emits, not 500. The cost per
// message does not grow with the number of members.
import { Injectable } from '@nestjs/common';
import { SERVER_EVENTS } from '../chat.constants';
import { ChatPorts } from '../chat.ports';
import { ChatSettingsService } from '../chat.settings';
import { ChatDelivery } from '../realtime/chat.delivery';
import { DmDbOperation, type DmMessageRow } from './dm.dboperation';
import { DmInboxDbOperation } from './dm.inbox.dboperation';
import { effectivePrefs, shouldNotify } from './dm.rules';
import { toDmView } from './dm.view';

// A viewer id that is nobody's: the view every member except the sender receives.
const OTHERS = '';

@Injectable()
export class DmDeliveryService {
  constructor(
    private readonly dm: DmDbOperation,
    private readonly inbox: DmInboxDbOperation,
    private readonly settingsService: ChatSettingsService,
    private readonly chatPorts: ChatPorts,
    private readonly delivery: ChatDelivery,
  ) {}

  // Sends a stored message to every member who may receive it. The members come from one cached list and the two
// views (the sender's, everyone else's) are built once; members who get the same payload are sent ONE event
// (a socket room list), so a message to a 500-member group is a few emits, not 500. A SYSTEM line
// ('X joined') notifies nobody and needs no preference lookups.
  async deliver(row: DmMessageRow): Promise<void> {
    const members = await this.dm.members(row.conversationId, ['ACTIVE', 'REQUEST']);
    if (members.length === 0) return;
    const system = row.type === 'SYSTEM';
    const ids = members.map((m) => m.userId);
    const settings = system ? null : await this.settingsService.global();
    const prefs = system ? null : await this.inbox.prefs(ids);
    const zones = system ? null : await this.chatPorts.accountTimeZones(ids);
    // Quiet hours are judged on the database clock, like every business time.
    const now = system ? null : await this.dm.dbNow();
    const senderView = toDmView(row, row.senderId);
    const othersView = toDmView(row, OTHERS);

    const buckets = new Map<string, { ids: string[]; event: string; payload: unknown }>();
    for (const member of members) {
      const isSender = member.userId === row.senderId;
      const notify =
        !system && !isSender && settings && prefs && zones && now
          ? shouldNotify(
              effectivePrefs(settings, {
                ...prefs.get(member.userId)!,
                timeZone: zones.get(member.userId) ?? null,
              }),
              member,
              now,
            )
          : false;
      const asRequest = member.state === 'REQUEST' && !isSender;
      const folder = member.state === 'REQUEST' ? 'REQUESTS' : member.folder;
      const key = `${asRequest}|${member.kind}|${folder}|${notify}|${isSender}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          ids: [],
          event: asRequest ? SERVER_EVENTS.DM_REQUEST : SERVER_EVENTS.DM_MESSAGE,
          payload: {
            conversationId: row.conversationId,
            kind: member.kind,
            folder,
            message: isSender ? senderView : othersView,
            notify,
          },
        };
        buckets.set(key, bucket);
      }
      bucket.ids.push(member.userId);
    }
    for (const bucket of buckets.values()) this.delivery.toUser(bucket.ids, bucket.event, bucket.payload);
  }

  // A message that changed in place (a membership notice that grew): every member gets the new version.
  async deliverUpdate(row: DmMessageRow): Promise<void> {
    const members = await this.dm.members(row.conversationId, ['ACTIVE']);
    this.delivery.toUser(
      members.map((m) => m.userId),
      SERVER_EVENTS.DM_MESSAGE_UPDATED,
      { conversationId: row.conversationId, message: toDmView(row, OTHERS) },
    );
  }

  // Any event to every active member.
  async broadcast(conversationId: string, event: string, payload: unknown): Promise<void> {
    const members = await this.dm.members(conversationId, ['ACTIVE', 'REQUEST']);
    this.delivery.toUser(
      members.map((m) => m.userId),
      event,
      payload,
    );
  }
}
