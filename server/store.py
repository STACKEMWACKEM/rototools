import contextlib
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import time

DATA = Path(os.getenv("ROTOTOOLS_DATA", "data")).resolve()
MAX_BYTES = int(os.getenv("ROTOTOOLS_MAX_BYTES", "268435456"))
MAX_SECONDS = float(os.getenv("ROTOTOOLS_MAX_SECONDS", "30"))
RETENTION = int(os.getenv("ROTOTOOLS_RETENTION_HOURS", "24")) * 3600


def uid():
    return secrets.token_hex(16)


@contextlib.contextmanager
def db():
    DATA.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DATA / "state.sqlite", timeout=30, isolation_level=None)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    c.execute("PRAGMA busy_timeout=30000")
    try:
        yield c
    finally:
        c.close()


def init():
    for folder in ("uploads", "assets", "jobs"):
        (DATA / folder).mkdir(parents=True, exist_ok=True)
    with db() as c:
        c.executescript("""
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, token TEXT UNIQUE, created REAL, touched REAL);
    CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, owner TEXT, name TEXT, size INTEGER, sha TEXT, offset INTEGER DEFAULT 0, state TEXT, created REAL);
    CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, owner TEXT, project TEXT, kind TEXT, path TEXT, metadata TEXT, created REAL);
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, owner TEXT, revision INTEGER, manifest TEXT, deleted INTEGER DEFAULT 0, created REAL, updated REAL);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT, project TEXT, kind TEXT, state TEXT, payload TEXT, result TEXT, error TEXT, progress INTEGER DEFAULT 0, total INTEGER DEFAULT 0, lease REAL DEFAULT 0, attempts INTEGER DEFAULT 0, worker TEXT, idem TEXT, signature TEXT, created REAL, updated REAL, UNIQUE(owner,idem));
    CREATE TABLE IF NOT EXISTS readiness(name TEXT PRIMARY KEY, value TEXT, updated REAL);
    """)


def session():
    token = secrets.token_urlsafe(32)
    owner = uid()
    now = time.time()
    with db() as c:
        c.execute(
            "INSERT INTO sessions VALUES(?,?,?,?)",
            (owner, hashlib.sha256(token.encode()).hexdigest(), now, now),
        )
    return token


def authenticate(token):
    with db() as c:
        row = c.execute(
            "SELECT * FROM sessions WHERE token=?",
            (hashlib.sha256(token.encode()).hexdigest(),),
        ).fetchone()
        if not row or row["touched"] < time.time() - RETENTION:
            raise PermissionError("SESSION_EXPIRED")
        c.execute("UPDATE sessions SET touched=? WHERE id=?", (time.time(), row["id"]))
    return row["id"]


def owned(table, id, owner):
    if table not in ("projects", "jobs", "assets", "uploads"):
        raise ValueError("Invalid resource")
    with db() as c:
        row = c.execute(
            f"SELECT * FROM {table} WHERE id=? AND owner=?", (id, owner)
        ).fetchone()
    if not row or (table == "projects" and row["deleted"]):
        raise KeyError("NOT_FOUND")
    if table == "assets" and row["project"]:
        owned("projects", row["project"], owner)
    return dict(row)


def asset(owner, project, kind, path, metadata=None, id=None):
    id = id or uid()
    with db() as c:
        c.execute("BEGIN IMMEDIATE")
        if (
            project
            and not c.execute(
                "SELECT id FROM projects WHERE id=? AND owner=? AND deleted=0",
                (project, owner),
            ).fetchone()
        ):
            c.execute("ROLLBACK")
            raise InterruptedError("PROJECT_DELETED")
        c.execute(
            "INSERT OR REPLACE INTO assets VALUES(?,?,?,?,?,?,?)",
            (
                id,
                owner,
                project,
                kind,
                str(path),
                json.dumps(metadata or {}),
                time.time(),
            ),
        )
        c.execute("COMMIT")
    return id


def enqueue(owner, project, kind, payload, idem):
    signature = hashlib.sha256(
        json.dumps([project, kind, payload], sort_keys=True).encode()
    ).hexdigest()
    now = time.time()
    with db() as c:
        c.execute("BEGIN IMMEDIATE")
        prior = c.execute(
            "SELECT * FROM jobs WHERE owner=? AND idem=?", (owner, idem)
        ).fetchone()
        if prior:
            c.execute("COMMIT")
            if prior["signature"] != signature:
                raise ValueError("IDEMPOTENCY_CONFLICT")
            return dict(prior)
        if (
            c.execute(
                "SELECT count(*) FROM jobs WHERE owner=? AND state IN ('queued','running','cancel_requested')",
                (owner,),
            ).fetchone()[0]
            >= 4
        ):
            c.execute("ROLLBACK")
            raise ValueError("JOB_LIMIT")
        id = uid()
        c.execute(
            "INSERT INTO jobs(id,owner,project,kind,state,payload,idem,signature,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (
                id,
                owner,
                project,
                kind,
                "queued",
                json.dumps(payload),
                idem,
                signature,
                now,
                now,
            ),
        )
        c.execute("COMMIT")
    return owned("jobs", id, owner)


