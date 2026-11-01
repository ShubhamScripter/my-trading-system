# Orebit-admin-backend

Admin backend service for Orebit. TypeScript on NestJS + Fastify, Prisma over
PostgreSQL, Redis for rate limits and caches, Vitest for testing.

The entire authenticated surface is **three auth routes plus `POST /2fa`**. The
sign-in ceremony — password, captcha, email code, and a second factor — spans two
of them, and the client carries exactly one value between the steps: `loginId`.

---

## The sign-in ceremony

An admin session requires three proofs, in order. None can be skipped.

```
  ┌───────────────────────────────────────────────────────────────────────┐
  │  POST /auth/login   { "step": "start" }                               │
  │  → which captcha provider to render, and its site key                 │
  └───────────────────────────────────────────────────────────────────────┘
                                    │
  ┌─────────────────────────────────▼─────────────────────────────────────┐
  │  1.  { "step": "password", email, password, captchaToken }            │
  │      → argon2id + durable lockout + captcha                           │
  │      → metered per device, then per email, then per IP (6/10/20)      │
  │      → opens an AdminLoginAttempt at PASSWORD_VERIFIED                │
  │      → RETURNS `loginId`  ◀── the only sign-in credential             │
  │      → sets the httpOnly `orebit_admin_device` cookie (rate limits)   │
  │      → emails a 6-digit code            NO SESSION ISSUED             │
  └─────────────────────────────────┬─────────────────────────────────────┘
                                    │  loginId
  ┌─────────────────────────────────▼─────────────────────────────────────┐
  │  2.  { "step": "verify-email", loginId, code }                        │
  │      → advances to EMAIL_VERIFIED                                     │
  │      → answers `mfa_required` or `enrollment_required`                │
  │      → returns the SAME loginId          NO SESSION ISSUED            │
  └─────────────────────────────────┬─────────────────────────────────────┘
                                    │  loginId
  ┌─────────────────────────────────▼─────────────────────────────────────┐
  │  3.  POST /2fa   — a different route, the same loginId                │
  │                                                                       │
  │      TOTP                          │  Passkey                         │
  │      { "action": "totp-enroll" }   │  { "action": "passkey-challenge"}│
  │      { "action": "totp-verify" }   │  { "action": "passkey-verify" }  │
  │                                                                       │
  │      → completes the attempt, nulls the secret hash in the same       │
  │        statement — the loginId resolves to nothing from here on       │
  │      → ISSUES THE SESSION  ◀── the only place tokens are minted       │
  └───────────────────────────────────────────────────────────────────────┘
```

**No authentication cookie in the sign-in flow.** `loginId` is returned in the
response body and sent back in the request body. A client holds it in memory for
the life of the ceremony and discards it once a session is issued — it is a
credential, not a public identifier, so it does not belong in `localStorage` or
`sessionStorage`. The two cookies the flow does set are the per-browser rate-limit
id and, at the very end, the refresh token and its CSRF companion.

One consequence, stated because it is a real behaviour change: a hard page refresh
loses the `loginId` and restarts the ceremony. `{ "step": "state" }` still reports
where an attempt is, for a client that holds the id but has lost track of its own
progress.

**Forced enrollment.** A seeded admin has no second factor, so their first sign-in
answers `enrollment_required` and they enroll TOTP or a passkey before any token
exists. No admin account can reach a session without one.

### What a wrong password costs

Failures are metered; successes are not. That split is the whole design, because a
limit charged on every attempt has to be loose enough to accommodate normal use — and
that looseness is exactly the room an attacker operates in.

| Limiter | Budget | Charged on | Fails |
|---|---|---|---|
| flood ceiling, per IP | 60 / 15m | every attempt | open |
| failures, per IP | 8 / 15m | wrong passwords only | open |
| failures, per device | 6 / 15m | wrong passwords only | open |
| consecutive failures, per account | 10 → lock | wrong passwords only | **durable** |

The per-device ceiling sits under the per-IP one deliberately: one device must not be
able to consume a shared address's whole budget and lock out everyone behind it. A
successful password clears the DEVICE streak but never the shared IP bucket — clearing
that would hand an attacker holding one valid credential a reset lever.

