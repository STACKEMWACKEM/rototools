# Running Rototools on a Chromebook and phone

## Current preview status

For browser testing without ZIP downloads or DNS setup, use the
[Codespaces preview guide](preview.md). Its dev container starts the app and
worker together. No codespace or live preview URL has been created by this
workspace; creation runs in the repository owner's GitHub account.


The managed workspace can run the app locally, but does not expose a public HTTPS
port. No public hostname, DNS control, hosting credential, or persistent external
CPU/GPU service is configured. Its configured outbound identities list is empty.
A private `localhost` address or container IP will not work on your phone.
Static-only hosting cannot run this app's FastAPI, native FFmpeg, durable worker,
SQLite volume or SAM runtime. Publishing only the frontend would leave online
preparation, tracking and video export disconnected.

The Docker image was built here with the actual locked dependencies. Local media
and browser checks are recorded in verification.md. Public certificate issuance
and phone access cannot be verified without the host and DNS setup below.

## Get a complete HTTPS preview running

1. Use an existing Linux server with Docker Engine and the Compose plugin. For
   manual editing and CPU exports, start with 4 CPU cores, 8 GB RAM and at least
   20 GB free disk. These are deployment starting points, not measured concurrency
   guarantees. No paid service is automatically provisioned.
2. Clone the source repository, preserving its dependency lock files:

   ```bash
   git clone https://github.com/STACKEMWACKEM/rototools.git
   cd rototools
   ```
3. Choose a hostname you control, for example `roto.your-domain.com`. Set its DNS
   A record to the server's public IPv4 address. Add an AAAA record only if the
   server also accepts incoming IPv6. Permit inbound TCP ports 80 and 443 and
   UDP 443 on the server firewall. Do not expose API port 8000 or the data volume.
4. From the repository root run:

   ```bash
   export ROTOTOOLS_DOMAIN=roto.your-domain.com
   docker compose -f deploy/compose.yaml up --build -d
   docker compose -f deploy/compose.yaml ps
   docker compose -f deploy/compose.yaml logs --tail=100 api worker https
   ```

   Replace the example hostname with your own. Caddy obtains and renews its
   certificate automatically. The API serves the built frontend and `/api` from
   the same HTTPS origin; no cross-origin configuration is needed.
5. Open `https://roto.your-domain.com/api/capabilities`. Check `workerReady: true`
   and the expected export formats. `model.ready: false` is expected until SAM
   is installed. Open the root URL on the Chromebook and phone. On supported
   browsers, install it using the browser's Install/Add to Home Screen action.
6. Test the workflow in the checklist below. Export a project backup before
   clearing browser data. Changing the site's hostname changes its local storage
   origin, so restore a backup if you move to another hostname.

If you want a private preview, place an authenticated access gateway in front of
the entire site. Project and asset endpoints already enforce guest ownership;
the starter app is not an abuse-resistant public anonymous processing service.
Guest-session creation, CPU/GPU charging and user concurrency require an outer
access/rate-limit policy before exposing it to unrelated users. Keep deployment
on one host and one processing worker; SQLite and provider state are not a
multi-host queue.

## Enable actual SAM 2.1 selection and tracking

The original build's checkpoint host returned HTTP 403. The official Meta
Hugging Face mirror is now reachable, and the pinned tiny checkpoint has loaded
successfully on CPU. A CUDA GPU is optional for correctness; it can improve
speed, which still needs measurement on actual camera clips.

[Codespaces preview setup](preview.md) installs the complete CPU runtime
automatically. For another machine, use these commands from the repository root:

```bash
# Activate your Python 3.12 virtual environment first.
python -m pip install -r requirements.lock.txt
python -m pip install --index-url https://download.pytorch.org/whl/cpu \
  torch==2.7.1 torchvision==0.22.1
python -m pip install setuptools==80.9.0 wheel==0.45.1
SAM2_BUILD_CUDA=0 python -m pip install --no-build-isolation -r requirements-ai.txt
python -m scripts.download_model
export SAM2_DEVICE=cpu
export SAM2_CPU_THREADS=2
python -m scripts.check_model
python -m scripts.smoke_ai
python -m server.serve
```

