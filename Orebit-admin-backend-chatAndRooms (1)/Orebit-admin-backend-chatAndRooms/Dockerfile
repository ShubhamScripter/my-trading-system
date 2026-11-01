# Multi-stage build for the admin backend.
#
# The split exists for one reason worth stating: `argon2` is a native module that
# needs a toolchain to build and nothing to run. Compiling in a stage that is
# discarded keeps python3, make and g++ out of the shipped image entirely.

# ─── build ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app

# The toolchain argon2's node-gyp rebuild needs. Present only in this stage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Manifests first, so a source-only change does not invalidate the dependency
# layer. This is the single biggest lever on rebuild time.
COPY package.json package-lock.json ./
RUN npm ci

# The Prisma schema must be present before `generate`, and generate must run
# before `tsc` — the generated client is what the TypeScript actually imports.
COPY db/schema.prisma ./db/schema.prisma
RUN npx prisma generate --schema=db/schema.prisma

COPY tsconfig.json ./
COPY src ./src
COPY auth ./auth
COPY redis ./redis
COPY db ./db

RUN npm run build

# Drop dev dependencies from node_modules in place, so the runtime stage can copy
# a tree that is already production-only.
RUN npm prune --omit=dev

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# openssl is a Prisma query-engine runtime dependency. ca-certificates is needed
# for the outbound TLS this service does: SMTP, and the captcha provider's
# siteverify endpoint.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Migrations and the raw SQL travel with the image so `db:migrate` can be run as a
# one-off task against the same artifact that serves traffic — the alternative is
# a deploy where the schema and the code come from different builds.
COPY --from=build /app/db/schema.prisma ./db/schema.prisma
COPY --from=build /app/db/migrations ./db/migrations
COPY --from=build /app/db/sql ./db/sql

# The API reference, if it exists. Served from the repo root by src/openapi.ts,
# which logs and skips when it is absent — so a missing file degrades /docs rather
# than failing the boot.
COPY openapi.jso[n] ./

# Never root. `node` is uid 1000 in the official image and owns nothing it writes,
# which is correct — this process has no reason to write to its own filesystem.
USER node

EXPOSE 3002

# No HEALTHCHECK directive: the orchestrator should poll /readiness, which reports
# on Postgres and Redis. A container-local check that only proves the process is
# alive duplicates /health and tells a scheduler less than it needs.

CMD ["node", "dist/src/main.js"]
