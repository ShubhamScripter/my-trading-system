import { Injectable, Logger } from '@nestjs/common';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import type { ChatSettings } from './chat.settings.contract';
import { CHAT_REFUSAL_REASONS, GLOBAL_ROOM_ID, TIMERS } from './chat.constants';
import { ChatBus } from './realtime/chat.bus';
import { ChatDbOperation } from './chat.dboperation';
import type { RoomConfigProblem } from './persistence/chat.sql';
import { ChatPorts } from './chat.ports';
import { ChatSettingsService } from './chat.settings';
import { ChatRestrictionsService } from './services/chat.restrictions.service';
import type {
  ChatUserContext,
  EligibilityFacts,
  RoomAccessEvaluation,
  RoomRecord,
} from './chat.types';
import { evaluateRoomAccess } from './services/chat.access.rules';
import { isChatStaff, normalizeRoomRef } from './chat.utility';

interface CachedFacts {
  readonly facts: EligibilityFacts;
  readonly at: number;
}

/** Evaluates room visibility and access permissions using cached user facts and room settings. */
@Injectable()
export class ChatAccessService {
  private readonly logger = new Logger('ChatAccessService');
  private rooms: {
    byId: Map<string, RoomRecord>;
    bySlug: Map<string, RoomRecord>;
    at: number;
  } | null = null;
  private loadingRooms: Promise<unknown> | null = null;
  private readonly facts = new Map<string, CachedFacts>();
  private readonly factsInFlight = new Map<string, Promise<EligibilityFacts>>();
  private readonly casino = new Map<string, { value: EligibilityFacts['casino']; at: number }>();
  private readonly reportedProblems = new Map<string, string>();

  constructor(
    private readonly db: ChatDbOperation,
    private readonly ports: ChatPorts,
    private readonly settings: ChatSettingsService,
    private readonly bus: ChatBus,
    private readonly restrictions: ChatRestrictionsService,
  ) {
    this.bus.subscribe((change) => {
      if (change.kind === 'restrictions') {
        for (const [userId, cached] of this.facts) {
          if (cached.facts.staffRole !== null) this.facts.delete(userId);
        }
      }
      if (change.kind === 'room' || change.kind === 'settings') this.rooms = null;
      if (change.kind === 'settings') {
        this.facts.clear();
        this.casino.clear();
      }
      if (change.kind === 'user') this.forgetUser(change.userId);
    });
  }

  forgetUser(userId: string): void {
    this.facts.delete(userId);
    this.casino.delete(userId);
  }

  /** Logged once per room per distinct problem set, so a bad stored entry is visible without flooding. */
  readonly onConfigProblem = (problem: RoomConfigProblem): void => {
    const key = problem.problems.join('|');
    if (this.reportedProblems.get(problem.roomId) === key) return;
    this.reportedProblems.set(problem.roomId, key);
    this.logger.warn(
      {
        component: 'ChatAccessService',
        roomId: problem.roomId,
        problems: problem.problems.slice(0, 10),
      },
      'room config entries skipped: they fail the chat contract',
    );
  };

  // Rooms
  private async roomMaps(): Promise<{
    byId: Map<string, RoomRecord>;
    bySlug: Map<string, RoomRecord>;
  }> {
    if (this.rooms && Date.now() - this.rooms.at < TIMERS.CACHE_SECONDS * 1000) return this.rooms;
    if (!this.loadingRooms) {
      this.loadingRooms = this.reloadRooms().finally(() => {
        this.loadingRooms = null;
      });
    }
    await this.loadingRooms;
    return this.rooms!;
  }

  /**
   * Reloads every room (one query) and returns the ids of rooms that changed, appeared or went away since the last
   * load — the 30-second backstop re-checks open sockets only for those.
   */
  async reloadRooms(): Promise<string[]> {
    const previous = this.rooms?.byId;
    const list = await this.db.loadRooms(this.onConfigProblem);
    const byId = new Map(list.map((room) => [room.id, room]));
    const bySlug = new Map(list.map((room) => [room.slug, room]));
    this.rooms = { byId, bySlug, at: Date.now() };
    if (!previous) return [];
    const changed: string[] = [];
    for (const [id, room] of byId)
      if (previous.get(id)?.fingerprint !== room.fingerprint) changed.push(id);
    for (const id of previous.keys()) if (!byId.has(id)) changed.push(id);
    return changed;
  }