def claim(worker):
    now = time.time()
    with db() as c:
        c.execute("BEGIN IMMEDIATE")
        c.execute(
            "UPDATE jobs SET state='canceled',updated=? WHERE state='cancel_requested' AND lease<?",
            (now, now),
        )
        c.execute(
            "UPDATE jobs SET state=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,error='WORKER_INTERRUPTED',worker=NULL WHERE state='running' AND lease<?",
            (now,),
        )
        row = c.execute(
            "SELECT * FROM jobs WHERE state='queued' ORDER BY created LIMIT 1"
        ).fetchone()
        if not row:
            c.execute("COMMIT")
            return None
        c.execute(
            "UPDATE jobs SET state='running',attempts=attempts+1,worker=?,lease=?,updated=? WHERE id=?",
            (worker, now + 45, now, row["id"]),
        )
        c.execute("COMMIT")
    job = dict(row)
    job["worker"] = worker
    return job


def check(job):
    with db() as c:
        row = c.execute(
            "SELECT state,worker FROM jobs WHERE id=?", (job["id"],)
        ).fetchone()
        project = (
            c.execute(
                "SELECT deleted FROM projects WHERE id=?", (job["project"],)
            ).fetchone()
            if job["project"]
            else None
        )
    if (
        not row
        or row["state"] != "running"
        or row["worker"] != job["worker"]
        or (job["project"] and (not project or project["deleted"]))
    ):
        raise InterruptedError("CANCELED")


def progress(job, done, total):
    check(job)
    with db() as c:
        c.execute(
            "UPDATE jobs SET progress=?,total=?,lease=?,updated=? WHERE id=? AND worker=?",
            (done, total, time.time() + 45, time.time(), job["id"], job["worker"]),
        )


def finish(job, state, result=None, error=None):
    with db() as c:
        row = c.execute(
            "SELECT state,worker FROM jobs WHERE id=?", (job["id"],)
        ).fetchone()
        if not row or row["worker"] != job["worker"]:
            return
        if row["state"] == "cancel_requested":
            state = "canceled"
        c.execute(
            "UPDATE jobs SET state=?,result=COALESCE(?,result),error=?,lease=0,updated=? WHERE id=?",
            (
                state,
                json.dumps(result) if result is not None else None,
                error,
                time.time(),
                job["id"],
            ),
        )


def checkpoint(job, result):
    check(job)
    with db() as c:
        c.execute(
            "UPDATE jobs SET result=?,lease=?,updated=? WHERE id=? AND worker=?",
            (
                json.dumps(result),
                time.time() + 45,
                time.time(),
                job["id"],
                job["worker"],
            ),
        )


def cancel(id, owner):
    owned("jobs", id, owner)
    with db() as c:
        c.execute(
            "UPDATE jobs SET state=CASE WHEN state='queued' THEN 'canceled' ELSE 'cancel_requested' END,updated=? WHERE id=? AND state IN ('queued','running')",
            (time.time(), id),
        )


def delete_project(id, owner):
    target = owned("projects", id, owner)
    logical_id = json.loads(target["manifest"]).get("id")
    paths, jobs = [], []
    with db() as c:
        c.execute("BEGIN IMMEDIATE")
        ids = (
            [
                row["id"]
                for row in c.execute(
                    "SELECT id FROM projects WHERE owner=? AND deleted=0 AND json_extract(manifest,'$.id')=?",
                    (owner, logical_id),
                ).fetchall()
            ]
            if logical_id
            else [id]
        )
        for project_id in ids:
            c.execute("UPDATE projects SET deleted=1 WHERE id=?", (project_id,))
            c.execute(
                "UPDATE jobs SET state=CASE WHEN state='queued' THEN 'canceled' WHEN state='running' THEN 'cancel_requested' ELSE state END WHERE project=?",
                (project_id,),
            )
            paths.extend(
                c.execute(
                    "SELECT path FROM assets WHERE project=?", (project_id,)
                ).fetchall()
            )
            jobs.extend(
                c.execute(
                    "SELECT id FROM jobs WHERE project=?", (project_id,)
                ).fetchall()
            )
            c.execute("DELETE FROM assets WHERE project=?", (project_id,))
        c.execute("COMMIT")
    for row in paths:
        Path(row["path"]).unlink(missing_ok=True)
    for row in jobs:
        shutil.rmtree(DATA / "jobs" / row["id"], ignore_errors=True)


def cleanup():
    cutoff = time.time() - RETENTION
    with db() as c:
        projects = c.execute(
            "SELECT id,owner FROM projects WHERE deleted=0 AND updated<?", (cutoff,)
        ).fetchall()
    for p in projects:
        try:
            delete_project(p["id"], p["owner"])
        except KeyError:
            # Another copy of this logical project was already removed.
            pass
    with db() as c:
        uploads = c.execute(
            "SELECT id FROM uploads WHERE created<?", (cutoff,)
        ).fetchall()
        orphan = c.execute(
            "SELECT id,path FROM assets WHERE project IS NULL AND created<?", (cutoff,)
        ).fetchall()
        jobs = c.execute(
            "SELECT id FROM jobs WHERE updated<? AND state IN ('completed','failed','canceled')",
            (cutoff,),
        ).fetchall()
        c.execute("DELETE FROM uploads WHERE created<?", (cutoff,))
        c.execute("DELETE FROM assets WHERE project IS NULL AND created<?", (cutoff,))
        c.execute("DELETE FROM sessions WHERE touched<?", (cutoff,))
    for r in uploads:
        (DATA / "uploads" / f"{r['id']}.part").unlink(missing_ok=True)
    for r in orphan:
        Path(r["path"]).unlink(missing_ok=True)
    for r in jobs:
        shutil.rmtree(DATA / "jobs" / r["id"], ignore_errors=True)
