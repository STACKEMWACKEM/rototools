import { uid, type Project, type Source } from "./domain";
import { getAsset, putAsset } from "./storage";
export type Capabilities = {
  workerReady: boolean;
  model: { ready: boolean; reason?: string; provider: string };
  exports: { formats: string[]; alphaVerified: boolean };
  retentionHours: number;
  limits: { bytes: number; seconds: number };
};
export type Job = {
  id: string;
  state: string;
  kind: string;
  error?: string;
  progress: number;
  total: number;
  result?: any;
};
let token = localStorage.getItem("rototools-session") ?? "";
export async function request<T>(
  path: string,
  options: RequestInit = {},
  auth = true,
): Promise<T> {
  if (auth && !token) {
    const session = await request<{ token: string }>(
      "/sessions",
      { method: "POST" },
      false,
    );
    token = session.token;
    localStorage.setItem("rototools-session", token);
  }
  const response = await fetch("/api" + path, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof Blob)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(auth ? { Authorization: "Bearer " + token } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    if (response.status === 401) {
      token = "";
      localStorage.removeItem("rototools-session");
    }
    let detail: string;
    try {
      detail = (await response.json()).detail;
    } catch {
      detail = "Connection or server error.";
    }
    throw new Error(
      typeof detail === "string" ? detail : JSON.stringify(detail),
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export async function asset(id: string, signal?: AbortSignal): Promise<Blob> {
  if (!token)
    throw new Error("The online session is missing. Prepare the clip again.");
  const r = await fetch("/api/assets/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + token },
    signal,
  });
  if (!r.ok) throw new Error("Online asset unavailable. It may have expired.");
  return r.blob();
}
export async function upload(
  blob: Blob,
  source: { name: string; fingerprint: string },
  onProgress: (n: number, total: number) => void,
  signal: AbortSignal,
) {
  const created = await request<{ id: string; offset: number }>("/uploads", {
    method: "POST",
    body: JSON.stringify({
      name: source.name,
      size: blob.size,
      sha256: source.fingerprint,
    }),
    signal,
  });
  let offset = created.offset;
  while (offset < blob.size) {
    signal.throwIfAborted();
    const chunk = blob.slice(
      offset,
      Math.min(blob.size, offset + 4 * 1024 * 1024),
    );
    await request("/uploads/" + created.id, {
      method: "PATCH",
      body: chunk,
      headers: {
        "Upload-Offset": String(offset),
        "Content-Type": "application/octet-stream",
      },
      signal,
    });
    offset += chunk.size;
    onProgress(offset, blob.size);
  }
  return request<{ asset: string }>("/uploads/" + created.id + "/complete", {
    method: "POST",
    signal,
  });
}
export async function waitJob(
  job: Job,
  onUpdate: (j: Job) => void,
  signal: AbortSignal,
): Promise<Job> {
  let current = job;
  for (;;) {
    onUpdate(current);
    if (["completed", "failed", "canceled"].includes(current.state)) {
      if (current.state !== "completed")
        throw new Error(current.error ?? current.state);
      return current;
    }
    signal.throwIfAborted();
    await new Promise((r) => setTimeout(r, 600));
    signal.throwIfAborted();
    current = await request<Job>("/jobs/" + job.id, { signal });
  }
}
export async function sync(project: Project) {
  if (!project.serverProject) {
    // Portable projects carry raster assets independently of a prior guest session.
    const clean = structuredClone(project);
    for (const layer of clean.layers) delete layer.model;
    const r = await request<{ id: string }>("/projects", {
      method: "POST",
      body: JSON.stringify(clean),
    });
    const next = structuredClone(project);
    next.serverProject = r.id;
    for (const layer of next.layers) {
      if (!layer.model) continue;
      const frames: Record<string, string> = {};
      for (const [frame, id] of Object.entries(layer.model.frames)) {
        const blob = await getAsset(id);
        if (!blob)
          throw new Error(
            "A saved mask is missing. Reconnect or restore a complete backup.",
          );
        const restored = await request<{ asset: string }>(
          `/projects/${r.id}/mask-assets?frame=${frame}&layer=${encodeURIComponent(layer.id)}`,
          {
            method: "POST",
            body: blob,
            headers: { "Content-Type": "image/png" },
          },
        );
        frames[frame] = restored.asset;
        await putAsset(restored.asset, blob);
      }
      layer.model.frames = frames;
    }
    if (next.layers.some((l) => l.model))
      await request("/projects/" + r.id, {
        method: "PATCH",
        headers: { "If-Match": String(next.revision) },
        body: JSON.stringify(next),
      });
    return next;
  }
  const old = await request<Project>("/projects/" + project.serverProject);
  await request("/projects/" + project.serverProject, {
    method: "PATCH",
    headers: { "If-Match": String(old.revision) },
    body: JSON.stringify(project),
  });
  return project;
}
export const idempotent = () => ({ "Idempotency-Key": uid() });
export async function exactFrame(
  proxy: string,
  index: number,
  signal?: AbortSignal,
) {
  const r = await fetch(`/api/assets/${proxy}/frames/${index}`, {
    headers: { Authorization: "Bearer " + token },
    signal,
  });
  if (!r.ok) throw new Error("Exact frame unavailable.");
  return createImageBitmap(await r.blob());
}
