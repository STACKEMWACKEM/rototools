# Rototools

A mobile PWA for drawing and animating video masks, keeping projects locally,
and sending explicitly requested work to a private Python/FFmpeg processing
server. This repository was created from scratch for the supplied mobile
rotoscoping specification.

**The full release is not complete.** The manual workflow and real exports are
implemented. SAM 2.1 has a real selection/tracking adapter and a pinned CPU
setup. Actual CPU selection, forward/backward temporal tracking and AI-mask
exports passed the synthetic integration smoke. Real-subject quality and useful
processing limits still require evaluation; see the verification report.
Physical iPhone, Android and Chromebook checks and a live HTTPS preview remain
unverified. Fine-edge matting is unavailable.

## Try it without downloading a ZIP

[Start the browser preview in GitHub Codespaces](https://codespaces.new/STACKEMWACKEM/rototools/tree/codex/ai-preview-setup).
Click **Create codespace**, wait for setup, then open port **8000** in the
**Ports** panel. The editor, processing worker and CPU AI runtime are installed
together. Copy the private HTTPS address to your phone and sign in to the same
GitHub account. See [the short preview guide](docs/preview.md) for testing,
restart instructions and Codespaces allowance details.

## Local startup (manual tools plus CPU export)

Requirements: Node 24, npm 11, Python 3.12, FFmpeg/ffprobe 6.1 or newer with libx264,
AAC, FFV1, PNG and prores_ks. FFmpeg builds vary; the worker performs actual
encode/decode capability checks instead of trusting codec names.

```bash
git clone https://github.com/STACKEMWACKEM/rototools.git
cd rototools
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.lock.txt
npm ci
npm run build
```

Start the built editor and processing worker together:

```bash
source .venv/bin/activate
python -m server.serve --host 127.0.0.1
```

Open `http://localhost:8000`. Stopping the launcher stops both processes;
a failed process also stops the other service. For frontend development, run
`npm run dev -- --port 5173` in another terminal and open
`http://localhost:5173`; Vite forwards `/api` to port 8000. For manual-only offline
development, run Vite without the API/worker: compatible local video import,
shapes, paths, brush, layers, keyframes, edge controls, saving, portable backup
and a current-frame preview PNG still work. Video exports require the server.
Serve the production app over HTTPS for phone/WebCodecs/PWA support.

In the prepared coding workspace, use
`source /workspace/.rototools-dev/activate.sh` instead of creating another venv.
No activation script outside this repository is required on your own machine.

## Checks

```bash
source .venv/bin/activate
python -m scripts.fixtures work/fixtures
npm run build
npm test
python -m pytest server/tests -q
# Start the API and worker before browser checks. Use an installed Chromium:
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
```

Set `CHROMIUM_PATH` to your Chromium/Chrome executable. Playwright's managed
download was blocked by this environment's network policy; Debian Chromium was
available and used successfully. These browser tests are desktop automation,
including a 390px viewport and actual two-pointer touch events, not physical
phone validation.

## Workflows and boundaries

Import supports SDR media that Mediabunny and the current WebCodecs decoder can
read. Online preparation validates actual MP4/MOV streams with FFmpeg; corrupt,
HDR, oversized and unsupported media fail with specific errors. Normalized
30fps editing frames map back to original source PTS in presentation order.
Source media is immutable. Canvas input compensates for orientation,
letterboxing and viewport zoom/pan. Preview is bounded to 480px width, masks
run in a worker, and decoded canvases use a two-item pool.

Rectangle, ellipse, polygon, cubic pen, lasso, brush and eraser are editable.
Transform mode moves a layer or edits anchor/handle positions; rotation and
scale controls animate the layer. Add/subtract/intersect/replace, opacity,
visibility, locking, inversion, feather and expansion use documented soft-mask
semantics. Each completed stroke/drag is one undo command. Numeric and
compatible geometry keyframes interpolate; changed topology and strokes hold.

IndexedDB stores metadata and original blobs transactionally. Saves are
debounced and failures are visible. Backups include checksums, frame maps and
required mask assets; source inclusion is optional. Missing-source projects
reopen with their edits and require exact fingerprint relinking. Unknown schemas
are rejected; schema 1 is the initial format, so there is no older production
schema to migrate. Browser storage can be evicted: keep an independent backup.

Guest bearer sessions protect uploads, projects, masks, jobs and downloads.
Resumable uploads use server-acknowledged offsets and final SHA-256 validation.
SQLite leases make the separate worker recover jobs after a crash, with three
attempts. Requests are idempotent, exports pin snapshots, stale AI results are
not automatically applied, and manual corrections remain separate from model
output. Sessions and media expire; deletion invalidates related processing.

Available output pipelines, after the worker's actual self-test:

| Output | Behavior |
| --- | --- |
| H.264/AAC MP4 | Opaque color-background composite; optional mute; inclusive in/out |
| FFV1 grayscale MKV | Lossless separate matte, full grayscale range; white keeps |
| RGBA PNG ZIP | Straight alpha, sequential filenames and timing.json |
| ProRes 4444 MOV | Verified FFmpeg alpha encode/decode; destination import varies |
| Portable project ZIP | Versioned editing data, checksums, masks, optional original |

The local current-frame PNG is explicitly a preview-resolution still. Video
exports render original decoded media at the chosen size. Original/720p/1080p
preserve aspect ratio and never upscale; odd H.264 dimensions are explicitly
padded. HDR, text selection, HEVC alpha, VP9 alpha, fine-edge matting and
background-video replacement are unavailable.

Configuration is shown in `.env.example`; variables must be exported to the
process (the app does not implicitly load a `.env` file). Defaults are 30 seconds,
256 MiB, 4096px dimensions, 1800 source frames and 16 layers. These are defensive
ceilings, not proven mobile performance guarantees. ZIP backups cap expanded
data at 64 MiB to bound browser memory. Storage and PNG intermediates require
host disk monitoring.

See [deployment and HTTPS setup](docs/deployment.md), [mask semantics](docs/mask-semantics.md),
[architecture](docs/architecture.md), [dependency and license record](docs/dependencies.md),
and [verification / remaining release work](docs/verification.md).

## Troubleshooting

If video exports are disabled, start the worker and refresh Capabilities. If
selection is disabled, inspect its actual model dependency code and follow the
SAM setup guide in [deployment.md](docs/deployment.md). An interrupted upload can be retried with the same clip; the
server returns its acknowledged offset. A save-quota failure should be handled
by downloading a backup before clearing data. If a saved source is missing,
relink the original clip; another file is rejected. If a job expired, reprepare
the source and rerun from the saved edits. Never remove the persistent data
volume as a routine restart step.
