/** ─── Module 5 — Social API client ──────────────────────────────────────────
 *  Commands, mute/block, ads and gifts, with the exact request bodies of chat.social.dto.ts (unknown fields are
 *  refused). Routes: chat.social.routes.ts
 */
import { apiFetch } from './client';
import type { Ad, AdBadge, AdOptions, AdQuote, Gift, GiftOptions, RelationUser } from '@/types/dm';

interface Envelope<T> { data: T }

/* eslint-disable @typescript-eslint/no-explicit-any -- raw backend views are mapped below */
type Raw = any;

const qs = (params: Record<string, string | number | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
  return q.toString();
};

// ─── Commands ─────────────────────────────────────────────────────────────────

/** HTTP fallback for slash-commands (the WS send_message path is preferred). */
export async function runCommand(roomId: string, text: string): Promise<unknown> {
  const res = await apiFetch<Envelope<unknown>>('/social/chat/commands', {
    method: 'POST',
    body: { roomId, text },
    fallbackMessage: 'Command failed',
  });
  return res.data;
}

// ─── Mute & Block ─────────────────────────────────────────────────────────────

const relation = (path: string, fallbackMessage: string) => async (handle: string): Promise<void> => {
  await apiFetch(`/social/chat/users/${encodeURIComponent(handle)}/${path}`, { method: 'POST', fallbackMessage });
};
export const muteUser = relation('mute', 'Failed to mute user');
export const unmuteUser = relation('unmute', 'Failed to unmute user');
export const blockUser = relation('block', 'Failed to block user');
export const unblockUser = relation('unblock', 'Failed to unblock user');

async function relationList(path: string, options: { limit?: number; cursor?: string | null }) {
  const res = await apiFetch<Envelope<Raw>>(`/social/chat/${path}?${qs({ limit: options.limit ?? 30, cursor: options.cursor })}`);
  return {
    items: (res.data?.items ?? []).map((u: Raw): RelationUser => ({ id: u.userId, username: u.username, createdAt: u.createdAt })),
    nextCursor: (res.data?.nextCursor ?? null) as string | null,
  };
}

export const getMutedUsers = (options: { limit?: number; cursor?: string | null } = {}) => relationList('mutes', options);
export const getBlockedUsers = (options: { limit?: number; cursor?: string | null } = {}) => relationList('blocks', options);

// ─── Ads ──────────────────────────────────────────────────────────────────────

/** What the composer may offer: badges, skins, limits. */
export async function getAdOptions(): Promise<AdOptions> {
  return (await apiFetch<Envelope<AdOptions>>('/social/chat/ads/options', { fallbackMessage: 'Could not load ad options' })).data;
}

/** Kept for older callers: the badges of the ad options. */
export async function getAdBadges(): Promise<AdBadge[]> {
  try {
    return (await getAdOptions()).badges;
  } catch {
    return [];
  }
}

export interface AdInput {
  content: string;
  /** Room ids or slugs; ignored with `allRooms`. */
  roomIds?: string[];
  allRooms?: boolean;
  /** Minutes pinned on top of each room (pinned ads). */
  pinMinutes?: number;
  /** Extra posts after the first one, `repeatGapMinutes` apart. */
  repeatCount?: number;
  repeatGapMinutes?: number;
  badgeId?: string;
  skinId?: string;
  /** ISO-2 country codes that will not see the ad. */
  hiddenCountries?: string[];
}

function adBody(input: AdInput) {
  return {
    content: input.content,
    ...(input.allRooms ? { allRooms: true } : { roomIds: input.roomIds ?? [] }),
    ...(input.pinMinutes ? { pinMinutes: input.pinMinutes } : {}),
    ...(input.repeatCount ? { repeatCount: input.repeatCount, repeatGapMinutes: input.repeatGapMinutes } : {}),
    ...(input.badgeId ? { badgeId: input.badgeId } : {}),
    ...(input.skinId ? { skinId: input.skinId } : {}),
    ...(input.hiddenCountries?.length ? { hiddenCountries: input.hiddenCountries } : {}),
  };
}

/** Prices an ad without storing anything. */
export async function quoteAd(input: AdInput): Promise<AdQuote> {
  const res = await apiFetch<Envelope<AdQuote>>('/social/chat/ads/quote', {
    method: 'POST',
    body: adBody(input),
    fallbackMessage: 'Failed to get ad quote',
  });
  return res.data;
}

/** Pays and posts the ad. */
export async function createAd(input: AdInput): Promise<{ adId: string; status: string; price: AdQuote['price'] }> {
  const res = await apiFetch<Envelope<Raw>>('/social/chat/ads', {
    method: 'POST',
    body: adBody(input),
    fallbackMessage: 'Failed to create ad',
  });
  return res.data;
}

async function adList(path: string, options: { limit?: number; cursor?: string | null }) {
  const res = await apiFetch<Envelope<Raw>>(`${path}?${qs({ limit: options.limit ?? 20, cursor: options.cursor })}`);
  return { items: (res.data?.items ?? []) as Ad[], nextCursor: (res.data?.nextCursor ?? null) as string | null };
}

/** The user's own ads, with price breakdown and refunds. */
export const getMyAds = (options: { limit?: number; cursor?: string | null } = {}) =>
  adList('/social/chat/ads/mine', options);

/** The "Separate Advertisement Tab" (when the admin has it on). */
export const getAdFeed = (options: { limit?: number; cursor?: string | null } = {}) =>
  adList('/social/chat/ads', options);
export const getAds = getAdFeed;

/** Posts not made and pinned minutes not shown are refunded. */
export async function cancelAd(adId: string): Promise<void> {
  await apiFetch(`/social/chat/ads/${adId}/cancel`, { method: 'POST', fallbackMessage: 'Failed to cancel ad' });
}

/** The ad pinned on top of a room now, if any. */
export async function getPinnedAd(roomId: string): Promise<Ad | null> {
  try {
    const res = await apiFetch<Envelope<{ pinnedAd: Ad | null }>>(`/social/chat/rooms/${encodeURIComponent(roomId)}/pinned-ad`);
    return res.data?.pinnedAd ?? null;
  } catch {
    return null;
  }
}

// ─── Gifts ────────────────────────────────────────────────────────────────────

export async function getGiftOptions(): Promise<GiftOptions> {
  return (await apiFetch<Envelope<GiftOptions>>('/social/chat/gifts/options', { fallbackMessage: 'Could not load gift options' })).data;
}

/** /send or /gift: checks and quote, then waits for the payment PIN or 2FA code (`verification`). */
export async function startGift(
  recipient: string,
  amount: string,
  currency: string,
  roomId?: string,
): Promise<Gift> {
  const res = await apiFetch<Envelope<Gift>>('/social/chat/gifts', {
    method: 'POST',
    body: { recipient: recipient.trim().replace(/^@/, ''), amount, currency, ...(roomId ? { roomId } : {}) },
    fallbackMessage: 'Failed to initiate gift',
  });
  return res.data;
}

/** The code, then the transfer; the recipient gets `gift_received`. */
export async function confirmGift(giftId: string, code: string): Promise<{ giftId: string; status: 'COMPLETED' }> {
  const res = await apiFetch<Envelope<{ giftId: string; status: 'COMPLETED' }>>(`/social/chat/gifts/${giftId}/confirm`, {
    method: 'POST',
    body: { code },
    fallbackMessage: 'Failed to confirm gift',
  });
  return res.data;
}

export async function cancelGift(giftId: string): Promise<void> {
  await apiFetch(`/social/chat/gifts/${giftId}/cancel`, { method: 'POST', fallbackMessage: 'Failed to cancel gift' });
}
