import json
import io
import hashlib
from pathlib import Path
import time
from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import Field
from PIL import Image, UnidentifiedImageError
from . import media, store
from .schema import Strict, Project, ExportRequest, TrackRequest


@asynccontextmanager
async def lifespan(app):
    store.init()
    yield


app = FastAPI(title="Rototools private processing", lifespan=lifespan)


@app.middleware("http")
async def headers(request, call_next):
    length = request.headers.get("content-length")
    if length and (not length.isdigit() or int(length) > 8 * 1024 * 1024):
        return Response("REQUEST_TOO_LARGE", status_code=413)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'"
    )
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def owner(authorization: str = Header(default="")):
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "SESSION_REQUIRED")
    try:
        return store.authenticate(authorization[7:])
    except PermissionError:
        raise HTTPException(401, "SESSION_EXPIRED")


def owned(table, id, user):
    try:
        return store.owned(table, id, user)
    except KeyError:
        raise HTTPException(404, "NOT_FOUND")


def job_view(row):
    return {k: json.loads(row[k]) if row[k] else None for k in ("result",)} | {
        k: row[k]
        for k in (
            "id",
            "state",
            "kind",
            "error",
            "progress",
            "total",
            "created",
            "updated",
        )
    }


def enqueue(user, project, kind, payload, key):
    if not key or len(key) > 100:
        raise HTTPException(422, "IDEMPOTENCY_KEY_REQUIRED")
    try:
        return job_view(store.enqueue(user, project, kind, payload, key))
    except ValueError as e:
        raise HTTPException(409, str(e))


@app.get("/api/capabilities")
def capabilities():
    with store.db() as c:
        rows = {r["name"]: r for r in c.execute("SELECT * FROM readiness").fetchall()}
    live = rows.get("exports") and rows["exports"]["updated"] > time.time() - 45
    model = (
        json.loads(rows["model"]["value"])
        if live and "model" in rows
        else {
            "ready": False,
            "reason": "PROCESSING_WORKER_OFFLINE",
            "provider": "sam2.1",
            "prompts": ["points", "box"],
            "matting": False,
        }
    )
    exports = (
        json.loads(rows["exports"]["value"])
        if live
        else {"formats": [], "alphaVerified": False}
    )
    return {
        "workerReady": bool(live),
        "model": model,
        "exports": exports,
        "limits": {
            "bytes": store.MAX_BYTES,
            "seconds": store.MAX_SECONDS,
            "dimension": 4096,
            "layers": 16,
            "editingFps": 30,
        },
        "retentionHours": store.RETENTION / 3600,
        "processing": "online",
        "hdr": False,
    }


@app.post("/api/sessions")
def new_session():
    return {"token": store.session()}


class UploadRequest(Strict):
    name: str = Field(max_length=250)
    size: int = Field(gt=0, le=268435456)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


@app.post("/api/uploads")
def begin_upload(req: UploadRequest, user=Depends(owner)):
    if req.size > store.MAX_BYTES:
        raise HTTPException(413, "UPLOAD_LIMIT")
    with store.db() as c:
        existing = c.execute(
            "SELECT * FROM uploads WHERE owner=? AND sha=? AND size=? AND state='uploading'",
            (user, req.sha256, req.size),
        ).fetchone()
        if existing:
            return {"id": existing["id"], "offset": existing["offset"]}
        active = c.execute(
            "SELECT count(*) FROM uploads WHERE owner=? AND state='uploading'", (user,)
        ).fetchone()[0]
        if active >= 4:
            raise HTTPException(429, "UPLOAD_LIMIT")
        id = store.uid()
        c.execute(
            "INSERT INTO uploads(id,owner,name,size,sha,state,created) VALUES(?,?,?,?,?,?,?)",
            (id, user, req.name, req.size, req.sha256, "uploading", time.time()),
        )
    (store.DATA / "uploads" / f"{id}.part").touch()
    return {"id": id, "offset": 0}


@app.head("/api/uploads/{id}")
def upload_offset(id, user=Depends(owner)):
    row = owned("uploads", id, user)
    return Response(
        headers={"Upload-Offset": str(row["offset"]), "Upload-Length": str(row["size"])}
    )


