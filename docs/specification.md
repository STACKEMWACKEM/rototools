# Mobile Rotoscoping and Masking Tool — Complete Build Prompt

Research checked: October 8, 2026.

**How to use this document:** Copy the complete document into your coding assistant, or give it the file and ask it to follow these instructions. The numbered sections are the build instructions. The appendix contains official sources and explains the research behind the recommended approach.

**What we are building:** A working video masking editor for phones, with manual drawing, automatic subject selection, video tracking, corrections, keyframes, edge controls, project saving, preview, and actual exports. Begin with a mobile website that can be installed on the home screen. Use a processing server for heavier AI and rendering work. Treat native apps and more advanced on-device AI as later extensions.

**Reading guide:** Sections 1–5 explain the goal and architecture. Sections 6–14 specify the editing tools and video behavior. Sections 15–23 specify processing, exports, reliability, and performance. Sections 24–28 explain implementation order, verification, and delivery.

---

## 1. Your role and the result you must deliver

Act as a senior engineer who understands mobile interfaces, video processing, computer vision, and maintainable software. Build the application described here. Make reasonable implementation decisions, explain important tradeoffs in plain language, and keep working until the agreed release requirements are implemented and verified, or until a concrete external dependency prevents further progress.

The desired result is an editor someone can use on a phone to isolate a moving person, animal, object, or animated subject from a video. The person must also be able to create masks by hand, fix an automatic mask, adjust it over time, and export the result for further editing or sharing.

The interface must be supported by working processing logic. Every enabled control must perform its named action. Automatic selection must run a real vision model. Tracking must calculate masks across actual video frames. Export must produce a decodable file containing the chosen edits.

During development, fixtures and test doubles are appropriate inside tests. Keep them separate from user-facing processing. Do not display a fixture mask, timed animation, or invented percentage as successful AI processing.

Deliver a runnable project, setup instructions, a working manual workflow, a connected AI workflow when its infrastructure is available, and evidence of verification. If a GPU, model download, account credential, or deployment service is unavailable, identify that exact dependency and finish all independent work. Mark affected features accurately. An incomplete AI connection means the full release remains incomplete.

## 2. Define the terms clearly

Use these meanings throughout the implementation and documentation:

- **Mask:** An image or shape that decides which pixels to keep. In an exported grayscale matte, white means fully visible, black means invisible, and gray means partly visible.
- **Segmentation:** Finding the pixels belonging to the chosen subject.
- **Video tracking:** Following the chosen subject through successive frames while preserving its identity.
- **Rotoscoping:** Creating and maintaining a subject outline across a video, manually or with automatic assistance.
- **Keyframe:** A saved editing state at a particular video moment. Other states can be calculated between compatible keyframes.
- **Feathering:** Softening a mask boundary. This is an edge effect; it does not reconstruct individual strands of hair.
- **Matting:** Estimating partial transparency and, where supported, foreground colors around fine edges.
- **Alpha:** The transparency value of a pixel.
- **Proxy:** A smaller editing copy of the source video, linked to the original through an explicit frame and timestamp map.
- **PWA:** A website with an app-like experience that can be installed on supported phones.
- **GPU:** A processor suited to graphics and many AI calculations. A server GPU handles heavy work away from the phone.
- **PTS:** Presentation timestamp: when a frame is supposed to appear on the video's own timeline.
- **Muxing/demuxing:** Packing encoded audio and video into a media file, or separating those streams for processing.
- **Worker:** A separate execution context or process that performs a task without occupying the main interface or request handler.
- **Job queue:** A system that records processing tasks and assigns them to available workers.
- **Premultiplied alpha:** An image convention in which RGB values already include the transparency multiplier. Applying that multiplier twice makes edges incorrectly dark.
- **Idempotent request:** A request that can be retried safely without creating a second copy of the same operation.
- **Revision:** A numbered editing state used to distinguish newer work from older work.

Explain these terms briefly when users first need them. Keep technical configuration, model identifiers, logs, and server details in documentation or an optional diagnostics view.

## 3. Product scope and sensible defaults

Use the following starting assumptions unless existing project requirements provide a better answer:

- Target iPhone Safari and Android Chrome first. Also support desktop browsers and Chromebooks where their capabilities permit.
- Build a PWA first, using touch controls and responsive layouts. Do not begin with separate iOS and Android codebases.
- Start with one source video per project and multiple masks or subject layers. A full multitrack video-editing suite is outside the initial scope.
- Support portrait and landscape video without stretching. A 9:16 phone clip is an important starting case.
- Prefer short clips for the first verified release. Use a configurable initial limit such as 30 seconds, then expand based on measured resource use.
- Start with SDR processing. Detect HDR inputs and either implement a tested conversion to SDR or explain the unsupported case before processing.
- Preview at a lower resolution when necessary. Offer 720p and 1080p final output only when the corresponding renderer has been verified.
- Preserve the source audio by default. Include a mute option.
- Let people use manual tools without a mandatory account. Hosted AI still needs secure ownership or session controls.
- Prefer existing pretrained models and established media libraries. Training a new model is outside the first release.
- Make feature availability reflect the current browser, model service, and export capabilities.

These are proposed development defaults, not proven performance guarantees. Record which defaults were changed and why.

## 4. Research before locking the implementation

Use the official sources in the appendix as a starting point. Recheck them when implementation begins because dependencies, model releases, and browser behavior can change. Prefer model authors, platform maintainers, official repositories, and official specifications over third-party summaries.

Before writing substantial code, produce a short engineering decision record covering:

1. The chosen frontend stack and rendering approach.
2. The chosen video segmentation model and checkpoint.
3. Whether fine-edge matting is available, and which subjects it supports.
4. Browser decoding and encoding capabilities, with server fallbacks.
5. Supported export formats and how transparency will be tested.
6. Media storage, project storage, retention, and recovery.
7. GPU requirements, deployment assumptions, and likely cost drivers.
8. Exact package versions or repository commits used by the implementation.

Evaluate at least a lightweight and a higher-quality checkpoint when practical. Compare them on the same sample clips. Consider mask quality, correction behavior, memory, startup time, processing speed, and operational complexity. Published throughput is background information; measure the full pipeline on the actual hardware.

Separate researched facts from engineering choices. A model supporting video masks does not establish that the finished app will run in real time on a particular phone.

Keep code and model licenses, download-access requirements, notices, and codec-build options in a dependency record. Check the exact artifacts being distributed or hosted. Do not assume all models or FFmpeg builds share the same terms.

Proceed with reversible implementation work after recording reasonable assumptions. Ask only for information that materially changes the result or unlocks a concrete dependency.

## 5. Recommended architecture

Use this architecture as the initial proposal, adapting it to an existing repository when appropriate:

| Component | Suggested technology | Responsibility |
| --- | --- | --- |
| Mobile editor | React and TypeScript with a lightweight build setup | Controls, timeline, editing state, project interactions |
| Preview compositor | WebGL2 where available, with a simpler Canvas fallback | Video, masks, background, and editing overlays |
| Browser workers | Web Workers; OffscreenCanvas where tested | Heavy raster operations and supported decoding or encoding work |
| Local persistence | IndexedDB for metadata; OPFS or supported blob storage for media | Autosave, cache, reopening, and portable backups |
| API service | Python with FastAPI | Validation, project access, uploads, job requests, and status |
| Processing workers | A durable queue and separate worker processes | Segmentation, tracking, refinement, and rendering |
| Video tools | Native FFmpeg and ffprobe | Inspection, frame extraction, proxies, audio, and exports |
| AI runtime | A supported runtime for the selected model | Actual inference and per-video tracking state |
| Hosted storage | Private object storage and a project metadata database | Source media, masks, manifests, and output files |

Keep editor state, media decoding, mask evaluation, compositing, and model inference as distinct modules with clear interfaces. Share the same documented mask semantics between preview and final render.

Use the phone for immediate interactions and lightweight preview work. Let the server perform longer AI or rendering jobs. That division is an engineering recommendation for broad device support, not a statement that every vision model requires a server.

Expose model providers through an adapter so the first provider can be replaced without rewriting the editor. The adapter must describe supported prompt types, subject classes, propagation directions, output formats, and limits.

Use only one real provider initially if that is sufficient. The default candidate is SAM 2.1 for selection and video propagation. Evaluate SAM 3 or SAM 3.1 when text-based selection or its other capabilities justify the extra requirements. Optional human matting must remain a separate capability.

## 6. Design the phone interface around actual editing

Make the editor readable and comfortable on a small screen:

- A central preview with a useful amount of visible video.
- A compact top bar for project name, save status, undo, redo, and export.
- A bottom timeline with a playhead, thumbnails, frame controls, and keyframe markers.
- A tool row with clear labels such as Select Subject, Draw, Brush, Erase, Move, and Edges.
- A collapsible layer panel for naming, selecting, hiding, locking, duplicating, and deleting masks.
- A settings sheet for the active tool, rather than many controls covering the video.
- An expanded editing view for precise work.

Use a restrained dark interface with a clear accent color. Keep mask overlays translucent and allow the user to change their color and opacity. Subject pixels must remain visible under the overlay.

Aim for touch targets of at least 44 CSS pixels as a design goal. Support safe areas, device rotation, browser toolbars, and the on-screen keyboard. Avoid hover-only actions. Do not require a tiny handle to be touched with pixel-perfect accuracy.

Implement a deliberate gesture system:

1. A single pointer operates the active drawing or selection tool.
2. Two fingers pan or pinch the viewport without accidentally drawing.
3. A second pointer cancels or safely suspends an unfinished drawing gesture.
4. Pointer cancellation, lost capture, and leaving the canvas cannot leave a tool stuck.
5. A clear Move mode allows navigation without changing a mask.

Apply appropriate touch-action rules to the editing region while preserving normal scrolling elsewhere. Add a magnifier or offset cursor for details hidden by a fingertip. Include visible brush size and a zoom readout.

Keep standard controls accessible by keyboard and screen reader. Use meaningful labels, visible focus, good contrast, and an alternative to gestures for essential actions. Respect reduced-motion settings.

## 7. Import, inspection, and media preparation

Import through the standard file input and support drag-and-drop on desktop. Feature-detect advanced file pickers; do not depend on their presence on every phone.

Inspect each file before substantial processing. Record its actual container, codecs, duration, dimensions, orientation, pixel aspect ratio, timestamps, audio tracks, frame-rate behavior, and color metadata. Validate decoded media instead of relying only on the filename or declared MIME type.

Handle common MP4 and MOV inputs when the available decoder supports them. An unsupported codec inside a familiar extension must trigger a precise explanation and a verified conversion path where available.

The app must handle:

- Videos recorded sideways with rotation metadata.
- Variable-frame-rate phone recordings.
- Common fractional rates such as 29.97 fps.
- Silent video, video with audio, and an audio track that begins at a different timestamp.
- Very small clips, odd frame dimensions, and non-square pixel metadata.
- Corrupt or incomplete files and a user canceling import.
- Oversized media that exceeds the configured limits.

Create an immutable source asset and a metadata manifest. Read the user's original file without overwriting it. Build a proxy when needed and store the mapping back to source frames. Preserve a useful poster frame and timeline thumbnails.

Choose a reproducible time policy. Either preserve original presentation timestamps throughout the pipeline, or create a documented constant-frame-rate editing representation with an explicit source-frame mapping. Do not quietly discard source timing and assume frameIndex divided by a nominal fps is accurate.

When a server is used, upload only after the user invokes an online operation and can see that the clip will be processed online. Manual local work must not cause an unexpected upload.

## 8. Coordinate systems and exact frame identity

Define one canonical coordinate system: the correctly oriented source image as it should be displayed, before viewport pan and zoom. Keep the relationships between encoded orientation, displayed orientation, proxy dimensions, model preprocessing, and canvas pixels explicit.

Store vector geometry in normalized source coordinates or another documented source-space representation. Store raster mask dimensions and their transform to the canonical source alongside the mask.

Implement one tested conversion path between:

- Pointer coordinates in CSS pixels.
- The displayed video rectangle, including letterboxing.
- Viewport pan and zoom.
- Canvas backing pixels and device pixel ratio.
- Canonical source coordinates.
- Proxy or model input coordinates, including padding and resizing.

Use the inverse transform for input and the forward transform for display. Do not independently guess these conversions in each tool. The model adapter owns its preprocessing and reverse mapping so scaling or padding is not applied twice.

A selection outside the actual video rectangle must not become a misleading model prompt. Correctly handle brush clipping and intentional vector points beyond the source boundary.

Every editable frame must have a stable identity and an authoritative media timestamp. Store source PTS ticks and the rational time base where available; derive display seconds or integer microseconds as needed. Handle frame presentation order separately from encoded packet order.

Use requestVideoFrameCallback when available for synchronized playback overlays. For exact paused-frame editing, use an indexed decoded frame or an authoritative extracted frame. Browser seeking alone must not be treated as proof that the requested source frame was decoded.

Ensure rapid scrubbing cannot display an older asynchronous response as the current frame. Use request identifiers or cancellation and discard stale results.

## 9. Manual masks must be a complete workflow

Implement these manual tools with actual geometry and raster behavior:

| Tool | Required behavior |
| --- | --- |
| Rectangle and ellipse | Create, move, resize, rotate, and animate a closed mask |
| Polygon | Place points, finish a closed shape, and edit its vertices |
| Pen path | Edit Bézier anchors and handles with predictable closed-path behavior |
| Freehand lasso | Draw a closed region with controlled simplification |
| Brush | Paint a keep region with adjustable size, softness, and strength |
| Eraser | Remove part of a mask without changing the source video |
| Transform | Move, scale, and rotate the chosen shape or layer |

Provide add, subtract, intersect, replace, invert, visibility, opacity, and layer locking. The user must be able to make holes in a selection and combine masks.

Record strokes and geometry non-destructively where practical. Use raster tiles or bounded dirty regions for large brush edits. A single stroke or completed drag should be one meaningful undo action; avoid filling the history with every pointer movement.

Make hit testing comfortable on touch screens. Distinguish a handle drag from moving the whole shape. Give the user a way to cancel an unfinished path or stroke. Define how an open path is finished and whether it is valid for a filled mask.

A saved manual mask must reproduce the same result after reopening the project, changing preview resolution, or exporting at the original resolution.

## 10. Timeline and keyframe animation

Support play, pause, jump to start or end, next frame, previous frame, scrubbing, timeline zoom, and an in/out range. Show elapsed time and the current editable frame identity.

Display different markers for manual keyframes, AI prompts, protected correction frames, tracked sections, and sections awaiting processing. Make these understandable without depending only on color.

Animate these properties independently where useful:

- Shape or layer position.
- Scale and rotation.
- Compatible path vertices and Bézier handles.
- Opacity.
- Feather amount.
- Mask expansion or contraction.

Support hold and linear interpolation first. Add eased interpolation when its behavior is implemented and tested. Preserve exact user states at the keyframes. Give path anchors stable IDs so vertex order cannot shift silently.

For a path whose topology changes, do not interpolate unrelated points. Use a documented hold or transition policy, or implement a tested topology-matching method. Explain the behavior in the editor.

Do not describe geometric interpolation as automatic subject tracking. These are separate operations. Arbitrary raster masks cannot be assumed to morph correctly through simple point interpolation; use AI propagation, a defined hold policy, or another verified raster method.

Allow a user to navigate to a keyframe, duplicate it, move it to another valid moment, or delete it. Keep time and mask revisions consistent when these operations affect existing tracking results.

## 11. Automatic subject selection

Implement a real selection workflow:

1. The user pauses on a frame and selects the subject tool.
2. The user taps a region to keep or draws a supported selection box.
3. The model returns a mask for that exact frame and subject.
4. The preview shows the mask over the original video.
5. The user adds keep/remove points or a supported mask correction.
6. The new result updates the current frame without losing the existing edits.
7. The user accepts the selection and chooses a tracking range.

Keep points and remove points need distinct visuals and accessible labels. When ambiguity exists, let the user refine the selection. Do not automatically choose every person when the user intended one person.

Support more than one subject as separate stable objects and editable layers. Record the prompt, frame identity, provider, checkpoint, preprocessing settings, and result revision. Keep a mapping between project object IDs and provider session IDs.

Display actual service states: preparing, queued, processing, ready, canceled, or failed. If the model is unavailable, keep manual tools available and explain the specific dependency without showing a successful AI result.

Use text selection only if the chosen provider supports it and it is actually connected. It is an extension to the core tap-and-correct workflow, not a reason to delay that workflow.

## 12. Video tracking and propagation

Track within a user-selected range and support forward, backward, or both directions from a prompted frame when the provider allows it. Return a per-frame mask for each subject with frame and timestamp references.

Maintain temporal context. Independently segmenting unrelated frames and calling it tracking is insufficient. Evaluate whether the same subject remains selected through movement, temporary obstruction, and reappearance.

Handle a subject leaving the frame, becoming partly hidden, or becoming fully absent. Do not force a visible mask when the subject is absent. Avoid combining distinct subjects just because they overlap.

Detect or identify shot changes and let the user split tracking into shots. Do not carry an identity blindly through a hard cut. Offer a new prompt or explicit reassociation for a new shot.

Store completed output progressively and keep processing memory bounded. For long clips, design around the selected model's real loading and state requirements. If processing in windows or chunks, explicitly preserve or rebuild the necessary temporal state and verify boundaries. Restarting each chunk without context can change the result and must not be hidden.

If model scores are exposed, describe them accurately. A score or heuristic is not automatically a calibrated probability of correctness. Use missing masks, abrupt area changes, identity changes, or other tested indicators to suggest review points. Do not invent confidence values.

Let the user cancel processing and inspect completed frames. Keep incomplete sections visibly distinct from completed sections. Rerunning the same unchanged request should reuse valid cached results when possible.

## 13. Corrections, protected frames, and revision safety

Corrections are central to the product. A user must be able to stop on a bad frame, add keep/remove points, paint a correction, or adjust a manual override, then update the surrounding tracking.

Provide clear correction scopes: this frame, forward to a chosen boundary, backward to a chosen boundary, or an interval between protected frames. Distinguish a local paint override from a prompt that influences the model.

Preserve user-authored correction frames as constraints. If the provider cannot respect every constraint directly, reconcile its output with saved manual overrides in the mask evaluator. Document the actual behavior.

Keep the original source, model masks, prompts, manual overrides, and edge effects separately. This makes it possible to rerun AI without erasing the user's work.

Assign a revision to every operation that changes meaningful mask state. A background job must be pinned to the source asset and editing revision from which it began. If the user changes the mask while that job is running, its result must not silently overwrite the newer work.

Use cancellation, stale-result rejection, or explicit result branching as appropriate. Allow inspection or application of a result only when the compatibility rules are satisfied. Undo and redo must invalidate or restore affected derived results consistently.

For preview caches, include the source identity, frame, object, edit revision, processing settings, and relevant provider version. Cache reuse must never mix another project or an older correction into the visible result.

## 14. Edges, matting, and visual quality

Implement feathering, expansion/contraction, opacity, and inversion as genuine mask operations. Store their values with defined units and keep preview and export behavior consistent.

Define the order of operations explicitly. For example: evaluate the base mask, apply manual corrections, apply geometric edge adjustment, feather, invert if selected, then apply opacity. If another order is chosen, document and test it.

Feathering should create a soft boundary without destroying the entire subject. Keep geometry and edge effects independently editable. Define how a source-space feather radius scales at different render resolutions.

For fine-edge recovery, evaluate a matting model that matches the subject and footage. RVM is a human-matting candidate; do not automatically apply it to animals, arbitrary objects, or cartoon clips as though it were a universal solution. Check its code and model distribution terms before adoption.