All three Redis limiters fail OPEN, because the account counter below them is in
Postgres and keeps enforcing with the cache completely down.

An unknown email address costs exactly what a wrong password costs: the same argon2
work (a real hash is verified and the answer discarded), the same two buckets, and the
same `invalid_credentials` response. Skipping the hash made the unknown-email path an
order of magnitude faster, which is an admin-existence oracle regardless of how
identical the response bodies are.

### The lockout ladder

| | Trigger | Consequence |
|---|---|---|
| 1st lock | 10 consecutive wrong passwords | 1 hour. `423`, `retryAfterSeconds: 3600` + `Retry-After: 3600` |
| 2nd lock | 10 more, within 30 days of the first | account suspended. `403 admin_login_manual_review`, no duration |

The wait is reported twice, as a body field and as a header, and the panel reads the
body. The header alone was not enough: the panel is a different origin, and a browser
hides every response header the server has not named in `Access-Control-Expose-Headers`
(src/cors.ts names this one). A refusal with nothing to wait for — the second rung,
or a disabled account — omits both. `retryAfterSeconds: 0` would say "retry now".

The second rung is the point. A flat policy bounds the RATE of guessing and nothing
else — an attacker willing to wait gets a thousand guesses a day, indefinitely, and
nobody is ever told. The second lock takes the account out of service, revokes every
session, retires every in-flight sign-in, and puts it in front of a human.

No wait restores a suspended account. A super admin decides at
`GET /admins/login-reviews` and `POST /admins {action:"resolve-login-review"}`, which
carries an `expectedVersion` so two reviewers cannot silently overwrite each other. It
may not target your own account.

A successful password clears the failure streak but NOT the strike memory: a correct
password proves the owner turned up, not that the grinding stopped. Only an `ENABLE`
decision clears strikes.

### Sign-in codes leave through a queue

The emailed code is a mandatory second factor with no password recovery behind it, so
a lost code is a total lockout. Delivery is therefore durable rather than inline:
`POST /auth/login` writes an AES-256-GCM-sealed job to `redis-durable` and returns, and
a worker pool retries it at 0s, 5s, 30s and 90s.

| Budget | Limit | Where |
|---|---|---|
| per attempt | 5 | Postgres — survives a cache flush |
| burst, per account | 5 / 15m | Redis |
| daily, per account | 50 / 24h | Redis |
| resend cooldown | 60s | Redis, holds across attempts |

Quotas are charged at enqueue and refunded by the worker if every delivery attempt
fails — the only honest arrangement when the limit must be checked before the send and
the outcome arrives after it. A rejected RECIPIENT is not refunded: the relay answered
and the address is the problem, so refunding would buy unlimited retries against a
mailbox that can never receive.

The cooldown is checked before the previous code is superseded. The reverse order kills
the code the admin is holding to make room for one that is then not sent.

### Why two routes and not nine

A route per step means nine places to get a guard right. Here there are two, split
where the CREDENTIAL changes rather than where the step does: `POST /auth/login`
is one discriminated union on `step` behind one gate — `resolveFor` in
`auth/auth.controller.ts` — and `POST /2fa` is one union on `action` behind
`stepUpFor`, which also serves signed-in callers proving a factor again.

What enforces the ordering is `STEP_REQUIRES` in [auth/auth.types.ts](auth/auth.types.ts)
and `TWO_FACTOR_STATE_REQUIRES` in [src/2fa/2fa.types.ts](src/2fa/2fa.types.ts) —
tables of which states each step is legal from. Read them first; they are the
access control. `tests/auth/stepup.spec.ts` asserts the full step × state matrix,
because a table this small should be checked exhaustively rather than sampled, and
`tests/auth/login-id.spec.ts` asserts that the `loginId` reaching those gates is
the one the password step minted.

---

## Layout