  async allRooms(): Promise<RoomRecord[]> {
    return [...(await this.roomMaps()).byId.values()];
  }

  /** A room by UUID or slug from the cache, or null; never created, never matched by display name. */
  async findRoom(ref: string | null | undefined): Promise<RoomRecord | null> {
    const normalized = normalizeRoomRef(ref);
    const maps = await this.roomMaps();
    return (
      (normalized.kind === 'id'
        ? maps.byId.get(normalized.value)
        : maps.bySlug.get(normalized.value)) ?? null
    );
  }

  async requireRoom(ref: string | null | undefined): Promise<RoomRecord> {
    const room = await this.findRoom(ref);
    if (!room) throw new ProblemException({ type: ERR.NOT_FOUND, detail: 'Room not found' });
    return room;
  }

  // Facts and evaluation
  async factsFor(user: ChatUserContext): Promise<EligibilityFacts> {
    const cached = this.facts.get(user.id);
    if (
      cached &&
      Date.now() - cached.at < TIMERS.CACHE_SECONDS * 1000 &&
      cached.facts.staffRole === user.staffRole
    ) {
      return cached.facts;
    }
    const inFlight = this.factsInFlight.get(user.id);
    if (inFlight) {
      const result = await inFlight;
      return result.staffRole === user.staffRole ? result : this.factsFor(user);
    }
    const pending = this.loadFacts(user);
    this.factsInFlight.set(user.id, pending);
    try {
      return await pending;
    } finally {
      if (this.factsInFlight.get(user.id) === pending) this.factsInFlight.delete(user.id);
    }
  }

  private async loadFacts(user: ChatUserContext): Promise<EligibilityFacts> {
    const [portFacts, excluded, included] = await Promise.all([
      this.ports.facts(user.id),
      this.db.excludedRoomIds(user.id),
      this.db.includedRoomIds(user.id),
    ]);
    const facts: EligibilityFacts = {
      staffRole: user.staffRole,
      country: portFacts.country,
      premiumPlanIds: portFacts.premiumPlanIds,
      kycLevel: portFacts.kycLevel,
      kycEntitlements: portFacts.kycEntitlements,
      isSiteOwner: portFacts.isSiteOwner,
      level: portFacts.level,
      casino: null,
      excludedRoomIds: new Set(excluded),
      includedRoomIds: new Set(included),
      staffRoomBlocked: false,
    };
    // Only a staff member can be shut out of the Staff room; everyone else is never asked.
    const staffRoomBlocked =
      user.staffRole !== null &&
      (await this.restrictions.find(user, facts, 'RESTRICT_STAFF_ROOM', null, await this.db.dbNow())) !== null;
    const finished: EligibilityFacts = { ...facts, staffRoomBlocked };
    this.facts.set(user.id, { facts: finished, at: Date.now() });
    return finished;
  }

  /** Casino facts are asked only for casino rooms, and cached per user for at most 30 seconds. */
  private async withCasino(
    user: ChatUserContext,
    facts: EligibilityFacts,
    settings: ChatSettings,
  ): Promise<EligibilityFacts> {
    const cached = this.casino.get(user.id);
    if (cached && Date.now() - cached.at < TIMERS.CACHE_SECONDS * 1000)
      return { ...facts, casino: cached.value };
    const value = await this.ports.casinoFacts(user.id, settings.casino.wagerWindowDays);
    this.casino.set(user.id, { value, at: Date.now() });
    return { ...facts, casino: value };
  }

  async settingsFor(user: ChatUserContext): Promise<ChatSettings> {
    return this.settings.forCountry((await this.factsFor(user)).country);
  }

  async evaluate(user: ChatUserContext, room: RoomRecord): Promise<RoomAccessEvaluation> {
    const baseFacts = await this.factsFor(user);
    const settings = await this.settings.forCountry(baseFacts.country);
    const facts =
      room.type === 'CASINO' ? await this.withCasino(user, baseFacts, settings) : baseFacts;
    return evaluateRoomAccess(facts, room, settings);
  }

