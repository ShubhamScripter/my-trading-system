// Fixed values of the chat module. Tunable numbers are NOT here: they are admin settings (chat.settings.contract.ts
// `DEFAULT_CHAT_SETTINGS`, read through ChatSettingsService). What is here either never changes or is a protocol
// value the web app depends on.

// The Global room, created by migration.
export const GLOBAL_ROOM_ID = '00000000-0000-0000-0000-000000000000';
export const GLOBAL_ROOM_SLUG = 'global';

// The author stored on system alerts and admin broadcasts. Not a user.
export const SYSTEM_AUTHOR_ID = '00000000-0000-0000-0000-000000000000';
export const SYSTEM_AUTHOR_NAME = 'OREBiT';

/** What a non-staff viewer sees as the author of a message whose author hides their identity. Differs from the
 *  system author, so a client can never mistake an anonymous user for an official alert. */
export const ANONYMOUS_AUTHOR_ID = '00000000-0000-4000-8000-000000000000';
export const ANONYMOUS_AUTHOR_NAME = 'Anonymous';
export const DELETED_AUTHOR_NAME = 'Deleted user';

// Chat staff roles that moderate by default and skip the automatic checks (words, links, spam). What each role may
// actually do is its permission set in the chat settings (`staffRoles`, Module 4), checked by chat.permissions.ts.
export const CHAT_STAFF_ROLES = ['ADMIN', 'MODERATOR'] as const;
// Higher outranks lower: staff may not act on a user whose chat role is equal or higher.
export const STAFF_RANK: Readonly<Record<string, number>> = { ADMIN: 3, MODERATOR: 2, SUPPORT: 1 };

// Every list: cursor paging, default 50, at most 100.
export const PAGE = { DEFAULT: 50, MAX: 100 } as const;

// Message and packet sizes.
export const LIMITS = {
  MESSAGE_CHARS: 4000,
  URL_CHARS: 2048,
  CAPTION_CHARS: 500,
  NOTE_CHARS: 500,
  // At most this many users are tagged per message; further @names stay plain text.
  TAGS_PER_MESSAGE: 10,
  // Socket.IO `maxHttpBufferSize`: a packet over this closes the connection.
  SOCKET_PACKET_BYTES: 64 * 1024,
  ROOM_REF_CHARS: 128,
} as const;

// Chat's own clocks that never store or show a time and its scheduling.
export const TIMERS = {
  // Caches of settings, rooms and user eligibility live at most this long.
  CACHE_SECONDS: 30,
  // The maintenance tick: presence refresh, stats, retry-id clean-up, due settings changes, media removal.
  TICK_MS: 60_000,
  // The money loop (chat.money-loop.ts) starts a pass this often; a signal starts one at once.
  MONEY_LOOP_MS: 15_000,
  // Presence markers expire this long after the last refresh, so a crash leaves no ghosts.
  PRESENCE_TTL_SECONDS: 150,
  // Logout reaches chat within about 5 seconds; the database backstop runs every 30.
  REVOCATION_CHECK_MS: 5_000,
  SESSION_BACKSTOP_MS: 30_000,
  // Online counts are sent to a room at most once a second.
  COUNT_EMIT_MS: 1_000,
  // Busy rooms: more than this many messages in a second switches the room to grouped frames.
  BUSY_ROOM_PER_SECOND: 10,
  GROUP_FLUSH_MS: 100,
  GROUP_MAX_MESSAGES: 50,
  // At most one member search per second per socket.
  MEMBER_SEARCH_MS: 1_000,
  // Handshakes being authenticated at once; more are refused with server_busy.
  MAX_PENDING_HANDSHAKES: 200,
  // Bound queued message writes so overload is refused before it becomes a long, silent ack delay.
  MAX_PENDING_SENDS: 200,
  // Send-retry ids are kept this long.
  CLIENT_ID_RETENTION_HOURS: 24,
  // Messages of a reconnect catch-up start this long before the last message the client had.
  CATCH_UP_OVERLAP_MS: 2_000,
} as const;

// How long the partition function looks ahead (NEW-1).
export const PARTITION_MONTHS_AHEAD = 3;

// Joins and leaves of a group within this many seconds are one notice line, not one line each.

// DM months older than this are detached into the chat_archive schema, never deleted.
export const DM_ARCHIVE_AFTER_MONTHS = 12;

