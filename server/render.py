import json
from pathlib import Path
import subprocess
import zipfile
import numpy as np
from PIL import Image
from . import media, masks, store


def output_size(source, resolution, format):
    w, h = source["width"], source["height"]
    if resolution != "original":
        limit = int(resolution)
        ratio = min(1, limit / min(w, h))
        w = max(1, round(w * ratio))
        h = max(1, round(h * ratio))
    return (
        w,
        h,
        w + (w % 2 if format == "mp4" else 0),
        h + (h % 2 if format == "mp4" else 0),
    )


def model_masks(project, frame, w, h, owner):
    result = {}
    for layer in project["layers"]:
        aid = (layer.get("model") or {}).get("frames", {}).get(str(frame))
        if aid:
            a = store.owned("assets", aid, owner)
            with Image.open(a["path"]) as image:
                result[layer["id"]] = np.asarray(
                    image.convert("L").resize((w, h), Image.Resampling.NEAREST)
                )
    return result


def render(job):
    payload = json.loads(job["payload"])
    project = payload["snapshot"]
    source = project["source"]
    fmt = payload["format"]
    check = lambda: store.check(job)
    asset = store.owned("assets", source["serverAsset"], job["owner"])
    meta = media.inspect(asset["path"])
    folder = store.DATA / "jobs" / job["id"]
    folder.mkdir(parents=True, exist_ok=True)
    frames_dir = folder / "frames"
    frames_dir.mkdir(exist_ok=True)
    w, h, ow, oh = output_size(source, payload["resolution"], fmt)
    first = project["inFrame"]
    last = project["outFrame"]
    count = last - first + 1
    vf = f"scale={w}:{h},setsar=1,setpts=PTS-STARTPTS,fps=fps=30:round=up,trim=start_frame={first}:end_frame={last + 1}"
    proc = subprocess.Popen(
        [
            "ffmpeg",
            "-v",
            "error",
            "-threads",
            "2",
            "-i",
            asset["path"],
            "-an",
            "-vf",
            vf,
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-threads",
            "1",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    background = [int(project["background"][i : i + 2], 16) for i in (1, 3, 5)]
    timing = []
    try:
        for i in range(count):
            check()
            raw = proc.stdout.read(w * h * 3)
            if len(raw) != w * h * 3:
                raise media.MediaError("SHORT_FRAME")
            rgb = np.frombuffer(raw, np.uint8).reshape(h, w, 3)
            alpha = masks.evaluate(
                project,
                first + i,
                w,
                h,
                model_masks(project, first + i, w, h, job["owner"]),
            )
            a = np.floor(alpha * 255 + 0.5).astype(np.uint8)
            if fmt == "matte":
                pixels = a
            elif fmt == "mp4":
                pixels = masks.composite(rgb, alpha, background)
            else:
                pixels = np.concatenate((rgb, a[..., None]), axis=2)
            Image.fromarray(pixels).save(frames_dir / f"{i:06d}.png")
            timing.append(
                {
                    "file": f"{i:06d}.png",
                    "timestamp": i / 30,
                    "sourceFrame": source["frames"][first + i],
                }
            )
            store.progress(job, i + 1, count)
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
    if fmt == "png":
        path = folder / "cutout.zip"
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(
                "timing.json",
                json.dumps(
                    {
                        "fps": 30,
                        "revision": project["revision"],
                        "alpha": "straight",
                        "frames": timing,
                    }
                ),
            )
            for file in sorted(frames_dir.glob("*.png")):
                check()
                z.write(file, file.name)
    else:
        ext = {"mp4": "mp4", "matte": "mkv", "prores": "mov"}[fmt]
        path = folder / f"export.{ext}"
        args = [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-threads",
            "2",
            "-framerate",
            "30",
            "-i",
            str(frames_dir / "%06d.png"),
        ]
        has_audio = any(s["codec_type"] == "audio" for s in meta["streams"])
        if fmt != "matte" and not project["mute"] and has_audio:
            start = first / 30
            end = (last + 1) / 30
            args += [
                "-copyts",
                "-i",
                asset["path"],
                "-filter_complex",
                f"[1:a:0]asetpts=PTS-{meta['start']}/TB,aresample=async=1:first_pts=0,apad,atrim=start={start}:end={end},asetpts=PTS-STARTPTS[a]",
                "-map",
                "0:v:0",
                "-map",
                "[a]",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ]
        else:
            args += ["-an"]
        if fmt == "mp4":
            args += [
                "-vf",
                f"pad={ow}:{oh}:0:0:color={project['background']}",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
            ]
        elif fmt == "matte":
            args += ["-c:v", "ffv1", "-level", "3", "-pix_fmt", "gray"]
        else:
            args += [
                "-c:v",
                "prores_ks",
                "-profile:v",
                "4",
                "-pix_fmt",
                "yuva444p10le",
                "-alpha_bits",
                "16",
            ]
        args += ["-frames:v", str(count), "-t", str(count / 30), str(path)]
        media.run(args, check, timeout=300)
        decoded = media.probe(path, True)
        v = next(s for s in decoded["streams"] if s["codec_type"] == "video")
        n = len(decoded.get("frames", []))
        if n != count or v["width"] != ow or v["height"] != oh:
            raise media.MediaError("OUTPUT_VALIDATION_FAILED")
    check()
    aid = store.asset(
        job["owner"],
        job["project"],
        "export",
        path,
        {
            "format": fmt,
            "revision": project["revision"],
            "width": ow,
            "height": oh,
            "frames": count,
            "duration": count / 30,
            "sha256": media.sha256(path),
        },
    )
    return {
        "asset": aid,
        "format": fmt,
        "revision": project["revision"],
        "frames": count,
        "width": ow,
        "height": oh,
        "duration": count / 30,
        "padded": ow != w or oh != h,
    }


def verify_encoders(folder):
    """Actual alpha + matte + playable opaque round trips before advertising formats."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    png = folder / "pattern.png"
    pixels = np.zeros((16, 24, 4), np.uint8)
    pixels[:, :, :3] = [220, 80, 30]
    pixels[:, :8, 3] = 0
    pixels[:, 8:16, 3] = 128
    pixels[:, 16:, 3] = 255
    Image.fromarray(pixels).save(png)
    available = ["png"]
    errors = {}
    for fmt in ("mp4", "matte", "prores"):
        try:
            path = (
                folder
                / ({"mp4": "test.mp4", "matte": "test.mkv", "prores": "test.mov"}[fmt])
            )
            args = [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-loop",
                "1",
                "-i",
                str(png),
                "-frames:v",
                "3",
                "-r",
                "30",
                "-an",
            ]
            if fmt == "mp4":
                args += ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
            elif fmt == "matte":
                args += ["-vf", "alphaextract", "-c:v", "ffv1", "-pix_fmt", "gray"]
            else:
                args += [
                    "-c:v",
                    "prores_ks",
                    "-profile:v",
                    "4",
                    "-pix_fmt",
                    "yuva444p10le",
                    "-alpha_bits",
                    "16",
                ]
            media.run(args + [str(path)])
            if fmt != "mp4":
                raw = media.run(
                    [
                        "ffmpeg",
                        "-v",
                        "error",
                        "-i",
                        str(path),
                        "-frames:v",
                        "1",
                        "-vf",
                        "alphaextract" if fmt == "prores" else "null",
                        "-pix_fmt",
                        "gray",
                        "-f",
                        "rawvideo",
                        "pipe:1",
                    ]
                )
                a = np.frombuffer(raw, np.uint8).reshape(16, 24)
                if np.max(np.abs(a.astype(int) - pixels[:, :, 3].astype(int))) > 1:
                    raise ValueError("ALPHA_ROUND_TRIP_FAILED")
            else:
                media.probe(path, True)
            available.append(fmt)
        except (ValueError, subprocess.SubprocessError):
            errors[fmt] = "ENCODER_ROUND_TRIP_FAILED"
    return {
        "formats": available,
        "errors": errors,
        "alphaVerified": "prores" in available,
    }
