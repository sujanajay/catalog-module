# syntax=docker/dockerfile:1
# catalog-worker. Build from the repo root:  docker build -f apps/worker/Dockerfile -t catalog-worker .
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@catalog/worker..."
RUN pnpm --filter @catalog/worker build
# Production node_modules for the externals (pg, @google-cloud/*, google-auth-library, sharp) + dist/.
RUN pnpm --filter @catalog/worker deploy --prod /out

FROM node:22-slim AS runtime
# Contact-sheet labels require font discovery and a real sans-serif font.
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
