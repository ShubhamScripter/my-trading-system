# Orebit-backend

Backend service for Orebit. TypeScript on Node, Prisma over PostgreSQL, Redis for
caching and locks, Vitest for tests, Docker for local orchestration.

> **Status: scaffold.** Every source file in this branch is an empty placeholder.
> The tree below documents the *intended* layout and the conventions each file is
> expected to follow — not behaviour that exists yet.

## Layout

```
.
├── src/                  Application code — HTTP layer and domain modules
├── auth/                 Authentication, authorization, MFA
├── db/                   Prisma schema, migrations, seeds, money primitives
├── redis/                Redis client, cache, key registry, distributed locks
├── tests/                Vitest suites, mirroring the module tree
└── docs/                 Developer docs and Postman collections
```

## Module convention

Each domain module under `src/` is one folder with the same seven files. The split
is a strict layering rule: **routes → controller → service → dboperation**, with
`dto`, `types`, and `utility` as leaf dependencies that never call back upward.

| File | Responsibility |
|---|---|
| `<name>.routes.ts` | Path definitions, method binding, middleware attachment |
| `<name>.controller.ts` | Request/response handling — parse, delegate, serialize |
| `<name>.service.ts` | Business logic and orchestration. No HTTP, no raw SQL |
| `<name>.dboperation.ts` | All persistence access. The only layer touching Prisma |
| `<name>.dto.ts` | Request/response shapes and validation schemas |
| `<name>.types.ts` | Internal domain types shared within the module |
| `<name>.utility.ts` | Pure helpers scoped to the module |

Keeping data access in `dboperation.ts` rather than the service is what makes the
services unit-testable against `tests/fake-prisma.ts` without a live database.

## `src/` — application

```
src/
├── main.ts               Process entrypoint — bootstrap and listen
├── app.module.ts         Composition root: wires modules and dependencies
├── app.routes.ts         Root router, mounts each module's routes
├── app.service.ts        App-level concerns (health, readiness)
├── config.ts             Environment parsing and typed config export
├── openapi.ts            OpenAPI/Swagger spec generation
│
├── user/                 Vacated — accounts live in auth/     [empty placeholders]
├── wallet/               Balances, deposits, withdrawals      [7-file convention]
├── earning/              Reward accrual and payout rules      [7-file convention]
├── merchant/             Merchant onboarding and operations   [7-file convention]
├── social/               Social graph and engagement          [7-file convention]
│
├── ledger/               Double-entry accounting core
│   ├── index.ts          Public surface — the only entry other modules import
│   ├── ledger.service.ts Posting rules, balance invariants
│   ├── ledger.dboperation.ts  Ledger persistence
│   ├── ledger.utility.ts Entry construction helpers
│   ├── sql.ts            Hand-written SQL for atomic/perf-critical operations
│   └── types.ts          Account, entry, and posting types
│
└── utils/
    ├── public.utils.ts       Cross-module pure helpers
    └── utils.dboperation.ts  Shared persistence helpers
```

**`user/` is empty on purpose.** Accounts are the other half of authentication, not
a module that merely depends on it — the two folders imported each other through a
pair of `forwardRef`s until the account code moved into `auth/`. The directory and
its nine filenames are kept as zero-byte placeholders so the layout above still
reads as the intended shape; nothing imports them. Account creation now lives in
`auth/services/user.service.ts` and its persistence in
`auth/persistence/user.dboperation.ts`, and the profile routes are `GET`/`PATCH
/auth/me`.

**`ledger/` is deliberately different.** It has no `controller`, `routes`, or
`dto` because it is never exposed over HTTP. Money moves only as a side effect of
a domain operation — `wallet` and `earning` call into it through `index.ts`. That
absence is the access-control boundary, so keep it: adding routes here would let
callers post arbitrary entries and bypass every business rule above it.

## `auth/` — authentication

```
auth/
├── auth.module.ts        Nest dependency-injection module
├── auth.routes.ts        Five HTTP paths: register, login, session, password, me (GET+PATCH)
├── auth.controller.ts    Request parsing, delegation, and response serialisation
├── auth.constants.ts     Authentication policy and token lifetimes
├── auth.types.ts         Claims, sessions, principals, and state-machine types
├── auth.utility.ts       Auth-scoped pure helpers
├── auth.dto.ts           Public DTO barrel
├── auth.service.ts       Service-provider barrel
├── auth.dboperation.ts   Persistence-provider barrel
│
├── dto/                  Request schemas and response payload types
│   ├── common.dto.ts
│   ├── login.dto.ts
│   ├── password.dto.ts
│   ├── register.dto.ts
│   ├── response.dto.ts
│   └── session.dto.ts
│
├── services/             Business flows
│   ├── blocklist.service.ts
│   ├── credential.service.ts
│   ├── login.service.ts
│   ├── oauth.service.ts
│   ├── password.service.ts
│   ├── registration.service.ts
│   ├── session.service.ts
│   └── user.service.ts   Account creation, identifier allocation, profile
│
├── persistence/          The only auth files that access Prisma
│   ├── blocklist.dboperation.ts
│   ├── challenge.dboperation.ts
│   ├── registration.dboperation.ts
│   ├── session.dboperation.ts
│   └── user.dboperation.ts
│
└── security/             HTTP authentication and token/cookie mechanics
    ├── guards.ts
    ├── jwt.ts
    └── registration.cookie.ts
```

