"""Download a pinned official SAM checkpoint and verify before replacing files."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.request
from server.model_artifacts import SAM2_TINY


def digest(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def download(directory, *, opener=urllib.request.urlopen):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / SAM2_TINY["filename"]
    if (
        target.is_file()
        and target.stat().st_size == SAM2_TINY["bytes"]
        and digest(target) == SAM2_TINY["sha256"]
    ):
        return target

    request = urllib.request.Request(
        SAM2_TINY["url"], headers={"User-Agent": "rototools-model-setup/1"}
    )
    temporary = None
    try:
        with opener(request, timeout=30) as response, tempfile.NamedTemporaryFile(
            dir=directory, prefix=".model-", delete=False
        ) as output:
            temporary = Path(output.name)
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > SAM2_TINY["bytes"]:
                    raise ValueError("MODEL_DOWNLOAD_SIZE_MISMATCH")
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if size != SAM2_TINY["bytes"]:
            raise ValueError("MODEL_DOWNLOAD_SIZE_MISMATCH")
        if digest(temporary) != SAM2_TINY["sha256"]:
            raise ValueError("MODEL_DOWNLOAD_CHECKSUM_MISMATCH")
        temporary.replace(target)
        target.with_suffix(".provenance.json").write_text(
            json.dumps(SAM2_TINY, indent=2) + "\n", encoding="utf-8"
        )
        return target
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", default=os.getenv("SAM2_MODEL_DIR", "models"))
    args = parser.parse_args()
    try:
        target = download(args.directory)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Model setup failed: {error}\n")
    print(f"Verified {target}\nSHA-256: {SAM2_TINY['sha256']}")


if __name__ == "__main__":
    main()
