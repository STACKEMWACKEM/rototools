# Verification and remaining release work — 2026-10-08

## CPU AI and preview follow-up

In a fresh checkout of commit `758b139`, the production build and all nine
frontend domain tests passed. The Python run passed 15 tests and failed the
existing missing-model test because an actual model was now installed. That test
now selects a deliberately absent checkpoint, so its assumption is independent
of developer setup. New checks cover atomic verified downloads and rejection
of corrupted artifacts.

The official Meta Hugging Face tiny checkpoint downloaded successfully:
156,008,466 bytes, SHA-256
`7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69`.
CPU PyTorch 2.7.1 and pinned SAM source were installed; `scripts.check_model`
successfully loaded the actual model on CPU. This was **loading only**.

The execution workspace then disconnected before real selection/tracking checks
could run. The new CPU AI smoke and browser-preview setup have been saved for
remote verification. Their result must be reported from an actual completed run;
they are not assumed to pass because code exists. A model-load success must not
be relabeled as an inference or subject-quality success.

GitHub Codespaces configuration now installs and starts the complete private
preview. A codespace has not yet been created in the user's account, so there
is no verified live preview address or physical-device result. Fine-edge matting
is still unavailable. The automated workflow records build, API/media, browser
and actual CPU inference results separately.

## Original build report

The following record was supplied with the initial implementation. Its
unavailable-runtime/403 observations describe that earlier workspace; use the
follow-up above for the current artifact-loading status.


The local editor and connected CPU processing workflow run. This is **not yet a
fully verified release of the entire specification**: actual SAM selection and
tracking, physical-device checks and a public HTTPS deployment are unavailable
in this workspace. The adapter is implemented; no model inference was executed.
No fixture, interpolation or manual mask is presented as AI output.

## Checks executed

| Check | Observed result |
| --- | --- |
| TypeScript and production Vite build | Passed; PWA asset manifest generated |
| Frontend domain/mask tests | 9 passed |
| Python API, persistence, media and rendering tests | 16 passed |
| Chromium browser workflow tests | 6 passed, none skipped in the final run |
| Python fatal-error/unused-import lint | Passed (`ruff check --select F,E9`) |
| CPU Docker image build | Passed, locked npm/Python dependencies |
| Actual Docker API and separate worker startup | Healthy; four export encoders ready |
| Compose configuration validation | Passed with an example hostname; no public certificate requested |

Commands from the prepared workspace:

```bash
source /workspace/.rototools-dev/activate.sh
python -m scripts.fixtures work/fixtures
npm run build
npm test
python -m pytest server/tests -q
# API and worker running at localhost:8000; production container at localhost:9010
PRODUCTION_URL=http://127.0.0.1:9010 npm run test:browser
```

Browser checks cover local import without any upload; drawing and undo; actual
autosave, backup and reload; two-pointer stroke cancellation at a 390px viewport;
frontend upload/preparation and real H.264/AAC download; a deliberately disabled
local decoder using actual FFmpeg-extracted online frames and reopening its
saved project; production PWA editing offline; independent restored source blobs
after original-project deletion; and a simulated quota error showing a save
failure. They do not prove physical-phone behavior.

Media/API checks cover source and owner isolation, acknowledged upload offsets,
checksum failure, idempotency, durable lease recovery and cancellation, deletion
including re-prepared copies, expiry, portable raster-asset restoration, exact
frame maps for variable frame rate and rotated inputs, masks and source-pixel
rotation, all four output pipelines, full-HD/720 dimensions and audio cues/offsets.
TypeScript and NumPy evaluators agree within 2e-6 on the shared soft-mask fixture.

The build reports a 742.67 KB main JS chunk (212.17 KB gzip), above Vite's
informational 500 KB threshold. Initial mobile loading time is not measured.
Python tests report the current Starlette/httpx TestClient deprecation warning;
the checks pass. Playwright's managed browser download was blocked; installed
Debian Chromium 151.0.7922.173 was used instead.

## Actual available behavior

| Area | Status and practical boundary |
| --- | --- |
| Local video import | Real Mediabunny/WebCodecs SDR decoding; compatible MP4/MOV streams; no automatic upload |
| Unsupported local decoder | Explicit online preparation, validated FFmpeg conversion and exact PNG frame previews; network required |
| Manual editing | Rectangle, ellipse, polygon, cubic pen, lasso, brush/erase, geometry/handle edits, layer transforms and combinations |
| Animation and edges | Compatible point-ID interpolation, holds for topology/raster changes, layer keyframes, opacity, invert, feather and expansion |
| Saving and backups | Transactional IndexedDB, failure labels, checksummed ZIP, optional original, exact relink, independent restoration |
| Backend | Private guest ownership, resumable uploads, SQLite durable jobs, separate worker, snapshot export, retention and deletion |
| Model selection/tracking | SAM 2.1 adapter code exists; **unavailable and unverified**, controls disabled without actual readiness |
| Hair/fine-edge matting | Unavailable; feather is only outline softening |
| Offline use | Cached production shell and available local manual media verified; online jobs require the server |
| Public HTTPS preview | Unavailable here; supplied Caddy/Compose setup requires an external host and DNS |

