import bisect
import hashlib
import json
from pathlib import Path
import subprocess
import time
import numpy as np
from . import store


class MediaError(ValueError):
    pass


def run(args, check=lambda: None, timeout=180):
    # A file keeps stderr bounded in process memory and out of API responses.
    import tempfile

    with tempfile.TemporaryFile() as err:
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=err)
        start = time.monotonic()
        try:
            while True:
                check()
                if time.monotonic() - start > timeout:
                    raise MediaError("MEDIA_TIMEOUT")
                try:
                    out, _ = p.communicate(timeout=0.25)
                    break
                except subprocess.TimeoutExpired:
                    continue
            if p.returncode:
                raise MediaError("DECODE_OR_ENCODE_FAILED")
            return out
        finally:
            if p.poll() is None:
                p.kill()
                p.wait()


def probe(path, frames=False):
    args = ["ffprobe", "-v", "error", "-of", "json", "-show_format", "-show_streams"]
    if frames:
        args += ["-select_streams", "v:0", "-show_frames"]
    args.append(str(path))
    return json.loads(run(args, timeout=45))


def inspect(path):
    info = probe(path, True)
    streams = probe(path)["streams"]
    v = next((s for s in streams if s["codec_type"] == "video"), None)
    if not v:
        raise MediaError("NO_VIDEO_STREAM")
    if (
        v.get("color_transfer") in ("smpte2084", "arib-std-b67")
        or v.get("color_primaries") == "bt2020"
    ):
        raise MediaError("HDR_UNSUPPORTED_USE_SDR")
    if v["width"] > 4096 or v["height"] > 4096:
        raise MediaError("RESOLUTION_LIMIT")
    duration = float(info["format"].get("duration", v.get("duration", 0)))
    if not 0 < duration <= store.MAX_SECONDS:
        raise MediaError("DURATION_LIMIT")
    frames = [f for f in info.get("frames", []) if "best_effort_timestamp_time" in f]
    if not frames or len(frames) > 1800:
        raise MediaError("FRAME_LIMIT_OR_INVALID_TIMESTAMPS")
    sar = v.get("sample_aspect_ratio", "1:1")
    try:
        a, b = map(int, sar.split(":"))
        sar_ratio = a / b
    except (ValueError, ZeroDivisionError):
        sar_ratio = 1
    rotation = next(
        (
            int(d.get("rotation", 0))
            for d in v.get("side_data_list", [])
            if "rotation" in d
        ),
        int(v.get("tags", {}).get("rotate", 0)),
    )
    width = round(v["width"] * sar_ratio)
    height = v["height"]
    if abs(rotation) % 180 == 90:
        width, height = height, width
    if width > 4096 or height > 4096:
        raise MediaError("DISPLAY_RESOLUTION_LIMIT")
    start = float(frames[0]["best_effort_timestamp_time"])
    end = float(frames[-1]["best_effort_timestamp_time"]) + float(
        frames[-1].get("duration_time", 1 / 30)
    )
    return {
        "width": width,
        "height": height,
        "duration": min(duration, end - start),
        "start": start,
        "rotation": rotation,
        "sar": sar,
        "streams": streams,
        "format": info["format"],
        "sourceFrames": [
            {
                "time": float(f["best_effort_timestamp_time"]),
                "pts": int(f["best_effort_timestamp"]),
                "timeBase": v["time_base"],
            }
            for f in frames
        ],
    }


def prepare(job, source):
    check = lambda: store.check(job)
    path = Path(source["path"])
    metadata = inspect(path)
    folder = store.DATA / "jobs" / job["id"]
    folder.mkdir(parents=True, exist_ok=True)
    proxy = folder / "proxy.mp4"
    w = metadata["width"]
    h = metadata["height"]
    # Autorotation is FFmpeg's default. Scale enforces canonical square-pixel dimensions.
    vf = f"scale={w}:{h},setsar=1,setpts=PTS-STARTPTS,fps=fps=30:round=up,pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0"
    run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-threads",
            "2",
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-an",
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "16",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(proxy),
        ],
        check,
    )
    pi = probe(proxy)
    pv = next(s for s in pi["streams"] if s["codec_type"] == "video")
    count = int(pv["nb_frames"])
    dur = count / 30
    # CFR proxy can have one-pixel codec padding; canonical frame crops it away.
    times = [f["time"] for f in metadata["sourceFrames"]]
    frames = []
    for i in range(count):
        f = metadata["sourceFrames"][
            max(0, bisect.bisect_right(times, metadata["start"] + i / 30) - 1)
        ]
        frames.append(
            {
                "index": i,
                "timestamp": i / 30,
                "sourceTimestamp": f["time"],
                "sourcePts": f["pts"],
                "timeBase": f["timeBase"],
            }
        )
    sha = source["metadata"]
    sha = json.loads(sha)["sha256"]
    manifest = {
        "id": source["id"],
        "name": json.loads(source["metadata"])["name"],
        "fingerprint": sha,
        "size": path.stat().st_size,
        "width": w,
        "height": h,
        "duration": dur,
        "fps": 30,
        "frames": frames,
        "serverAsset": source["id"],
        "metadata": {k: v for k, v in metadata.items() if k != "sourceFrames"},
    }
    aid = store.asset(
        job["owner"], job["project"], "proxy", proxy, {"manifest": manifest}
    )
    store.progress(job, count, count)
    return {"proxy": aid, "source": manifest}


def frame_bytes(proxy_path, index, w, h):
    return run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-threads",
            "1",
            "-i",
            str(proxy_path),
            "-vf",
            f"select=eq(n\\,{index}),crop={w}:{h}:0:0:exact=1",
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "-threads",
            "1",
            "pipe:1",
        ],
        timeout=30,
    )


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while b := f.read(1024 * 1024):
            h.update(b)
    return h.hexdigest()


def detect_cuts(path, w, h, check):
    # A review heuristic, not a calibrated cut detector; do not auto-cross these boundaries.
    p = subprocess.Popen(
        [
            "ffmpeg",
            "-v",
            "error",
            "-threads",
            "1",
            "-i",
            str(path),
            "-vf",
            "scale=64:64",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    previous = None
    cuts = []
    i = 0
    try:
        while True:
            check()
            raw = p.stdout.read(64 * 64 * 3)
            if not raw:
                break
            if len(raw) != 64 * 64 * 3:
                raise MediaError("SHORT_FRAME")
            pixels = np.frombuffer(raw, np.uint8).astype(float)
            if previous is not None and np.mean(np.abs(pixels - previous)) / 255 > 0.32:
                cuts.append(i)
            previous = pixels
            i += 1
    finally:
        if p.poll() is None:
            p.kill()
        p.wait()
    return cuts