`security/guards.ts` is the enforcement point for every route in the service. `AuthGuard` is registered globally in `src/app.module.ts`, so authentication is the default and a new controller is protected the moment it is wired up; a route that should be open says so with `@Public()`, which is greppable and fails closed when forgotten. `AuthGuard` checks two things and needs both — the JWT proves the token was minted here, and the session lookup proves it has not been revoked since, without which a logout would leave the access token working for its full fifteen minutes. `OptionalAuthGuard` exists for `POST /auth/session`, which must serve a caller whose access token has already expired. MFA is not implemented yet, so it has no placeholder production file.

`security/jwt.ts` signs the access/refresh pair with **ES256** (ECDSA P-256) via `jsonwebtoken`, replacing the original shared HS256 secret. A single key — `JWT_PRIVATE_KEY`, the only one configured anywhere — signs both token types, since Orebit is a monolith and nothing outside this process verifies a token. What separates the two is the `aud` claim, `orebit/access` or `orebit/refresh`, pinned at signing and demanded at verification so that `jsonwebtoken` rejects a refresh token used as a bearer before our own code sees it; `typ` is re-asserted afterwards as defence in depth. The public key is computed from the private one at boot because ECDSA verification needs it, and is never stored or exported. `algorithms` is pinned to ES256 on every verification, and the curve is checked at boot rather than left to fail on the first login.

Expiry is enforced by `jwt.ts` rather than by the library (`ignoreExpiration` is set, and `exp` checked by hand immediately after `aud` and `typ`). This is deliberate: `jsonwebtoken` tests `exp` before `aud`, so leaving it on would let an expired refresh token used as a bearer answer `token_expired` — confirming to a forger that their payload parsed. `tests/auth/jwt.spec.ts` pins that ordering and is treated as non-negotiable.

## `db/` — persistence

```
db/
├── schema.prisma             Single source of truth for the data model
├── client.ts                 Prisma client instance and lifecycle
├── migrate.ts                Migration runner
├── migrations/               Generated migration history
│   └── migration_lock.toml   Provider lock — commit, never hand-edit
├── seed.ts                   Development seed data
├── ledger.sql                Ledger DDL: constraints, triggers, invariants
├── objects.snapshot.json     Snapshot of expected DB objects, for drift checks
└── money.ts                  Monetary primitives — integer minor units, no floats
```

`money.ts` and `ledger.sql` carry the financial-correctness rules. Amounts are
integer minor units; floating point must not appear in any balance calculation.
`ledger.sql` pushes invariants into the database so they hold even against a
buggy or bypassed service layer.

## `redis/` — caching and coordination

```
redis/
├── index.ts              Public surface
├── client.ts             Connection and lifecycle
├── cache.ts              Read-through / write-through helpers, TTL policy
├── keys.ts               Central key-name registry — all keys defined here
└── lock.ts               Distributed locks for critical sections
```

Declaring every key in `keys.ts` keeps namespaces greppable and prevents the
collisions that come from inline key strings. `lock.ts` guards operations that
must not run concurrently across instances — balance mutations especially.

## `tests/`

```
tests/
├── setup.ts                  Global Vitest setup
├── harness.ts                Shared fixtures and helpers
├── fake-prisma.ts            In-memory Prisma double for unit tests
├── <module>/                 Per-module specs, mirroring src/
│   ├── *.controller.spec.ts
│   ├── *.service.spec.ts
│   ├── *.routes.spec.ts
│   └── *.dto.spec.ts
├── ledger/
│   ├── ledger.service.spec.ts
│   └── invariants.spec.ts    Accounting invariants — entries must always balance
└── db/
    ├── migrations.spec.ts    Migrations apply cleanly
    └── constraints.spec.ts   Database-level constraints actually reject bad data
```

`ledger/invariants.spec.ts` and `db/constraints.spec.ts` are the safety net for
the money path and should be treated as non-negotiable.

## Root files

| File | Purpose |
|---|---|
| `package.json` | Dependencies and scripts |
| `tsconfig.json` | TypeScript compiler configuration |
| `vitest.config.ts` | Test runner configuration |
| `.eslintrc.cjs` | Lint rules |
| `Dockerfile` | Service image build |
| `docker-compose.yml` | Local stack — service, Postgres, Redis |
| `.dockerignore` | Build-context exclusions |
| `.env.example` | Required environment variables, no real values |
| `.gitignore` | Ignore rules |
| `.gitattributes` | Line-ending and diff behaviour |
| `CONTRIBUTING.md` | Contribution workflow |
| `structure.md` | Structure notes |
| `docs/` | Developer documentation and `docs/postman/` collections |

## Adding a module

1. Create `src/<name>/` with all seven convention files. Note that accounts are
   **not** such a module — they live in `auth/`, because authentication and the
   `User` row are one concern and splitting them produced a module cycle.
2. Mount its router in `src/app.routes.ts`; register dependencies in `src/app.module.ts`.
3. Add models to `db/schema.prisma` and generate a migration.
4. Mirror the folder in `tests/<name>/`.
5. If it moves money, go through `src/ledger/index.ts` — never write ledger tables directly.
