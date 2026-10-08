import { useEffect, useRef, useState } from "react";
import {
  type Project,
  type Shape,
  type LayerState,
  type Point,
  uid,
  stateAt,
  sourceToView,
  viewToSource,
  type Viewport,
  editLayer,
} from "./domain";
import { flatten, linearComposite } from "./mask";
import { LocalMedia } from "./media";
import * as storage from "./storage";
import * as api from "./api";

export type Tool =
  | "rectangle"
  | "ellipse"
  | "polygon"
  | "pen"
  | "lasso"
  | "brush"
  | "erase"
  | "transform"
  | "move"
  | "select";
export type Mode =
  "overlay" | "original" | "matte" | "checkerboard" | "light" | "dark";
type Props = {
  project: Project;
  frame: number;
  active: string;
  tool: Tool;
  mode: Mode;
  media?: LocalMedia;
  proxy?: string;
  brush: { radius: number; softness: number; strength: number };
  operation: Shape["op"];
  overlay: { color: string; opacity: number };
  onCommit: (p: Project) => void;
  onPrompt: (x: number, y: number, label: 0 | 1) => void;
  negative: boolean;
  onError: (s: string) => void;
  onReady: (frame: number) => void;
  zoom: number;
  setZoom: (n: number) => void;
  finishRef: React.RefObject<(() => void) | null>;
  cancelRef: React.RefObject<(() => void) | null>;
};
function localPoint(
  x: number,
  y: number,
  s: LayerState,
  sw: number,
  sh: number,
): [number, number] {
  const dx = (x - 0.5 - s.x) * sw,
    dy = (y - 0.5 - s.y) * sh,
    a = (s.rotation * Math.PI) / 180;
  return [
    (Math.cos(a) * dx + Math.sin(a) * dy) / (s.sx * sw) + 0.5,
    (-Math.sin(a) * dx + Math.cos(a) * dy) / (s.sy * sh) + 0.5,
  ];
}
function transformed(
  p: Point,
  s: LayerState,
  sw: number,
  sh: number,
): [number, number] {
  const dx = (p.x - 0.5) * s.sx * sw,
    dy = (p.y - 0.5) * s.sy * sh,
    a = (s.rotation * Math.PI) / 180;
  return [
    (Math.cos(a) * dx - Math.sin(a) * dy) / sw + 0.5 + s.x,
    (Math.sin(a) * dx + Math.cos(a) * dy) / sh + 0.5 + s.y,
  ];
}
export function CanvasEditor(props: Props) {
  const canvas = useRef<HTMLCanvasElement>(null),
    worker = useRef<Worker | null>(null),
    serial = useRef(0),
    latest = useRef(props),
    pointers = useRef(new Map<number, [number, number]>()),
    gesture = useRef<any>(null),
    image = useRef<HTMLCanvasElement | null>(null),
    alpha = useRef<Float32Array | null>(null),
    ready = useRef(-1),
    jobBusy = useRef(false),
    next = useRef<any>(null),
    sourceRequest = useRef(0),
    paintRef = useRef<() => void>(() => {});
  const [size, setSize] = useState({ width: 600, height: 430 }),
    [pan, setPan] = useState<[number, number]>([0, 0]),
    [draft, setDraft] = useState<Shape | null>(null),
    [cursor, setCursor] = useState<[number, number] | null>(null),
    [preview, setPreview] = useState<Project | null>(null),
    [loading, setLoading] = useState(false);
  latest.current = props;
  const source = props.project.source,
    layer = props.project.layers.find((l) => l.id === props.active),
    state = layer ? stateAt(layer, props.frame) : null;
  const v: Viewport = {
    ...size,
    sourceWidth: source?.width ?? 1,
    sourceHeight: source?.height ?? 1,
    zoom: props.zoom,
    panX: pan[0],
    panY: pan[1],
  };
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ width: r.width, height: r.height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  useEffect(() => {
    worker.current = new Worker(new URL("./mask.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current.onmessage = (e) => {
      jobBusy.current = false;
      if (e.data.id === serial.current) {
        if (e.data.error) latest.current.onError(e.data.error);
        else {
          alpha.current = e.data.alpha;
          paintRef.current();
        }
      }
      if (next.current) {
        const n = next.current;
        next.current = null;
        jobBusy.current = true;
        worker.current?.postMessage(n);
      }
    };
    return () => worker.current?.terminate();
  }, []);
  useEffect(() => {
    const media = props.media,
      proxy = props.proxy,
      index = props.frame,
      id = ++sourceRequest.current;
    let canceled = false;
    const controller = new AbortController();
    ready.current = -1;
    serial.current++;
    next.current = null;
    setLoading(true);
    async function get() {
      if (!source || (!media && !proxy)) {
        setLoading(false);
        return;
      }
      try {
        const result = media
          ? await media.frame(index, controller.signal)
          : await api.exactFrame(proxy!, index, controller.signal);
        if (canceled || id !== sourceRequest.current) {
          if (result instanceof ImageBitmap) result.close();
          return;
        }
        const c = document.createElement("canvas"),
          scale = Math.min(1, 480 / source.width);
        c.width = Math.round(source.width * scale);
        c.height = Math.round(source.height * scale);
        c.getContext("2d")!.drawImage(result, 0, 0, c.width, c.height);
        if (result instanceof ImageBitmap) result.close();
        image.current = c;
        alpha.current = null;
        ready.current = index;
        setLoading(false);
        props.onReady(index);
        paintRef.current();
        await requestMask();
      } catch (e) {
        if (!canceled) {
          setLoading(false);
          props.onError(String(e));
        }
      }
    }
    void get();
    return () => {
      canceled = true;
      controller.abort();
    };
  }, [props.frame, props.media, props.proxy, source?.id]);
  async function requestMask() {
    const current = latest.current,
      c = image.current;
    if (!c || ready.current !== current.frame) return;
    const id = ++serial.current,
      models: Record<string, Uint8Array> = {};
    for (const l of current.project.layers) {
      const aid = l.model?.frames[String(current.frame)];
      if (!aid) continue;
      try {
        let blob = await storage.getAsset(aid);
        if (!blob) {
          blob = await api.asset(aid);
          await storage.putAsset(aid, blob);
        }
        const bitmap = await createImageBitmap(blob),
          temp = document.createElement("canvas");
        temp.width = c.width;
        temp.height = c.height;
        const ctx = temp.getContext("2d")!;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bitmap, 0, 0, c.width, c.height);
        bitmap.close();
        const pixels = ctx.getImageData(0, 0, c.width, c.height).data,
          mask = new Uint8Array(c.width * c.height);
        for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4];
        models[l.id] = mask;
      } catch (e) {
        current.onError(String(e));
        return;
      }
    }
    if (id !== serial.current) return;
    let project = preview ?? current.project;
    if (draft && current.tool !== "polygon" && current.tool !== "pen")
      project = editLayer(project, current.active, current.frame, (s) =>
        s.shapes.push(draft),
      );
    const message = {
      id,
      project,
      frame: current.frame,
      width: c.width,
      height: c.height,
      models,
    };
    if (jobBusy.current) next.current = message;
    else {
      jobBusy.current = true;
      worker.current?.postMessage(message);
    }
  }
  useEffect(() => {
    void requestMask();
  }, [props.project, props.frame, draft, preview]);
  function paint() {
    const el = canvas.current,
      c = image.current,
      p = latest.current;
    if (!el) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    el.width = Math.round(size.width * dpr);
    el.height = Math.round(size.height * dpr);
    const ctx = el.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#090d12";
    ctx.fillRect(0, 0, size.width, size.height);
    if (!c || !source || ready.current !== p.frame) return;
    const layer = (preview ?? p.project).layers.find((l) => l.id === p.active),
      state = layer ? stateAt(layer, p.frame) : null;
    const temp = document.createElement("canvas");
    temp.width = c.width;
    temp.height = c.height;
    const tctx = temp.getContext("2d")!;
    tctx.drawImage(c, 0, 0);
    const data = tctx.getImageData(0, 0, c.width, c.height),
      a = alpha.current;
    if (a && a.length === c.width * c.height) {
      const overlay = [1, 3, 5].map((i) =>
        parseInt(p.overlay.color.slice(i, i + 2), 16),
      );
      const bg = [1, 3, 5].map((i) =>
        parseInt(p.project.background.slice(i, i + 2), 16),
      );
      for (let i = 0; i < a.length; i++) {
        const x = i % c.width,
          y = Math.floor(i / c.width),
          b = (Math.floor(x / 12) + Math.floor(y / 12)) % 2 ? 68 : 100;
        for (let ch = 0; ch < 3; ch++) {
          const fg = data.data[i * 4 + ch];
          data.data[i * 4 + ch] =
            p.mode === "matte"
              ? Math.round(a[i] * 255)
              : p.mode === "overlay"
                ? Math.round(
                    fg * (1 - a[i] * p.overlay.opacity) +
                      overlay[ch] * a[i] * p.overlay.opacity,
                  )
                : p.mode === "original"
                  ? fg
                  : Math.round(
                      linearComposite(
                        fg / 255,
                        (p.mode === "checkerboard"
                          ? b
                          : p.mode === "light"
                            ? 242
                            : p.mode === "dark"
                              ? 24
                              : bg[ch]) / 255,
                        a[i],
                      ) * 255,
                    );
        }
      }
      tctx.putImageData(data, 0, 0);
    }
    const [left, top] = sourceToView(0, 0, v),
      [right, bottom] = sourceToView(1, 1, v);
    ctx.drawImage(temp, left, top, right - left, bottom - top);
    if (state && p.mode !== "original") {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#a7f3b6";
      for (const shape of state.shapes) {
        const pts =
          shape.kind === "rectangle" || shape.kind === "ellipse"
            ? shape.points
            : flatten(shape).map(([x, y], i) => ({ id: String(i), x, y }));
        ctx.beginPath();
        if (
          (shape.kind === "rectangle" || shape.kind === "ellipse") &&
          pts.length === 2
        ) {
          const [a, b] = pts;
          const poly =
            shape.kind === "rectangle"
              ? [
                  [a.x, a.y],
                  [b.x, a.y],
                  [b.x, b.y],
                  [a.x, b.y],
                ]
              : Array.from({ length: 48 }, (_, i) => [
                  (a.x + b.x) / 2 +
                    (Math.cos((i / 48) * Math.PI * 2) * Math.abs(b.x - a.x)) /
                      2,
                  (a.y + b.y) / 2 +
                    (Math.sin((i / 48) * Math.PI * 2) * Math.abs(b.y - a.y)) /
                      2,
                ]);
          poly.forEach(([x, y], i) => {
            const [xx, yy] = transformed(
                { id: "", x, y },
                state,
                source.width,
                source.height,
              ),
              [vx, vy] = sourceToView(xx, yy, v);
            i ? ctx.lineTo(vx, vy) : ctx.moveTo(vx, vy);
          });
          ctx.closePath();
        } else
          pts.forEach((point, i) => {
            const [x, y] = transformed(
                point,
                state,
                source.width,
                source.height,
              ),
              [vx, vy] = sourceToView(x, y, v);
            i ? ctx.lineTo(vx, vy) : ctx.moveTo(vx, vy);
          });
        if (shape.kind !== "brush") ctx.closePath();
        ctx.stroke();
        if (p.tool === "transform")
          for (const point of shape.points) {
            const [x, y] = transformed(
                point,
                state,
                source.width,
                source.height,
              ),
              [vx, vy] = sourceToView(x, y, v);
            ctx.fillStyle = "#a7f3b6";
            ctx.fillRect(vx - 5, vy - 5, 10, 10);
            for (const handle of [point.in, point.out])
              if (handle) {
                const [hx, hy] = transformed(
                    { id: "", x: handle[0], y: handle[1] },
                    state,
                    source.width,
                    source.height,
                  ),
                  [xx, yy] = sourceToView(hx, hy, v);
                ctx.beginPath();
                ctx.moveTo(vx, vy);
                ctx.lineTo(xx, yy);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(xx, yy, 4, 0, Math.PI * 2);
                ctx.fill();
              }
          }
      }
    }
    if (draft) {
      ctx.beginPath();
      ctx.strokeStyle = "#fff";
      draft.points.forEach((p, i) => {
        const [x, y] = sourceToView(p.x, p.y, v);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
    for (const prompt of layer?.prompts ?? [])
      if (prompt.frame === p.frame)
        for (const point of prompt.points) {
          const [x, y] = sourceToView(point.x, point.y, v);
          ctx.fillStyle = point.label ? "#a7f3b6" : "#ff8585";
          ctx.beginPath();
          ctx.arc(x, y, 8, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#111";
          ctx.font = "bold 14px sans-serif";
          ctx.fillText(point.label ? "+" : "−", x - 4, y + 5);
        }
    if (cursor && (p.tool === "brush" || p.tool === "erase")) {
      const radius = (p.brush.radius / source.width) * (right - left);
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.arc(cursor[0], cursor[1], radius, 0, Math.PI * 2);
      ctx.stroke();
      const [sx, sy] = viewToSource(cursor[0], cursor[1], v),
        mx = Math.min(size.width - 44, cursor[0] + 65),
        my = Math.max(44, cursor[1] - 65);
      ctx.save();
      ctx.beginPath();
      ctx.arc(mx, my, 36, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(
        temp,
        sx * c.width - 12,
        sy * c.height - 12,
        24,
        24,
        mx - 36,
        my - 36,
        72,
        72,
      );
      ctx.restore();
      ctx.beginPath();
      ctx.arc(mx, my, 36, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  paintRef.current = paint;
  useEffect(
    () => paint(),
    [
      size,
      pan,
      props.zoom,
      props.mode,
      props.overlay,
      cursor,
      props.tool,
      draft,
      props.project,
    ],
  );
  function commitShape(shape: Shape) {
    if (!layer || layer.locked) return;
    props.onCommit(
      editLayer(props.project, props.active, props.frame, (s) =>
        s.shapes.push(shape),
      ),
    );
    setDraft(null);
    setPreview(null);
  }
  function finish() {
    if (draft && draft.points.length >= 3) commitShape(draft);
    else if (draft)
      props.onError("A closed path needs at least three anchors.");
  }
  props.finishRef.current = finish;
  props.cancelRef.current = () => {
    gesture.current = null;
    setDraft(null);
    setPreview(null);
  };
  useEffect(() => {
    gesture.current = null;
    setDraft(null);
    setPreview(null);
  }, [props.tool, props.frame, props.active]);
  function point(e: React.PointerEvent) {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as [number, number];
  }
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    const pt = point(e);
    pointers.current.set(e.pointerId, pt);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointers.current.size === 2) {
      gesture.current = null;
      setDraft(null);
      setPreview(null);
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        type: "pinch",
        distance: Math.hypot(a[0] - b[0], a[1] - b[1]),
        zoom: props.zoom,
        pan,
        center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      };
      return;
    }
    if (pointers.current.size !== 1) return;
    if (props.tool === "move") {
      gesture.current = { type: "pan", start: pt, pan };
      return;
    }
    if (!source || ready.current !== props.frame || !layer || layer.locked)
      return;
    let [x, y] = viewToSource(pt[0], pt[1], v);
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    if (props.tool === "select") {
      props.onPrompt(x, y, props.negative ? 0 : 1);
      return;
    }
    if (props.tool === "transform" && state) {
      let hit: any;
      for (const shape of state.shapes)
        for (const p of shape.points)
          for (const handle of ["point", "in", "out"]) {
            const hp =
              handle === "point" ? [p.x, p.y] : p[handle as "in" | "out"];
            if (!hp) continue;
            const [tx, ty] = transformed(
                { id: "", x: hp[0], y: hp[1] },
                state,
                source.width,
                source.height,
              ),
              q = sourceToView(tx, ty, v);
            if (Math.hypot(pt[0] - q[0], pt[1] - q[1]) < 22)
              hit = { shape: shape.id, point: p.id, handle };
          }
      gesture.current = {
        type: "transform",
        start: [x, y],
        state: structuredClone(state),
        hit,
      };
      return;
    }
    if (state) [x, y] = localPoint(x, y, state, source!.width, source!.height);
    const shape: Shape =
      draft && (props.tool === "pen" || props.tool === "polygon")
        ? structuredClone(draft)
        : {
            id: uid(),
            kind:
              props.tool === "erase" ? "brush" : (props.tool as Shape["kind"]),
            op: props.tool === "erase" ? "subtract" : props.operation,
            points: [],
            ...props.brush,
          };
    const anchor: Point = { id: uid(), x, y };
    shape.points.push(anchor);
    if (props.tool === "rectangle" || props.tool === "ellipse")
      shape.points.push({ ...anchor, id: uid() });
    setDraft(shape);
    gesture.current = { type: "draw", shape, start: [x, y] };
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    const pt = point(e);
    setCursor(pt);
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, pt);
    const g = gesture.current;
    if (!g) return;
    if (g.type === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const nextZoom = Math.max(
        0.5,
        Math.min(
          8,
          (g.zoom * Math.hypot(a[0] - b[0], a[1] - b[1])) / g.distance,
        ),
      );
      props.setZoom(nextZoom);
      const ratio = nextZoom / g.zoom;
      setPan([
        (a[0] + b[0]) / 2 -
          size.width / 2 -
          (g.center[0] - size.width / 2 - g.pan[0]) * ratio,
        (a[1] + b[1]) / 2 -
          size.height / 2 -
          (g.center[1] - size.height / 2 - g.pan[1]) * ratio,
      ]);
      return;
    }
    if (g.type === "pan") {
      setPan([g.pan[0] + pt[0] - g.start[0], g.pan[1] + pt[1] - g.start[1]]);
      return;
    }
    let [x, y] = viewToSource(pt[0], pt[1], v);
    if (g.type === "transform") {
      const p = editLayer(props.project, props.active, props.frame, (s) => {
        Object.assign(s, structuredClone(g.state));
        if (g.hit) {
          const shape = s.shapes.find((z) => z.id === g.hit.shape),
            p = shape?.points.find((z) => z.id === g.hit.point);
          if (p) {
            const q = localPoint(x, y, s, source!.width, source!.height);
            if (g.hit.handle === "point") {
              const dx = q[0] - p.x,
                dy = q[1] - p.y;
              p.x = q[0];
              p.y = q[1];
              if (p.in) p.in = [p.in[0] + dx, p.in[1] + dy];
              if (p.out) p.out = [p.out[0] + dx, p.out[1] + dy];
            } else p[g.hit.handle as "in" | "out"] = q;
          }
        } else {
          s.x = g.state.x + x - g.start[0];
          s.y = g.state.y + y - g.start[1];
        }
      });
      setPreview(p);
      g.project = p;
      return;
    }
    if (state) [x, y] = localPoint(x, y, state, source!.width, source!.height);
    const shape: Shape = g.shape;
    if (props.tool === "rectangle" || props.tool === "ellipse")
      Object.assign(shape.points[1], { x, y });
    else if (props.tool === "pen") {
      const p = shape.points[shape.points.length - 1];
      p.out = [x, y];
      p.in = [2 * p.x - x, 2 * p.y - y];
    } else if (props.tool !== "polygon") {
      const prev = shape.points[shape.points.length - 1];
      if (
        shape.points.length < 2048 &&
        Math.hypot(
          (x - prev.x) * source!.width,
          (y - prev.y) * source!.height,
        ) > 2
      )
        shape.points.push({ id: uid(), x, y });
    }
    setDraft(structuredClone(shape));
  }
  function up(e: React.PointerEvent<HTMLCanvasElement>, canceled = false) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.type === "pinch") {
      if (!pointers.current.size) gesture.current = null;
      return;
    }
    gesture.current = null;
    if (canceled) {
      setDraft(null);
      setPreview(null);
      return;
    }
    if (g.type === "transform" && g.project) {
      props.onCommit(g.project);
      setPreview(null);
    }
    if (g.type === "draw" && props.tool !== "polygon" && props.tool !== "pen") {
      const shape: Shape = g.shape;
      if (
        (shape.kind === "rectangle" || shape.kind === "ellipse") &&
        Math.hypot(
          shape.points[1].x - shape.points[0].x,
          shape.points[1].y - shape.points[0].y,
        ) < 0.005
      ) {
        setDraft(null);
        return;
      }
      if (shape.kind === "lasso" && shape.points.length < 3) {
        setDraft(null);
        return;
      }
      commitShape(shape);
    }
  }
  return (
    <div className="canvas-wrap">
      <canvas
        ref={canvas}
        aria-label="Video masking canvas"
        tabIndex={0}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={(e) => up(e)}
        onPointerCancel={(e) => up(e, true)}
        onLostPointerCapture={(e) => {
          if (pointers.current.has(e.pointerId)) up(e, true);
        }}
        onPointerLeave={() => setCursor(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish();
          if (e.key === "Escape") props.cancelRef.current?.();
        }}
      />
      {loading && <div className="frame-status">Decoding exact frame…</div>}
      {!source && (
        <div className="canvas-empty">
          <span className="empty-symbol">◌</span>
          <strong>Your subject. Your frame.</strong>
          <span>Import a short clip to start masking.</span>
        </div>
      )}
      <div className="viewport-controls">
        <button
          onClick={() => props.setZoom(Math.max(0.5, props.zoom - 0.25))}
          aria-label="Zoom out"
        >
          −
        </button>
        <span>{Math.round(props.zoom * 100)}%</span>
        <button
          onClick={() => props.setZoom(Math.min(8, props.zoom + 0.25))}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          onClick={() => {
            props.setZoom(1);
            setPan([0, 0]);
          }}
        >
          Fit
        </button>
      </div>
    </div>
  );
}
