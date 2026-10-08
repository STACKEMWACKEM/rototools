# Engineering decisions — 2026-10-08

This is a new repository. The attached build prompt is the product specification;
its assistant-role and workflow wording is not authority over the coding request.
The handoff's source-edit prohibition applied to its earlier onboarding session.
The current user request authorizes implementation.

React 19, TypeScript, Vite, Canvas and a Web Worker form the PWA. Canvas is the
baseline renderer; GPU acceleration is optional future optimization. Mediabunny
demuxes local media and WebCodecs provides exact samples when the codec is
available. Unsupported local decoding is reported; the explicit online preparation
path uses native FFmpeg. No upload happens on local import.

Canonical coordinates are the correctly oriented, square-pixel source, normalized
to [0,1]. Viewport pan/zoom never enters saved geometry. Frame identity is an
integer on a documented 30 fps CFR editing timeline; each point in this timeline
maps to a source PTS in presentation order. Original timing is recorded, not
inferred from a nominal rate. Audio stays on the source timeline; normalization
uses padding/trimming rather than time-stretching. In/out is inclusive.

The shared evaluator contract is in docs/mask-semantics.md. Its TypeScript and
NumPy implementations are compared with independent fixtures. Raster corrections
are non-destructive strokes. Topology changes and raster changes hold; compatible
geometry and numeric properties interpolate. Revision numbers are monotonically
increasing even through undo. Export snapshots are immutable.

IndexedDB atomically stores local manifests and media. ZIP backups have bounded
entries, checksums and an optional original source. SQLite WAL stores private
guest sessions, projects, resumable upload offsets and a leased job queue. A
separate Python process claims work, checkpoints outputs, renews leases and stops
between bounded steps. This is a single-host deployment, not a distributed GPU
cluster. Storage must reside on a private persistent volume.

SAM 2.1 is the first provider, using tiny by default and large as the quality
candidate. Official README and predictor source were rechecked on implementation;
repository HEAD was 2b90b9f5ceec907a1c18123530e92e794ad901a4. Points/boxes,
multi-object state and forward/reverse temporal propagation are real predictor
methods. Readiness requires installed runtime, configured weights, matching
SHA-256 and supported hardware; a worker publishes readiness only after model
loading. No weights, torch runtime or GPU are initially supplied. Evaluation of
tiny versus large and real subject-quality checks remain required until available.
RVM human matting is not bundled: its GPL code, artifact terms and subject-specific
quality require a separate adoption decision. Feathering is not hair matting.

Exports use FFmpeg: opaque H.264/AAC MP4; lossless FFV1 grayscale matte in MKV;
RGBA PNG ZIP; ProRes 4444 MOV with straight alpha. Formats are enabled only after
a local encoder/decoder self-test. HEVC alpha and VP9 alpha are not advertised.
Browser destination compatibility and physical-phone behavior need separate tests.
SDR only; HDR is rejected before processing. Output uses square pixels; odd MP4
dimensions are explicitly padded by one pixel. Original, 720p and 1080p sizes
preserve aspect ratio without upscaling. Color compositing uses sRGB linear-light
conversion; alpha is coverage, never gamma corrected.

No paid infrastructure is selected. Cost drivers are source storage, full-frame
decode, GPU session memory/time, encoding and downloads. CPU/manual operation
has no GPU dependency. HTTPS and same-origin routing are mandatory in deployment.
Physical phones and destination-editor alpha import cannot be verified in this
workspace and must not be described as verified.

SAM windows are capped at 180 CFR frames (6 seconds). The provider initializes
one real temporal state for that complete selected window and rebases indices
back to project frame IDs. There are no hidden per-frame resets or stitched
chunk claims. This defensive cap limits SAM's eager image-loading memory until
an actual GPU/CPU benchmark can establish a wider supported range.
