# Chat (public rooms, Modules 1–3; staff, commands, ads, gifts, rain, DMs and groups, Modules 4–9)

What the chat server does, where each rule lives, and what must stay true. The requirement documents are Chat MAIN,
Chat SETTINGS and the 10-module roadmap.

## One chat server in version 1

Version 1 runs **exactly one** chat server. Several things assume it and would silently split chat if a second copy
were started:

- the registry of connected sockets per user (`chat.presence.service.ts`): connection cap, "online", member lists;
- the per-connection flood buckets and the per-socket send order (`chat.gateway.ts`);
- the grouping of busy rooms into `new_messages` frames and the throttled online counts (`realtime/chat.delivery.ts`);
- the one `LISTEN chat_events` connection that receives admin changes (`chat.events.listener.ts`).

Do not start a second copy before a Socket.IO Redis adapter is added (the platform owner's change, and only if the
speed target is missed after re-measuring). A restart disconnects everyone and they reconnect; the server accepts at
most 200 handshakes being checked at once and refuses the rest with `server_busy`, so clients back off with jitter.

## Where things are

Every file is under 500 lines. Flow: routes → controller → service → dboperation; only a dboperation touches Prisma.
The files the hand-off names stay at the top of this folder. The rest sit in three subfolders, like `auth/`:
`services/` (rules and services), `persistence/` (queries) and `realtime/` (socket plumbing).

| File | What |
|---|---|
| **Entry** | |
| `chat.module.ts` | Wiring. |
| `chat.routes.ts`, `chat.controller.ts`, `chat.dto.ts` | HTTP: paths, guards and pipes; the handler bodies; request shapes. |
| **Contract and shared** | |
| `chat.contract.ts`, `chat.settings.contract.ts` | The room config, access rule and chat-wide settings both backends validate against. Byte-identical copies live in the admin backend; both test `tests/social/fixtures/chat-contract.fixture.json`. |
| `chat.types.ts`, `chat.constants.ts`, `chat.keys.ts`, `chat.utility.ts` | Shared types; limits, timers and event names; every Redis key and its lifetime; pure helpers (cursors, links, public message shape). |
| **Rules and facts** | |
| `services/chat.access.rules.ts` | Who may see, read and write a room (pure; one matrix test). |
| `chat.access.service.ts` | Room cache, per-user eligibility facts (30 s), room list, the room that opens. |
| `chat.ports.ts` | Facts other modules own: country, premium plans, KYC level and entitlements, site owner, casino, level. The VIP system is removed for now. Null = not connected = closed. |
| `chat.test-providers.ts` | The test-only stand-ins for those ports (NEW-2): answer from `chat.test_entitlements`, only when the setting, `CHAT_ALLOW_TEST_PROVIDERS` and a non-production `NODE_ENV` all allow it. |
| **Services** | |
| `chat.service.ts` | One send path for both transports, retract, room lists, system alerts. |
| `services/chat.read.service.ts` | History, pinned messages, the tag feed, a user's warnings. |
| `services/chat.content.service.ts` | Room content rules (types, restrictions, words, links, spam) and the offence ladder. |
| `chat.moderation.service.ts` | Bans (database clock, ban version), slow mode and send limits, frequent hitters. |
| `services/chat.staff.service.ts` | Staff warn, ban, pin, retract; user reports of messages and users. |
| `services/chat.account.service.ts`, `chat.upload.ts` | Preferences, profile cards, skins; uploads and the signed media route. |
| `chat.presence.service.ts`, `chat.settings.ts`, `chat.auth.helper.ts` | Who is online and each user's last room; chat-wide settings and their scheduled changes; HTTP user resolution. |
| **Real time** | |
| `chat.gateway.ts` | Socket handlers: handshake, rooms, send, retract, members. |
| `realtime/chat.gateway.changes.ts` | What the gateway does when an admin, staff member or setting changes (re-check rooms, notices); moving a socket between rooms. |
| `chat.gateway.guard.ts`, `chat.ws.filter.ts`, `chat.ws.pipe.ts` | The sign-in guard, the failure filter and the input pipe of every socket handler. |
| `realtime/chat.gateway.helpers.ts` | Flood bucket, send-payload mapping and last-room hint (pure). |
| `chat.session.adapter.ts`, `realtime/chat.session.watch.ts` | Cookie-only socket login; ends sockets whose session died. |
| `realtime/chat.bus.ts`, `realtime/chat.delivery.ts`, `chat.ack.ts` | In-process change bus; delivery to rooms and users; the ack shape every handler returns. |
| `chat.events.listener.ts`, `chat.maintenance.ts`, `chat.seed.ts` | Admin changes (LISTEN/NOTIFY); the one-minute tick; development data. |
| **Database** | |
| `chat.dboperation.ts`, `persistence/chat.history.dboperation.ts` | Messages, rooms, users, preferences; history, pinned and tag-feed pages. |
| `persistence/chat.records.dboperation.ts`, `persistence/chat.settings.dboperation.ts`, `persistence/chat.sql.ts` | Bans, warnings, reports and audit records; the settings document; shared SQL pieces. |