@app.patch("/api/uploads/{id}")
async def chunk(
    id, request: Request, upload_offset: int = Header(), user=Depends(owner)
):
    row = owned("uploads", id, user)
    body = bytearray()
    async for data in request.stream():
        body.extend(data)
        if len(body) > 4 * 1024 * 1024:
            raise HTTPException(413, "CHUNK_LIMIT")
    if not body:
        raise HTTPException(422, "EMPTY_CHUNK")
    with store.db() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute(
            "SELECT * FROM uploads WHERE id=? AND owner=?", (id, user)
        ).fetchone()
        if (
            row["state"] != "uploading"
            or row["offset"] != upload_offset
            or upload_offset + len(body) > row["size"]
        ):
            c.execute("ROLLBACK")
            raise HTTPException(409, "UPLOAD_OFFSET_CONFLICT")
        # Rewrites from the last committed offset safely after an interrupted write.
        path = store.DATA / "uploads" / f"{id}.part"
        with path.open("r+b") as f:
            f.seek(upload_offset)
            f.write(body)
            f.truncate()
            f.flush()
        c.execute("UPDATE uploads SET offset=offset+? WHERE id=?", (len(body), id))
        c.execute("COMMIT")
    return Response(
        status_code=204, headers={"Upload-Offset": str(upload_offset + len(body))}
    )


@app.post("/api/uploads/{id}/complete")
def complete_upload(id, user=Depends(owner)):
    row = owned("uploads", id, user)
    if row["state"] == "complete":
        return {"asset": id}
    if row["offset"] != row["size"]:
        raise HTTPException(409, "UPLOAD_INCOMPLETE")
    path = store.DATA / "uploads" / f"{id}.part"
    if path.stat().st_size != row["size"] or media.sha256(path) != row["sha"]:
        raise HTTPException(422, "UPLOAD_CHECKSUM_MISMATCH")
    store.asset(
        user, None, "source", path, {"sha256": row["sha"], "name": row["name"]}, id=id
    )
    with store.db() as c:
        c.execute("UPDATE uploads SET state='complete' WHERE id=?", (id,))
    return {"asset": id}


@app.delete("/api/uploads/{id}")
def remove_upload(id, user=Depends(owner)):
    row = owned("uploads", id, user)
    if row["state"] == "complete":
        raise HTTPException(409, "DELETE_ASSOCIATED_PROJECT")
    with store.db() as c:
        c.execute("DELETE FROM uploads WHERE id=?", (id,))
    (store.DATA / "uploads" / f"{id}.part").unlink(missing_ok=True)
    return {"deleted": True}


class PrepareRequest(Strict):
    asset: str


@app.post("/api/media/inspect")
def prepare(req: PrepareRequest, idempotency_key: str = Header(), user=Depends(owner)):
    a = owned("assets", req.asset, user)
    if a["kind"] != "source":
        raise HTTPException(422, "SOURCE_REQUIRED")
    return enqueue(user, a["project"], "prepare", {"asset": req.asset}, idempotency_key)


def validate_assets(project, user):
    if not project.source or not project.source.serverAsset:
        raise HTTPException(422, "PREPARED_SOURCE_REQUIRED")
    source = owned("assets", project.source.serverAsset, user)
    if (
        source["kind"] != "source"
        or json.loads(source["metadata"]).get("sha256") != project.source.fingerprint
    ):
        raise HTTPException(422, "SOURCE_MISMATCH")
    with store.db() as c:
        proxies = c.execute(
            "SELECT * FROM assets WHERE owner=? AND kind='proxy'", (user,)
        ).fetchall()
    prepared = next(
        (
            json.loads(p["metadata"])["manifest"]
            for p in proxies
            if json.loads(p["metadata"])["manifest"]["serverAsset"] == source["id"]
        ),
        None,
    )
    if (
        not prepared
        or any(
            getattr(project.source, k) != prepared[k]
            for k in ("width", "height", "frames", "duration")
            if k != "frames"
        )
        or project.source.frames
        != [
            type(project.source.frames[0]).model_validate(f) for f in prepared["frames"]
        ]
    ):
        raise HTTPException(422, "FRAME_MAP_MISMATCH")
    for layer in project.layers:
        if layer.model:
            if len(layer.model.frames) > len(project.source.frames):
                raise HTTPException(422, "MODEL_FRAME_LIMIT")
            for frame, id in layer.model.frames.items():
                a = owned("assets", id, user)
                meta = json.loads(a["metadata"])
                if (
                    a["kind"] != "model_mask"
                    or meta.get("layer") != layer.id
                    or str(meta.get("frame")) != frame
                    or meta.get("sourceFingerprint") != project.source.fingerprint
                ):
                    raise HTTPException(422, "MODEL_MASK_MISMATCH")