Keep temporal consistency during refinement. A crisp individual frame is insufficient if its edges flicker during playback. Evaluate hair, motion blur, thin objects, semi-transparent edges, and similar foreground/background colors separately.

When available, use estimated foreground colors for proper edge compositing. Multiplying the original RGB by alpha alone can preserve background contamination around hair. Do not claim automatic recovery of glass, smoke, or every transparent material without evidence on those cases.

Provide comparison views: original, mask overlay, grayscale matte, checkerboard transparency, and the subject over a light or dark background. These reveal different defects. The checkerboard is an editor overlay and must never be burned into a transparent export.

## 15. Mask evaluation and compositing

Choose one explicit mask evaluator that can be used or faithfully reproduced in both preview and server rendering. Inputs are the project revision, source frame identity, layer state, manual edits, and available model output. Output is the final per-frame alpha mask and any required foreground image.

Use a single documented convention: alpha values range from 0 to 1, where 1 keeps the pixel. For continuous mask values, adopt and test clearly defined operations. One acceptable product convention is:

- Replace: result = B.
- Add: result = max(A, B).
- Subtract: result = A × (1 − B).
- Intersect: result = A × B.
- Invert: result = 1 − A.
- Opacity: result = A × layerOpacity.

These are chosen editor semantics for soft masks. Keep them consistent rather than switching between different notions of union or intersection in different renderers. Define what happens when there is no base mask, when a layer is hidden, and when several subject layers overlap.

Treat alpha as coverage or transparency data, not as a display color. Avoid unintended gamma transformations of the matte. Document straight versus premultiplied alpha at module boundaries and convert deliberately. Do not multiply a foreground by its alpha twice.

For an opaque replacement background and a straight-alpha foreground, a simple conceptual composite is foreground × alpha + background × (1 − alpha). Use the correct color-space handling and layer-compositing convention in the actual implementation.

Handle input color metadata and full/limited range deliberately. If HDR conversion is offered, test tone mapping; merely removing HDR metadata is not a valid conversion.

Include color and alpha test patterns so preview and final output can be compared. Check bright and dark backgrounds for halos. Keep the cursor, control points, selection outline, guides, and timeline graphics outside the export compositor.

## 16. Browser media processing and fallbacks

Use WebCodecs where supported and tested, with a maintained demuxer and muxer when needed. WebCodecs operates on encoded chunks and frames; the application still needs a correct media-file pipeline.

Check the exact decoder and encoder configurations at runtime. Browser identity alone cannot establish codec support, a usable resolution, a particular alpha path, or successful encoding under current resource conditions.

Keep expensive processing off the interface thread when the relevant APIs permit. Release VideoFrame, ImageBitmap, GPU textures, object URLs, and worker resources promptly. Use bounded decode/encode queues and backpressure.

Separate playback from export. Frame callbacks and a real-time canvas recording can support preview or a limited convenience export. They must not be the only path for deterministic frame-by-frame rendering with correct audio and timing.

If MediaRecorder is offered, check the MIME type, handle recording failure, and disclose the actual export characteristics. Do not assume recording a transparent canvas preserves transparency in the resulting video.

Use native server FFmpeg for robust fallback processing. Browser FFmpeg through WebAssembly can be evaluated for a small, bounded local task, but must not become an assumed universal solution for long mobile clips. Consider its memory, CPU, loading, and cross-origin isolation requirements for the exact build.

A fallback must produce the same documented editing result. If a browser cannot support the requested operation locally, offer the tested online route or a clear unsupported status. Do not quietly reduce output resolution, drop frames, strip audio, or flatten transparency.

## 17. Project structure, autosave, and portable backups

Use a versioned project schema. The minimum model should capture:

| Record | Required information |
| --- | --- |
| Project | ID, schema version, edit revision, name, creation/update times, settings |
| Source asset | Immutable asset ID, fingerprint, size, filename, media metadata, availability |
| Frame map | Source frame identity, PTS and time base, proxy mapping, editing-time policy |
| Layer | Stable ID, subject ID where applicable, name, visibility, lock state, composition order |
| Geometry | Source-space points, anchor IDs, handles, transforms, keyframes |
| Manual raster edits | Stroke or tile references, target frame/range, effect and revision |
| AI prompts | Frame, coordinates, labels, prompt type, subject and provider-session mapping |
| AI output | Asset references, processed range, provider/checkpoint, parameters, input revision |
| Edge effects | Feather, expansion/contraction, opacity, inversion, evaluation order |
| Job | ID, type, pinned input, status, progress, output references, error and cancellation state |
| Export | Snapshot revision, format, dimensions, timing, audio policy, completion status |

Store large masks and frames as referenced binary assets rather than huge base64 strings inside project JSON. Use local metadata transactions so a saved revision and its referenced assets remain consistent.

Autosave meaningful edits with a debounce and checkpoint policy. Show Saved, Saving, or a specific save failure. A label must reflect an actual successful write. Preserve a recovery checkpoint during migration or major project changes.

Use IndexedDB for structured metadata and OPFS or supported blob storage for larger local assets. Query estimated storage when available, handle quota errors, and request persistent storage when appropriate. Browser storage can still be cleared or evicted, so offer a portable backup.

A backup package should contain a manifest, editing data, required mask assets, frame timing, and checksums. Let the user choose whether to include the source clip. When it is omitted, explain how to relink the same source and validate its identity before using old masks.

On reopen, handle missing source data, incomplete model output, and offline server assets gracefully. Restore usable edits immediately. Never label a project recovered when necessary edits failed to load.

Implement schema migration deliberately. Reject unknown incompatible formats with a readable explanation. Validate imported project packages, bound their extracted size, and prevent unsafe file paths.

## 18. API contracts and secure project access

Define typed requests and responses before connecting the UI. The following endpoint families are a suggested application contract; they are not claims about a third-party model API:

| Operation | Example route | Result |
| --- | --- | --- |
| Discover capabilities | GET /api/capabilities | Available providers, limits, prompt types, and verified export formats |
| Begin/resume upload | POST /api/uploads and supported upload routes | Upload ID, authorized destination, current offset, and limits |
| Inspect media | POST /api/media/inspect | Inspection job or validated metadata |
| Create project | POST /api/projects | Project ID and access context |
| Load/save revision | GET or PATCH /api/projects/{id} | Versioned project manifest with conflict checks |
| Start subject session | POST /api/projects/{id}/subjects | Stable project subject and provider session |
| Apply prompt | POST /api/subjects/{id}/prompts | Validated prompt revision and mask response or job |
| Track interval | POST /api/subjects/{id}/tracking | Durable processing job |
| Refine edges | POST /api/subjects/{id}/refinement | Refinement job when capability is supported |
| Render export | POST /api/projects/{id}/exports | Export job pinned to a project snapshot |
| Observe/cancel job | GET /api/jobs/{id}, POST /api/jobs/{id}/cancel | Actual progress or cancellation request status |
| Retrieve authorized asset | GET /api/assets/{id} or a scoped download URL | Authorized media or output |
| Delete project/media | DELETE authorized resource route | Deletion state covering related jobs and assets |

