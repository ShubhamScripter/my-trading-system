import type { RoomType } from '../chat.contract';
import type { ChatSettings } from '../chat.settings.contract';
import type {
  AccessRequirement,
  CasinoConditions,
  EligibilityFacts,
  RoomAccessEvaluation,
  RoomRecord,
} from '../chat.types';
import { compareDecimal, isChatStaff, toDisplayUsd } from '../chat.utility';
import { canAct } from './chat.permissions';

/**
 * The room access rules: who may see, read and write a room. Pure functions of the facts, the room and the settings,
 * covered row by row by the matrix in tests/social/chat.utility.spec.ts.
 */

// Room access
const GEO_TYPES: ReadonlySet<RoomType> = new Set(['COUNTRY', 'CONTINENT', 'REGION', 'LANGUAGE']);

/**
 * Whether a room group is switched off in the chat settings (Chat SETTINGS "Chat Rooms by Country / Continent /
 * Region: ON / OFF", "Site Owner Chat Room", the premium variants). A switched-off room is off for everyone.
 */
export function roomSwitchedOff(room: RoomRecord, settings: ChatSettings): boolean {
  const s = settings.rooms;
  const premiumVariant = room.access.requirePremium;
  switch (room.type) {
    case 'COUNTRY':
      return !s.byCountry || (premiumVariant && !s.regionPremiumRooms);
    case 'CONTINENT':
      return !s.byContinent || (premiumVariant && !s.regionPremiumRooms);
    case 'REGION':
      return !s.byRegion || (premiumVariant && !s.regionPremiumRooms);
    case 'LANGUAGE':
      return !s.byLanguage || (premiumVariant && !s.languagePremiumRooms);
    case 'SO':
      return !s.siteOwnerRoom || (room.access.requirePremium && !s.siteOwnerPremiumRoom);
    case 'CASINO':
      return room.access.requirePremium && !s.casinoPremiumRoom;
    case 'PREMIUM':
      return room.access.allowedPlanIds.length > 0 ? !s.premiumPerPlan : !s.premiumOverall;
    default:
      return false;
  }
}

interface Gate {
  readonly ok: boolean;
  readonly requirement?: AccessRequirement;
  readonly reason?: string;
}

const PASS: Gate = { ok: true };

function premiumGate(facts: EligibilityFacts, planIds: readonly string[]): Gate {
  const held = facts.premiumPlanIds;
  const ok =
    held !== null &&
    (planIds.length === 0 ? held.length > 0 : held.some((id) => planIds.includes(id)));
  return ok
    ? PASS
    : {
        ok: false,
        requirement: { kind: 'PREMIUM', planIds: [...planIds] },
        reason:
          planIds.length === 0
            ? 'A premium plan is required to write here'
            : "One of this room's premium plans is required to write here",
      };
}

function kycGate(facts: EligibilityFacts, minLevel: number): Gate {
  const level = facts.kycLevel;
  return level !== null && level >= minLevel
    ? PASS
    : {
        ok: false,
        requirement: { kind: 'KYC', minLevel },
        reason: `KYC level ${minLevel} is required to write here`,
      };
}

function levelGate(facts: EligibilityFacts, minLevel: number): Gate {
  return facts.level !== null && facts.level >= minLevel
    ? PASS
    : {
        ok: false,
        requirement: { kind: 'LEVEL', minLevel },
        reason: `Level ${minLevel} is required to write here`,
      };
}

function countryGate(facts: EligibilityFacts, countries: readonly string[]): Gate {
  if (countries.length === 0) return PASS;
  return facts.country !== null && countries.includes(facts.country)
    ? PASS
    : {
        ok: false,
        requirement: { kind: 'COUNTRY', countries: [...countries] },
        reason: 'This room is for users from its countries; you can read it',
      };
}

