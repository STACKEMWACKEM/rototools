# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; npm ci --strict-ssl=true
COPY frontend ./frontend
COPY tsconfig.json vite.config.ts ./
COPY scripts/prepare-pwa.mjs ./scripts/prepare-pwa.mjs
RUN npm run build

FROM python:3.12.14-slim-trixie
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY requirements.lock.txt ./
RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then export PIP_CERT=/run/secrets/proxy_ca; fi; pip install --no-cache-dir -r requirements.lock.txt
COPY server ./server
COPY --from=frontend /build/dist ./dist
RUN chmod -R a+rX /app && useradd --uid 10001 --create-home worker && mkdir /data && chown worker:worker /data
ENV ROTOTOOLS_DATA=/data PYTHONUNBUFFERED=1
USER worker
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