Include source asset ID, subject ID, frame identity, input revision, prompt type, relevant settings, and a request identifier in model operations. Use an idempotency key for retriable job creation so a connection retry does not create duplicate processing charges or conflicting outputs.

Validate coordinates, dimensions, frame ranges, finite numeric values, file sizes, durations, and prompt count limits. Do not pass user-provided strings directly into shell commands. Use structured subprocess arguments and bounded resources for media tools.

Protect source clips, masks, jobs, and outputs with project-scoped ownership checks. A guessed object ID must not expose another user's clip. For a single-user prototype, a secure guest session or scoped project capability can be sufficient; a public multiuser service needs a properly designed identity and authorization flow.

Keep storage credentials, provider secrets, model-access tokens, and signing keys on the server. Serve the editor over HTTPS. Configure CORS, cookies or bearer authentication, and request limits for the chosen deployment rather than using permissive defaults without justification.

Give the frontend concise error codes and recovery actions. Keep sensitive URLs, tokens, file paths, and verbose server traces out of normal user messages.

## 19. Durable uploads, jobs, and AI sessions

Use resumable uploads for large media. Prefer a maintained implementation of a protocol such as tus, or a tested object-storage multipart approach. Record the upload ID and acknowledged offset so the user can recover after a connection interruption.

The server must not start inference on an incomplete upload. Validate final size and integrity before making the source asset available. Configure cleanup for abandoned partial uploads.

Run heavy work through a real queue and separate workers. HTTP handlers should return promptly with a job identifier. An in-process background callback alone is insufficient for durable long-running processing across server restarts.

Jobs need actual states such as queued, preparing, running, cancel_requested, canceled, completed, and failed. Give progress a defined unit: processed frames, bytes uploaded, or completed stages. If the total is unknown, use an indeterminate state rather than an invented percentage.

Support status polling initially; add server-sent events or WebSockets only when they improve the implemented experience. Reconnecting must recover status from durable records. The browser does not own the lifetime of a server job.

Manage GPU sessions deliberately. Reuse loaded model weights where safe, bound concurrent sessions, and serialize mutations to a subject's inference state. Do not accidentally load a large independent model into every HTTP worker.

Record model configuration, checkpoint identity, compatibility information, and the relevant preprocessing settings. Store prompts and output assets so an expired in-memory tracking session can be reconstructed or rerun. Do not rely on an unsupported promise to serialize a provider's internal state.

For cancellation, mark the request immediately, stop between bounded processing steps, and terminate render subprocesses when safe. Show Canceling until the worker actually stops. Release temporary files and GPU memory. Preserve useful completed output when consistent with the user's action.

Define retry limits, worker leases or equivalent recovery, resource timeouts, and safe restart behavior. A job that resumes after a failure must not append duplicate frames or overwrite newer project edits.

## 20. Privacy, retention, and deletion

Make processing location visible in ordinary language: On this device or Online processing. Explain which media is sent before an online operation begins. Keep the manual local workflow usable where the browser supports it.

Keep hosted assets private by default. Do not add media to public galleries, shared links, analytics payloads, or model training. Avoid recording the content of uploaded frames in logs.

Make retention configurable and visible. Distinguish source media, partial uploads, proxies, model masks, temporary render files, final exports, and project metadata. Each needs a retention or deletion policy.

Implement deletion across related records and files. Cancel or invalidate queued and running work so an older worker cannot recreate deleted assets. Use a deletion marker or generation check where necessary.

Deleting a local project must not delete the user's original camera or filesystem file. Provide clear local-cache cleanup and preserve any independent backup the user exported.

Offline support should cover the cached app shell and available local manual editing. State which operations require the server. A service worker must not be treated as a guarantee that long AI or rendering work continues when a mobile browser is suspended.

Keep service-worker caching scoped to public app assets and deliberately managed private project data. Do not cache authenticated media or token-bearing responses through a blanket caching rule. Respect account or session changes, expiry, and deletion when deciding which local assets remain accessible.

## 21. Export formats and real transparency

Export is a core feature and must be implemented early. Every export must use a snapshot of the selected project revision so later edits cannot change a render partway through.

Offer these output families as their pipelines become verified:

| Output | Purpose | Requirement |
| --- | --- | --- |
| Composited MP4 | Subject over a chosen color, image, or supported background | Common playable codec, synchronized audio, intentional opaque background |
| Grayscale matte | Reuse the mask in an editor that accepts a separate matte | Matching timing and dimensions; documented black/white meaning and range |
| PNG sequence | Preserve individual frames and transparency | Actual RGBA alpha, consistent names, timing manifest, manageable archive |
| Alpha-capable video | Transfer a cutout without flattening | Verified codec/container/encoder/decoder path and destination compatibility |
| Portable project | Continue editing later | Versioned manifest and required editing assets |

A normal H.264 MP4 export is an opaque output. Transparent export depends on the codec, container, encoding path, and receiving application; the file extension alone is insufficient. Do not advertise all MP4 files as transparent or assume all MP4 variations are incapable of alpha.

Evaluate ProRes 4444 in MOV for an appropriate high-quality alpha route. Evaluate VP9 alpha in WebM only when the installed encoder, muxer, decoding tools, and target application preserve it. HEVC with alpha is a separate platform-specific possibility that needs its own tested pipeline; generic HEVC encoding does not establish alpha support.

Make PNG sequence and separate-matte exports available as reliable preservation routes when implemented. Explain that a receiving mobile editor may still have its own import limitations. Test the intended destination rather than claiming universal compatibility.

For every render:

1. Resolve the pinned project snapshot and media assets.
2. Evaluate the mask for each exact output frame according to the chosen timing policy.
3. Apply manual edits, edge effects, layer composition, and background selection consistently.
4. Preserve or explicitly transform frame timestamps and durations.
5. Preserve audio timing, including the in/out range and initial offset.
6. Encode and mux using a configuration that has been checked on the installed tools.
7. Validate the result before marking it completed.
8. Provide an actual download or a supported share/save action.

Check odd output dimensions and codec restrictions without silently cropping the subject. If padding or resizing is required, reflect it in the output settings and metadata.

A transparent export must contain non-opaque alpha values when the project calls for them. Decode or extract its alpha and inspect it over at least two backgrounds. Merely seeing a checkerboard in the editor is not proof.

