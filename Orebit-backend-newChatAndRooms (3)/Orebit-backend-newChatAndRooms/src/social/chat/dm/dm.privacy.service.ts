// A user's DM privacy and lookups (Module 8, , , , , , , ): last seen, common
// groups, notifications per folder, quiet mode (in the account time zone), the one typing/read switch; finding a person
// by username only (a blocked person looks like an unknown one); and the folder move when a follow changes.
import { Injectable } from '@nestjs/common';
import { ERR } from '../../../contracts';
import { ProblemException } from '../../../http';
import { CHAT_REFUSAL_REASONS, SERVER_EVENTS } from '../chat.constants';
import { ChatDbOperation } from '../chat.dboperation';
import { ChatFeaturePorts } from '../chat.feature-ports';
import { refuse } from '../chat.moderation.service';
import { ChatPorts } from '../chat.ports';
import type { VisibilityChoice } from '../chat.features.contract';
import type { ChatUserContext } from '../chat.types';
import { ChatBus } from '../realtime/chat.bus';
import { ChatDelivery } from '../realtime/chat.delivery';
import { ChatRelationsService } from '../services/chat.relations.service';
import { DmDbOperation } from './dm.dboperation';
import { DmInboxDbOperation } from './dm.inbox.dboperation';
import { directKey, directPlacement, effectivePrefs, inQuietHours, visibleTo } from './dm.rules';
import { DmService } from './dm.service';
import { signMediaUrl } from '../chat.upload';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

@Injectable()
export class DmPrivacyService {
  constructor(
    private readonly dm: DmDbOperation,
    private readonly inbox: DmInboxDbOperation,
    private readonly db: ChatDbOperation,
    private readonly ports: ChatFeaturePorts,
    private readonly chatPorts: ChatPorts,
    private readonly relations: ChatRelationsService,
    private readonly delivery: ChatDelivery,
    private readonly messages: DmService,
    bus: ChatBus,
  ) {
    // The Social module tells chat when a follow changes; the direct chat of the two moves by the folder rules.
    bus.subscribe((change) => {
      if (change.kind !== 'follow') return;
      return this.onFollowChanged(change.userA, change.userB).catch(() => undefined);
    });
  }

  private invalid(path: string, message: string): ProblemException {
    return new ProblemException({ type: ERR.VALIDATION_FAILED, errors: [{ path, message }] });
  }

  private updated(userId: string, conversationId: string, change: Record<string, unknown>): void {
    this.delivery.toUser(userId, SERVER_EVENTS.DM_CONVERSATION_UPDATED, { conversationId, ...change });
  }

  async privacy(user: ChatUserContext) {
    const settings = await this.messages.guard(false);
    const stored = (await this.inbox.prefs([user.id])).get(user.id)!;
    // the quiet-mode zone is the account time zone (Auth/User owns it); no zone, no auto-night.
    const zone = (await this.chatPorts.accountTimeZones([user.id])).get(user.id) ?? null;
    const prefs = { ...effectivePrefs(settings, stored), timeZone: zone };
    return {
      lastSeenVisibility:
        (stored.lastSeenVisibility as VisibilityChoice | null) ?? settings.privacy.lastSeenDefault,
      commonGroupsVisibility:
        (stored.commonGroupsVisibility as VisibilityChoice | null) ??
        settings.privacy.commonGroupsDefault,
      notifyPrimary: prefs.notifyPrimary,
      notifyGeneral: prefs.notifyGeneral,
      notifyGroups: prefs.notifyGroups,
      quietMode: prefs.quietMode,
      quietStart: prefs.quietStart,
      quietEnd: prefs.quietEnd,
      timeZone: zone,
      typingReceiptsEnabled: stored.typingReceiptsEnabled,
      inQuietHoursNow: inQuietHours(prefs, await this.dm.dbNow()),
      canChangeQuietTimes: settings.privacy.allowQuietChange,
    };
  }

