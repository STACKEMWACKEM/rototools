# Verification and remaining release work — 2026-10-08

The manual editor and CPU processing workflow are implemented. Real SAM 2.1
selection, forward/backward temporal tracking and exports from AI-generated masks
have now passed an integration smoke. **The entire specification is not yet a
finished, fully verified release.** Hair matting, real-subject quality, physical
device checks and a running HTTPS preview in the user's account remain unfinished.

## Latest verified checks

[GitHub verification run 37749121530](https://github.com/STACKEMWACKEM/rototools/actions/runs/37749121530)
tested code commit `cf3832c89332dcfd07ccf38d1c36f8a6830504cd`.
Both jobs completed successfully. The execution workspace disconnected during
local verification; these completed remote checks establish the current results.

| Check | Observed result |
| --- | --- |
| TypeScript and production Vite/PWA build | Passed |
| Frontend domain/mask tests | 9 passed |
| API, persistence, media, rendering and artifact tests | 18 passed without the AI runtime |
| Same Python suite with SAM and its actual checkpoint installed | 18 passed |
| Chrome browser workflow tests | 6 passed; no skips |
| Exact Codespaces dev-container Docker build | Passed |
| Exact CPU preview dependency/model setup script | Passed |
| Actual SAM frame selection | Passed on the synthetic fixture |
| Actual forward and backward temporal propagation | Passed |
| Negative prompt and protected selection | Passed |
| Queued snapshot revision isolation | Passed |
| PNG alpha equality with inferred masks and decoded MP4 export | Passed |

There are **33 distinct domain/API/browser tests**, plus the real-inference
integration smoke. The Python suite runs twice to check both dependency states;
that second execution does not create 18 additional distinct tests.

The browser checks use real local video import without uploading, drawing/undo,
saving/reloading, checksummed backup restoration, quota-error handling, a
390px viewport with two-pointer events, actual backend preparation/export, an
unsupported local decoder's online frame fallback, and production PWA editing
offline. They are desktop automation, not physical-phone validation.

The media/API checks cover owner isolation, upload offsets and checksums,
idempotency, durable leases/recovery, cancellation, deletion/expiry, restored
model-mask assets, variable frame rate, rotation and source dimensions, output
alpha, original/720/1080 sizes, and audio cues/offsets. The new artifact checks
reject corrupt downloads without replacing an existing file and verify cached
downloads without another network request.

## Actual CPU AI evidence

Runtime: CPU PyTorch 2.7.1, torchvision 0.22.1, and official SAM source commit
`2b90b9f5ceec907a1c18123530e92e794ad901a4`.

Checkpoint: `facebook/sam2.1-hiera-tiny`, official Meta Hugging Face revision
`de431c4043854a71d8101e17995dfe596bf101a5`,
`sam2.1_hiera_tiny.pt`, 156,008,466 bytes,
SHA-256 `7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69`.
The pinned size/digest were reviewed against that upstream revision's Git LFS
pointer. The runtime rechecks the digest before loading.

`scripts.smoke_ai` generated an original CC0 three-frame, 160×96 moving-object
clip. It sent the real upload, preparation, selection, tracking and export
requests through FastAPI and the durable worker. The layer had **no manual mask
shapes**. SAM returned actual logits, thresholded into PNG mask assets.

The smoke selected the anchor frame, supplied an additional negative point,
protected the existing selection, tracked both directions, edited the project
while the old snapshot was queued, and verified that the current revision
remained unchanged. It then exported the accepted inference masks:

- All three masks contained 768 foreground pixels.
- Synthetic intersection-over-union was 1.0 for each frame.
- Every exported RGBA PNG's alpha exactly matched its inferred mask.
- The H.264 MP4 decoded to the expected three 160×96 frames.
- The complete smoke took **18.20 seconds** on this GitHub runner, including
  loading, encoder checks, preparation and export. This is not a camera-clip
  performance estimate.

The workflow's `cpu-ai-checks` artifact contains the generated input, mask PNGs,
PNG-sequence ZIP, MP4 and report. The `editor-checks` artifact contains browser
screenshots/export and logs. Artifacts have a seven-day retention period.

Synthetic geometry success verifies integration. It does **not** establish
quality on people, hair, animals, crossing subjects, animation, occlusion or
reappearance. `subjectQualityVerified` remains false and `matting` remains false.
The CPU path disables the optional CUDA connected-components postprocessing.

## Available behavior and boundaries

| Area | Current behavior |
| --- | --- |
| Local video import | Real Mediabunny/WebCodecs SDR decoding; supported MP4/MOV streams; no automatic upload |
| Online preparation | Validated FFmpeg conversion and exact frame fallback when local decoding is unavailable |
| Manual masks | Rectangle, ellipse, polygon, cubic pen, lasso, brush/erase, geometry edits and layer transforms |
| Animation and edges | Compatible geometry interpolation, held topology/raster changes, keyframes, opacity, inversion, feather and expansion |
| Saving and backups | IndexedDB, visible save errors, checksummed project ZIP, optional source and exact relinking |
| Backend | Guest ownership, resumable uploads, SQLite durable jobs, separate worker and snapshot exports |
| AI selection/tracking | Real SAM adapter; CPU artifact setup and synthetic inference smoke passed |
| Fine-edge/hair matting | Unavailable; feathering only softens an outline |
| Offline editing | Cached shell and stored compatible media; server jobs still require the server |
| HTTPS preview | Codespaces launch setup is present; no user codespace/live address has been verified |

The worker now refreshes readiness independently of the main processing loop,
so a long active job does not expire its status merely because it runs over
45 seconds. The preview launcher supervises the API and worker together.
The ordinary Linux Compose image remains a manual/export image; follow
deployment.md's optional AI worker instructions when deploying that image.

Available pipelines after each worker's encoder self-test:

| Output | Behavior |
| --- | --- |
| H.264/AAC MP4 | Opaque color-background composite; optional mute and inclusive range |
| FFV1 grayscale MKV | Lossless separate matte; white keeps |
| RGBA PNG ZIP | Straight alpha, sequential files and timing.json |
| ProRes 4444 MOV | Alpha encode/decode checks; destination-editor interpretation still needs testing |
| Portable project ZIP | Versioned data, checksums, masks and optional original |

Limits remain 30 seconds, 256 MiB, 4096px source dimensions and 16 layers.
SAM windows cap at 180 CFR frames, or six seconds at 30fps. No cross-window
identity continuity is claimed. These limits are ceilings, not measured mobile
or production capacity guarantees. Backup expansion caps at 64 MiB.
SDR only: no HDR tone mapping, text selection, background-video replacement,
HEVC alpha or VP9 alpha route is advertised.

## Device and deployment matrix

| Platform | Verification |
| --- | --- |
| GitHub-hosted Linux Chrome, 1280×900 | Manual workflow, API/export, save/reload and offline production shell |
| Chrome 390×844 viewport with emulated multi-touch | Layout width and second-pointer cancellation |
| Codespaces dev container | Docker build and exact dependency/CPU AI setup script |
| Actual Codespace and forwarded HTTPS origin | Not created or verified yet |
| Physical Chromebook | Unverified |
| Physical Android Chrome | Unverified |
| Physical iPhone/iPad Safari | Unverified |

## Work remaining

1. Evaluate actual permitted clips: people, hair, animals, animation, crossing
   subjects, hard cuts, absence/reappearance and corrections. Compare tiny/large,
   measure CPU/GPU latency/memory and verify cancellation/recovery during inference.
2. Add and evaluate a proper fine-edge matting provider if that feature is required.
   Feathering is not hair matting.
3. Create the private Codespace, check the real forwarded HTTPS origin and test
   import, touch/stylus, saving, suspension/resume and export downloads on devices.
4. Inspect alpha/audio in the receiving editing apps, especially ProRes and phone
   download/share behavior.
5. Provision a permanent host if needed. Public multiuser identity, abuse controls,
   processing quotas and multi-host orchestration are not built; the current
   deployment is a private, single-host preview.

Source and tests are saved in GitHub. Model weights, generated media, user uploads,
credentials and caches are excluded. Start with [preview.md](preview.md) for
browser testing or [deployment.md](deployment.md) for a permanent server.
