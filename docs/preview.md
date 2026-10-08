# Try Rototools in your browser

A GitHub Codespace runs the editor, API, FFmpeg worker and CPU SAM model on a
remote computer. You can open the resulting HTTPS address on a Chromebook and
phone. This is a development preview; stopping the codespace stops processing.

## Start it

1. Sign in to the GitHub account that owns this repository.
2. [Open the preview setup in Codespaces](https://codespaces.new/STACKEMWACKEM/rototools/tree/codex/ai-preview-setup).
   Confirm that the selected branch is `codex/ai-preview-setup` and click
   **Create codespace**. Use a machine with at least 2 cores and 8 GB RAM.
3. Wait for container creation and setup to finish. Setup installs the locked
   app dependencies, builds the editor, installs CPU PyTorch and pinned SAM,
   and downloads the official tiny checkpoint with a fixed checksum.
4. The editor should open in a browser tab. If it does not, open the **Ports**
   panel, find port **8000**, and click its **Open in Browser** globe icon.
5. The worker needs a little extra startup time to load SAM and check the
   encoders. In the editor's Capabilities view, confirm the processing worker
   and SAM are ready. The exact status is also at
   `YOUR-PREVIEW-ADDRESS/api/capabilities`.

The URL should start with `https://` and end in `.app.github.dev`. Port 8000
uses HTTP *inside* the container; GitHub supplies HTTPS to your browser.
Do not switch the port's internal protocol to HTTPS: this server has no internal
TLS certificate.

Keep the port's visibility **Private**. To test on your phone, copy the forwarded
URL and sign in to the same GitHub account there. You do not need to make it
public or configure a domain.

GitHub personal accounts have a monthly Codespaces allowance. Check your
account's remaining allowance before creating a machine. If GitHub asks for
payment because the allowance is exhausted, you can stop at that screen; this
repository does not add a payment method or provision paid hosting.

## First test

1. Import a short SDR MP4 you own. Start with a few seconds at a modest resolution.
2. Draw a manual mask, undo it, add a keyframe and reload to check saving.
3. Choose online preparation when requested, then add a foreground point or box.
   Run selection on one frame before tracking a small range.
4. Try keep/remove correction points and protect a corrected frame.
5. Export an MP4 or PNG sequence. MP4 is opaque; PNGs can carry transparency.
6. Download a portable project backup before deleting the codespace or clearing
   browser data.

CPU inference can be slow. Tracking is capped at 180 frames (six seconds at
30 fps); begin with a much smaller range. This preview does not provide hair
matting, HDR processing or guaranteed performance on physical phones.

## If startup fails

Open a terminal in the codespace, from the repository root:

```bash
bash .devcontainer/setup.sh
bash .devcontainer/start.sh
tail -n 100 work/preview.log
```

Setup can be rerun. A previously downloaded checkpoint is reused only after its
size and SHA-256 match the pinned record. Interrupted or invalid downloads do
not replace an existing file.

If manual tools work but online buttons remain unavailable, check
`/api/capabilities` and the log. A checkpoint, runtime or encoder error must be
resolved; changing a readiness flag does not install the missing dependency.

When a codespace restarts, the preview starts automatically. If it was stopped
manually, run `bash .devcontainer/start.sh` again. If it is already running,
the script leaves the current preview in place.

## Verification commands

```bash
.venv/bin/python -m scripts.check_model
.venv/bin/python -m scripts.smoke_ai --output work/ai-smoke
npm test
.venv/bin/python -m pytest server/tests -q
```

The AI smoke performs actual SAM frame selection and forward/backward temporal
tracking through the API and worker. It checks a negative point, a protected
selection, revision isolation, PNG alpha equality and a decoded MP4 export.
Its original synthetic input is only an integration fixture. A passing smoke
does not prove performance on people, hair, occlusions, animals or animation.
Generated media, logs and model weights stay outside Git.

For a permanent server, use [deployment.md](deployment.md). GitHub Codespaces
is a convenient way to test; it is not the permanent production host.

Official GitHub guidance:
- [Create a codespace](https://docs.github.com/en/codespaces/developing-in-a-codespace/creating-a-codespace-for-a-repository).
- [Forward ports and control visibility](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace).
- [Codespaces billing](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-codespaces/about-billing-for-github-codespaces).
