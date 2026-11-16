# Weekly refresh of the revolving-door and FARA data, as a Railway cron job
# (the `refresh-lobbying` service, RAILWAY_DOCKERFILE_PATH=src/refresh-lobbying.Dockerfile).
# It reruns `pnpm ingest --steps=revolving,fara` on main's data and pushes the
# result to main, which redeploys the site. The LD-1/LD-2 filings and FEC bulk
# files it reads are cached on a volume at /cache. Needs LDA_API_KEY and
# DEPLOY_KEY (a write deploy key for the GitHub repo).
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client unzip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --filter us-gov-contributions-labeler
COPY tsconfig.json ./
COPY src ./src
RUN ln -s /cache .cache
CMD ["sh", "src/scripts/refresh-lobbying.sh"]
