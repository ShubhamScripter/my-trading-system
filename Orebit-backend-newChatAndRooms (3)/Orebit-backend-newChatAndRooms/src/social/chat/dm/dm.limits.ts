// A limit the admin has not set refuses the limited action: there is no built-in number to fall back to.
import { ERR } from '../../../contracts';
import { CHAT_REFUSAL_REASONS } from '../chat.constants';
import { refuse } from '../chat.moderation.service';
import type { ChatSettings } from '../chat.settings.contract';

// The limit's value, or a refusal naming the setting that is missing.
export function requireLimit(value: number | null | undefined, setting: string): number {
  if (value === null || value === undefined) {
    throw refuse(ERR.FORBIDDEN, CHAT_REFUSAL_REASONS.LIMIT_NOT_SET, 'This limit has not been set by the admin yet', {
      setting,
    });
  }
  return value;
}

// The new-DM limit that applies: one when the other person follows the starter, another when they do not.
export function limitOf(settings: ChatSettings, withFollower: boolean): { count: number; hours: number } {
  const dm = settings.dm;
  return withFollower
    ? {
        count: requireLimit(dm.newDmFollowerCount, 'dm.newDmFollowerCount'),
        hours: requireLimit(dm.newDmFollowerWindowHours, 'dm.newDmFollowerWindowHours'),
      }
    : {
        count: requireLimit(dm.newDmNonFollowerCount, 'dm.newDmNonFollowerCount'),
        hours: requireLimit(dm.newDmNonFollowerWindowHours, 'dm.newDmNonFollowerWindowHours'),
      };
}

export function newDmLimit(settings: ChatSettings, withFollower: boolean) {
  return { ...limitOf(settings, withFollower), withFollower };
}
