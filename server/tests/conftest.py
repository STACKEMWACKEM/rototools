import pytest
from fastapi.testclient import TestClient
from server import store
from server.app import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA", tmp_path / "data")
    store.init()
    with TestClient(app) as c:
        yield c


@pytest.fixture
def auth(client):
    return {"Authorization": "Bearer " + client.post("/api/sessions").json()["token"]}