Prefer lossless storage for archived matte data. If a convenience matte video is lossy or uses a limited video range, document that and verify correct values when it is reconstructed. Retain a precise alternative.

Use a standard download fallback where file-system saving or sharing is unsupported. Check whether the chosen Web Share operation accepts the actual file. Do not claim a save to the photo library unless the platform action confirms it.

## 22. Performance and memory discipline

Measure resource use throughout development. Keep decoded frames, masks, thumbnails, and GPU textures in bounded caches. Prioritize the current editing frame, then nearby frames, and evict old derived data when necessary.

Do not decode or store an entire long clip as uncompressed RGBA frames in phone memory. A 1920 × 1080 RGBA frame is about 8.3 MB in decimal units; 900 such frames require about 7.5 GB before overhead. This is a capacity example, not a claim about a particular browser's limit.

Use proxy frames for interactive work and demand-driven full-resolution frames for detailed inspection. Store masks compactly with a defined quality policy. Avoid repeated large blob copies and unnecessary JSON serialization.

During scrubbing, use the latest requested frame, cancel obsolete work, and provide a useful preview while the exact frame arrives. Keep controls responsive while upload, AI, or export is running.

Use a graceful quality mode for weaker devices: lower preview resolution, simpler overlays, smaller caches, and slower nonessential updates. Preserve the final export settings unless the user changes them.

Feature-detect optional GPU acceleration. If evaluating on-device AI through ONNX Runtime Web, MediaPipe, or another runtime, verify the actual converted model, supported operators, numerical behavior, runtime provider, memory, and sustained speed. A model having an ONNX file does not establish that it will run well on a phone.

Set development targets, then report measurements. Suggested targets include approximately 30 fps proxy playback on the declared target device, responsive touch interactions, and no progressive memory growth during a sustained edit session. Adjust these targets based on actual devices and clearly report the supported operating range.

Record cold model startup separately from warm inference. Measure upload, decoding, tracking, refinement, compositing, encoding, and download. Do not estimate user waiting time from model-only FPS.

## 23. Failure recovery and operational behavior

Handle each of these conditions with a defined state and recovery action:

- Network interruption during upload, model processing, status polling, or download.
- The user switching apps, locking the phone, or returning after browser suspension.
- GPU memory exhaustion or an unavailable model checkpoint.
- A corrupted frame, decoder failure, unsupported codec, or failed export.
- Local storage quota exhaustion or missing cached assets.
- A worker or API process restarting.
- A project changing while an older job is running.
- A subject disappearing or a tracker selecting the wrong object.
- A canceled job that has already produced some output.
- A saved project's source clip being unavailable or mismatched.

Preserve the user's edits through recoverable failures. When returning from a hidden page, reconnect to server jobs, validate current frame state, and restore the saved project revision. Do not assume browser animation timers continue normally in the background.

Provide useful messages such as The clip is still processing online, Reconnect to resume the upload, or Choose the original clip to reopen this project. Provide Retry only when it can safely retry the operation.

Keep diagnostics structured: project revision, job ID, provider version, stage, processing duration, and a sanitized error code. Make detailed diagnostics available on request without overwhelming the editing interface.

For hosted operation, enforce duration, size, resolution, session, and concurrency limits. Measure GPU time, storage, bandwidth, and render time. Provide a cost estimate based on measured sample jobs and current provider pricing if a hosting provider is selected. An available model download does not eliminate infrastructure costs.

## 24. Implement in dependency order

Use milestones to build and verify working slices. These stages organize delivery; all core requirements still belong to the intended full release.

**Milestone A — project setup and an honest capability report**

Inspect the repository and applicable instructions. Choose compatible dependencies, record the architecture, establish a real media fixture, and implement capability detection. Define project state, source coordinates, frame timing, and the shared mask evaluator before connecting complex tools.

**Milestone B — a complete manual editing slice**

Import a supported clip, display exact paused frames, create a manual mask, edit it on the timeline, preview the result, save and reopen it, and produce a real output. Add shapes, paths, brush edits, layers, undo/redo, keyframes, and edge controls using the same evaluator.

**Milestone C — a real AI selection slice**

Load the chosen checkpoint in its actual runtime. Run a prompted selection on an actual clip frame, display its returned mask in the correct coordinates, and apply a real corrective prompt. Record the request and output provenance.

**Milestone D — tracking with correction and recovery**

Propagate through a short real clip. Add range selection, multi-object handling, correction scopes, protected frames, stale-result protection, cancellation, and progressive results. Implement durable jobs and resumable media preparation where they are needed.

**Milestone E — refinement and reusable output**

Connect a suitable matting provider if selected. Verify fine edges and temporal behavior. Complete matte and PNG output, at least one tested alpha-capable video route, project backup, audio synchronization, and original-resolution rendering within the declared limits.

**Milestone F — mobile release verification**

Test actual target devices, permission and saving flows, rotation, gestures, background/foreground transitions, poor connections, resource limits, and sustained use. Fix the defects found. Complete setup, deployment, support, and known-limit documentation.

Do not spend the first milestone on account screens, billing, marketing pages, or elaborate animation. Focus implementation effort on the source-to-mask-to-export workflow. Add optional natural-language selection, background-video composition, and expanded clip limits after the core workflow is dependable.

## 25. Organize the code and deliver useful documentation

Use a structure suited to the existing project. Keep clear homes for:

- Editor UI and accessible controls.
- Domain state, command history, and project schema.
- Source-frame indexing and media adapters.
- Coordinate transforms and input gestures.
- Vector/raster mask evaluation and edge effects.
- Preview rendering and final-render specifications.
- Local storage, backup, and migration.
- API types, uploads, job status, and error handling.
- Server authorization, project records, and asset management.
- Model-provider adapters and worker orchestration.
- Media inspection, proxy generation, render, and validation scripts.
- Meaningful test fixtures, automated tests, and device verification notes.

Define TypeScript and Python types at the boundaries and validate incoming data. Pin dependencies and document model checkpoint acquisition. Keep secrets out of source control and provide a configuration example containing placeholders only.

Provide a README with an exact local startup sequence, a manual-only development path, AI worker setup, system media-tool requirements, configuration variables, supported formats, and troubleshooting. Include commands for the actual project; do not give commands that were never checked.

Record how to obtain model weights, verify their identity, select a checkpoint, and detect that inference is ready. Include an infrastructure example or deployment guide that fits the selected hosting environment. Keep server GPU requirements separate from frontend hosting requirements.

Create a support matrix showing what was verified on each device and browser. Distinguish verified, available but unverified, and unsupported behavior. Keep known limitations specific.

## 26. Verify behavior with meaningful tests and fixtures

Use automated tests for correctness-sensitive logic and integration boundaries. Use visual and physical-device checks for touch behavior, codec handling, saving, and sustained performance. Avoid tests that simply repeat the implementation without independent expectations.

