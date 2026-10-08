FROM node:24.19.0-bookworm-slim AS node
FROM python:3.12.14-slim-trixie
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl ffmpeg git procps \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
