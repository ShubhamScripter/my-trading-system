// Small pure helpers used across chat: room references, staff checks, the public view of a message,
// cursors, text, links, banned words, emoji, media URLs, money and the client IP.
// Nothing here touches the database, Redis or the network, so every helper is easy to unit test.
import { BlockList, isIP } from 'node:net';
import { USERNAME } from '../../../auth/auth.constants';
import { ERR } from '../../contracts';
import { ProblemException } from '../../http';
import type { GifProvider, StaffRole } from './chat.contract';
import {
  ANONYMOUS_AUTHOR_ID,
  ANONYMOUS_AUTHOR_NAME,
  DELETED_AUTHOR_NAME,
  CHAT_STAFF_ROLES,
  GIF_HOSTS,
  GLOBAL_ROOM_ID,
  GLOBAL_ROOM_SLUG,
  LINK_TLDS,
  SYSTEM_AUTHOR_NAME,
} from './chat.constants';
import type { MediaType, MessageRow, PublicMessage, Viewer } from './chat.types';
import { signMediaUrl } from './chat.upload';
import { compare, cryptoShown, cutText, usdShown } from './platform/money';

// Ids and room references
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID.test(value);
}

// A room is addressed by its UUID or its slug, never by its display name. `global` is the Global room's
// alias. UUIDs are lower-cased so an upper-case id resolves to the same room.
export function normalizeRoomRef(ref: string | null | undefined): {
  kind: 'id' | 'slug';
  value: string;
} {
  const trimmed = (ref ?? '').trim();
  if (trimmed === '' || trimmed.toLowerCase() === GLOBAL_ROOM_SLUG)
    return { kind: 'id', value: GLOBAL_ROOM_ID };
  if (isUuid(trimmed)) return { kind: 'id', value: trimmed.toLowerCase() };
  return { kind: 'slug', value: trimmed.toLowerCase() };
}

// Staff
// Chat staff moderate: ADMIN and MODERATOR.
export function isChatStaff(role: StaffRole | null | undefined): boolean {
  return (
    role !== null && role !== undefined && (CHAT_STAFF_ROLES as readonly string[]).includes(role)
  );
}

// Messages as viewers see them
// The one place a stored message becomes what a viewer receives: history, pinned, the tag feed and both
// broadcasts all go through here.
// - A retracted message reaches only its author and chat staff; everyone else gets its id and time, no content or
// media ("visible to mods / team with retracted tag", Chat MAIN).
// - An anonymous author is shown as 'Anonymous' with a fixed id to everyone but staff.
// - System and admin alerts carry the system name, or the assigned chat bot's for automated alerts.
// - Who retracted or pinned, and skin prices, are never included.
export function toPublicMessage(row: MessageRow, viewer: Viewer): PublicMessage {
  const createdAt = row.createdAt.toISOString();
  const isRetracted = row.retractedAt !== null;
  const isAuthor = row.userId === viewer.userId;
  if (isRetracted && !isAuthor && !viewer.isStaff) {
    return { id: row.id, roomId: row.roomId, createdAt, isRetracted: true };
  }

  const isAlert = row.type === 'SYSTEM_ALERT' || row.type === 'ADMIN_ALERT';
  const hidden = row.metadata.anonymous === true && !viewer.isStaff && !isAuthor;
  return {
    id: row.id,
    roomId: row.roomId,
    userId: hidden ? ANONYMOUS_AUTHOR_ID : row.userId,
    username: isAlert
      ? (row.metadata.bot?.username ?? SYSTEM_AUTHOR_NAME)
      : hidden
        ? ANONYMOUS_AUTHOR_NAME
        : (row.authorUsername ?? DELETED_AUTHOR_NAME),
    content: row.content,
    type: row.type,
    skin: row.skin,
    // Upload links are signed for the viewer so images load without a session refresh on that request.
    media: row.metadata.media
      ? {
          ...row.metadata.media,
          url: signMediaUrl(row.metadata.media.url),
          ...(row.metadata.media.thumbnailUrl
            ? { thumbnailUrl: signMediaUrl(row.metadata.media.thumbnailUrl) }
            : {}),
        }
      : null,
    taggedUsernames: row.metadata.taggedUsernames ?? [],
    createdAt,
    isRetracted,
    isPinned: row.pinnedAt !== null,
    ...(isAlert && row.metadata.alertType ? { alertType: row.metadata.alertType } : {}),
    ...(isAlert && row.metadata.bot ? { bot: row.metadata.bot } : {}),
    ...(row.type === 'AD' && row.metadata.ad
      ? { ad: { adId: row.metadata.ad.adId, badge: row.metadata.ad.badge ?? null } }
      : {}),
    ...(row.type === 'GIFT' && row.metadata.gift ? { gift: row.metadata.gift } : {}),
  };
}