  /** Read access for history, pinned, members and rules. An unknown room is not_found. */
  async assertCanView(
    user: ChatUserContext,
    ref: string,
  ): Promise<{ room: RoomRecord; access: RoomAccessEvaluation }> {
    const room = await this.requireRoom(ref);
    const access = await this.evaluate(user, room);
    if (!access.isEligibleToView) {
      // A hidden room answers not_found to outsiders rather than confirming it exists.
      throw new ProblemException(
        access.isListed
          ? {
              type: ERR.FORBIDDEN,
              detail: access.reason ?? 'You cannot view this room',
              extra: {
                reason: CHAT_REFUSAL_REASONS.ROOM_HIDDEN,
                ...(access.requirement ? { requirement: access.requirement } : {}),
              },
            }
          : {
              type: ERR.FORBIDDEN,
              detail: 'You cannot view this room',
              extra: { reason: CHAT_REFUSAL_REASONS.ROOM_HIDDEN },
            },
      );
    }
    return { room, access };
  }

  /** Every room the user may see, evaluated once per room. */
  async visibleRooms(
    user: ChatUserContext,
  ): Promise<{ room: RoomRecord; access: RoomAccessEvaluation }[]> {
    const rooms = await this.allRooms();
    const baseFacts = await this.factsFor(user);
    const settings = await this.settings.forCountry(baseFacts.country);
    const casinoFacts = rooms.some((room) => room.type === 'CASINO')
      ? await this.withCasino(user, baseFacts, settings)
      : baseFacts;
    const out: { room: RoomRecord; access: RoomAccessEvaluation }[] = [];
    for (const room of rooms) {
      const access = evaluateRoomAccess(
        room.type === 'CASINO' ? casinoFacts : baseFacts,
        room,
        settings,
      );
      if (access.isListed) out.push({ room, access });
    }
    return out;
  }

  /**
   * The room that opens: the last room the browser remembers if the user may still
   * view it; else the premium or KYC room first when that setting is on and the user can write there (premium wins
   * over KYC); else the admin default — the user's country room or Global; else Global.
   */
  async effectiveRoom(
    user: ChatUserContext,
    lastRoomHint: string | null,
  ): Promise<{ room: RoomRecord; access: RoomAccessEvaluation }> {
    const visible = await this.visibleRooms(user);
    const viewable = visible.filter((entry) => entry.access.isEligibleToView);

    if (lastRoomHint) {
      const ref = normalizeRoomRef(lastRoomHint);
      const hit = viewable.find((entry) =>
        ref.kind === 'id' ? entry.room.id === ref.value : entry.room.slug === ref.value,
      );
      if (hit) return hit;
    }

    const settings = await this.settingsFor(user);
    const writable = viewable.filter(
      (entry) => entry.access.isEligibleToWrite && entry.room.type !== 'STAFF',
    );
    if (settings.defaultRoom.premiumFirst) {
      const premium = writable.find((entry) => entry.room.type === 'PREMIUM');
      if (premium) return premium;
    }
    if (settings.defaultRoom.kycFirst) {
      const kyc = writable.find((entry) => entry.room.type === 'KYC');
      if (kyc) return kyc;
    }
    if (settings.defaultRoom.base === 'COUNTRY') {
      const facts = await this.factsFor(user);
      const own = writable.find(
        (entry) =>
          entry.room.type === 'COUNTRY' &&
          facts.country !== null &&
          (entry.room.regionCountries ?? entry.room.access.allowedCountries).includes(
            facts.country,
          ) &&
          !entry.room.access.requirePremium,
      );
      if (own) return own;
    }

    const global = viewable.find((entry) => entry.room.id === GLOBAL_ROOM_ID);
    if (global) return global;
    const room = await this.requireRoom(GLOBAL_ROOM_ID);
    return { room, access: await this.evaluate(user, room) };
  }

  isStaff(user: ChatUserContext): boolean {
    return isChatStaff(user.staffRole);
  }
}
