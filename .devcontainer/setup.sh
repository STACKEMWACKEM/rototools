#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python -m venv .venv
.venv/bin/python -m pip install -r requirements.lock.txt
npm ci --no-audit --no-fund
npm run build
# A CPU wheel avoids downloading CUDA libraries onto a CPU-only codespace.
.venv/bin/python -m pip install --index-url https://download.pytorch.org/whl/cpu \
    torch==2.7.1 torchvision==0.22.1
.venv/bin/python -m pip install setuptools==80.9.0 wheel==0.45.1
# Use installed torch for SAM's build instead of an isolated second GPU wheel.
SAM2_BUILD_CUDA=0 .venv/bin/python -m pip install --no-build-isolation -r requirements-ai.txt
.venv/bin/python -m scripts.download_model
.venv/bin/python -m scripts.check_model
printf '\nSetup complete. Open the Rototools preview in the Ports panel.\n'
