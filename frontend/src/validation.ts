import { z } from "zod";
import type { Project } from "./domain";
const num = z.number().finite();
const id = z.string().min(1).max(80);
const op = z.enum(["add", "subtract", "intersect", "replace"]);
const point = z.object({
  id,
  x: num.min(-4).max(5),
  y: num.min(-4).max(5),
  in: z.tuple([num, num]).optional(),
  out: z.tuple([num, num]).optional(),
});
const shape = z.object({
  id,
  kind: z.enum(["rectangle", "ellipse", "polygon", "pen", "lasso", "brush"]),
  op,
  points: z.array(point).max(2048),
  radius: num.positive().max(512),
  softness: num.min(0).max(1),
  strength: num.min(0).max(1),
});
const state = z.object({
  shapes: z.array(shape).max(128),
  x: num.min(-4).max(4),
  y: num.min(-4).max(4),
  sx: num.min(0.01).max(10),
  sy: num.min(0.01).max(10),
  rotation: num.min(-3600).max(3600),
  opacity: num.min(0).max(1),
  feather: num.min(0).max(64),
  expansion: num.min(-64).max(64),
  invert: z.boolean(),
});
const frame = z.object({
  index: z.number().int().nonnegative(),
  timestamp: num.nonnegative(),
  sourceTimestamp: num,
  sourcePts: z.number().int(),
  timeBase: z.string().max(64),
});
const source = z.object({
  id,
  name: z.string().max(250),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(268435456),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  duration: num.positive().max(60),
  fps: z.literal(30),
  frames: z.array(frame).min(1).max(1801),
  serverAsset: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const layer = z.object({
  id,
  name: z.string().max(120),
  visible: z.boolean(),
  locked: z.boolean(),
  op,
  keys: z
    .array(
      z.object({
        frame: z.number().int().nonnegative(),
        interpolation: z.enum(["hold", "linear"]),
        state,
      }),
    )
    .min(1)
    .max(1801),
  protected: z.array(z.number().int().nonnegative()).max(1801),
  prompts: z
    .array(
      z.object({
        frame: z.number().int().nonnegative(),
        points: z
          .array(
            z.object({
              x: num.min(0).max(1),
              y: num.min(0).max(1),
              label: z.union([z.literal(0), z.literal(1)]),
            }),
          )
          .max(64),
        box: z.tuple([num, num, num, num]).optional(),
      }),
    )
    .max(128),
  model: z
    .object({
      revision: z.number().int().nonnegative(),
      provider: z.string().max(100),
      checkpoint: z.string().max(200),
      frames: z.record(z.string(), z.string()),
    })
    .optional(),
});
const schema = z.object({
  schema: z.literal(1),
  id,
  name: z.string().max(120),
  revision: z.number().int().nonnegative(),
  created: z.number(),
  updated: z.number(),
  source: source.optional(),
  layers: z.array(layer).max(16),
  inFrame: z.number().int().nonnegative(),
  outFrame: z.number().int().nonnegative(),
  mute: z.boolean(),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  serverProject: z.string().optional(),
});
export function validateProject(input: unknown): Project {
  const p = schema.parse(input);
  const count = p.source?.frames.length ?? 1;
  if (p.inFrame > p.outFrame || p.outFrame >= count)
    throw new Error("Invalid project range.");
  if (new Set(p.layers.map((l) => l.id)).size !== p.layers.length)
    throw new Error("Duplicate layer IDs.");
  if (
    p.source?.frames.some(
      (f, i) => f.index !== i || Math.abs(f.timestamp - i / 30) > 1e-5,
    )
  )
    throw new Error("Invalid frame map.");
  for (const l of p.layers) {
    if (
      new Set(l.keys.map((k) => k.frame)).size !== l.keys.length ||
      l.keys.some((k) => k.frame >= count) ||
      l.prompts.some((k) => k.frame >= count) ||
      l.protected.some((k) => k >= count)
    )
      throw new Error("Invalid keyframe or prompt.");
    if (
      l.model &&
      Object.keys(l.model.frames).some((f) => !/^\d+$/.test(f) || +f >= count)
    )
      throw new Error("Invalid model frame.");
  }
  return p as Project;
}
