# The Bluesky feed generator. Built from the repo root
# (Railway: RAILWAY_DOCKERFILE_PATH=feeds/Dockerfile), with the SQLite
# database on a volume at DATA_DIR. Member data is fetched at runtime.
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --filter us-gov-contributions-labeler
COPY tsconfig.json ./
COPY feeds ./feeds
ENV DATA_DIR=/data
CMD ["pnpm", "feeds"]
