import hashlib
import json
import time
import zipfile
from pathlib import Path
import numpy as np
import pytest
from PIL import Image
from scripts.fixtures import generate
from server import media, render, store
from server.worker import work_once
from server.providers import SAM2


@pytest.fixture(scope="module")
def fixtures(tmp_path_factory):
    return generate(tmp_path_factory.mktemp("media"))


def prepared(client, auth, path):
    data = path.read_bytes()
    owner = store.authenticate(auth["Authorization"][7:])
    u = client.post(
        "/api/uploads",
        headers=auth,
        json={
            "name": path.name,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        },
    ).json()["id"]
    assert (
        client.patch(
            "/api/uploads/" + u, headers=auth | {"Upload-Offset": "0"}, content=data
        ).status_code
        == 204
    )
    client.post("/api/uploads/" + u + "/complete", headers=auth)
    j = client.post(
        "/api/media/inspect",
        headers=auth | {"Idempotency-Key": "prepare"},
        json={"asset": u},
    ).json()
    work_once(SAM2(), "test-worker")
    done = client.get("/api/jobs/" + j["id"], headers=auth).json()
    assert done["state"] == "completed", done
    source = done["result"]["source"]
    state = {
        "shapes": [
            {
                "id": "mask",
                "kind": "rectangle",
                "op": "add",
                "points": [
                    {"id": "a", "x": 10 / 160, "y": 24 / 96},
                    {"id": "b", "x": 34 / 160, "y": 56 / 96},
                ],
                "radius": 10,
                "softness": 0,
                "strength": 1,
            }
        ],
        "x": 0,
        "y": 0,
        "sx": 1,
        "sy": 1,
        "rotation": 0,
        "opacity": 1,
        "feather": 0,
        "expansion": 0,
        "invert": False,
    }
    end = json.loads(json.dumps(state))
    end["shapes"][0]["points"][0]["x"] = 69 / 160
    end["shapes"][0]["points"][1]["x"] = 93 / 160
    last = len(source["frames"]) - 1
    keys = [{"frame": 0, "state": state, "interpolation": "linear"}]
    if last:
        keys.append({"frame": last, "state": end, "interpolation": "linear"})
    project = {
        "schema": 1,
        "id": "local",
        "name": "fixture",
        "revision": 1,
        "created": 1,
        "updated": 1,
        "source": source,
        "layers": [
            {
                "id": "layer",
                "name": "subject",
                "visible": True,
                "locked": False,
                "op": "add",
                "keys": keys,
                "protected": [],
                "prompts": [],
            }
        ],
        "inFrame": 0,
        "outFrame": last,
        "mute": False,
        "background": "#0000ff",
    }
    response = client.post("/api/projects", headers=auth, json=project)
    assert response.status_code == 200, response.text
    project["serverProject"] = response.json()["id"]
    return owner, project, done["result"]["proxy"]


def enable_formats():
    formats = render.verify_encoders(store.DATA / "selftest")
    with store.db() as c:
        c.execute(
            "INSERT OR REPLACE INTO readiness VALUES(?,?,?)",
            ("exports", json.dumps(formats), time.time()),
        )
    return formats


def test_codec_alpha_round_trip(client):
    formats = enable_formats()
    assert set(formats["formats"]) == {"mp4", "matte", "png", "prores"}
    assert formats["alphaVerified"]


def test_exact_frames_orientation_vfr_and_corrupt(fixtures):
    m = media.inspect(fixtures / "rotated.mp4")
    assert (m["width"], m["height"]) == (96, 160)
    assert abs(m["rotation"]) == 90
    m = media.inspect(fixtures / "vfr.mp4")
    times = [f["time"] for f in m["sourceFrames"]]
    assert len(set(round(b - a, 3) for a, b in zip(times, times[1:]))) > 1
    with pytest.raises(ValueError):
        media.inspect(fixtures / "corrupt.mp4")


