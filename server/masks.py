"""Pixel-center mask evaluator matching frontend/src/mask.ts."""

import copy
import math
import numpy as np
from scipy.ndimage import maximum_filter, minimum_filter, convolve1d


def combine(a, b, op):
    if op == "replace":
        return b
    if op == "subtract":
        return a * (1 - b)
    if op == "intersect":
        return a * b
    return np.maximum(a, b)


def state_at(layer, frame):
    keys = sorted(layer["keys"], key=lambda k: k["frame"])
    left = next((k for k in reversed(keys) if k["frame"] <= frame), keys[0])
    right = next((k for k in keys if k["frame"] > frame), None)
    state = copy.deepcopy(left["state"])
    if right is None or left["interpolation"] == "hold" or frame <= left["frame"]:
        return state
    t = (frame - left["frame"]) / (right["frame"] - left["frame"])
    for prop in ("x", "y", "sx", "sy", "rotation", "opacity", "feather", "expansion"):
        state[prop] += (right["state"][prop] - state[prop]) * t
    for s in state["shapes"]:
        r = next((r for r in right["state"]["shapes"] if r["id"] == s["id"]), None)
        if (
            not r
            or s["kind"] == "brush"
            or r["kind"] != s["kind"]
            or [p["id"] for p in s["points"]] != [p["id"] for p in r["points"]]
        ):
            continue
        for p, q in zip(s["points"], r["points"]):
            for axis in ("x", "y"):
                p[axis] += (q[axis] - p[axis]) * t
            for handle in ("in", "out"):
                if p.get(handle) and q.get(handle):
                    p[handle] = [a + (b - a) * t for a, b in zip(p[handle], q[handle])]
    return state


def flatten(shape):
    pts = shape["points"]
    if shape["kind"] != "pen":
        return [(p["x"], p["y"]) for p in pts]
    out = []
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        c = a.get("out") or [a["x"], a["y"]]
        d = b.get("in") or [b["x"], b["y"]]
        for j in range(16):
            t = j / 16
            u = 1 - t
            out.append(
                (
                    u**3 * a["x"]
                    + 3 * u * u * t * c[0]
                    + 3 * u * t * t * d[0]
                    + t**3 * b["x"],
                    u**3 * a["y"]
                    + 3 * u * u * t * c[1]
                    + 3 * u * t * t * d[1]
                    + t**3 * b["y"],
                )
            )
    return out


def shape_mask(shape, x, y, sw, sh):
    pts = flatten(shape)
    kind = shape["kind"]
    if not pts:
        return np.zeros_like(x)
    if kind in ("rectangle", "ellipse"):
        if len(pts) < 2:
            return np.zeros_like(x)
        a, b = pts[:2]
        cx = (a[0] + b[0]) / 2
        cy = (a[1] + b[1]) / 2
        rx = abs(b[0] - a[0]) / 2
        ry = abs(b[1] - a[1]) / 2
        if not rx or not ry:
            return np.zeros_like(x)
        if kind == "ellipse":
            return (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1).astype(np.float32)
        return ((np.abs(x - cx) <= rx) & (np.abs(y - cy) <= ry)).astype(np.float32)
    if kind == "brush":
        xx = x * sw
        yy = y * sh
        dist = np.full_like(x, np.inf)
        for i, b in enumerate(pts):
            a = pts[max(0, i - 1)]
            ax = a[0] * sw
            ay = a[1] * sh
            dx = (b[0] - a[0]) * sw
            dy = (b[1] - a[1]) * sh
            t = np.clip(
                ((xx - ax) * dx + (yy - ay) * dy) / (dx * dx + dy * dy or 1), 0, 1
            )
            dist = np.minimum(dist, np.hypot(xx - ax - t * dx, yy - ay - t * dy))
        return (
            np.clip(
                (1 - dist / max(0.001, shape["radius"]))
                / max(0.0001, shape["softness"]),
                0,
                1,
            )
            * shape["strength"]
        )
    yes = np.zeros_like(x, dtype=bool)
    for i, a in enumerate(pts):
        b = pts[i - 1]
        if b[1] == a[1]:
            continue
        yes ^= ((a[1] > y) != (b[1] > y)) & (
            x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]
        )
    return yes.astype(np.float32)


def evaluate(project, frame, w, h, models=None):
    result = np.zeros((h, w), dtype=np.float32)
    sw = project["source"]["width"]
    sh = project["source"]["height"]
    xx, yy = np.meshgrid((np.arange(w) + 0.5) / w, (np.arange(h) + 0.5) / h)
    for layer in project["layers"]:
        if not layer["visible"]:
            continue
        s = state_at(layer, frame)
        angle = s["rotation"] * math.pi / 180
        cos = math.cos(angle)
        sin = math.sin(angle)
        dx = (xx - 0.5 - s["x"]) * sw
        dy = (yy - 0.5 - s["y"]) * sh
        x = (cos * dx + sin * dy) / (s["sx"] * sw) + 0.5
        y = (-sin * dx + cos * dy) / (s["sy"] * sh) + 0.5
        alpha = (
            np.asarray(
                (models or {}).get(layer["id"], np.zeros((h, w))), dtype=np.float32
            )
            / 255
        )
        for shape in s["shapes"]:
            alpha = combine(alpha, shape_mask(shape, x, y, sw, sh), shape["op"])
        scale = w / sw
        r = math.floor(abs(s["expansion"]) * scale + 0.5)
        if r:
            alpha = (maximum_filter if s["expansion"] > 0 else minimum_filter)(
                alpha, size=2 * r + 1, mode="constant", cval=0
            )
        sigma = s["feather"] * scale
        if sigma >= 0.01:
            radius = math.ceil(3 * sigma)
            kernel = np.exp(
                -(np.arange(-radius, radius + 1) ** 2) / (2 * sigma * sigma)
            )
            kernel /= kernel.sum()
            alpha = convolve1d(
                convolve1d(alpha, kernel, axis=1, mode="constant"),
                kernel,
                axis=0,
                mode="constant",
            )
        if s["invert"]:
            alpha = 1 - alpha
        result = combine(result, alpha * s["opacity"], layer["op"])
    return np.clip(result, 0, 1)


def composite(rgb, alpha, background):
    fg = rgb.astype(np.float32) / 255
    bg = np.array(background, dtype=np.float32) / 255
    linear = lambda v: np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
    c = linear(fg) * alpha[..., None] + linear(bg) * (1 - alpha[..., None])
    c = np.where(
        c <= 0.0031308, 12.92 * c, 1.055 * np.maximum(c, 0) ** (1 / 2.4) - 0.055
    )
    return np.clip(np.floor(c * 255 + 0.5), 0, 255).astype(np.uint8)
