# Monthly refresh of the IRS 527 data (data/irs527.json), as a Railway cron job
# (the `refresh-527` service, RAILWAY_DOCKERFILE_PATH=src/refresh-527.Dockerfile).
# It downloads the IRS political organization bulk file, reruns
# src/scripts/irs527/{parse,orgs,build}.py on main's data and pushes the result
# to main, which redeploys the site. The ~4 GB of unzipped and parsed files live
# on a volume at /cache. Needs DEPLOY_KEY (a write deploy key for the GitHub repo).
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client unzip curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY src/scripts/refresh-527.sh ./
CMD ["sh", "refresh-527.sh"]
