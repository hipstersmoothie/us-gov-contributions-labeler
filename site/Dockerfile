# The public website: a static Astro build of data/*.json, served by `serve`.
# Built from the repo root (Railway: RAILWAY_DOCKERFILE_PATH=site/Dockerfile).
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY site/package.json ./site/
RUN pnpm install --frozen-lockfile
COPY . .
# Current follower counts and avatars; on failure, the committed copy.
RUN pnpm photos && (pnpm bluesky-profiles || echo "Keeping data/bluesky-profiles.json") && pnpm site:build

FROM node:24-slim
WORKDIR /app
RUN npm install -g serve@14
COPY --from=build /app/site/dist ./dist
CMD ["sh", "-c", "exec serve dist --listen tcp://0.0.0.0:${PORT:-3000} --no-clipboard"]
