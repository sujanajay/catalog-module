# syntax=docker/dockerfile:1
# catalog-web. Build from the REPO ROOT:  docker build -f apps/web/Dockerfile -t catalog-web .

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo

# ---- deps: install from the lockfile only (cached unless manifests change) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build: Next.js standalone output ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/web apps/web
RUN pnpm --filter @catalog/web build

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
WORKDIR /app
# outputFileTracingRoot is the repo root, so standalone mirrors the monorepo layout:
#   /app/apps/web/server.js, /app/node_modules, /app/packages/core/...
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