function casinoGate(
  facts: EligibilityFacts,
  room: RoomRecord,
  settings: ChatSettings,
): { gate: Gate; conditions: CasinoConditions } {
  const windowDays = settings.casino.wagerWindowDays;
  const onCasino = facts.casino?.onCasino === true;
  const wager = facts.casino?.wagerUsd ?? '0';
  const wagerGateOn = room.config.casino?.onlyUsersOnCasino === true;
  const min = wagerGateOn ? room.access.minWagerUsd : null;
  const wagerMet = min === null || compareDecimal(wager, min) >= 0;
  const conditions: CasinoConditions = {
    onCasino,
    wagerMet,
    minWagerUsd: min === null ? null : toDisplayUsd(min),
    wagerUsd: toDisplayUsd(wager),
    windowDays,
    allMet: onCasino && wagerMet,
  };
  return {
    conditions,
    gate: conditions.allMet
      ? PASS
      : {
          ok: false,
          requirement: {
            kind: 'CASINO',
            onCasino,
            minWagerUsd: conditions.minWagerUsd,
            windowDays,
          },
          reason: !onCasino
            ? 'Only users on OREBiT Play can write in the casino room'
            : `A wager of $${conditions.minWagerUsd} over the last ${windowDays} days is required to write here`,
        },
  };
}

/** The Staff room and the STAFF audience follow the role permission "Join Staff Chat Room" (Module 4). */
function canEnterStaffRoom(facts: EligibilityFacts, settings: ChatSettings): boolean {
  return !facts.staffRoomBlocked && canAct(settings, facts.staffRole, 'JOIN_STAFF_ROOM');
}

function inVisibilityAudience(
  facts: EligibilityFacts,
  room: RoomRecord,
  settings: ChatSettings,
): boolean {
  const { groups, minLevel } = room.access.visibility;
  if (groups.length === 0 && minLevel === 0) return true;
  for (const group of groups) {
    if (group === 'PREMIUM' && (facts.premiumPlanIds?.length ?? 0) > 0) return true;
    if (group === 'SO' && facts.isSiteOwner === true) return true;
    if (group === 'STAFF' && canEnterStaffRoom(facts, settings)) return true;
    if (group === 'KYC' && (facts.kycLevel ?? 0) >= 1) return true;
  }
  return minLevel > 0 && facts.level !== null && facts.level >= minLevel;
}

const LOCKED_HIDDEN = (reason: string): RoomAccessEvaluation => ({
  accessMode: 'LOCKED',
  isListed: false,
  isEligibleToView: false,
  isEligibleToWrite: false,
  receivesUserMessages: false,
  reason,
});

/**
 * Who may see, read and write a room. Pure: every fact it needs is passed in, so the whole rule set is covered by
 * one table-driven test.
 *
 * Order matters and is the fix for several bugs:
 *  1. OFF (status DISABLED or the room group switched off in the settings): hidden from everyone.
 *  2. Visibility audience (Chat SETTINGS "Visibility: Specific"): outsiders do not see the room at all.
 *  3. Eligibility to write: the room TYPE gates plus the rule's own flags; a missing fact (a module not
 *     connected yet) fails its gate.
 *  4. The ineligible result comes from the rule's ineligible mode: read-only, hidden or promo-only.
 *     Chat staff may view every room to moderate but write only where eligible.
 *  5. MAINTENANCE only on top of an eligible result, so a hidden room stays hidden.
 */
