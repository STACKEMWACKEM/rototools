#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if curl --fail --silent --max-time 2 http://127.0.0.1:8000/api/health >/dev/null; then
    printf 'Rototools is already running on port 8000.\n'
    exit 0
fi
mkdir -p work
nohup .venv/bin/python -m server.serve >work/preview.log 2>&1 </dev/null &
printf 'Starting Rototools at http://localhost:8000\n'
printf 'The Ports panel provides the HTTPS address for your Chromebook and phone.\n'
printf 'Startup log: work/preview.log\n'
