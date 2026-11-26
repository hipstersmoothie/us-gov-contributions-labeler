# `pnpm uptime` as an always-on Railway service (the `uptime` service,
# RAILWAY_DOCKERFILE_PATH=src/uptime.Dockerfile): checks the public services
# every two minutes and DMs the owner when one is down. BSKY_DM_APP_PASSWORD
# references the posts service's app password, which can send DMs.
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --filter us-gov-contributions-labeler
COPY tsconfig.json ./
COPY src/uptime.ts ./src/
CMD ["pnpm", "uptime"]