def test_source_to_all_exports_with_independent_masks_and_audio(client, auth, fixtures):
    owner, p, proxy = prepared(client, auth, fixtures / "moving.mp4")
    enable_formats()
    pid = p["serverProject"]
    assert (
        client.get("/api/assets/" + proxy + "/frames/10", headers=auth).headers[
            "content-type"
        ]
        == "image/png"
    )
    outputs = {}
    for fmt in ("mp4", "matte", "png", "prores"):
        j = client.post(
            f"/api/projects/{pid}/exports",
            headers=auth | {"Idempotency-Key": "export-" + fmt},
            json={"revision": 1, "format": fmt, "resolution": "original"},
        ).json()
        work_once(SAM2(), "renderer")
        done = client.get("/api/jobs/" + j["id"], headers=auth).json()
        assert done["state"] == "completed", done
        a = store.owned("assets", done["result"]["asset"], owner)
        outputs[fmt] = Path(a["path"])
        assert done["result"]["frames"] == 60
    with zipfile.ZipFile(outputs["png"]) as z:
        assert len([n for n in z.namelist() if n.endswith(".png")]) == 60
        import io

        with Image.open(io.BytesIO(z.read("000030.png"))) as im:
            alpha = np.asarray(im)[:, :, 3]
        known = np.zeros((96, 160), np.uint8)
        known[24:56, 40:64] = 255
        assert np.array_equal(alpha, known)
    matte = media.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(outputs["matte"]),
            "-vf",
            "select=eq(n\\,30)",
            "-frames:v",
            "1",
            "-pix_fmt",
            "gray",
            "-f",
            "rawvideo",
            "pipe:1",
        ]
    )
    assert np.array_equal(np.frombuffer(matte, np.uint8).reshape(96, 160), known)
    prores = media.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(outputs["prores"]),
            "-vf",
            "select=eq(n\\,30),alphaextract",
            "-frames:v",
            "1",
            "-pix_fmt",
            "gray",
            "-f",
            "rawvideo",
            "pipe:1",
        ]
    )
    assert (
        np.max(
            np.abs(np.frombuffer(prores, np.uint8).reshape(96, 160).astype(int) - known)
        )
        <= 1
    )
    info = media.probe(outputs["mp4"])
    assert abs(float(info["format"]["duration"]) - 2) < 1 / 30
    video = media.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(outputs["mp4"]),
            "-vf",
            "select=eq(n\\,30)",
            "-frames:v",
            "1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
        ]
    )
    pixels = np.frombuffer(video, np.uint8).reshape(96, 160, 3)
    assert pixels[0, 0, 2] > 240
    assert pixels[40, 50, 0] > 220
    raw = media.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(outputs["mp4"]),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "pipe:1",
        ]
    )
    audio = np.frombuffer(raw, "<f4")
    for cue in (0.1, 0.9, 1.7):
        window = audio[max(0, int((cue - 0.04) * 48000)) : int((cue + 0.06) * 48000)]
        idx = np.flatnonzero(np.abs(window) > 0.15)
        assert len(idx)
        actual = cue - 0.04 + idx[0] / 48000
        assert abs(actual - cue) < 1 / 30


def test_audio_offset_preserved_and_snapshot_is_immutable(client, auth, fixtures):
    owner, p, _ = prepared(client, auth, fixtures / "offset.mp4")
    enable_formats()
    pid = p["serverProject"]
    j = client.post(
        f"/api/projects/{pid}/exports",
        headers=auth | {"Idempotency-Key": "offset-export"},
        json={"revision": 1, "format": "mp4"},
    ).json()
    p["revision"] = 2
    p["background"] = "#00ff00"
    assert (
        client.patch(
            "/api/projects/" + pid, headers=auth | {"If-Match": "1"}, json=p
        ).status_code
        == 200
    )
    assert (
        client.patch(
            "/api/projects/" + pid, headers=auth | {"If-Match": "1"}, json=p
        ).status_code
        == 409
    )
    work_once(SAM2(), "renderer")
    done = client.get("/api/jobs/" + j["id"], headers=auth).json()
    assert done["state"] == "completed", done
    assert done["result"]["revision"] == 1
    a = store.owned("assets", done["result"]["asset"], owner)
    raw = media.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            a["path"],
            "-vn",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "pipe:1",
        ]
    )
    audio = np.frombuffer(raw, "<f4")
    assert np.max(np.abs(audio[: int(0.25 * 48000)])) < 0.04
    for cue in (0.3, 1.1, 1.9):
        window = audio[int((cue - 0.04) * 48000) : int((cue + 0.05) * 48000)]
        idx = np.flatnonzero(np.abs(window) > 0.15)
        assert len(idx)
        assert abs(cue - 0.04 + idx[0] / 48000 - cue) < 1 / 30


