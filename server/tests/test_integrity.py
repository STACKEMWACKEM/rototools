import hashlib
import json
import time
import pytest
from server import store


def upload(client, auth, data=b"abcdef"):
    r = client.post(
        "/api/uploads",
        headers=auth,
        json={
            "name": "clip.mp4",
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        },
    )
    assert r.status_code == 200
    return r.json()["id"]


def test_session_and_resource_isolation(client, auth):
    id = upload(client, auth)
    other = {"Authorization": "Bearer " + client.post("/api/sessions").json()["token"]}
    assert client.head("/api/uploads/" + id, headers=other).status_code == 404
    assert client.head("/api/uploads/" + id).status_code == 401
    assert client.get("/api/assets/" + id, headers=other).status_code == 404


def test_upload_resume_integrity_idempotent_completion(client, auth):
    id = upload(client, auth)
    base = "/api/uploads/" + id
    assert client.post(base + "/complete", headers=auth).status_code == 409
    assert (
        client.patch(
            base, headers=auth | {"Upload-Offset": "0"}, content=b"abc"
        ).status_code
        == 204
    )
    assert client.head(base, headers=auth).headers["upload-offset"] == "3"
    resumed = client.post(
        "/api/uploads",
        headers=auth,
        json={
            "name": "clip.mp4",
            "size": 6,
            "sha256": hashlib.sha256(b"abcdef").hexdigest(),
        },
    ).json()
    assert resumed == {"id": id, "offset": 3}
    assert (
        client.patch(
            base, headers=auth | {"Upload-Offset": "0"}, content=b"abc"
        ).status_code
        == 409
    )
    assert (
        client.patch(
            base, headers=auth | {"Upload-Offset": "3"}, content=b"def"
        ).status_code
        == 204
    )
    assert client.post(base + "/complete", headers=auth).json() == {"asset": id}
    assert client.post(base + "/complete", headers=auth).json() == {"asset": id}
    assert client.get("/api/assets/" + id, headers=auth).content == b"abcdef"


def test_checksum_failure_and_invalid_numeric_input(client, auth):
    id = upload(client, auth)
    client.patch(
        "/api/uploads/" + id, headers=auth | {"Upload-Offset": "0"}, content=b"xxxxxx"
    )
    assert (
        client.post("/api/uploads/" + id + "/complete", headers=auth).status_code == 422
    )
    assert (
        client.post(
            "/api/uploads",
            headers=auth,
            json={"name": "bad", "size": -1, "sha256": "a" * 64},
        ).status_code
        == 422
    )


def test_durable_lease_retry_cancellation_and_idempotency(client, auth):
    owner = store.authenticate(auth["Authorization"][7:])
    j = store.enqueue(owner, None, "prepare", {"asset": "x"}, "request")
    assert (
        store.enqueue(owner, None, "prepare", {"asset": "x"}, "request")["id"]
        == j["id"]
    )
    with pytest.raises(ValueError, match="IDEMPOTENCY_CONFLICT"):
        store.enqueue(owner, None, "prepare", {"asset": "y"}, "request")
    first = store.claim("worker-a")
    assert first["id"] == j["id"]
    with store.db() as c:
        c.execute("UPDATE jobs SET lease=? WHERE id=?", (time.time() - 1, j["id"]))
    second = store.claim("worker-b")
    assert second["id"] == j["id"]
    with pytest.raises(InterruptedError):
        store.check(first)
    store.cancel(j["id"], owner)
    with pytest.raises(InterruptedError):
        store.check(second)
    store.finish(second, "completed", {"should": "not complete"})
    assert store.owned("jobs", j["id"], owner)["state"] == "canceled"


def test_deletion_invalidates_workers_and_related_private_assets(
    client, auth, tmp_path
):
    owner = store.authenticate(auth["Authorization"][7:])
    p = "project"
    with store.db() as c:
        c.execute(
            "INSERT INTO projects VALUES(?,?,0,?,0,?,?)",
            (p, owner, "{}", time.time(), time.time()),
        )
    f = tmp_path / "private"
    f.write_bytes(b"private")
    aid = store.asset(owner, p, "source", f)
    store.enqueue(owner, p, "export", {}, "export")
    j = store.claim("worker")
    assert client.delete("/api/projects/" + p, headers=auth).status_code == 200
    assert not f.exists()
    assert client.get("/api/assets/" + aid, headers=auth).status_code == 404
    with pytest.raises(InterruptedError):
        store.check(j)
    with pytest.raises(InterruptedError):
        store.asset(owner, p, "export", tmp_path / "new")


def test_expiry_cleans_partial_uploads_and_sessions(client, auth):
    id = upload(client, auth)
    with store.db() as c:
        c.execute("UPDATE uploads SET created=0")
        c.execute("UPDATE sessions SET touched=0")
    store.cleanup()
    assert not (store.DATA / "uploads" / f"{id}.part").exists()
    assert client.get("/api/projects", headers=auth).status_code == 401


def test_deletion_cleans_reprepared_copies_but_preserves_other_owners(
    client, auth, tmp_path
):
    owner = store.authenticate(auth["Authorization"][7:])
    other = store.authenticate(store.session())
    paths = []
    for project_id, project_owner in [
        ("original", owner),
        ("reprepared", owner),
        ("other", other),
    ]:
        with store.db() as c:
            c.execute(
                "INSERT INTO projects VALUES(?,?,0,?,0,?,?)",
                (
                    project_id,
                    project_owner,
                    json.dumps({"id": "local-project"}),
                    time.time(),
                    time.time(),
                ),
            )
        path = tmp_path / project_id
        path.write_bytes(b"private")
        store.asset(project_owner, project_id, "proxy", path)
        paths.append(path)
    store.delete_project("reprepared", owner)
    assert not paths[0].exists() and not paths[1].exists()
    assert paths[2].exists()
    assert store.owned("projects", "other", other)["deleted"] == 0
    with pytest.raises(KeyError):
        store.owned("projects", "original", owner)


def test_api_does_not_claim_ai_without_a_loaded_model(client):
    c = client.get("/api/capabilities").json()
    assert not c["model"]["ready"]
    assert not c["workerReady"]
    assert c["exports"]["formats"] == []