  async updatePrivacy(
    user: ChatUserContext,
    dto: Partial<{
      lastSeenVisibility: VisibilityChoice;
      commonGroupsVisibility: VisibilityChoice;
      notifyPrimary: boolean;
      notifyGeneral: boolean;
      notifyGroups: boolean;
      quietMode: 'AUTO_NIGHT' | 'OFF' | 'CUSTOM';
      quietStart: string;
      quietEnd: string;
      typingReceiptsEnabled: boolean;
      timeZone: string | null;
    }>,
  ) {
    const settings = await this.messages.guard(true);
    // the time zone is an account setting, not a chat one.
    if (dto.timeZone !== undefined) throw this.invalid('timeZone', 'Set your time zone in your account settings');
    if (
      (dto.quietMode === 'CUSTOM' || dto.quietStart || dto.quietEnd) &&
      !settings.privacy.allowQuietChange
    ) {
      throw refuse(
        ERR.FORBIDDEN,
        CHAT_REFUSAL_REASONS.FEATURE_DISABLED,
        'Quiet-mode times are set by the admin',
      );
    }
    for (const key of ['quietStart', 'quietEnd'] as const) {
      if (dto[key] !== undefined && !HHMM.test(dto[key]!))
        throw this.invalid(key, 'A time as HH:MM');
    }
    await this.inbox.savePrefs(user.id, dto);
    return this.privacy(user);
  }

  // A live account by username, so a client can start a DM with someone it has not met (no id and no login code
// from a user). A blocked person looks exactly like an unknown one. Only the username is returned.
  async resolveUser(user: ChatUserContext, handle: string) {
    await this.messages.guard(false);
    const otherId = await this.db.resolveUserHandle(handle.replace(/^@/, ''));
    const found = otherId ? await this.db.findChatUser(otherId) : null;
    const blocked = found ? (await this.relations.blockedEitherWay(user.id, [found.id])).has(found.id) : false;
    if (!found || blocked) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'User not found' });
    return { username: found.username };
  }

  // "Users can also see common groups with their friends", as the other user's privacy allows.
  async commonGroups(user: ChatUserContext, handle: string) {
    const settings = await this.messages.guard(false);
    const otherId = await this.db.resolveUserHandle(handle.replace(/^@/, ''));
    // Unknown, blocked and hidden all answer the same: nothing to see.
    const hidden = { visible: false, items: [] };
    if (!otherId) return hidden;
    if (otherId !== user.id && (await this.relations.blockedEitherWay(user.id, [otherId])).has(otherId)) return hidden;
    const stored = (await this.inbox.prefs([otherId])).get(otherId)!;
    const choice =
      (stored.commonGroupsVisibility as VisibilityChoice | null) ??
      settings.privacy.commonGroupsDefault;
    const friend = await this.ports.areFriends(user.id, otherId);
    if (!visibleTo(choice, otherId === user.id, friend)) return hidden;
    return {
      visible: true,
      items: (await this.inbox.commonGroups(user.id, otherId)).map((g) => ({
        ...g,
        logoUrl: g.logoUrl ? signMediaUrl(g.logoUrl) : null,
      })),
    };
  }

  // A follow changed between two people: their direct chat is placed again by the folder rules unless
// a member chose the folder themselves. A pending request becomes a normal chat once its receiver follows the sender.
// The Social module calls this when a follow is added or removed.
  async onFollowChanged(userA: string, userB: string): Promise<void> {
    const conversationId = await this.dm.findDirect(directKey(userA, userB));
    if (!conversationId) return;
    const starter = await this.dm.conversationCreator(conversationId);
    const members = (await this.dm.members(conversationId)).filter((m) => m.state === 'ACTIVE' || m.state === 'REQUEST');
    for (const m of members) {
      if (m.folderChosen || m.folder === 'MERCHANT') continue;
      const otherId = m.userId === userA ? userB : userA;
      const follow = (await this.ports.follows(m.userId, [otherId])).get(otherId);
      if (!follow) continue;
      const placement = directPlacement(starter === m.userId, follow);
      const state = m.state === 'REQUEST' && placement.state === 'ACTIVE' ? 'ACTIVE' : m.state;
      if (state === m.state && placement.folder === m.folder) continue;
      await this.dm.updateMember(conversationId, m.userId, { state, folder: placement.folder });
      this.updated(m.userId, conversationId, { folder: state === 'REQUEST' ? 'REQUESTS' : placement.folder });
    }
  }
}
