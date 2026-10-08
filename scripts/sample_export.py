"""Render an annotated synthetic manual project through the real API and worker."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import time
import zipfile
from fastapi.testclient import TestClient
from server import store, render
from server.app import app
from server.worker import work_once
from server.providers import SAM2
from scripts.fixtures import generate


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="work/sample")
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    store.DATA = Path("work/sample-data").resolve()
    store.init()
    fixtures = generate("work/fixtures")
    original = fixtures / "moving.mp4"
    raw = original.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    with TestClient(app) as client:
        token = client.post("/api/sessions").json()["token"]
        auth = {"Authorization": "Bearer " + token}
        owner = store.authenticate(token)
        u = client.post(
            "/api/uploads",
            headers=auth,
            json={"name": original.name, "size": len(raw), "sha256": digest},
        ).json()["id"]
        assert (
            client.patch(
                "/api/uploads/" + u, headers=auth | {"Upload-Offset": "0"}, content=raw
            ).status_code
            == 204
        )
        client.post("/api/uploads/" + u + "/complete", headers=auth)
        j = client.post(
            "/api/media/inspect",
            headers=auth | {"Idempotency-Key": "sample-prepare"},
            json={"asset": u},
        ).json()
        work_once(SAM2(), "sample-worker")
        done = client.get("/api/jobs/" + j["id"], headers=auth).json()
        assert done["state"] == "completed", done
        source = done["result"]["source"]
        annotations = json.loads((fixtures / "annotations.json").read_text())[
            "geometry"
        ]
        keys = []
        for i in (0, 59):
            a, b, c, d = annotations[i]["rectangle"]
            state = {
                "shapes": [
                    {
                        "id": "rectangle",
                        "kind": "rectangle",
                        "op": "add",
                        "points": [
                            {"id": "top-left", "x": a, "y": b},
                            {"id": "bottom-right", "x": c, "y": d},
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
            keys.append({"frame": i, "interpolation": "linear", "state": state})
        p = {
            "schema": 1,
            "id": "manual-sample",
            "name": "Manual moving-object example",
            "revision": 1,
            "created": int(time.time() * 1000),
            "updated": int(time.time() * 1000),
            "source": source,
            "layers": [
                {
                    "id": "subject",
                    "name": "Moving orange subject",
                    "visible": True,
                    "locked": False,
                    "op": "add",
                    "keys": keys,
                    "protected": [],
                    "prompts": [],
                }
            ],
            "inFrame": 0,
            "outFrame": 59,
            "mute": False,
            "background": "#244963",
        }
        r = client.post("/api/projects", headers=auth, json=p)
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        formats = render.verify_encoders(store.DATA / "selftest")
        with store.db() as c:
            c.execute(
                "INSERT OR REPLACE INTO readiness VALUES(?,?,?)",
                ("exports", json.dumps(formats), time.time()),
            )
        evidence = {
            "description": "Original synthetic clip with manually authored/interpolated masks. No AI inference.",
            "sourceSha256": digest,
            "exports": {},
        }
        for fmt, ext in [
            ("mp4", "mp4"),
            ("matte", "mkv"),
            ("png", "zip"),
            ("prores", "mov"),
        ]:
            start = time.perf_counter()
            j = client.post(
                f"/api/projects/{pid}/exports",
                headers=auth | {"Idempotency-Key": "sample-" + fmt},
                json={"revision": 1, "format": fmt, "resolution": "original"},
            ).json()
            work_once(SAM2(), "sample-worker")
            done = client.get("/api/jobs/" + j["id"], headers=auth).json()
            assert done["state"] == "completed", done
            asset = store.owned("assets", done["result"]["asset"], owner)
            destination = out / f"sample-{fmt}.{ext}"
            shutil.copyfile(asset["path"], destination)
            evidence["exports"][fmt] = done["result"] | {
                "elapsedSeconds": round(time.perf_counter() - start, 3),
                "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
                "bytes": destination.stat().st_size,
            }
        shutil.copyfile(original, out / "sample-source.mp4")
        # A portable package matching the editor's schema/checksum contract.
        portable = json.loads(json.dumps(p))
        portable["source"].pop("serverAsset", None)
        entries = {"project.json": json.dumps(portable).encode(), "source.bin": raw}
        checksums = {n: hashlib.sha256(b).hexdigest() for n, b in entries.items()}
        with zipfile.ZipFile(
            out / "sample-project.rototools.zip", "w", zipfile.ZIP_DEFLATED
        ) as z:
            for name, data in entries.items():
                z.writestr(name, data)
            z.writestr(
                "manifest.json",
                json.dumps(
                    {"schema": 1, "sourceIncluded": True, "checksums": checksums}
                ),
            )
        (out / "sample-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
        print(
            json.dumps(
                {
                    "output": str(out),
                    "exports": {
                        k: {"seconds": v["elapsedSeconds"], "bytes": v["bytes"]}
                        for k, v in evidence["exports"].items()
                    },
                },
                indent=2,
            )
        )


if __name__ == "__main__":
    main()