## Modules 4–9

| File | What |
|---|---|
| `chat.features.contract.ts`, `chat.features.defaults.ts` | The chat-wide sections of these modules (staff roles, commands, gifts, ads, rewards, chat bot, DM, groups, privacy) and their defaults. Byte-identical in the admin backend, like the other contracts. |
| `chat.feature-ports.ts` | Transfers (and their revert), charges, 2FA, follows and rewards (EXP and universal currency): owned by other modules; stand-ins only in test mode. |
| `chat.staff.routes.ts`, `chat.staff.controller.ts` | Staff HTTP routes (`/social/chat/staff/…`). |
| `services/chat.permissions.ts`, `services/chat.staff.gate.ts` | Role permissions ACT / REPORT / NONE, scopes and limits; a REPORT-mode action becomes a `chat.staff_requests` row. |
| `services/chat.staff.tools.service.ts` | Restrict, room status, rules, room access (ADD / REMOVE / RESTORE), roles, chat-wide commands and sending money. |
| `services/chat.staff.penalties.service.ts` | Penalised list; lift and change bans and restrictions. |
| `services/chat.staff.queue.service.ts`, `services/chat.staff.insight.service.ts` | Report queue, user messages and tags, room history, staff requests; user stats (only the role's `visibleStats`) and the bot log. |
| `chat.social.routes.ts`, `services/chat.commands.*`, `services/chat.relations.service.ts` | Commands (`/help`, `/mute`, `/block`, `/send`, `/ad`, `/rain`, …); mute and block. |
| `../rain/*` | Modules 6–7: Rainpool (the 15-second rain tick: random currency, random USD amount, random time, countdown with the pot counting up) and user rain (`/rain CURRENCY AMOUNT 5\|all\|10% [repeat COUNT 60s\|5m\|1h]`), the security rules, reverts and scheduled ON / OFF / MAINTENANCE. The settings live in `rain.config` (contract `rain.contract.ts`, copied byte for byte into the admin backend, which owns the settings, reviews and reverts and queues money work in `rain.jobs`). USD prices and VPN detection come through `rain.ports.ts`; money moves only through `rain.wallet.ts` (the development wallet until the ledger is connected). |
| `services/chat.ads.*`, `services/chat.gifts.service.ts`, `services/chat.rewards.ts` | Ads (pricing incl. sub-premium rooms and skins, posting, pinning, refunds, reverted rewards); gifts (limits per currency, the receive restriction, admin reverts); reward rules. |
| `dm/` | Direct messages and groups: `dm.service.ts` (open, send, read), `dm.actions.service.ts` (retract, pin, forward, report, gift button), `dm.inbox.service.ts` (tabs PRIMARY / GENERAL / GROUPS / CHANNELS / REQUESTS, privacy), `dm.groups.service.ts` and `dm.groups.moderation.service.ts` (roles, timeouts, bans, ownership transfer: at once, no code, V2-144). Groups change under one lock on the group row (join, member and admin caps, ownership); `dm.member-cache.ts` keeps each conversation's member list 5 s and every `dm_members` write invalidates it. |

The one-minute tick also runs ads (slots, repeats, refunds, reward take-backs) and the gift reverts an admin queued
(`REVERT_PENDING` → `REVERTED` or `REVERT_FAILED` with the transfer module's reason). Automated alerts are posted
under the chat bot profile when the admin assigns one (`bot.profileUserId`).

## Rules that must stay true

- **Database clock** for every stored, shown or business time. The only exceptions: the flood bucket (server
  stopwatch) and cache-freshness / presence timers. Message links use the database's text of `created_at`
  (microseconds); a JavaScript `Date` keeps only milliseconds.
- **Messages are never deleted** (Chat SETTINGS). `chat.room_messages` is partitioned by month; the tick keeps three
  months ahead ready and logs an error if a row lands in the DEFAULT partition.
- **Safe by default**: images, video, links, commands and ads are off unless an admin turns them on.
- Message text is **plain text as typed**; clients render it as text, never as HTML.
- Refusals carry `extra.reason` (`chat.constants.ts` `CHAT_REFUSAL_REASONS`); clients never parse the English detail.

## Environment (read by chat only)

| Variable | Default | Meaning |
|---|---|---|
| `CHAT_ALLOWED_ORIGINS` | origin of `WEB_APP_URL` | Comma-separated origins the socket accepts. |
| `CHAT_UPLOADS_ENABLED` | off | Uploads work only when exactly `true`. Keep off in production until an NSFW scan and object storage exist. |
| `CHAT_UPLOADS_DIR` | `<cwd>/storage/chat-media` | Private folder for uploads (never under `uploads/`). |
| `CHAT_MEDIA_BASE_URL` | `http://localhost:<PORT>` | Public origin of this server; upload URLs are built and checked against it. |
| `CHAT_LISTEN_DATABASE_URL` | `DATABASE_DIRECT_URL` | A DIRECT Postgres connection for `LISTEN chat_events` (not through a transaction pooler). |
| `CHAT_ALLOW_TEST_PROVIDERS` | off | With the chat setting `testProviders.enabled`, outside production only: stand-in facts from `chat.test_entitlements`. |

## Tests

```
npx vitest run --config vitest.chat.config.ts
```

The default `vitest.config.ts` leaves `tests/social` out. The database-backed checks and the schema drift check run only against a MIGRATED scratch database (never the
development database):

```
CHAT_TEST_DATABASE_URL=postgresql://…/orebit_chat_verify \
CHAT_TEST_SHADOW_DATABASE_URL=postgresql://…/orebit_chat_shadow \
npx vitest run --config vitest.chat.config.ts
```

Set `DATABASE_DIRECT_URL` as well as `DATABASE_URL` when migrating a scratch database: `prisma migrate deploy` uses
the direct URL.

## Development data (`chat.seed.ts`)

Never in production. Touches only the `chat` schema and `chat:*` Redis keys; user accounts, admin accounts and sessions stay.

```
npx tsx --env-file=.env src/social/chat/chat.seed.ts reset    # wipe all chat data, then seed (clean test start)
npx tsx --env-file=.env src/social/chat/chat.seed.ts clean    # wipe all chat data only
npx tsx --env-file=.env src/social/chat/chat.seed.ts seed     # Global, Staff, demo rooms, default settings, skin, report reasons
npx tsx --env-file=.env src/social/chat/chat.seed.ts unseed   # remove exactly what seed added
```

Restart the chat server after `clean` / `reset` so its in-memory caches start empty.

## Modules 8–9: personal chat and groups (files, seams, and what keeps it fast)

Every file here is under 500 lines and has one job. Flow as everywhere: routes → controller → service → dboperation.

| File | What |
|---|---|
| `dm/dm.service.ts` | Open a direct chat, send (the guard, folder and request rules, caps, limits), history, accept/decline |
| `dm/dm.delivery.service.ts` | Delivery to sockets: one cached member list, two views, one emit per distinct payload (a 500-member group is a few emits) |
| `dm/dm.signals.service.ts` | Typing and read receipts: the one switch both ways, never across a block, groups only below the admin-set size |
| `dm/dm.inbox.service.ts` | Folders, inbox lists (ids first, details for that page only), pins, nicknames, search, shared items |
| `dm/dm.privacy.service.ts` | Last seen, quiet mode (account time zone), the typing/read switch, username-only lookup, folder move on a follow change |
| `dm/dm.actions.service.ts`, `dm/dm.cards.service.ts` | Retract, pin, forward, report, the gift button; gift cards (CARD message, never the code) |
| `dm/dm.groups.service.ts`, `dm/dm.groups.invites.service.ts`, `dm/dm.groups.moderation.service.ts` | Groups and channels; invites (limits, expiry, revoke); roles, timeouts, bans, ownership (no code) |
| `dm/dm.dboperation.ts`, `dm/dm.messages.dboperation.ts`, `dm/dm.inbox.dboperation.ts` | Conversations and members (with the member cache); messages (de-duplicated, partitioned, archived); inbox SQL |
| `dm/dm.groups.dboperation.ts`, `dm/dm.group-invites.dboperation.ts`, `dm/dm.group-bans.dboperation.ts` | The group row and its locked changes; invites; bans |
| `dm/dm.rows.ts`, `dm/dm.rules.ts`, `dm/dm.limits.ts`, `dm/dm.view.ts`, `dm/dm.member-cache.ts` | Row types and SQL; pure rules; "an unset limit refuses" helper; what a member receives; the 5-second member cache |

Seams other modules use:

- **Follows (Social module).** Publish `{ kind: 'follow', userA, userB }` on `ChatBus` when a follow is added or removed;
  the two people's direct chat is placed again by the folder rules (a folder the user chose is never moved).
- **Gift cards (Coupon module).** Bind `CHAT_COUPON_PORT` (`describe`, `give`). Not bound = `feature_unavailable`.
- **Account time zone.** `TimeZonePort`; no zone means no automatic night mode.

What keeps it fast at 1 million users:

- A group's member count is a column kept by a trigger (`dm_groups.member_count`); nothing counts member rows.
- `chat.dm_messages` is partitioned by month; DM months older than 12 are detached into `chat_archive` (never deleted) by
  the daily maintenance step, and a history that reaches its end says `archivedBefore`.
- A retry of a send is decided by the primary key of `chat.dm_message_dedupe`, not by a unique index on the table.
- Join, member limits, admin caps and ownership run under one lock on the group row; the unique indexes are the backstop.
- Join and leave lines that come close together are one line whose counts grow (`dm_message_updated`).

## `platform/`: the shared pieces of Modules 4–5 (money, idempotency, jobs, limiter, gate)

| File | What it is for | Rule |
|---|---|---|
| `platform/money.ts` | The one place that adds, scales, cuts and formats an amount: 60-digit decimals, cut never round, USD 8/2 and crypto 18/8 places, `parseAmount` refuses extra decimals. Nothing else in chat may call `toFixed`, `Math.round` or `parseFloat` (a test scans for it). | B-1, B-2, FR-004/181/105 |
| `platform/idempotency.ts` | `fingerprint` of a request, `requireKey`, and the 409 when a key is reused for a different request. The table that holds the key belongs to the feature (ads, gifts). | FR-016 |
| `platform/jobs.ts` | `claimBatch`: claim due rows with `FOR UPDATE SKIP LOCKED`, take over a stale claim, `releaseClaim`. Needs a `claimed_at` column. | FR-017, FR-106 |
| `platform/limiter.ts` | `ChatActionLimiter`: per-user counter in Redis (atomic INCR) with a cooldown; the in-process fallback when Redis is down. The numbers are the admin's chat limits. | FR-173, V2-07 |
| `services/chat.action-gate.service.ts` | `ChatActionGate`: the one gate for send, gift, ad, mute, block and their lists: switches, maintenance, room controls, restrictions, standing, pace. Used by typed commands, the HTTP routes and the DM gift button/card. | FR-103, FR-173 |