The downloader pins the official repository revision, byte length and SHA-256
in `server/model_artifacts.py`. It writes into ignored `models/`, verifies
before replacing a file and reuses a verified cache. Readiness validates the
same digest before loading; downloaded provenance JSON is informational only.
The default checkpoint path works without manually entering a digest.

A custom checkpoint requires exported `SAM2_CHECKPOINT`, its independently
reviewed `SAM2_SHA256`, and a matching `SAM2_CONFIG`. `SAM2_DEVICE=auto`
selects CUDA when available and CPU otherwise. For CUDA, first install a
hardware-appropriate PyTorch wheel following the official PyTorch/SAM guides.
CPU runs disable SAM's optional CUDA connected-components postprocessing.

A successful model-load check establishes runtime availability. The real
inference smoke establishes the selected integration checks. Neither establishes
human/animal/animation quality, hair matting or physical-device performance.

For Docker, derive an AI worker image from `rototools:local`, install the optional
runtime during the image build, mount reviewed weights read-only at `/models`,
pass the four SAM2 settings to the worker service, and give only that service
access to the selected GPU (NVIDIA Container Toolkit required for CUDA). Do not
run a host-side worker against a separately isolated Docker data volume.
The supplied CPU Compose file deliberately does not claim GPU provisioning.

Tracking windows currently cap at 180 frames (6 seconds); use an explicit in/out
range. No cross-window identity continuity is claimed. This defensive memory
limit must be revisited after actual hardware measurement.

Before declaring AI complete, evaluate tiny and large on the same permitted
clips: person, fine hair, crossing subjects, absence/reappearance, hard cut,
animal and animation. Test correction points, protected edits, cancellation,
worker recovery and stale revisions. The provider rebuilds temporal state from
saved prompts and thresholds returned logits at zero; review flags are area
change/absence heuristics, not confidence probabilities. It stops ranges crossing
detected shot changes rather than silently reassociating an identity.

## Short testing checklist

1. Import a 5–10 second SDR MP4/MOV on each device. Check orientation, duration,
   frame stepping and original sound. Import alone must send no clip to the API.
2. Draw an ellipse and polygon, brush a keep area, erase a hole, move a vertex,
   rotate/scale a layer, feather its edge and undo/redo. Check overlay, matte and
   checkerboard views. Try two-finger zoom while a stroke is unfinished.
3. Add two keyframes and scrub between them. Lock/hide/duplicate layers. Reload,
   restore a backup, and relink the same source when omitted from the backup.
4. Choose online preparation explicitly. Interrupt an upload and retry; it should
   resume at the confirmed offset. Cancel a worker job and reopen the app.
5. Once the model reports ready, add keep/remove points, run selection, track a
   bounded range, correct a bad frame, and protect it. Edit during a job and check
   that its older result does not overwrite the new revision.
6. Export MP4, matte, PNG ZIP and ProRes MOV. Check start/middle/end audio cues and
   alpha over light and dark backgrounds in the receiving editor. Test phone
   download/share behavior separately; no save-to-photo-library promise is made.

## Operations

Media retention defaults to 24 hours from inactive project/server asset creation
or updates, not permanent archival. Partial uploads, orphan preparation assets,
finished job scratch directories and expired sessions are cleaned by the worker.
Delete a project to invalidate jobs and remove associated private files. Browser
backups and original camera files are independent. Restore service after failures
with the same persistent volume; do not use `down -v` unless you intend to erase
all hosted projects. Rotate hostname/access policies with backups in hand.

CPU/GPU processing time, disk for PNG intermediates, bandwidth and source retention
drive hosting cost. No provider pricing or GPU benchmark has been measured, so no
numeric monthly cost is asserted. Monitor the volume and enforce host-level disk,
CPU and GPU budgets before increasing duration/resolution limits.