Build fixtures from synthetic scenes, original footage, or appropriately permitted sample clips. Include:

1. A simple moving object with an independently known mask for manual and renderer checks.
2. A person moving against a visually clear background.
3. Hair and motion blur against contrasting backgrounds.
4. Two subjects crossing or partly overlapping.
5. A subject leaving the frame and returning within one shot.
6. A hard cut to another shot.
7. A portrait phone recording with rotation metadata and variable frame timing.
8. A video with a clear audio synchronization cue.
9. A silent clip and a clip with an initial audio offset.
10. An animated or cartoon clip for evaluating the declared subject support.
11. An unsupported or corrupt input.

Use independently annotated frames for model-quality evaluation where feasible. Report which cases work, which need corrections, and which are unsupported. Do not present success on a simple person clip as evidence for every object or animation style.

Test mask arithmetic, coordinate transforms, undo/redo, keyframe constraints, source relinking, stale-result rejection, project migration, and pinned export snapshots. Compare preview and render pixels within a justified tolerance.

For frame and audio correctness, check output timestamps, duration, expected frame count under the chosen timing policy, and synchronization at the start, middle, and end. Set an explicit sync tolerance, preferably no more than one output-frame interval where appropriate, and explain any larger measured deviation.

For alpha correctness, use a test foreground with known fully opaque, fully transparent, and partly transparent regions. Verify those regions survive the exported format. Check decoded alpha and visible composites rather than relying only on a codec name or metadata field.

For backend integrity, test ownership isolation, interrupted upload recovery, worker restart, cancellation, expiry, deletion during processing, and a retried idempotent request. For storage, test quota failure and reopening a project with missing media.

Browser automation can cover repeatable UI behavior. A desktop viewport pretending to be a phone is not sufficient evidence for real iPhone or Android codec, memory, download, and lifecycle behavior. If physical devices are unavailable, mark those checks as unverified and provide a concise testing procedure.

Run appropriate checks after each milestone. Fix failing behavior and rerun affected checks. Do not claim a test, model run, device check, or export inspection happened unless it actually did.

## 27. Definition of a functioning full release

The full release should satisfy the following acceptance checklist within its declared device and media limits:

- A real phone can import a supported clip and display it with the correct orientation and timing.
- The user can draw shapes and paths, brush or erase a mask, and use the named combination operations.
- Layers, edge settings, keyframes, and undo/redo work and survive saving/reopening.
- Exact paused-frame editing and playback overlays match the intended source frames.
- A connected model returns a real selection for the chosen subject.
- The selected subject can be tracked over a range and corrected afterward.
- Multi-subject selection preserves independent identities and edits.
- Protected manual edits survive propagation, and old job results do not overwrite newer work.
- The available edge-refinement workflow behaves as documented, including any subject restrictions.
- Users can preview the original, overlay, matte, and transparency views.
- A real opaque composited video exports with correct timing and the chosen audio policy.
- Reusable matte and PNG sequence outputs exist and have been inspected.
- At least one advertised alpha-video export has passed an actual transparency round trip.
- A portable project backup can be reopened, with explicit handling of missing source media.
- Processing and uploads show accurate progress, cancel correctly, and recover from supported interruptions.
- Private media and jobs are scoped correctly, with implemented retention and deletion.
- The UI remains usable under the measured mobile resource limits.
- Setup, versions, dependencies, support matrix, and known limits are documented.

If a requirement is unavailable because of environment limits, name it in the completion report and keep it visible in the remaining work. The release must not be described as fully functioning until these core capabilities are verified within its stated scope.

## 28. How to work and what to return

Begin by inspecting the actual environment and repository. Use available documentation, capabilities, and hardware rather than assuming an unspecified platform supports GPU workers or long-lived processing.

Present a concise plan and decision record, then implement. Continue through working milestones. Explain material findings, new constraints, and what the next check will resolve. Do not stop after a plan when implementation is possible.

Make reasonable choices inside the stated scope. Preserve existing useful code. Keep code changes reviewable, and avoid introducing unrelated systems. Use the existing deployment or authentication choices when they fit the requirements.

Do not add paid services or make purchases without an established budget and authorization. Prepare a concrete configuration and a measured cost estimate before asking for infrastructure approval. Meanwhile, finish local implementation, setup instructions, and available verification.

At delivery, provide:

1. The runnable source project and its startup instructions.
2. A clear account of what is implemented and available.
3. The model provider, checkpoint, and processing location actually used.
4. The supported input/output formats and verified device/browser matrix.
5. Results of relevant automated, media, visual, and mobile checks.
6. A real sample export or an exact explanation of the dependency preventing one.
7. Known limitations, remaining release requirements, and any concrete infrastructure blocker.
8. Configuration and deployment instructions that match the finished code.

Explain this to someone who understands video editing but may be new to software development. Use plain language, define necessary terms, and distinguish observed results from proposed improvements.

---

## Research appendix: verified facts and engineering implications

The facts below summarize the official sources checked for this prompt. The architecture, proposed milestones, defaults, API routes, formulas for product behavior, and acceptance criteria above are engineering recommendations. They are not claims that the sources provide a ready-made complete mobile editor.

### A. Model choices

**R01 — Meta SAM 2 repository and checkpoints**