// The machine-readable reason on every refusal, in `extra.reason` of both HTTP problems and socket acks.
// A client decides what to show from these, never from the English detail.
export const CHAT_REFUSAL_REASONS = {
  CHAT_BANNED: 'chat_banned',
  CHAT_MUTED: 'chat_muted',
  ROOM_READ_ONLY: 'room_read_only',
  ROOM_HIDDEN: 'room_hidden',
  CONTENT_BLOCKED: 'content_blocked',
  CANNOT_REPORT_OWN_MESSAGE: 'cannot_report_own_message',
  ALREADY_REPORTED: 'already_reported',
  ALREADY_RETRACTED: 'already_retracted',
  RETRACT_WINDOW_PASSED: 'retract_window_passed',
  SKIN_NOT_ALLOWED: 'skin_not_allowed',
  FEATURE_DISABLED: 'feature_disabled',
  UPLOAD_STORAGE_UNAVAILABLE: 'upload_storage_unavailable',
  MEDIA_DELETED: 'media_deleted',
  STAFF_ONLY: 'staff_only',
  TARGET_OUTRANKS_YOU: 'target_outranks_you',
  LIMIT_BLOCKED: 'limit_blocked',
  SESSION_REPLACED: 'session_replaced',
  // Module 4: role permissions
  // The staff role lacks this permission (or has it only in REPORT mode where acting was asked).
  PERMISSION_DENIED: 'permission_denied',
  // Outside the role's scope: a room it may not act in, a ban longer than its maximum, a penalty of a higher role.
  OUTSIDE_ROLE_SCOPE: 'outside_role_scope',
  // Module 5: commands, ads and gifts
  UNKNOWN_COMMAND: 'unknown_command',
  // Commands are off chat-wide, or this command is.
  COMMAND_DISABLED: 'command_disabled',
  // The room does not accept commands, or not this one.
  COMMAND_NOT_ALLOWED_HERE: 'command_not_allowed_here',
  // A restriction takes this command (or ads, gifts, DMs) away from the user.
  RESTRICTED: 'restricted',
  // A module chat relies on is not connected (transfers, payments, verification).
  FEATURE_UNAVAILABLE: 'feature_unavailable',
  // One of the two users blocked (or, for gifts, muted) the other.
  BLOCKED: 'blocked',
  ADS_NOT_ALLOWED: 'ads_not_allowed',
  AD_QUEUE_FULL: 'ad_queue_full',
  // The payment or transfer module refused (insufficient balance, limits). `extra.detail` says why.
  PAYMENT_FAILED: 'payment_failed',
  // Ad, gift and alert notices are removed only from the admin panel.
  NOT_RETRACTABLE: 'not_retractable',
  // A live ban already exists for this user (and room): a second one is not made.
  ALREADY_BANNED: 'already_banned',
  // The charge could not be confirmed yet: the same request, sent again, finishes it.
  PAYMENT_PENDING: 'payment_pending',
  VERIFICATION_FAILED: 'verification_failed',
  GIFT_EXPIRED: 'gift_expired',
  // Modules 8–9: direct messages and groups
  DM_UNAVAILABLE: 'dm_unavailable',
  // An area of chat is under maintenance (read-only) or switched off.
  FEATURE_MAINTENANCE: 'feature_maintenance',
  // A closed support ticket takes no more messages.
  TICKET_CLOSED: 'ticket_closed',
  // "Rate Limit of Sending DMs to users with whom you never had chat with".
  NEW_DM_LIMIT: 'new_dm_limit',
  // "Users cannot send links in their DM / PM message if they are not friends"; images, videos and GIFs too.
  LINKS_MEDIA_FRIENDS_ONLY: 'links_media_friends_only',
  // The other person declined this message request: the sender cannot write until they write first.
  DM_REQUEST_DECLINED: 'dm_request_declined',
  // DM is ACTIVE in the stored settings but a value is still unset.
  DM_NOT_CONFIGURED: 'dm_not_configured',
  // A limit the admin has not set yet: the limited action is refused.
  LIMIT_NOT_SET: 'limit_not_set',
  // A stranger or a merchant-app customer wrote the allowed number of messages and nobody replied.
  REQUEST_CAP_REACHED: 'request_cap_reached',
  // Too many mute, block, ad or gift actions by one user in a short time.
  ACTION_LIMIT: 'action_limit',
  // A money action sent without a usable key, or with a key already used by a different request.
  IDEMPOTENCY_KEY_REQUIRED: 'idempotency_key_required',
  IDEMPOTENCY_KEY_REUSED: 'idempotency_key_reused',
  // Only admins post in a channel.
  CHANNEL_ADMINS_ONLY: 'channel_admins_only',
  // The group closed when its last member left.
  GROUP_CLOSED: 'group_closed',
  // Nicknames are for friends only.
  FRIENDS_ONLY: 'friends_only',
  NOT_A_MEMBER: 'not_a_member',
  GROUP_BAN_NOT_FOUND: 'group_ban_not_found',
  // A limit from the DM settings: pinned people or messages, groups created or joined, admins, members.
  LIMIT_REACHED: 'limit_reached',
  // The group's "members can text" is off, or this member is timed out.
  GROUP_TEXT_OFF: 'group_text_off',
  GROUP_BANNED: 'group_banned',
  INVITE_ONLY: 'invite_only',
} as const;
export type ChatRefusalReason = (typeof CHAT_REFUSAL_REASONS)[keyof typeof CHAT_REFUSAL_REASONS];

// `extra.rule` of a `content_blocked` refusal.
export const CONTENT_RULES = {
  MEDIA_TYPE: 'media_type',
  TEXT: 'text',
  EMOJI: 'emoji',
  BANNED_WORD: 'banned_word',
  LINK: 'link',
  SPAM: 'spam',
} as const;

