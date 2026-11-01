import type { PenaltyReasons } from './chat.types';

// Said when an approved request carries no internal reason (a request written before the two reasons existed).
const REQUESTED_BY_STAFF = 'Requested by staff';

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

// The two reasons of a request body, with an absent user reason left out.
export function reasonsOf(source: { internalReason: string; userReason?: string }): PenaltyReasons {
  return {
    internalReason: source.internalReason,
    ...(source.userReason ? { userReason: source.userReason } : {}),
  };
}

// The two reasons stored in a staff request's payload. A request saved before the reasons were split holds one `reason`,
// which is the internal one: it is never copied into the user's reason.
export function reasonsFromPayload(payload: Record<string, unknown>): PenaltyReasons {
  const userReason = text(payload.userReason);
  return {
    internalReason: text(payload.internalReason) ?? text(payload.reason) ?? REQUESTED_BY_STAFF,
    ...(userReason ? { userReason } : {}),
  };
}