@app.post("/api/projects")
def create_project(project: Project, user=Depends(owner)):
    validate_assets(project, user)
    id = store.uid()
    manifest = project.model_dump(by_alias=True, exclude_none=True)
    manifest["serverProject"] = id
    if owned("assets", project.source.serverAsset, user)["project"]:
        raise HTTPException(409, "SOURCE_ALREADY_ASSOCIATED_UPLOAD_NEW_COPY")
    with store.db() as c:
        c.execute("BEGIN IMMEDIATE")
        c.execute(
            "INSERT INTO projects VALUES(?,?,?,?,0,?,?)",
            (
                id,
                user,
                project.revision,
                json.dumps(manifest),
                time.time(),
                time.time(),
            ),
        )
        c.execute(
            "UPDATE assets SET project=? WHERE id=? AND owner=?",
            (id, project.source.serverAsset, user),
        )
        proxies = c.execute(
            "SELECT id,metadata FROM assets WHERE owner=? AND kind='proxy'", (user,)
        ).fetchall()
        for proxy in proxies:
            if (
                json.loads(proxy["metadata"])["manifest"]["serverAsset"]
                == project.source.serverAsset
            ):
                c.execute("UPDATE assets SET project=? WHERE id=?", (id, proxy["id"]))
        c.execute("COMMIT")
    return {"id": id, "revision": project.revision}


@app.get("/api/projects")
def projects(user=Depends(owner)):
    with store.db() as c:
        rows = c.execute(
            "SELECT id,manifest FROM projects WHERE owner=? AND deleted=0", (user,)
        ).fetchall()
    return [{"id": r["id"], "project": json.loads(r["manifest"])} for r in rows]


@app.get("/api/projects/{id}")
def get_project(id, user=Depends(owner)):
    return json.loads(owned("projects", id, user)["manifest"])


@app.get("/api/projects/{id}/preview")
def get_preview(id, user=Depends(owner)):
    owned("projects", id, user)
    with store.db() as c:
        row = c.execute(
            "SELECT id FROM assets WHERE owner=? AND project=? AND kind='proxy' ORDER BY created DESC LIMIT 1",
            (user, id),
        ).fetchone()
    if not row:
        raise HTTPException(404, "PREVIEW_EXPIRED_PREPARE_AGAIN")
    return {"proxy": row["id"]}


@app.post("/api/projects/{id}/mask-assets")
async def restore_mask(
    id: str, frame: int, layer: str, request: Request, user=Depends(owner)
):
    project = json.loads(owned("projects", id, user)["manifest"])
    if not 0 <= frame < len(project["source"]["frames"]) or not any(
        l["id"] == layer for l in project["layers"]
    ):
        raise HTTPException(422, "MASK_FRAME_OR_LAYER_MISMATCH")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 4 * 1024 * 1024:
            raise HTTPException(413, "MASK_ASSET_LIMIT")
    try:
        with Image.open(io.BytesIO(body)) as im:
            if (
                im.format != "PNG"
                or im.mode not in ("L", "1")
                or im.size != (project["source"]["width"], project["source"]["height"])
            ):
                raise HTTPException(422, "MASK_FORMAT_OR_DIMENSION_MISMATCH")
            im.load()
    except (UnidentifiedImageError, OSError):
        raise HTTPException(422, "INVALID_MASK_ASSET")
    aid = store.uid()
    path = store.DATA / "assets" / (aid + ".png")
    path.write_bytes(body)
    try:
        store.asset(
            user,
            id,
            "model_mask",
            path,
            {
                "frame": frame,
                "layer": layer,
                "sourceFingerprint": project["source"]["fingerprint"],
                "revision": project["revision"],
                "origin": "restored project asset; no inference performed",
                "sha256": hashlib.sha256(body).hexdigest(),
            },
            id=aid,
        )
    except InterruptedError:
        path.unlink(missing_ok=True)
        raise HTTPException(410, "PROJECT_DELETED")
    return {"asset": aid}


@app.patch("/api/projects/{id}")
def save_project(id, project: Project, if_match: int = Header(), user=Depends(owner)):
    current = owned("projects", id, user)
    validate_assets(project, user)
    old = json.loads(current["manifest"])
    if old["source"]["serverAsset"] != project.source.serverAsset:
        raise HTTPException(409, "IMMUTABLE_SOURCE")
    if project.revision < current["revision"]:
        raise HTTPException(409, "REVISION_CONFLICT")
    manifest = project.model_dump(by_alias=True, exclude_none=True)
    manifest["serverProject"] = id
    with store.db() as c:
        changed = c.execute(
            "UPDATE projects SET revision=?,manifest=?,updated=? WHERE id=? AND revision=? AND deleted=0",
            (project.revision, json.dumps(manifest), time.time(), id, if_match),
        ).rowcount
    if not changed:
        raise HTTPException(409, "REVISION_CONFLICT")
    return {"id": id, "revision": project.revision}


