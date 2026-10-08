import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  History,
  newProject,
  newLayer,
  emptyState,
  stateAt,
  viewToSource,
  sourceToView,
  editLayer,
  compatibleResult,
  type Project,
  type Shape,
} from "../frontend/src/domain";
import { combine, evaluate, linearComposite } from "../frontend/src/mask";
import { validateProject } from "../frontend/src/validation";
function fixture(): Project {
  const p = newProject();
  p.source = {
    id: "source",
    name: "fixture",
    size: 1,
    fingerprint: "a".repeat(64),
    width: 32,
    height: 24,
    duration: 1,
    fps: 30,
    frames: Array.from({ length: 30 }, (_, index) => ({
      index,
      timestamp: index / 30,
      sourceTimestamp: index / 30,
      sourcePts: index,
      timeBase: "1/30",
    })),
  };
  p.outFrame = 29;
  return p;
}
const shape: Shape = {
  id: "rect",
  kind: "rectangle",
  op: "add",
  radius: 5,
  softness: 0.4,
  strength: 0.7,
  points: [
    { id: "a", x: 0.25, y: 0.25 },
    { id: "b", x: 0.75, y: 0.75 },
  ],
};
describe("mask arithmetic and frame state", () => {
  it("defines soft operations independently", () => {
    expect(combine(0.25, 0.6, "add")).toBe(0.6);
    expect(combine(0.25, 0.6, "subtract")).toBeCloseTo(0.1);
    expect(combine(0.25, 0.6, "intersect")).toBeCloseTo(0.15);
    expect(combine(0.25, 0.6, "replace")).toBe(0.6);
  });
  it("maps letterboxing, pan and zoom without DPR assumptions", () => {
    const v = {
      width: 400,
      height: 700,
      sourceWidth: 1920,
      sourceHeight: 1080,
      zoom: 2.25,
      panX: -83,
      panY: 37,
    };
    for (const [x, y] of [
      [0, 0],
      [1, 1],
      [0.13, 0.78],
    ]) {
      const q = sourceToView(x, y, v);
      expect(viewToSource(...q, v)[0]).toBeCloseTo(x, 10);
      expect(viewToSource(...q, v)[1]).toBeCloseTo(y, 10);
    }
    expect(
      viewToSource(0, 0, { ...v, zoom: 1, panX: 0, panY: 0 })[1],
    ).toBeLessThan(0);
  });
  it("preserves exact keys, interpolates matching anchors and holds changed topology", () => {
    const l = newLayer(),
      a = emptyState(),
      b = emptyState();
    a.shapes = [structuredClone(shape)];
    b.shapes = [structuredClone(shape)];
    b.x = 1;
    b.shapes[0].points[0].x = 0.75;
    l.keys = [
      { frame: 0, state: a, interpolation: "linear" },
      { frame: 10, state: b, interpolation: "linear" },
    ];
    expect(stateAt(l, 5).x).toBe(0.5);
    expect(stateAt(l, 5).shapes[0].points[0].x).toBe(0.5);
    expect(stateAt(l, 0)).toEqual(a);
    expect(stateAt(l, 10)).toEqual(b);
    b.shapes[0].points[0].id = "different";
    expect(stateAt(l, 5).shapes[0].points[0].x).toBe(0.25);
  });
  it("uses one reversible history entry per command and increasing revisions", () => {
    const p = fixture(),
      h = new History(p),
      n = editLayer(p, p.layers[0].id, 5, (s) => s.shapes.push(shape));
    h.commit(n);
    expect(h.past).toHaveLength(1);
    expect(h.current.revision).toBe(1);
    h.undo();
    expect(h.current.layers[0].keys).toHaveLength(1);
    expect(h.current.revision).toBe(2);
    h.redo();
    expect(h.current.layers[0].keys).toHaveLength(2);
    expect(h.current.revision).toBe(3);
    expect(
      compatibleResult(h.current, { revision: 1, sourceId: "source" }),
    ).toBe(false);
  });
  it("rasterizes known rectangle centers, holes, hidden masks and opacity", () => {
    const p = fixture();
    p.layers[0].keys[0].state.shapes = [shape];
    let a = evaluate(p, 0, 32, 24);
    expect(a.reduce((x, y) => x + y, 0)).toBe(16 * 12);
    expect(a[12 * 32 + 16]).toBe(1);
    p.layers[0].keys[0].state.shapes.push({
      ...shape,
      id: "hole",
      op: "subtract",
      points: [
        { id: "h1", x: 0.4, y: 0.4 },
        { id: "h2", x: 0.6, y: 0.6 },
      ],
    });
    a = evaluate(p, 0, 32, 24);
    expect(a[12 * 32 + 16]).toBe(0);
    p.layers[0].visible = false;
    expect(evaluate(p, 0, 32, 24).every((v) => v === 0)).toBe(true);
  });
  it("composites in linear light without multiplying straight alpha twice", () => {
    expect(linearComposite(1, 0, 0.5)).toBeCloseTo(0.73535698, 6);
    expect(linearComposite(0.7, 0.2, 1)).toBeCloseTo(0.7, 10);
  });
  it("rotates in source pixels rather than distorting a nonsquare image", () => {
    const p = fixture();
    p.layers[0].keys[0].state.shapes = [shape];
    p.layers[0].keys[0].state.rotation = 90;
    const a = evaluate(p, 0, 32, 24);
    expect(a.reduce((x, y) => x + y, 0)).toBe(192);
    expect(a[12 * 32 + 8]).toBe(0);
    expect(a[5 * 32 + 16]).toBe(1);
  });
  it("rejects invalid backup schemas, frame maps and nonfinite geometry", () => {
    const p = fixture();
    expect(validateProject(p).id).toBe(p.id);
    expect(() => validateProject({ ...p, schema: 99 })).toThrow();
    p.source!.frames[4].index = 99;
    expect(() => validateProject(p)).toThrow();
  });
  it("agrees with the independent NumPy evaluator for paths, strokes and edges", () => {
    const p = fixture();
    const s = p.layers[0].keys[0].state;
    s.shapes = [
      shape,
      {
        ...shape,
        id: "ellipse",
        kind: "ellipse",
        op: "subtract",
        points: [
          { id: "c", x: 0.35, y: 0.4 },
          { id: "d", x: 0.65, y: 0.7 },
        ],
      },
      {
        ...shape,
        id: "path",
        kind: "pen",
        points: [
          { id: "e", x: 0.1, y: 0.1, out: [0.3, 0.05] },
          { id: "f", x: 0.8, y: 0.1, in: [0.6, 0.1], out: [0.8, 0.4] },
          { id: "g", x: 0.8, y: 0.8 },
          { id: "h", x: 0.1, y: 0.8 },
        ],
      },
      {
        ...shape,
        id: "paint",
        kind: "brush",
        op: "subtract",
        points: [
          { id: "i", x: 0.3, y: 0.2 },
          { id: "j", x: 0.7, y: 0.7 },
        ],
      },
    ];
    s.rotation = 13;
    s.x = 0.02;
    s.feather = 1.2;
    s.expansion = -1;
    s.opacity = 0.73;
    const py = JSON.parse(
      execFileSync(
        process.env.ROTOTOOLS_PYTHON ?? "python",
        [
          "-c",
          "import json,sys;from server.masks import evaluate;p=json.load(sys.stdin);print(json.dumps(evaluate(p,0,32,24).reshape(-1).tolist()))",
        ],
        { input: JSON.stringify(p), encoding: "utf8" },
      ),
    );
    const js = evaluate(p, 0, 32, 24);
    expect(Math.max(...js.map((n, i) => Math.abs(n - py[i])))).toBeLessThan(
      2e-6,
    );
  });
});
