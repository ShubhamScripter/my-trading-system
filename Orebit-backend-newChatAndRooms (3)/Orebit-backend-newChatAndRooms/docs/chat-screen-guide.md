# Chat — guide for the app team

One page: routes, socket events, reconnect, refusal reasons, list shape. Details of every route: the "Chat — …" tags in
`openapi.json` (served at `/docs`) and `docs/postman/orebit-chat.postman_collection.json`. Socket frames to try:
`docs/postman/orebit-chat-socket.testing-guide.json`. Guide version: **1**.

## Sign in

Cookie only. `POST /auth/login` sets `orebit_session` and `orebit_csrf`. Send requests with
`credentials: "include"`; every POST/PUT also sends `x-orebit-csrf: <orebit_csrf value>`. No token goes in an address,
header or socket payload.

## Answers

- Success: `{ "data": …, "meta": { "requestId" } }`.
- Failure: `application/problem+json` with `type`, `status`, `detail`, and `extra.reason` for chat refusals.
- Lists: `{ items, nextCursor }`. Send `nextCursor` back as `cursor`; `null` ends the list. Page size `limit` 1–100.

## Routes (all under `/social/chat`)

| Screen | Route |
|---|---|
| Lobby | `GET rooms` |
| Room rules box | `GET rooms/:roomId/rules` |
| Member list (on open, not pushed) | `GET rooms/:roomId/users?prefix=` |
| History / catch-up | `GET rooms/:roomId/messages?cursor=` or `?after=<messageId>` |
| Pinned | `GET rooms/:roomId/pinned` |
| Profile card, report a user | `GET users/:userId/profile`, `POST users/:userId/report` |
| Preferences, skins, warnings, mentions | `GET/PUT preferences`, `GET skins`, `GET warnings`, `GET tags` |
| Media | `POST upload?roomId=` (multipart `file`) → `POST messages/media` |
| Retract, report a message | `POST messages/:messageId/retract`, `POST messages/:messageId/report` |
| Report reasons | `GET report-reasons` |
| Staff only | `POST staff/warn`, `POST staff/ban`, `POST messages/:messageId/pin`, `…/unpin` |

`:roomId` is a room id or slug. Open the room in `preferences.effectiveDefaultRoomId` first.

## Socket

Namespace `/chat`, same cookie, from an allowed origin. One room per socket; the server decides which.

**You send** (every one answers an ack `{ ok: true, data }` or `{ ok: false, error }`):

| Event | Payload | Ack data |
|---|---|---|
| `send_message` | `{ roomId?, content, skinId?, clientMessageId? }` or with `mediaUrl`, `mediaType`, `thumbnailUrl?` | `{ messageId, createdAt }` |
| `retract_message` | `{ messageId, note? }` | `{ messageId, roomId, retractedAt }` |
| `join_room` | `{ roomId }` | `{ roomId, access, onlineCount }` |
| `leave_room` | `{}` | `{ roomId }` |
| `get_online_users` | `{ roomId?, limit?, cursor?, prefix? }` (one search a second) | `{ roomId, count, items, nextCursor }` |

**You receive:** `new_message`, `new_messages` (busy room, grouped), `message_retracted`, `message_pinned`,
`message_unpinned`, `user_tagged`, `room_access` (`joined`, `forbidden`, `removed`, `updated`), `room_left`,
`rooms_changed` (reload the lobby), `online_count_updated`, `online_users`, `rate_limit_cooldown`
(`{ remainingSeconds, reason }`), `moderation_notice` (ban, warning, retract, unban — show it), `session_ended`,
`session_replaced`, `exception`.

**`connect_error`** message is one of `unauthenticated` (sign in again), `session_refresh_required` (refresh the
session, then reconnect), `session_store_unavailable` (retry with back-off), `origin_not_allowed` (fix the page),
`server_busy` (back off with jitter).

## Reconnect recipe

1. Keep the id of the last message you received.
2. On reconnect the server puts you back in your last room (or the default). Wait for `room_access: joined`.
3. `GET rooms/:roomId/messages?after=<last id>` — newer messages, oldest first; repeat while `hasMore`.
4. Drop any message whose id you already have. Resend an unacknowledged send with the **same** `clientMessageId`: it is
   stored and shown once.

## Refusal reasons (`extra.reason`)

`chat_banned` and `chat_muted` (`extra.expiresAt`), `room_read_only`, `room_hidden`, `content_blocked`
(`extra.rule`: `media_type`, `text`, `emoji`, `banned_word`, `link`, `spam`), `limit_blocked`, `skin_not_allowed`,
`already_reported`, `cannot_report_own_message`, `already_retracted`, `retract_window_passed`, `feature_disabled`,
`upload_storage_unavailable`, `media_deleted`, `staff_only`, `target_outranks_you`, `session_replaced`. Show text from
the reason, never from the English `detail`. A `429` carries `Retry-After`.