[Official repository](https://github.com/facebookresearch/sam2)

The repository provides pretrained SAM 2.1 checkpoints, prompted image selection, and a video predictor for propagating masks. It documents multi-object interactions and Apache 2.0 licensing for the listed checkpoints and project components. Its published speed table uses an A100 GPU. This supports evaluating an existing model, while requiring separate measurement of the finished pipeline.

**R02 — SAM 2 video predictor implementation**

[Official predictor source](https://github.com/facebookresearch/sam2/blob/main/sam2/sam2_video_predictor.py)

The implementation maintains per-object mappings, prompts, outputs, and tracking state. Inspect the selected version's real methods before implementing a provider adapter. Correction ranges, protected frames, project revisions, durable storage, and cancellation are application responsibilities that must be designed around the provider.

**R03 — Meta SAM 3 / SAM 3.1**

[Official repository](https://github.com/facebookresearch/sam3) · [Official license](https://github.com/facebookresearch/sam3/blob/main/LICENSE)

SAM 3 supports text and visual prompts for segmentation and tracking. The repository documents SAM 3.1 checkpoints, CUDA-based setup, checkpoint-access requirements, and a distinct SAM License. It is an option to evaluate for additional capabilities, not a mandatory dependency for the first tap-and-track workflow.

**R04 — Robust Video Matting**

[Official repository](https://github.com/PeterL1n/RobustVideoMatting)

RVM is specifically designed for human video matting and uses temporal memory. Its repository provides several runtime formats, including TensorFlow.js and CoreML, and identifies GPL-3.0 for its code. Subject suitability, performance, and the exact distributed model terms need verification before integration.

**R05 — MediaPipe image segmentation on the web**

[Official web guide](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter/web_js)

The web task can segment video frames, and the guide warns that its synchronous calls block the interface thread unless moved to workers. Frame segmentation is useful for a lightweight path, but the application must separately establish subject identity and temporal tracking.

**R06 — MediaPipe interactive image segmentation**

[Official interactive guide](https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter/web_js)

The task uses a selected image location or stroke to produce an object segmentation. It provides a browser implementation route for interactive image selection. That capability alone does not establish a full video propagation system.

**R07 — ONNX Runtime Web acceleration**

[Official WebGPU guide](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)

ONNX Runtime Web documents WebGPU execution and a WebAssembly route for lightweight models. The runtime choice, model conversion, operator coverage, device capabilities, and resource use all need testing. Some browser-support statements on individual documentation pages may lag platform releases; use runtime detection and current platform sources.

### B. Browser video, input, and storage

**R08 — WebCodecs processing**

[MDN usage guide](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Using_the_WebCodecs_API)

The guide covers decoding and encoding queues, file muxing/demuxing, resource management, and audio handling. It notes that encoding may fail when browser resources are reclaimed. The design therefore needs bounded work, explicit frame disposal, failure recovery, and a dependable render fallback.

**R09 — Encoder configuration support**

[MDN encoder check](https://developer.mozilla.org/en-US/docs/Web/API/VideoEncoder/isConfigSupported_static) · [MDN decoder check](https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/isConfigSupported_static)

These methods check a requested codec configuration. Test the actual configuration and handle later runtime failures as well. Serve the hosted editor through a secure context.

**R10 — WebCodecs alpha specification**

[W3C specification](https://www.w3.org/TR/webcodecs/)

The specification includes alpha preservation options and encoded alpha side data. Specification support is not proof that a particular browser, encoder, muxer, and destination application preserve transparency. An end-to-end alpha test is required.

**R11 — Presented video frame metadata**

[MDN frame-callback documentation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)

The callback exposes the presentation timestamp of the displayed frame through mediaTime. Use that for playback coordination and use an authoritative indexed frame path for precise paused editing and rendering.

**R12 — Canvas stream capture**

[MDN captureStream documentation](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream)

Canvas capture supports stream-based recording, including manually requested frames in an appropriate capture mode. This is a useful browser primitive, not proof of correct source timing, audio muxing, or alpha export.

**R13 — Recorder MIME support**

[MDN MediaRecorder support check](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static)

A positive MIME support result still does not guarantee recording succeeds when resources are insufficient. Handle that failure and validate the actual output.

**R14 — Pointer Events**

[MDN Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events)

Pointer Events provide a common input model for mouse, touch, and pen, including capture and touch-action behavior. The editor still needs explicit gesture arbitration so viewport movement and mask drawing do not interfere.

**R15 — OPFS**

[MDN origin-private filesystem](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)

OPFS provides storage private to the site's origin and worker-accessible file operations. It is subject to origin storage limits and can be removed when site data is cleared. It must be paired with quota handling and user-exported backups.

**R16 — Browser quotas and eviction**

[MDN storage guide](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

The guide explains quota failures, estimated usage, persistence requests, and eviction. Avoid relying on a fixed storage allowance or presenting browser-local data as an indestructible backup.

**R17 — WebKit storage policy**

[Official WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)

WebKit documents best-effort and persistent storage, heuristic persistence decisions, and the need to handle quota exceptions. Installation on the home screen does not eliminate the need for recovery and backup behavior.

**R18 — Background page behavior**

[MDN Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)

Hidden pages are subject to browser performance policies, including throttled or stopped animation callbacks. Persist edits and reconnect to durable server jobs when the user returns.

### C. Media tools, deployment, and uploads

**R19 — ffprobe media inspection**

[Official ffprobe documentation](https://ffmpeg.org/ffprobe.html)

ffprobe exposes stream, packet, and frame inspection, including frame reporting. Use inspection and decoded-frame data to build the authoritative media manifest rather than trusting a file extension or nominal frame rate.

**R20 — FFmpeg alpha processing**

[Official filters documentation](https://ffmpeg.org/ffmpeg-filters.html)

FFmpeg documents alpha extraction, alpha merging, color handling, and compositing operations. Those are useful building blocks for matte validation and rendering; the project's timing and editing semantics remain its own responsibility.

**R21 — FFmpeg ProRes encoding**

[Official codecs documentation](https://ffmpeg.org/ffmpeg-codecs.html)

The ProRes encoder documentation includes 4444 profiles and alpha-component options. Verify the installed build, chosen pixel format, output alpha, and destination import behavior before offering this export.

**R22 — Apple alpha-capable codec APIs**

[Apple ProRes codec documentation](https://developer.apple.com/documentation/avfoundation/avvideocodectype/prores4444)

Apple documents ProRes 4444 and lists HEVC with alpha as a distinct codec option. Treat Apple-native alpha encoding as a separate pipeline that requires appropriate platform implementation and testing.

**R23 — FFmpeg licensing and build options**

[Official license and build guidance](https://ffmpeg.org/legal.html)

The documented license depends on optional components included in the build. Record the actual binary configuration and the distribution model. Model licenses and media-tool licenses should be tracked separately.

**R24 — Browser FFmpeg limitations**

[Official ffmpeg.wasm FAQ](https://ffmpegwasm.netlify.app/docs/faq/)

The project documents slower performance than native FFmpeg and increased memory and CPU use for its multithreaded route. Verify current build limits directly; do not use a historical maximum file size as a safe mobile memory budget.

**R25 — FastAPI background work**

[Official background-task guide](https://fastapi.tiangolo.com/tutorial/background-tasks/)

FastAPI distinguishes small in-process background tasks from heavier work that can benefit from a separate queue system. Durable video processing needs job records and worker recovery in addition to an HTTP response.

**R26 — Resumable uploads**

[Official tus protocol](https://tus.io/protocols/resumable-upload)

tus specifies resuming uploads through server-confirmed offsets and HTTP operations. It leaves authorization to the server, so a resumable uploader still needs private project access and completed-upload validation.

### Final research interpretation

Existing models and media APIs provide enough building blocks for this product. The main engineering work is combining them correctly: frame identity, coordinates, editable corrections, bounded processing, persistence, audio, alpha, and mobile interaction. The recommended starting architecture is a mobile PWA with a server processing path because it can support weaker phones while keeping editing responsive. That is a design choice to validate, not a universal requirement or a claim of identical results on every device.
