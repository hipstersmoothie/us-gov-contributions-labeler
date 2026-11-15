# The public website: a static Astro build of data/*.json, served by a small
# Node server (site/server) that also renders link-preview images on request.
# Built from the repo root (Railway: RAILWAY_DOCKERFILE_PATH=site/Dockerfile).
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY site/package.json ./site/
COPY site/server/package.json ./site/server/
RUN pnpm install --frozen-lockfile
COPY . .
# Current follower counts and avatars; on failure, the committed copy.
RUN pnpm photos && (pnpm bluesky-profiles || echo "Keeping data/bluesky-profiles.json") && pnpm site:build
# The server and only its own dependencies, without the site's build tooling.
RUN pnpm --filter site-server deploy --prod /server

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /server ./server
COPY --from=build /app/site/server/data ./server/data
COPY --from=build /app/site/dist ./dist
CMD ["node", "server/src/index.ts"]
