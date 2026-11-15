# The labeler service Bluesky talks to. Railway uses this root Dockerfile for
# the labeler; the website builds from site/Dockerfile.
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
# Only the labeler's own dependencies, not the website's.
RUN pnpm install --frozen-lockfile --filter us-gov-contributions-labeler
COPY tsconfig.json ./
COPY src ./src
CMD ["pnpm", "start"]
