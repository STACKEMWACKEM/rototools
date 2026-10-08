export type Operation = "add" | "subtract" | "intersect" | "replace";
export type Point = {
  id: string;
  x: number;
  y: number;
  in?: [number, number];
  out?: [number, number];
};
export type Shape = {
  id: string;
  kind: "rectangle" | "ellipse" | "polygon" | "pen" | "lasso" | "brush";
  op: Operation;
  points: Point[];
  radius: number;
  softness: number;
  strength: number;
};
export type LayerState = {
  shapes: Shape[];
  x: number;
  y: number;
  sx: number;
  sy: number;
  rotation: number;
  opacity: number;
  feather: number;
  expansion: number;
  invert: boolean;
};
export type Keyframe = {
  frame: number;
  interpolation: "hold" | "linear";
  state: LayerState;
};
export type Prompt = {
  frame: number;
  points: { x: number; y: number; label: 0 | 1 }[];
  box?: [number, number, number, number];
};
export type Layer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  op: Operation;
  keys: Keyframe[];
  protected: number[];
  prompts: Prompt[];
  model?: {
    revision: number;
    provider: string;
    checkpoint: string;
    frames: Record<string, string>;
  };
};
export type Frame = {
  index: number;
  timestamp: number;
  sourceTimestamp: number;
  sourcePts: number;
  timeBase: string;
};
export type Source = {
  id: string;
  name: string;
  fingerprint: string;
  size: number;
  width: number;
  height: number;
  duration: number;
  fps: number;
  frames: Frame[];
  serverAsset?: string;
  metadata?: Record<string, unknown>;
};
export type Project = {
  schema: 1;
  id: string;
  name: string;
  revision: number;
  created: number;
  updated: number;
  source?: Source;
  layers: Layer[];
  inFrame: number;
  outFrame: number;
  mute: boolean;
  background: string;
  serverProject?: string;
};
export const uid = () => crypto.randomUUID();
export const emptyState = (): LayerState => ({
  shapes: [],
  x: 0,
  y: 0,
  sx: 1,
  sy: 1,
  rotation: 0,
  opacity: 1,
  feather: 0,
  expansion: 0,
  invert: false,
});
export const newLayer = (name = "Mask 1"): Layer => ({
  id: uid(),
  name,
  visible: true,
  locked: false,
  op: "add",
  keys: [{ frame: 0, interpolation: "linear", state: emptyState() }],
  protected: [],
  prompts: [],
});
export const newProject = (): Project => ({
  schema: 1,
  id: uid(),
  name: "Untitled clip",
  revision: 0,
  created: Date.now(),
  updated: Date.now(),
  layers: [newLayer()],
  inFrame: 0,
  outFrame: 0,
  mute: false,
  background: "#18212d",
});
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function stateAt(layer: Layer, frame: number): LayerState {
  const keys = [...layer.keys].sort((a, b) => a.frame - b.frame);
  const left = [...keys].reverse().find((k) => k.frame <= frame) ?? keys[0];
  const right = keys.find((k) => k.frame > frame);
  if (!left) return emptyState();
  const state = structuredClone(left.state);
  if (!right || left.interpolation === "hold" || frame <= left.frame)
    return state;
  const t = (frame - left.frame) / (right.frame - left.frame);
  for (const key of [
    "x",
    "y",
    "sx",
    "sy",
    "rotation",
    "opacity",
    "feather",
    "expansion",
  ] as const)
    state[key] = lerp(state[key], right.state[key], t);
  state.shapes = state.shapes.map((s) => {
    const r = right.state.shapes.find((v) => v.id === s.id);
    if (
      !r ||
      s.kind === "brush" ||
      r.kind !== s.kind ||
      r.points.length !== s.points.length ||
      r.points.some((p, i) => p.id !== s.points[i].id)
    )
      return s;
    return {
      ...s,
      points: s.points.map((p, i) => {
        const q = r.points[i];
        return {
          ...p,
          x: lerp(p.x, q.x, t),
          y: lerp(p.y, q.y, t),
          in:
            p.in && q.in
              ? [lerp(p.in[0], q.in[0], t), lerp(p.in[1], q.in[1], t)]
              : p.in,
          out:
            p.out && q.out
              ? [lerp(p.out[0], q.out[0], t), lerp(p.out[1], q.out[1], t)]
              : p.out,
        };
      }),
    };
  });
  return state;
}
export function editLayer(
  project: Project,
  id: string,
  frame: number,
  edit: (s: LayerState) => void,
): Project {
  const p = structuredClone(project),
    layer = p.layers.find((l) => l.id === id);
  if (!layer || layer.locked) return project;
  const state = stateAt(layer, frame);
  edit(state);
  const key = layer.keys.find((k) => k.frame === frame);
  if (key) key.state = state;
  else layer.keys.push({ frame, state, interpolation: "linear" });
  layer.keys.sort((a, b) => a.frame - b.frame);
  return p;
}
export class History {
  past: Project[] = [];
  future: Project[] = [];
  constructor(public current: Project) {}
  commit(next: Project) {
    if (next === this.current) return this.current;
    this.past.push(this.current);
    if (this.past.length > 80) this.past.shift();
    this.future = [];
    return this.assign(next);
  }
  private assign(next: Project) {
    this.current = {
      ...structuredClone(next),
      revision: this.current.revision + 1,
      updated: Date.now(),
    };
    return this.current;
  }
  undo() {
    const p = this.past.pop();
    if (!p) return this.current;
    this.future.push(this.current);
    return this.assign(p);
  }
  redo() {
    const p = this.future.pop();
    if (!p) return this.current;
    this.past.push(this.current);
    return this.assign(p);
  }
}
export type Viewport = {
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  zoom: number;
  panX: number;
  panY: number;
};
export function sourceToView(
  x: number,
  y: number,
  v: Viewport,
): [number, number] {
  const s =
    Math.min(v.width / v.sourceWidth, v.height / v.sourceHeight) * v.zoom;
  return [
    (x - 0.5) * v.sourceWidth * s + v.width / 2 + v.panX,
    (y - 0.5) * v.sourceHeight * s + v.height / 2 + v.panY,
  ];
}
export function viewToSource(
  x: number,
  y: number,
  v: Viewport,
): [number, number] {
  const s =
    Math.min(v.width / v.sourceWidth, v.height / v.sourceHeight) * v.zoom;
  return [
    (x - v.width / 2 - v.panX) / (v.sourceWidth * s) + 0.5,
    (y - v.height / 2 - v.panY) / (v.sourceHeight * s) + 0.5,
  ];
}
export function compatibleResult(
  p: Project,
  input: { revision: number; sourceId: string },
) {
  return p.revision === input.revision && p.source?.id === input.sourceId;
}
