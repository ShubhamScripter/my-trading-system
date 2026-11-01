# syntax=docker/dockerfile:1

# ─── build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Manifests first: a source-only change then reuses this layer instead of
# re-resolving the whole dependency tree.
COPY package.json package-lock.json ./
RUN npm ci

# The Prisma client is generated code, not a published package. It has to exist
# before tsc runs, because everything that touches the database imports its types.
COPY db/schema.prisma ./db/schema.prisma
RUN npx prisma generate --schema=db/schema.prisma

# `tests/**` is in tsconfig's include but is deliberately not copied — the glob
# simply matches nothing, and dist stays free of specs that import devDependencies.
COPY tsconfig.json ./
COPY src ./src
COPY auth ./auth
COPY redis ./redis
COPY db ./db
RUN npm run build

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# `prisma generate` cannot run here: the CLI is a devDependency and so is absent
# from the pruned tree. Copying the client the builder already generated is the
# alternative to shipping the whole toolchain in the runtime image.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

COPY --from=builder /app/dist ./dist
# Read at boot by src/openapi.ts, which resolves it from process.cwd().
COPY openapi.json ./openapi.json

# node:alpine ships an unprivileged `node` user. Nothing here needs to write to
# the image, so there is no reason to run as root.
USER node

EXPOSE 3001
CMD ["node", "dist/src/main.js"]
