"""Exercise real CPU SAM selection/tracking and export through the actual API.

The original synthetic clip checks the integration only, not real-subject quality.
No raster mask or manually drawn shape is supplied as a substitute for inference.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import tempfile
import time
import zipfile
import numpy as np
from PIL import Image, ImageDraw
from fastapi.testclient import TestClient
from server import media, render, store
from server.app import app
from server.providers import SAM2
from server.worker import work_once


def require(response, code=200):
    if response.status_code != code:
        raise AssertionError(f"HTTP {response.status_code}: {response.text}")
    return response.json() if code != 204 else None


def fixture(directory):
    frames = directory / "frames"
    frames.mkdir()
    for index in range(3):
        image = Image.new("RGB", (160, 96), (18, 30, 48))
        ImageDraw.Draw(image).rectangle(
            (10 + index, 24, 33 + index, 55), fill=(235, 110, 40)
        )
        image.save(frames / f"{index:06d}.png")
    path = directory / "input.mp4"
    media.run([
        "ffmpeg", "-v", "error", "-y", "-framerate", "30",
        "-i", str(frames / "%06d.png"), "-c:v", "libx264",
        "-pix_fmt", "yuv420p", str(path),
    ])
    return path


def run(output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    provider = SAM2()
    if not provider.load():
        raise RuntimeError(json.dumps(provider.capabilities()))
    old_data = store.DATA
    try:
        with tempfile.TemporaryDirectory(prefix="rototools-ai-smoke-") as temporary:
            directory = Path(temporary)
            store.DATA = directory / "data"
            store.init()
            path = fixture(directory)
            shutil.copy2(path, output / "input.mp4")
            formats = render.verify_encoders(store.DATA / "selftest")
            def publish_readiness():
                for name, value in [
                    ("model", provider.capabilities()), ("exports", formats)
                ]:
                    with store.db() as connection:
                        connection.execute(
                            "INSERT OR REPLACE INTO readiness VALUES(?,?,?)",
                            (name, json.dumps(value), time.time()),
                        )

            publish_readiness()
            with TestClient(app) as client:
                auth = {
                    "Authorization": "Bearer " + require(
                        client.post("/api/sessions")
                    )["token"]
                }

                def request(method, endpoint, body=None, key=None, revision=None):
                    headers = dict(auth)
                    if key is not None:
                        headers["Idempotency-Key"] = key
                    if revision is not None:
                        headers["If-Match"] = str(revision)
                    return require(client.request(
                        method, endpoint, headers=headers, json=body
                    ))

                def complete(job):
                    if not work_once(provider, "ai-smoke"):
                        raise AssertionError("Queued job was not claimed")
                    done = request("GET", "/api/jobs/" + job["id"])
                    if done["state"] != "completed":
                        raise AssertionError(json.dumps(done))
                    # This smoke uses work_once directly, rather than the main
                    # worker process that owns the continuous readiness heartbeat.
                    publish_readiness()
                    return done["result"]

                data = path.read_bytes()
                upload = request("POST", "/api/uploads", {
                    "name": path.name, "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                })["id"]
                require(client.patch(
                    "/api/uploads/" + upload,
                    headers=auth | {"Upload-Offset": "0"}, content=data,
                ), 204)
                request("POST", "/api/uploads/" + upload + "/complete")
                prepared = complete(request("POST", "/api/media/inspect",
                    {"asset": upload}, key="prepare"))
                source = prepared["source"]
                assert len(source["frames"]) == 3
                assert (source["width"], source["height"]) == (160, 96)
                layer = {
                    "id": "subject", "name": "AI subject",
                    "visible": True, "locked": False, "op": "add",
                    "keys": [{
                        "frame": 0, "interpolation": "linear", "state": {
                            "shapes": [], "x": 0, "y": 0, "sx": 1, "sy": 1,
                            "rotation": 0, "opacity": 1, "feather": 0,
                            "expansion": 0, "invert": False,
                        },
                    }],
                    "protected": [],
                    "prompts": [{
                        "frame": 1,
                        "points": [{"x": 23 / 160, "y": 40 / 96, "label": 1}],
                        "box": [11 / 160, 24 / 96, 35 / 160, 56 / 96],
                    }],
                }
                project = {
                    "schema": 1, "id": "ai-smoke", "name": "AI smoke",
                    "revision": 1, "created": 1, "updated": 1, "source": source,
                    "layers": [layer], "inFrame": 0, "outFrame": 2,
                    "mute": True, "background": "#0000ff",
                }
                project_id = request("POST", "/api/projects", project)["id"]
                project["serverProject"] = project_id
                endpoint = "/api/projects/" + project_id

                selection = complete(request("POST", endpoint + "/tracking", {
                    "revision": 1, "layerId": "subject", "start": 1,
                    "end": 1, "anchor": 1, "direction": "frame",
                }, key="select"))
                selected = selection["frames"]["subject"]["1"]
                assert selection["checkpoint"] == provider.sha
                layer["model"] = {
                    "revision": 1, "provider": selection["provider"],
                    "checkpoint": selection["checkpoint"], "frames": {"1": selected},
                }
                layer["protected"] = [1]
                layer["prompts"][0]["points"].append(
                    {"x": 140 / 160, "y": 10 / 96, "label": 0}
                )
                project["revision"] = 2
                request("PATCH", endpoint, project, revision=1)
                tracking_job = request("POST", endpoint + "/tracking", {
                    "revision": 2, "layerId": "subject", "start": 0,
                    "end": 2, "anchor": 1, "direction": "both",
                }, key="track")
                # Simulate an edit while the snapshot is queued. Results must not
                # silently mutate the current project revision.
                project["revision"] = 3
                project["name"] = "Edited while tracking"
                request("PATCH", endpoint, project, revision=2)
                tracking = complete(tracking_job)
                current = request("GET", endpoint)
                assert current["revision"] == 3
                assert current["name"] == "Edited while tracking"
                assert tracking["revision"] == 2
                frames = tracking["frames"]["subject"]
                assert set(frames) == {"0", "1", "2"}
                assert frames["1"] == selected, "Protected selection was replaced"
                assert frames["0"] != selected and frames["2"] != selected

                masks = {}
                observations = []
                for index in range(3):
                    response = client.get(
                        "/api/assets/" + frames[str(index)], headers=auth
                    )
                    if response.status_code != 200:
                        raise AssertionError(response.text)
                    with Image.open(io.BytesIO(response.content)) as image:
                        assert image.size == (160, 96) and image.mode == "L"
                        alpha = np.array(image)
                    mask = alpha > 0
                    assert mask[40, 22 + index], "Positive prompt subject is missing"
                    assert not mask[10, 140], "Background removal failed"
                    assert 0 < mask.sum() < mask.size
                    truth = np.zeros((96, 160), dtype=bool)
                    truth[24:56, 10 + index:34 + index] = True
                    iou = float((mask & truth).sum() / (mask | truth).sum())
                    assert iou >= 0.5, f"Integration fixture IoU too low: {iou}"
                    masks[str(index)] = alpha
                    (output / f"mask-{index:06d}.png").write_bytes(response.content)
                    observations.append({
                        "frame": index, "foregroundPixels": int(mask.sum()),
                        "syntheticIoU": iou, "asset": frames[str(index)],
                    })

                layer["model"] = {
                    "revision": tracking["revision"], "provider": tracking["provider"],
                    "checkpoint": tracking["checkpoint"], "frames": frames,
                }
                project["revision"] = 4
                request("PATCH", endpoint, project, revision=3)
                exported = {}
                for format_name in ("png", "mp4"):
                    assert format_name in formats["formats"], formats
                    result = complete(request("POST", endpoint + "/exports", {
                        "revision": 4, "format": format_name, "resolution": "original",
                    }, key="export-" + format_name))
                    asset = store.owned("assets", result["asset"],
                        store.authenticate(auth["Authorization"][7:]))
                    target = output / ("ai-export.zip" if format_name == "png"
                                       else "ai-export.mp4")
                    shutil.copy2(asset["path"], target)
                    exported[format_name] = target.name
                    if format_name == "png":
                        with zipfile.ZipFile(target) as archive:
                            timing = json.loads(archive.read("timing.json"))
                            assert len(timing["frames"]) == 3
                            for index in range(3):
                                with Image.open(io.BytesIO(
                                    archive.read(f"{index:06d}.png")
                                )) as image:
                                    pixels = np.array(image)
                                assert pixels.shape == (96, 160, 4)
                                np.testing.assert_array_equal(
                                    pixels[:, :, 3], masks[str(index)]
                                )
                    else:
                        decoded = media.inspect(target)
                        assert decoded["width"] == 160 and decoded["height"] == 96
                        assert len(decoded["sourceFrames"]) == 3

                report = {
                    "status": "passed", "model": provider.capabilities(),
                    "seconds": time.monotonic() - started,
                    "checks": [
                        "actual SAM frame selection", "forward temporal tracking",
                        "backward temporal tracking", "negative prompt",
                        "protected selection", "immutable revision snapshot",
                        "PNG export alpha matches inference", "decoded MP4 export",
                    ],
                    "fixtureLicense": "Original synthetic fixture; CC0",
                    "subjectQualityVerified": False,
                    "observations": observations, "exports": exported,
                }
                (output / "report.json").write_text(
                    json.dumps(report, indent=2) + "\n", encoding="utf-8"
                )
                print(json.dumps(report, indent=2))
                return report
    finally:
        store.DATA = old_data


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="work/ai-smoke")
    run(parser.parse_args().output)
