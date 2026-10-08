import { stateAt, type Project, type Shape, type Point } from "./domain";
export function combine(a: number, b: number, op: string) {
  return op === "replace"
    ? b
    : op === "subtract"
      ? a * (1 - b)
      : op === "intersect"
        ? a * b
        : Math.max(a, b);
}
export function flatten(shape: Shape): [number, number][] {
  const pts = shape.points;
  if (shape.kind !== "pen") return pts.map((p) => [p.x, p.y]);
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i],
      b = pts[(i + 1) % pts.length],
      c = a.out ?? [a.x, a.y],
      d = b.in ?? [b.x, b.y];
    for (let j = 0; j < 16; j++) {
      const t = j / 16,
        u = 1 - t;
      out.push([
        u ** 3 * a.x +
          3 * u * u * t * c[0] +
          3 * u * t * t * d[0] +
          t ** 3 * b.x,
        u ** 3 * a.y +
          3 * u * u * t * c[1] +
          3 * u * t * t * d[1] +
          t ** 3 * b.y,
      ]);
    }
  }
  return out;
}
function inside(x: number, y: number, pts: [number, number][]) {
  let yes = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i],
      b = pts[j];
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    )
      yes = !yes;
  }
  return yes ? 1 : 0;
}
function distance(
  x: number,
  y: number,
  a: [number, number],
  b: [number, number],
) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    t = Math.max(
      0,
      Math.min(
        1,
        ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1),
      ),
    );
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
export function coverage(
  s: Shape,
  x: number,
  y: number,
  sw: number,
  sh: number,
  pts = flatten(s),
) {
  if (!pts.length) return 0;
  if (s.kind === "rectangle" || s.kind === "ellipse") {
    if (pts.length < 2) return 0;
    const a = pts[0],
      b = pts[1],
      cx = (a[0] + b[0]) / 2,
      cy = (a[1] + b[1]) / 2,
      rx = Math.abs(b[0] - a[0]) / 2,
      ry = Math.abs(b[1] - a[1]) / 2;
    if (!rx || !ry) return 0;
    return s.kind === "ellipse"
      ? ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
        ? 1
        : 0
      : Math.abs(x - cx) <= rx && Math.abs(y - cy) <= ry
        ? 1
        : 0;
  }
  if (s.kind === "brush") {
    let d = Infinity;
    for (let i = 0; i < pts.length; i++)
      d = Math.min(
        d,
        distance(
          x * sw,
          y * sh,
          [pts[i][0] * sw, pts[i][1] * sh],
          [pts[Math.max(0, i - 1)][0] * sw, pts[Math.max(0, i - 1)][1] * sh],
        ),
      );
    const r = Math.max(0.001, s.radius),
      soft = Math.max(0.0001, s.softness);
    return Math.min(1, Math.max(0, (1 - d / r) / soft)) * s.strength;
  }
  return inside(x, y, pts);
}
function morphology(
  input: Float32Array,
  w: number,
  h: number,
  r: number,
  expand: boolean,
) {
  let a = input;
  for (const axis of [0, 1]) {
    const b = new Float32Array(a.length);
    const n = axis === 0 ? w : h,
      lines = axis === 0 ? h : w;
    for (let line = 0; line < lines; line++) {
      const deque: number[] = [];
      let head = 0;
      const val = (j: number) => a[axis === 0 ? line * w + j : j * w + line];
      for (let j = -r; j < n + r; j++) {
        if (j >= 0 && j < n) {
          while (
            deque.length > head &&
            (expand
              ? val(deque[deque.length - 1]) <= val(j)
              : val(deque[deque.length - 1]) >= val(j))
          )
            deque.pop();
          deque.push(j);
        }
        const k = j - r;
        if (k >= 0 && k < n) {
          while (head < deque.length && deque[head] < k - r) head++;
          let value = deque.length > head ? val(deque[head]) : 0;
          if (!expand && (k - r < 0 || k + r >= n)) value = 0;
          b[axis === 0 ? line * w + k : k * w + line] = value;
        }
      }
    }
    a = b;
  }
  return a;
}
function blur(input: Float32Array, w: number, h: number, sigma: number) {
  if (sigma < 0.01) return input;
  const r = Math.ceil(3 * sigma),
    kernel = Array.from({ length: 2 * r + 1 }, (_, i) =>
      Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)),
    ),
    sum = kernel.reduce((a, b) => a + b, 0);
  let a = input;
  for (const axis of [0, 1]) {
    const b = new Float32Array(a.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let z = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + (axis === 0 ? k : 0),
            yy = y + (axis === 1 ? k : 0);
          if (xx >= 0 && xx < w && yy >= 0 && yy < h)
            z += (a[yy * w + xx] * kernel[k + r]) / sum;
        }
        b[y * w + x] = z;
      }
    a = b;
  }
  return a;
}
export function evaluate(
  project: Project,
  frame: number,
  w: number,
  h: number,
  models: Record<string, Uint8Array> = {},
): Float32Array {
  const final = new Float32Array(w * h),
    sw = project.source?.width ?? w,
    sh = project.source?.height ?? h;
  for (const layer of project.layers) {
    if (!layer.visible) continue;
    const s = stateAt(layer, frame);
    let alpha: Float32Array = new Float32Array(w * h);
    const model = models[layer.id];
    if (model) for (let i = 0; i < alpha.length; i++) alpha[i] = model[i] / 255;
    const cos = Math.cos((s.rotation * Math.PI) / 180),
      sin = Math.sin((s.rotation * Math.PI) / 180),
      shapes = s.shapes.map((shape) => ({ shape, pts: flatten(shape) }));
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const dx = ((x + 0.5) / w - 0.5 - s.x) * sw,
          dy = ((y + 0.5) / h - 0.5 - s.y) * sh,
          xx = (cos * dx + sin * dy) / (s.sx * sw) + 0.5,
          yy = (-sin * dx + cos * dy) / (s.sy * sh) + 0.5,
          i = y * w + x;
        for (const { shape, pts } of shapes)
          alpha[i] = combine(
            alpha[i],
            coverage(shape, xx, yy, sw, sh, pts),
            shape.op,
          );
      }
    const scale = w / sw;
    const r = Math.round(Math.abs(s.expansion) * scale);
    if (r) alpha = morphology(alpha, w, h, r, s.expansion > 0);
    alpha = blur(alpha, w, h, s.feather * scale);
    for (let i = 0; i < final.length; i++) {
      let a = alpha[i];
      if (s.invert) a = 1 - a;
      final[i] = combine(final[i], a * s.opacity, layer.op);
    }
  }
  return final;
}
export function linearComposite(fg: number, bg: number, a: number) {
  const linear = (v: number) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const v = linear(fg) * a + linear(bg) * (1 - a);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}
