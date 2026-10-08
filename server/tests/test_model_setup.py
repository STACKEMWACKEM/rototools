import hashlib
import io
from pathlib import Path
import pytest
from scripts import download_model
from server.providers import SAM2


def test_verified_download_is_atomic_and_cached(tmp_path, monkeypatch):
    expected = b"reviewed model bytes"
    manifest = {
        "filename": "fixture.pt",
        "bytes": len(expected),
        "sha256": hashlib.sha256(expected).hexdigest(),
        "url": "https://example.invalid/fixture.pt",
    }
    monkeypatch.setattr(download_model, "SAM2_TINY", manifest)
    target = tmp_path / manifest["filename"]
    original = b"old artifact stays until a new download verifies"
    target.write_bytes(original)
    corrupt = b"x" * len(expected)
    with pytest.raises(ValueError, match="CHECKSUM_MISMATCH"):
        download_model.download(
            tmp_path, opener=lambda *_args, **_kwargs: io.BytesIO(corrupt)
        )
    assert target.read_bytes() == original
    assert list(tmp_path.iterdir()) == [target]

    downloaded = download_model.download(
        tmp_path, opener=lambda *_args, **_kwargs: io.BytesIO(expected)
    )
    assert downloaded.read_bytes() == expected

    def offline(*_args, **_kwargs):
        raise AssertionError("Verified cache must not trigger a network request")

    assert download_model.download(tmp_path, opener=offline) == target
    assert target.with_suffix(".provenance.json").is_file()


def test_invalid_custom_checkpoint_fails_before_runtime_load(tmp_path, monkeypatch):
    checkpoint = Path(tmp_path) / "unreviewed.pt"
    checkpoint.write_bytes(b"not a model")
    monkeypatch.setenv("SAM2_CHECKPOINT", str(checkpoint))
    monkeypatch.setenv("SAM2_SHA256", "0" * 64)
    provider = SAM2()
    assert not provider.load()
    assert provider.capabilities()["reason"] == "SAM2_CHECKSUM_MISSING_OR_MISMATCH"
    assert provider.predictor is None