const ANYONE: Viewer = { userId: '', isStaff: false };

// The public view of a message for the room broadcast: no viewer-specific extras.
export function broadcastView(row: MessageRow): PublicMessage {
  return toPublicMessage(row, ANYONE);
}

// Cursors
export interface Cursor {
  // Database time as text with microseconds, never through a JavaScript Date (milliseconds only).
  readonly createdAt: string;
  readonly id: string;
}

const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url');
}

// An undecodable cursor is the caller's mistake: 400 validation_failed.
export function decodeCursor(raw: string): Cursor {
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    text = '';
  }
  const [createdAt, id] = text.split('|');
  if (!createdAt || !id || !CURSOR_TIME.test(createdAt) || !isUuid(id)) {
    throw new ProblemException({
      type: ERR.VALIDATION_FAILED,
      errors: [{ path: 'cursor', message: 'Not a cursor this API returned' }],
    });
  }
  return { createdAt, id: id.toLowerCase() };
}

// Text
// Message text is stored exactly as typed: trimmed, line endings unified and runs of blank lines
// collapsed, never HTML-escaped. Clients render every chat text field as plain text.
export function normalizeContent(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/\n{3,}/g, '\n\n');
}

const TAG = new RegExp(
  `(^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{${USERNAME.PREMIUM_MIN_LENGTH ?? 2},${USERNAME.MAX_LENGTH}})(?![A-Za-z0-9_])`,
  'g',
);