def snapshot(id, revision, user):
    row = owned("projects", id, user)
    if row["revision"] != revision:
        raise HTTPException(409, "REVISION_CONFLICT")
    return json.loads(row["manifest"])


@app.post("/api/projects/{id}/exports")
def export(
    id, req: ExportRequest, idempotency_key: str = Header(), user=Depends(owner)
):
    if req.format not in capabilities()["exports"]["formats"]:
        raise HTTPException(503, "EXPORT_WORKER_OR_FORMAT_UNAVAILABLE")
    p = snapshot(id, req.revision, user)
    return enqueue(
        user,
        id,
        "export",
        {"snapshot": p, "format": req.format, "resolution": req.resolution},
        idempotency_key,
    )


@app.post("/api/projects/{id}/tracking")
def track(id, req: TrackRequest, idempotency_key: str = Header(), user=Depends(owner)):
    if not capabilities()["model"]["ready"]:
        raise HTTPException(503, capabilities()["model"]["reason"])
    p = snapshot(id, req.revision, user)
    count = len(p["source"]["frames"])
    layer = next((l for l in p["layers"] if l["id"] == req.layerId), None)
    if not layer or not req.start <= req.anchor <= req.end < count:
        raise HTTPException(422, "INVALID_TRACKING_RANGE")
    if req.end - req.start + 1 > 180:
        raise HTTPException(422, "TRACKING_RANGE_LIMIT_180_FRAMES")
    if not any(prompt["frame"] == req.anchor for prompt in layer["prompts"]):
        raise HTTPException(422, "ANCHOR_PROMPT_REQUIRED")
    if (
        req.direction == "forward"
        and req.start != req.anchor
        or req.direction == "backward"
        and req.end != req.anchor
        or req.direction == "frame"
        and (req.start != req.anchor or req.end != req.anchor)
    ):
        raise HTTPException(422, "INVALID_DIRECTION_RANGE")
    with store.db() as c:
        rows = c.execute(
            "SELECT * FROM assets WHERE owner=? AND kind='proxy'", (user,)
        ).fetchall()
    proxy = next(
        (
            r
            for r in rows
            if json.loads(r["metadata"])["manifest"]["serverAsset"]
            == p["source"]["serverAsset"]
        ),
        None,
    )
    if not proxy:
        raise HTTPException(422, "PREPARE_REQUIRED")
    return enqueue(
        user,
        id,
        "track",
        {
            "snapshot": p,
            "request": req.model_dump(),
            "proxy": proxy["id"],
            "checkpoint": capabilities()["model"]["sha256"],
        },
        idempotency_key,
    )


@app.get("/api/jobs/{id}")
def get_job(id, user=Depends(owner)):
    return job_view(owned("jobs", id, user))


@app.post("/api/jobs/{id}/cancel")
def cancel_job(id, user=Depends(owner)):
    owned("jobs", id, user)
    store.cancel(id, user)
    return job_view(owned("jobs", id, user))


@app.get("/api/assets/{id}")
def download(id, user=Depends(owner)):
    row = owned("assets", id, user)
    path = Path(row["path"])
    if not path.is_file():
        raise HTTPException(410, "ASSET_EXPIRED")
    return FileResponse(path, filename=path.name)


@app.get("/api/assets/{id}/frames/{frame}")
def exact_frame(id, frame: int, user=Depends(owner)):
    row = owned("assets", id, user)
    if row["kind"] != "proxy":
        raise HTTPException(422, "PROXY_REQUIRED")
    source = json.loads(row["metadata"])["manifest"]
    if not 0 <= frame < len(source["frames"]):
        raise HTTPException(422, "FRAME_RANGE")
    try:
        return Response(
            media.frame_bytes(row["path"], frame, source["width"], source["height"]),
            media_type="image/png",
        )
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.delete("/api/projects/{id}")
def delete_project(id, user=Depends(owner)):
    owned("projects", id, user)
    store.delete_project(id, user)
    return {"deleted": True}


if Path("dist").is_dir():
    app.mount("/", StaticFiles(directory="dist", html=True), name="editor")