```text
.
├── auth/                 # authentication — the only domain module so far
│   ├── dto/              # Zod request schemas + response payload mappers
│   ├── persistence/      # *.dboperation.ts — the ONLY files that may inject Prisma
│   ├── security/         # jwt, guards, totp, passkey, step-up, challenge protocol
│   └── services/         # login, mfa, session, password, credential
├── src/
│   ├── captcha/          # server-side verification for the one active provider
│   ├── mail/             # nodemailer transport + templates
│   ├── config.ts         # Zod-parsed env, frozen, parsed once at import
│   ├── contracts.ts      # THE error catalogue
│   └── http.ts           # ProblemException, the global filter, parseDto, ok()
├── db/                   # schema.prisma, migrations, db/sql/*.sql, seed, migrate
├── redis/                # client, cache, locks, and the key registry
└── tests/                # Vitest, mirroring the module layout
```

### Module layering

```
*.routes.ts  →  *.controller.ts  →  *.service.ts  →  *.dboperation.ts
                     ↓ (leaves, never call upward)
       *.dto.ts   *.types.ts   *.utility.ts   *.constants.ts
```

Keeping data access in `*.dboperation.ts` rather than in the service is what makes
the services unit-testable against doubles instead of a live database.

---

## The rules that are load-bearing

- **Auth is default-on.** `AuthGuard` is bound to `APP_GUARD` in
  [src/app.module.ts](src/app.module.ts), so every route is authenticated the
  moment it is wired up. Opting out is `@Public()`, and `grep -rn "@Public()"` is
  the audit. Forget it and the route 401s on first call — a bug that reports itself.
- **Every error is a slug in `ERR`.** Adding an entry to
  [src/contracts.ts](src/contracts.ts) is the only way to add an error to the API.
  Clients switch on the slug, never on the HTTP status.
- **Validation is Zod, applied by hand at the controller.** Handlers take
  `@Body() body: unknown` and call `parseDto`. Every schema is `.strict()`.
- **Only `*.dboperation.ts` may inject `PrismaService`.** Review discipline, not a
  framework rule; [auth/auth.dboperation.ts](auth/auth.dboperation.ts) is the
  auditable list.
- **Every Redis key comes from [redis/keys.ts](redis/keys.ts).** No inline key
  strings anywhere.
- **Product policy lives in [auth/auth.constants.ts](auth/auth.constants.ts), not
  env.** A cooldown should not need a deploy to change. Env holds secrets and
  infrastructure coordinates only.
- **State transitions are compare-and-swaps.** `updateMany` with the expected state
  in the WHERE clause, checking the returned count. A read-then-write can be raced;
  the database cannot.
- **No global prefix, no versioning.** Paths are literally `/auth/login`.
- **Every `POST` returns 201.**
- **TOTP accepts the current 30-second step and nothing else, so the server clock is
  a hard dependency.** `TOTP.WINDOW` is `0` in
  [auth/auth.constants.ts](auth/auth.constants.ts): the moment an authenticator rolls
  over, the code it was showing is refused. There is no ±1-step skew tolerance and no
  grace period — see **Clock synchronisation** below, which is an operational
  requirement and not optional.

---

## Getting started

```bash
cp .env.example .env
```

Then fill the three generated secrets:

```bash
# ES256 signing key
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt | base64 | tr -d '\n'
# AES-256-GCM key for TOTP secrets at rest
openssl rand -base64 32
# argon2id pepper
openssl rand -base64 48
```

> **`DATABASE_URL` must carry `?schema=admin`.** This service shares a Postgres
> instance with the main Orebit backend — it owns the `admin` schema, that one owns
> `identity`. Prisma writes `_prisma_migrations` into the schema this parameter
> names, so without it both services share one history table and each reads the
> other's migrations as drift. `src/config.ts` and `db/migrate.ts` both refuse to
> start without it.

```bash
docker compose up -d          # redis-cache :6379, redis-durable :6380
npm install
npm run prisma:generate
npm run db:migrate            # migrations THEN db/sql/*.sql THEN verify
npm run db:seed               # creates the first SUPER_ADMIN from SEED_ADMIN_*
npm run dev                   # :3002
```