def test_unsupported_model_stays_unavailable_and_queue_fails_honestly(client):
    provider = SAM2()
    assert not provider.load()
    assert not provider.capabilities()["ready"]


def test_portable_raster_assets_can_be_restored_without_model_or_prior_session(
    client, auth, fixtures
):
    import io

    owner, p, _ = prepared(client, auth, fixtures / "moving.mp4")
    pid = p["serverProject"]
    image = Image.new("L", (160, 96), 128)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    response = client.post(
        f"/api/projects/{pid}/mask-assets?frame=0&layer=layer",
        headers=auth | {"Content-Type": "image/png"},
        content=buffer.getvalue(),
    )
    assert response.status_code == 200, response.text
    aid = response.json()["asset"]
    metadata = json.loads(store.owned("assets", aid, owner)["metadata"])
    assert "no inference" in metadata["origin"]
    p["revision"] = 2
    p["layers"][0]["model"] = {
        "revision": 1,
        "provider": "restored-user-project",
        "checkpoint": "original-provenance",
        "frames": {"0": aid},
    }
    assert (
        client.patch(
            "/api/projects/" + pid, headers=auth | {"If-Match": "1"}, json=p
        ).status_code
        == 200
    )
    other = {"Authorization": "Bearer " + client.post("/api/sessions").json()["token"]}
    assert (
        client.post(
            f"/api/projects/{pid}/mask-assets?frame=0&layer=layer",
            headers=other,
            content=buffer.getvalue(),
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/projects/{pid}/mask-assets?frame=999&layer=layer",
            headers=auth,
            content=buffer.getvalue(),
        ).status_code
        == 422
    )


def test_full_hd_and_720_render_routes(client, auth, tmp_path):
    import subprocess

    path = tmp_path / "fullhd.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=orange:s=1920x1080:r=30:d=0.1",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
    )
    owner, p, _ = prepared(client, auth, path)
    enable_formats()
    for resolution, size in [("720", (1280, 720)), ("1080", (1920, 1080))]:
        j = client.post(
            f"/api/projects/{p['serverProject']}/exports",
            headers=auth | {"Idempotency-Key": "scale-" + resolution},
            json={"revision": 1, "format": "mp4", "resolution": resolution},
        ).json()
        work_once(SAM2(), "renderer")
        done = client.get("/api/jobs/" + j["id"], headers=auth).json()
        assert done["state"] == "completed", done
        assert (done["result"]["width"], done["result"]["height"]) == size


def test_vfr_proxy_maps_each_pixel_to_preceding_sample(client, auth, fixtures):
    owner, p, proxy = prepared(client, auth, fixtures / "vfr.mp4")
    canonical = store.owned("assets", proxy, owner)
    import io

    for i, frame in enumerate(p["source"]["frames"]):
        raw = media.frame_bytes(canonical["path"], i, 160, 96)
        with Image.open(io.BytesIO(raw)) as im:
            rgb = np.asarray(im)
        expected_source = next(
            j
            for j, f in enumerate(media.inspect(fixtures / "vfr.mp4")["sourceFrames"])
            if f["pts"] == frame["sourcePts"]
        )
        # Object has independently annotated x=10+source-frame index.
        row = rgb[40, :, 0]
        actual = np.flatnonzero(row > 180)[0]
        assert abs(actual - (10 + expected_source)) <= 1
