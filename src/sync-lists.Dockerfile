# `pnpm sync-lists --apply` as a daily Railway cron job (the `sync-lists`
# service, RAILWAY_DOCKERFILE_PATH=src/sync-lists.Dockerfile). Every push to
# main rebuilds it with the current data, so lists catch up with a data
# refresh by the next run. LABELER_PASSWORD references the labeler's variable.
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --filter us-gov-contributions-labeler
COPY tsconfig.json ./
COPY src ./src
COPY data/members.json data/congress-committees.json ./data/
COPY design/logo/avatar.png ./design/logo/
# --wait: a big change waits out the hourly rate-limit window instead of
# leaving the rest for tomorrow.
CMD ["pnpm", "sync-lists", "--apply", "--wait"]