export function evaluateRoomAccess(
  facts: EligibilityFacts,
  room: RoomRecord,
  settings: ChatSettings,
): RoomAccessEvaluation {
  const status = room.config.status;
  if (status === 'DISABLED' || roomSwitchedOff(room, settings))
    return LOCKED_HIDDEN('This room is off');

  const staff = isChatStaff(facts.staffRole);
  // "Change chat Room access for user (Remove / Add user from specific rooms)" (Module 4). A removed user does not
  // see the room; an added one passes its gates. Site-Owner rooms keep their own exclusion gate below.
  if (!staff && room.type !== 'SO' && facts.excludedRoomIds.has(room.id)) {
    return LOCKED_HIDDEN('You were removed from this room');
  }
  const included = room.type !== 'STAFF' && facts.includedRoomIds.has(room.id);

  if (room.type === 'STAFF') {
    // Hidden from everyone who is not chat staff, whatever the rule says.
    if (!canEnterStaffRoom(facts, settings)) return LOCKED_HIDDEN('Staff only');
  } else if (!staff && !included && !inVisibilityAudience(facts, room, settings)) {
    return LOCKED_HIDDEN('This room is not visible to you');
  }

  // Gates, first failure wins
  const access = room.access;
  const gates: Gate[] = [];
  let casinoConditions: CasinoConditions | undefined;

  switch (room.type) {
    case 'SO':
      gates.push(
        facts.isSiteOwner === true && !facts.excludedRoomIds.has(room.id)
          ? PASS
          : {
              ok: false,
              requirement: { kind: 'SITE_OWNER' },
              reason: 'Site owners only',
            },
      );
      break;
    case 'KYC':
      gates.push(kycGate(facts, Math.max(1, access.minKycLevel)));
      break;
    case 'PREMIUM':
      gates.push(premiumGate(facts, access.allowedPlanIds));
      break;
    case 'CASINO': {
      const casino = casinoGate(facts, room, settings);
      casinoConditions = casino.conditions;
      gates.push(casino.gate);
      break;
    }
    default:
      break;
  }

  // The rule's own flags, on any room type ("Region Specific Different chat Rooms for Premium" and so on).
  if (access.requirePremium && room.type !== 'PREMIUM')
    gates.push(premiumGate(facts, access.allowedPlanIds));
  if (access.minKycLevel > 0 && room.type !== 'KYC') gates.push(kycGate(facts, access.minKycLevel));
  gates.push(countryGate(facts, room.regionCountries ?? access.allowedCountries));

  const groupMinLevel =
    room.type === 'GLOBAL'
      ? settings.minLevel.global
      : GEO_TYPES.has(room.type)
        ? settings.minLevel.countryLanguage
        : 0;
  const minLevel = Math.max(access.minLevel, groupMinLevel);
  if (minLevel > 0) gates.push(levelGate(facts, minLevel));

  // KYC chat entitlements: only once the KYC module is connected; until then public chat stays open.
  const entitlements = facts.kycEntitlements;
  if (entitlements !== null) {
    if (!entitlements.publicChat) {
      gates.push({
        ok: false,
        requirement: { kind: 'KYC', minLevel: (facts.kycLevel ?? 0) + 1 },
        reason: 'Your KYC level does not include public chat',
      });
    } else if (entitlements.roomIds !== null && !entitlements.roomIds.includes(room.id)) {
      gates.push({
        ok: false,
        requirement: { kind: 'KYC', minLevel: (facts.kycLevel ?? 0) + 1 },
        reason: 'Your KYC level does not include this room',
      });
    }
  }

  const failed = included ? undefined : gates.find((gate) => !gate.ok);
  const casinoField = casinoConditions ? { casinoConditions } : {};

  if (failed) {
    const requirement = failed.requirement ? { requirement: failed.requirement } : {};
    if (staff) {
      return {
        accessMode: 'VIEW_ONLY',
        isListed: true,
        isEligibleToView: true,
        isEligibleToWrite: false,
        receivesUserMessages: true,
        reason: failed.reason,
        ...requirement,
        ...casinoField,
      };
    }
    const mode = room.type === 'STAFF' ? 'HIDE' : access.ineligibleMode;
    if (mode === 'HIDE')
      return {
        ...LOCKED_HIDDEN(failed.reason ?? 'Not available'),
        ...requirement,
      };
    if (mode === 'PROMO_ONLY') {
      return {
        accessMode: 'PROMO_ONLY',
        isListed: true,
        isEligibleToView: true,
        isEligibleToWrite: false,
        receivesUserMessages: false,
        reason: failed.reason,
        ...requirement,
        ...casinoField,
      };
    }
    return {
      accessMode: 'VIEW_ONLY',
      isListed: true,
      isEligibleToView: true,
      isEligibleToWrite: false,
      receivesUserMessages: true,
      reason: failed.reason,
      ...requirement,
      ...casinoField,
    };
  }

  if (status === 'MAINTENANCE') {
    const maintenance = {
      note: room.config.statusNote ?? null,
      until: room.config.statusUntil ?? null,
    };
    return {
      accessMode: staff ? 'FULL_ACCESS' : 'VIEW_ONLY',
      isListed: true,
      isEligibleToView: true,
      isEligibleToWrite: staff,
      receivesUserMessages: true,
      reason: 'This room is under maintenance',
      maintenance,
      ...casinoField,
    };
  }

  return {
    accessMode: 'FULL_ACCESS',
    isListed: true,
    isEligibleToView: true,
    isEligibleToWrite: true,
    receivesUserMessages: true,
    ...casinoField,
  };
}
