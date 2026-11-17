# Automated posts from @contributions.fyi. Built from the repo root
# (Railway: RAILWAY_DOCKERFILE_PATH=posts/Dockerfile), with its SQLite
# database on a volume at DATA_DIR. Data is fetched from main at runtime.
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --filter us-gov-contributions-labeler
COPY tsconfig.json ./
COPY src ./src
COPY posts ./posts
ENV DATA_DIR=/data
CMD ["pnpm", "posts"]