Default import limits are 30 seconds, 256 MiB, 4096px dimensions and 1800 source
frames, with 16 layers. Browser ZIP backups cap expanded contents at 64 MiB.
SAM windows cap at 180 CFR frames (6 seconds); no cross-window identity
continuity is claimed. These are defensive ceilings, not measured mobile or
GPU capacity guarantees. SDR footage only; no HDR tone mapping, text selection,
background-video replacement, HEVC alpha or VP9 alpha route is advertised.

## Real sample exports

`scripts/sample_export.py` produced a two-second, 60-frame, 160×96 synthetic
moving-object clip with sound, manually authored geometry and interpolation.
The input and annotations are original CC0 fixtures. This is an export and
timing fixture, not an AI-quality demonstration.

| File | Actual content | Observed local rendering time |
| --- | --- | --- |
| sample-mp4.mp4 | H.264 opaque masked composite, AAC audio, 2.000 seconds | 0.891 s |
| sample-matte.mkv | FFV1 full-range grayscale matte, 60 frames | 0.732 s |
| sample-png.zip | 60 straight-RGBA PNG frames plus timing.json | 0.661 s |
| sample-prores.mov | ProRes 4444 straight-alpha MOV with audio | 0.653 s |
| sample-project.rototools.zip | Reopenable editing data and original source | — |

The connected browser also produced a real 160×96, 2.000-second H.264/AAC
`browser-export.mp4` from a mask drawn in the frontend. Sample checksums and
metadata are in sample-evidence.json. Tiny fixture timings are observations on
this workspace, not performance estimates for camera footage.

Encoder self-tests decode alpha levels 0, 128 and 255 and accept at most one
8-bit level of error. A separately decoded colored ProRes pixel was
RGBA [220,80,30,129]; compositing its straight color gave [162,57,19] over black
and [238,193,188] over white. Alpha is not a burned-in checkerboard. Export
tests also decode the resulting files and verify frames, dimensions and audio
cue alignment. Receiving-editor ProRes interpretation still needs testing.

## Browser/device matrix

| Platform | Verified here |
| --- | --- |
| Linux Chromium 151, 1280×900 | Local workflow, backend export and save/reload |
| Chromium 390×844 viewport, actual emulated multi-touch | Layout width and second-pointer cancellation |
| Built app in Chromium, offline context | PWA shell, stored clip, manual editing/autosave |
| Physical Chromebook | Not available; unverified |
| Physical Android Chrome | Not available; unverified |
| Physical iPhone/iPad Safari | Not available; unverified |

## Exact blockers and work remaining

1. **AI runtime and artifacts:** no configured SAM weights, installed optional
   PyTorch/SAM runtime or supplied CUDA GPU. The official tiny checkpoint host
   returned proxy HTTP 403. Readiness reports `SAM2_CHECKPOINT_MISSING`. No real
   selection, temporal tracking, correction quality, occlusion/reappearance,
   identity preservation or tiny/large comparison has been verified. Follow
   deployment.md's model setup, then perform those quality/recovery checks.
2. **Public HTTPS:** no public host/hostname, DNS control, external hosting
   identity or inbound HTTPS routing is configured. Localhost and container IPs
   are not remote preview URLs. Follow deployment.md to run the complete API,
   worker and Caddy on a reachable Linux host with persistent storage.
3. **Physical devices and performance:** verify secure-context codec support,
   orientation/SAR/VFR camera samples, pen/touch ergonomics, suspension/resume,
   storage eviction, long-clip memory and export downloading on actual devices.
   Measure supported processing limits before expanding them.
4. **Fine-edge matting and destination compatibility:** no matting provider is
   adopted. Verify ProRes alpha/audio in target editing software and phone
   downloads separately. MP4 output is intentionally opaque.
5. **Release operations:** no migration from an older deployed schema exists
   (schema 1 is initial; unknown schemas are rejected). Public multiuser identity,
   abuse controls, hardware quotas and multi-host orchestration are not built.
   The supplied deployment is a private, single-host preview.

Source, tests, locked dependencies, deployment configuration and documentation
are maintained in https://github.com/STACKEMWACKEM/rototools. Generated videos,
local data, secrets, dependency caches and model weights are excluded. Recreate
the sample exports with `python -m scripts.sample_export` from the repository root.
Dependencies and model provenance are recorded in dependencies.md; masks and timing are specified
in mask-semantics.md. See deployment.md for the short device-testing checklist.