// Handshake refusals (`connect_error` message), distinct so a client knows whether to refresh, retry or sign in.
export const HANDSHAKE_REFUSALS = {
  UNAUTHENTICATED: 'unauthenticated',
  SESSION_REFRESH_REQUIRED: 'session_refresh_required',
  SESSION_STORE_UNAVAILABLE: 'session_store_unavailable',
  ORIGIN_NOT_ALLOWED: 'origin_not_allowed',
  SERVER_BUSY: 'server_busy',
} as const;

// Socket events the server emits.
export const SERVER_EVENTS = {
  NEW_MESSAGE: 'new_message',
  NEW_MESSAGES: 'new_messages',
  MESSAGE_RETRACTED: 'message_retracted',
  MESSAGE_PINNED: 'message_pinned',
  MESSAGE_UNPINNED: 'message_unpinned',
  USER_TAGGED: 'user_tagged',
  ROOM_ACCESS: 'room_access',
  ROOM_LEFT: 'room_left',
  // The user's room list may have changed (admin room edit, settings, eligibility facts): reload it.
  ROOMS_CHANGED: 'rooms_changed',
  ONLINE_COUNT_UPDATED: 'online_count_updated',
  ONLINE_USERS: 'online_users',
  RATE_LIMIT_COOLDOWN: 'rate_limit_cooldown',
  MODERATION_NOTICE: 'moderation_notice',
  SESSION_ENDED: 'session_ended',
  // Module 4
  // A staff member asked a higher role to act (REPORT mode); sent to staff who may resolve it.
  STAFF_REQUEST: 'staff_request',
  // Module 5
  AD_PINNED: 'ad_pinned',
  AD_UNPINNED: 'ad_unpinned',
  GIFT_RECEIVED: 'gift_received',
  // RainPool (Modules 6–7), all sent only after the money moved
  // A rain was paid in a room: to the room's viewers.
  RAIN_COMPLETED: 'rain_completed',
  // To each recipient: their own share.
  RAIN_RECEIVED: 'rain_received',
  // A rain was reversed: to the payer and every recipient.
  RAIN_REVERSED: 'rain_reversed',
  // The next system rain changed: to everyone connected.
  RAIN_STATE: 'rain_state',
  // RainPool settings changed: to everyone connected, who reload GET /social/rain/state.
  RAIN_CONFIG_CHANGED: 'rain_config_changed',
  // To the payer: an admin reviewing their rain asked for the questionnaire or a KYC check.
  RAIN_VERIFICATION_REQUESTED: 'rain_verification_requested',
  // To the payer: an admin approved or rejected their rain under manual verification.
  RAIN_REVIEWED: 'rain_reviewed',
  // Module 10
  // A support ticket changed (an answer, or it was closed).
  SUPPORT_UPDATED: 'support_updated',
  // Modules 8–9
  DM_MESSAGE: 'dm_message',
  DM_MESSAGE_RETRACTED: 'dm_message_retracted',
  DM_MESSAGE_HIDDEN: 'dm_message_hidden',
  DM_MESSAGE_PINNED: 'dm_message_pinned',
  // A message changed in place: a membership notice that grew.
  DM_MESSAGE_UPDATED: 'dm_message_updated',
  DM_MESSAGE_UNPINNED: 'dm_message_unpinned',
  DM_TYPING: 'dm_typing',
  DM_READ: 'dm_read',
  DM_REQUEST: 'dm_request',
  // Something about a conversation changed for this member (folder, membership, group details, invite).
  DM_CONVERSATION_UPDATED: 'dm_conversation_updated',
  SESSION_REPLACED: 'session_replaced',
  EXCEPTION: 'exception',
} as const;

// GIF hosts per provider (NEW-3). Only https URLs on these hosts are accepted as GIFs.
export const GIF_HOSTS: Readonly<Record<'TENOR' | 'GIPHY', readonly string[]>> = {
  TENOR: ['media.tenor.com'],
  GIPHY: [
    'media.giphy.com',
    'media0.giphy.com',
    'media1.giphy.com',
    'media2.giphy.com',
    'media3.giphy.com',
    'media4.giphy.com',
    'i.giphy.com',
  ],
};

// Top-level domains that make a bare `word.tld` a link. Kept short on purpose: `node.js`, `e.g.` and
// `v1.2` must stay plain text, so only common real TLDs count.
export const LINK_TLDS: ReadonlySet<string> = new Set([
  'com',
  'net',
  'org',
  'io',
  'co',
  'xyz',
  'info',
  'biz',
  'app',
  'dev',
  'me',
  'gg',
  'tv',
  'ly',
  'to',
  'ai',
  'cc',
  'ru',
  'cn',
  'uk',
  'de',
  'fr',
  'es',
  'it',
  'nl',
  'in',
  'us',
  'ca',
  'au',
  'br',
  'jp',
  'kr',
  'site',
  'online',
  'club',
  'shop',
  'store',
  'live',
  'link',
  'click',
  'top',
  'win',
  'bet',
  'casino',
  'vip',
  'pro',
]);

// Redis channel-free, one server: socket rooms.
export const socketRoom = (roomId: string): string => `room:${roomId}`;
export const personalRoom = (userId: string): string => `user:${userId}`;
