"""Real SAM 2.1 adapter; never substitutes fixtures for inference."""

import importlib.util
import json
import os
from pathlib import Path
import numpy as np
from PIL import Image
from . import media, store


class SAM2:
    name = "sam2.1"

    def __init__(self):
        self.predictor = None
        self.reason = "SAM2_NOT_CONFIGURED"
        self.checkpoint = os.getenv("SAM2_CHECKPOINT", "")
        self.sha = os.getenv("SAM2_SHA256", "")
        self.device = os.getenv("SAM2_DEVICE", "cuda")

    def load(self):
        if not self.checkpoint or not Path(self.checkpoint).is_file():
            self.reason = "SAM2_CHECKPOINT_MISSING"
            return False
        if not self.sha or media.sha256(self.checkpoint) != self.sha:
            self.reason = "SAM2_CHECKSUM_MISSING_OR_MISMATCH"
            return False
        if (
            importlib.util.find_spec("torch") is None
            or importlib.util.find_spec("sam2") is None
        ):
            self.reason = "SAM2_RUNTIME_MISSING"
            return False
        try:
            import torch

            if self.device == "cuda" and not torch.cuda.is_available():
                self.reason = "CUDA_GPU_UNAVAILABLE"
                return False
            from sam2.build_sam import build_sam2_video_predictor

            self.predictor = build_sam2_video_predictor(
                os.getenv("SAM2_CONFIG", "configs/sam2.1/sam2.1_hiera_t.yaml"),
                self.checkpoint,
                device=self.device,
            )
            self.reason = None
            return True
        except Exception:
            self.reason = "SAM2_MODEL_LOAD_FAILED"
            return False

    def capabilities(self):
        return {
            "provider": self.name,
            "ready": self.predictor is not None,
            "reason": self.reason,
            "checkpoint": Path(self.checkpoint).name,
            "sha256": self.sha,
            "prompts": ["points", "box"],
            "directions": ["forward", "backward", "both"],
            "subjects": ["person", "animal", "object", "animation"],
            "subjectQualityVerified": False,
            "matting": False,
            "maxFrames": 180,
        }

    def process(self, job):
        if self.predictor is None:
            raise ValueError(self.reason or "MODEL_NOT_READY")
        import torch

        payload = json.loads(job["payload"])
        project = payload["snapshot"]
        request = payload["request"]
        source = project["source"]
        if payload.get("checkpoint") != self.sha:
            raise ValueError("MODEL_VERSION_CHANGED_RERUN_REQUIRED")
        start, end, anchor = request["start"], request["end"], request["anchor"]
        if end - start + 1 > 180:
            raise ValueError("TRACKING_RANGE_LIMIT_180_FRAMES")
        check = lambda: store.check(job)
        proxy = store.owned("assets", payload["proxy"], job["owner"])
        folder = store.DATA / "jobs" / job["id"]
        folder.mkdir(parents=True, exist_ok=True)
        frames = folder / "model_frames"
        frames.mkdir(exist_ok=True)
        # A single bounded temporal window; no hidden context resets inside this range.
        media.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-threads",
                "2",
                "-i",
                proxy["path"],
                "-vf",
                f"trim=start_frame={start}:end_frame={end + 1},crop={source['width']}:{source['height']}:0:0:exact=1",
                "-q:v",
                "2",
                "-start_number",
                "0",
                str(frames / "%06d.jpg"),
            ],
            check,
        )
        cuts = media.detect_cuts(
            proxy["path"], source["width"], source["height"], check
        )
        if any(start < c <= end for c in cuts):
            raise ValueError("SHOT_CHANGE_SPLIT_RANGE_REQUIRED")
        objects = {
            layer["id"]: i + 1
            for i, layer in enumerate(project["layers"])
            if any(start <= p["frame"] <= end for p in layer["prompts"])
        }
        if request["layerId"] not in objects:
            raise ValueError("PROMPT_REQUIRED")
        outputs = {id: {} for id in objects}
        review = []
        areas = {}
        seen = set()
        with torch.inference_mode():
            state = self.predictor.init_state(
                str(frames), offload_video_to_cpu=True, offload_state_to_cpu=True
            )
            try:
                for layer in project["layers"]:
                    if layer["id"] not in objects:
                        continue
                    for prompt in layer["prompts"]:
                        if not start <= prompt["frame"] <= end:
                            continue
                        check()
                        points = np.array(
                            [
                                [p["x"] * source["width"], p["y"] * source["height"]]
                                for p in prompt["points"]
                            ],
                            np.float32,
                        ).reshape(-1, 2)
                        labels = np.array(
                            [p["label"] for p in prompt["points"]], np.int32
                        )
                        box = prompt.get("box")
                        box = (
                            np.array(
                                [
                                    box[0] * source["width"],
                                    box[1] * source["height"],
                                    box[2] * source["width"],
                                    box[3] * source["height"],
                                ],
                                np.float32,
                            )
                            if box
                            else None
                        )
                        idx, ids, logits = self.predictor.add_new_points_or_box(
                            state,
                            prompt["frame"] - start,
                            objects[layer["id"]],
                            points=points if len(points) else None,
                            labels=labels if len(labels) else None,
                            box=box,
                        )
                        idx += start
                        if request["direction"] == "frame" and idx == anchor:
                            self._save(
                                job,
                                folder,
                                idx,
                                ids,
                                logits,
                                objects,
                                outputs,
                                review,
                                areas,
                            )
                            seen.add(idx)
                directions = []
                if request["direction"] in ("forward", "both"):
                    directions.append((False, end - anchor))
                if request["direction"] in ("backward", "both"):
                    directions.append((True, anchor - start))
                for reverse, n in directions:
                    for idx, ids, logits in self.predictor.propagate_in_video(
                        state,
                        start_frame_idx=anchor - start,
                        max_frame_num_to_track=n,
                        reverse=reverse,
                    ):
                        idx += start
                        check()
                        if not start <= idx <= end:
                            continue
                        self._save(
                            job,
                            folder,
                            idx,
                            ids,
                            logits,
                            objects,
                            outputs,
                            review,
                            areas,
                        )
                        seen.add(idx)
                        store.progress(job, len(seen), end - start + 1)
                        store.checkpoint(
                            job,
                            {
                                "revision": project["revision"],
                                "sourceId": source["id"],
                                "provider": self.name,
                                "checkpoint": self.sha,
                                "frames": outputs,
                                "reviewFrames": sorted(set(review)),
                                "partial": True,
                            },
                        )
            finally:
                self.predictor.reset_state(state)
        check()
        return {
            "revision": project["revision"],
            "sourceId": source["id"],
            "provider": self.name,
            "checkpoint": self.sha,
            "frames": outputs,
            "reviewFrames": sorted(set(review)),
            "shots": cuts,
            "objectIds": objects,
            "preprocessing": "SAM2 native canonical dimensions; JPEG input; threshold logits > 0",
        }

    def _save(self, job, folder, idx, ids, logits, objects, outputs, review, areas):
        snapshot = json.loads(job["payload"])["snapshot"]
        for n, obj in enumerate(ids):
            id = next(id for id, value in objects.items() if value == obj)
            mask = (logits[n, 0] > 0).cpu().numpy().astype(np.uint8) * 255
            layer = next(l for l in snapshot["layers"] if l["id"] == id)
            previous_asset = (layer.get("model") or {}).get("frames", {}).get(str(idx))
            if idx in layer["protected"] and previous_asset:
                store.owned("assets", previous_asset, job["owner"])
                outputs[id][str(idx)] = previous_asset
                continue
            area = float(np.mean(mask > 0))
            previous = areas.get(id)
            if area == 0 or (
                previous and abs(area - previous) > max(0.1, previous * 0.5)
            ):
                review.append(idx)
            areas[id] = area
            path = folder / f"{obj}-{idx:06d}.png"
            Image.fromarray(mask).save(path)
            # Deterministic asset IDs avoid duplicate assets on retry. No project edits are applied here.
            aid = f"{job['id']}-{obj}-{idx}"
            store.asset(
                job["owner"],
                job["project"],
                "model_mask",
                path,
                {
                    "frame": idx,
                    "layer": id,
                    "sourceFingerprint": snapshot["source"]["fingerprint"],
                    "revision": snapshot["revision"],
                },
                id=aid,
            )
            outputs[id][str(idx)] = aid
