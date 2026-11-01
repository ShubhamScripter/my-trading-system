/**
 * Every Redis key the chat module uses, and only here. Kept apart from redis/keys.ts, which is not chat's.
 *
 * Every key is written with a TTL: Redis here is a cache that may evict, so nothing chat must not lose lives
 * in it. Offence counts are in Postgres (chat.moderation_offences); bans are in Postgres and only their check result
 * is cached, keyed by a per-user ban version so a new ban or unban is seen by the very next message.
 */
export const CHAT_REDIS_KEYS = {
  /** "Online" marker, refreshed by the maintenance tick; expires after a crash. */
  presence: (userId: string) => `chat:presence:${userId}`,

  /** A random value replaced on every ban and unban of the user. */
  banVersion: (userId: string) => `chat:ban:version:${userId}`,
  /** The user's active bans as computed for one ban version: `{ v, bans: [{ roomId, expiresAt }] }`. */
  banState: (userId: string) => `chat:ban:state:${userId}`,

  /** Slow mode window of one user: `{ windowStartMs, count, cooldownUntilMs }` in database time. */
  messageWindow: (userId: string) => `chat:limit:message:${userId}`,
  /** Database time of the user's last media message. */
  mediaWindow: (userId: string) => `chat:limit:media:${userId}`,
  /** Per-IP send window; the IP is hashed by the caller. */
  ipWindow: (ipTag: string) => `chat:limit:ip:${ipTag}`,
  /** Spam repeat window of one user in one room: `{ hash, windowStartMs, count }`. */
  spamWindow: (userId: string, roomId: string) => `chat:spam:${userId}:${roomId}`,
} as const;

/** TTLs, in seconds. They only clean up; no decision is ever made from a TTL. */
export const CHAT_KEY_TTL = {
  BAN_STATE: 30,
  BAN_VERSION: 7 * 24 * 3600,
  /** Longest window or cooldown a setting allows, plus slack. */
  LIMIT_WINDOW: 2 * 3600,
  SPAM_WINDOW: 2 * 3600,
} as const;