// The @usernames in a message, lower-cased and unique, in order. `@bobby` never tags `bob`.
export function extractTaggedUsernames(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(TAG)) {
    const name = match[2]?.toLowerCase();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

// Links
export interface FoundLink {
  readonly host: string;
  // Written without a scheme (`evil.com`), which is refused but never counts as an offence.
  readonly bare: boolean;
}

const SCHEME_LINK = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const WWW_LINK = /(^|[^\w.-])(www\.(?:[a-z0-9-]+\.)+[a-z]{2,63})(?=[\s/:?#,;!.)"']|$)/gi;
const BARE_LINK =
  /(^|[^\w.@/-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}))(?=[\s/:?#,;!.)"']|$)/gi;

export function findLinks(text: string): FoundLink[] {
  const links: FoundLink[] = [];
  let rest = text;

  for (const match of text.matchAll(SCHEME_LINK)) {
    try {
      const url = new URL(match[0]);
      links.push({ host: url.hostname.toLowerCase(), bare: false });
    } catch {
      links.push({ host: '', bare: false });
    }
    rest = rest.replace(match[0], ' ');
  }
  for (const match of rest.matchAll(WWW_LINK)) {
    links.push({ host: (match[2] ?? '').toLowerCase(), bare: true });
    rest = rest.replace(match[2] ?? '', ' ');
  }
  for (const match of rest.matchAll(BARE_LINK)) {
    const tld = (match[3] ?? '').toLowerCase();
    if (LINK_TLDS.has(tld)) links.push({ host: (match[2] ?? '').toLowerCase(), bare: true });
  }
  return links;
}

// A host is allowed when it IS an allowed domain or a subdomain of one — never when it merely contains the word.
export function hostAllowed(host: string, allowedDomains: readonly string[]): boolean {
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

// Banned words
// Scripts written without spaces between words: a banned word in them matches anywhere in the text.
const NO_SPACE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

const matchers = new Map<string, RegExp | null>();
const MATCHER_CACHE_LIMIT = 500;

// One compiled matcher per word list, reused until the list changes. Case-insensitive in every language ("This will
// NOT be case sensitive", Chat SETTINGS); a word matches only as a whole word, except in scripts without spaces. Runs of
// spaces, tabs and line breaks count as one in a phrase, so "free  money" is caught like "free money".
export function bannedWordMatcher(words: readonly string[]): RegExp | null {
  const key = words.join('\u0000');
  const cached = matchers.get(key);
  if (cached !== undefined) return cached;

  const parts = words
    .map((word) => word.trim().replace(/\s+/g, ' '))
    .filter((word) => word.length > 0)
    .map((word) => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
      return NO_SPACE_SCRIPT.test(word)
        ? escaped
        : `(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`;
    });
  const matcher = parts.length === 0 ? null : new RegExp(parts.join('|'), 'iu');

  if (matchers.size >= MATCHER_CACHE_LIMIT) matchers.clear();
  matchers.set(key, matcher);
  return matcher;
}

// Emoji
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const NOT_EMOJI = /[©®™]/g;

// Emoji for "allow emoji": pictographs, but not ©, ® or ™.
export function containsEmoji(text: string): boolean {
  return PICTOGRAPH.test(text.replace(NOT_EMOJI, ''));
}

// Media URLs (NEW-3)
// A GIF is accepted only as an https URL on the chosen provider's hosts.
export function isAllowedGifUrl(raw: string, provider: GifProvider): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && GIF_HOSTS[provider].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Images and video must be chat uploads, served by the chat media route under `mediaBase` (the chat server's own
// public origin). https is required except when the base itself is plain http (local development).
export function isChatMediaUrl(raw: string, mediaBase: string): boolean {
  try {
    const url = new URL(raw);
    const base = new URL(mediaBase);
    if (url.protocol !== 'https:' && !(base.protocol === 'http:' && url.protocol === 'http:'))
      return false;
    return (
      url.host === base.host &&
      /^\/social\/chat\/media\/[0-9a-f-]{36}$/i.test(url.pathname) &&
      url.search === ''
    );
  } catch {
    return false;
  }
}

export function isAllowedMediaUrl(
  raw: string,
  type: MediaType,
  provider: GifProvider,
  mediaBase: string,
): boolean {
  return type === 'gif' ? isAllowedGifUrl(raw, provider) : isChatMediaUrl(raw, mediaBase);
}

// Money
// Cuts, never rounds: `cutDecimal('9.999', 2)` is `'9.99'`; pads to `places`. (platform/money)
export const cutDecimal = cutText;

export const toDisplayUsd = usdShown;
export const toDisplayCrypto = cryptoShown;

export function compareDecimal(
  a: string | { toString(): string },
  b: string | { toString(): string },
): number {
  return compare(a, b);
}

// Client IP
let trustedCache: { source: readonly string[]; list: BlockList } | null = null;

function trustedList(trusted: readonly string[]): BlockList {
  if (trustedCache?.source === trusted) return trustedCache.list;
  const list = new BlockList();
  for (const entry of trusted) {
    const [address = '', bits] = entry.trim().split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (!isIP(address)) continue;
    if (bits === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(bits), family);
  }
  trustedCache = { source: trusted, list };
  return list;
}

function stripV4Mapped(address: string): string {
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

// The client's IP with the same rule the web side uses (TRUSTED_PROXIES, see src/main.ts): walk X-Forwarded-For from
// the right and stop at the first address that is not one of our proxies. Without trusted proxies, the socket
// address.
export function clientIp(
  forwardedFor: string | string[] | undefined,
  remote: string,
  trusted: readonly string[],
): string {
  const socketAddress = stripV4Mapped(remote);
  if (trusted.length === 0) return socketAddress;
  const list = trustedList(trusted);
  const isTrusted = (address: string): boolean => {
    const clean = stripV4Mapped(address);
    const family = isIP(clean);
    return family !== 0 && list.check(clean, family === 6 ? 'ipv6' : 'ipv4');
  };
  if (!isTrusted(socketAddress)) return socketAddress;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const hops = header
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = stripV4Mapped(hops[i] ?? '');
    if (!isTrusted(hop)) return hop;
  }
  return hops.length > 0 ? stripV4Mapped(hops[0] ?? socketAddress) : socketAddress;
}