**Use `npm run db:migrate`, not `npx prisma migrate dev`.** The partial unique
indexes in `db/sql/*.sql` are the authority behind email uniqueness, passkey
registration, and the TOTP downgrade guard — Prisma cannot express them, so a
deploy that ran migrations but not those files would look migrated and silently
permit duplicates. `db/migrate.ts` binds the two together and then verifies.

---

## Clock synchronisation

**An operational requirement, not a nice-to-have.** Every host running this service
must keep its system clock synchronised — `systemd-timesyncd`, `chrony`, or the
platform's own time service. Every managed container runtime supplies one; confirm
it is actually enabled rather than assuming it.

**Why it is load-bearing here.** `TOTP.WINDOW` is `0`, so a code is verified against
exactly one 30-second step: `Math.floor(unixSeconds / 30)`. Nothing absorbs a
drifting clock any more. A host a few seconds fast or slow will refuse correct codes
from correctly synchronised phones — intermittently, worst near a step boundary,
which is the hardest shape to recognise from a support ticket. The failure looks like
"2FA is broken for some people sometimes", and the cause is not in this repository.

**If codes start being refused in bulk, check the clock.** Compare the host's time
against a public NTP source before touching anything else:

```bash
timedatectl status                      # "System clock synchronized: yes"
chronyc tracking                        # or this, if chrony is what is installed
date -u                                 # and eyeball it against a known-good source
```

**Do not respond by reintroducing a verification window.** A window cannot fix a
broken clock — it can only hide one, and it does so by extending every code's
lifetime for every admin. One step of tolerance costs 30 extra seconds of validity
on every code in the system, which is exactly the exposure `WINDOW: 0` was chosen to
remove. Fix the clock.

Timezone is irrelevant and needs no configuration: `stepFor` derives the step from
`Date.prototype.getTime()`, which is epoch milliseconds and carries no zone. The
container's `TZ` cannot affect TOTP, and no code in the TOTP path converts between
zones.

---

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | watch-mode server on :3002 |
| `npm run check` | `typecheck` + `lint` — run before pushing |
| `npm test` | Vitest |
| `npm run db:migrate` | prisma migrate deploy → `db/sql/*.sql` → verify |
| `npm run db:verify` | assert every expected index exists; applies nothing |
| `npm run db:seed` | create the first `SUPER_ADMIN` |

---

## Admin provisioning

There is no signup route, no invite flow, and no "create admin" endpoint. Accounts
come from `db/seed.ts`, so the set of people who can mint a platform administrator
is exactly the set who already hold the database.

That is a deliberate floor rather than a missing feature — an invite flow needs its
own token lifetime, its own rate limits, and a decision about who may invite whom.
Until that is designed, no route can create an admin.

---

## Known gaps

- **No MFA recovery.** An admin who enrolls a single factor and loses the device
  cannot get back in. `db/seed.ts` is shaped to grow a super-admin `reset-mfa`
  subcommand; that is the intended answer.
- **`TOTP_SECRET_KEY` is not rotatable** without re-enrolling every TOTP admin —
  the secrets are encrypted under it, not hashed. Back it up separately from the
  database, since a leak of both hands over every authenticator.
- **`WEBAUTHN_RP_ID` is permanent per environment.** A passkey is bound to the RP
  ID it was registered under; changing it silently invalidates every enrolled key.
- **No RBAC enforcement.** `role` is stored and carried in the access token's `rol`
  claim, but nothing branches on it yet.
- **Mail sends inline.** `redis-durable` is defined in docker-compose for the queue
  this should become, and is currently unused. A failed send is not retried and not
  held anywhere — it is lost, and a crash mid-send loses it silently. Three things
  soften that and none replaces it: connections are pooled, a backup relay
  (`SMTP_BACKUP_HOST`) covers one provider going down, and the send budget is
  refunded so a lost code costs the admin nothing. The send is still synchronous, so
  a slow relay still holds the HTTP request open for up to the 20s socket timeout —
  twice that when failover engages.
- **No password recovery.** An admin who forgets their password cannot reset it;
  `POST /auth/password` was removed. Setting a password is a `db/seed.ts` operation,
  and there is no super-admin action for it yet.
