import { openDB } from "idb";
import { zip, unzip, unzipSync, strToU8, strFromU8 } from "fflate";
import { type Project, uid } from "./domain";
import { fingerprint } from "./media";
import { validateProject } from "./validation";
const database = () =>
  openDB("rototools", 1, {
    upgrade(db) {
      db.createObjectStore("projects", { keyPath: "id" });
      db.createObjectStore("assets");
      db.createObjectStore("recovery");
    },
  });
export async function save(project: Project, blob?: Blob) {
  validateProject(project);
  const db = await database();
  const tx = db.transaction(["projects", "assets"], "readwrite");
  try {
    await tx.objectStore("projects").put(project);
    if (
      blob &&
      project.source &&
      !(await tx.objectStore("assets").getKey(project.source.id))
    )
      await tx.objectStore("assets").put(blob, project.source.id);
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* The failed request may already have aborted. */
    }
    await tx.done.catch(() => {});
    throw error;
  }
}
export async function load(id: string) {
  const db = await database();
  const project = (await db.get("projects", id)) as Project;
  return {
    project: validateProject(project),
    blob: project.source
      ? ((await db.get("assets", project.source.id)) as Blob)
      : undefined,
  };
}
export async function list() {
  return ((await (await database()).getAll("projects")) as Project[]).sort(
    (a, b) => b.updated - a.updated,
  );
}
export async function remove(id: string) {
  const db = await database(),
    p = (await db.get("projects", id)) as Project;
  const tx = db.transaction(["projects", "assets"], "readwrite");
  await tx.objectStore("projects").delete(id);
  if (p?.source) await tx.objectStore("assets").delete(p.source.id);
  for (const l of p?.layers ?? [])
    for (const aid of Object.values(l.model?.frames ?? {}))
      await tx.objectStore("assets").delete(aid);
  await tx.done;
}
export async function putAsset(id: string, blob: Blob) {
  await (await database()).put("assets", blob, id);
}
export async function getAsset(id: string) {
  return (await database()).get("assets", id) as Promise<Blob | undefined>;
}
export async function backup(project: Project, includeSource: boolean) {
  const entries: Record<string, Uint8Array> = {},
    checksums: Record<string, string> = {};
  let size = 0;
  const add = async (name: string, blob: Blob) => {
    size += blob.size;
    if (size > 64 * 1024 * 1024)
      throw new Error(
        "This backup exceeds the 64 MB browser memory limit. Export editing data without the source, or use a shorter clip.",
      );
    entries[name] = new Uint8Array(await blob.arrayBuffer());
    checksums[name] = await fingerprint(blob);
  };
  if (includeSource && project.source) {
    const blob = await getAsset(project.source.id);
    if (!blob)
      throw new Error("The original clip is missing. Relink it first.");
    await add("source.bin", blob);
  }
  for (const l of project.layers)
    for (const id of Object.values(l.model?.frames ?? {})) {
      if (entries["masks/" + id]) continue;
      const blob = await getAsset(id);
      if (!blob)
        throw new Error(
          "A model mask is not cached. Reconnect before backing up.",
        );
      await add("masks/" + id, blob);
    }
  const p = structuredClone(project);
  delete p.serverProject;
  if (p.source) delete p.source.serverAsset;
  entries["project.json"] = strToU8(JSON.stringify(p));
  checksums["project.json"] = await fingerprint(
    new Blob([entries["project.json"] as Uint8Array<ArrayBuffer>]),
  );
  entries["manifest.json"] = strToU8(
    JSON.stringify({ schema: 1, sourceIncluded: includeSource, checksums }),
  );
  const bytes = await new Promise<Uint8Array>((resolve, reject) =>
    zip(entries, { level: 1 }, (err, out) =>
      err ? reject(err) : resolve(out),
    ),
  );
  return new Blob([bytes as Uint8Array<ArrayBuffer>], {
    type: "application/zip",
  });
}
export async function restore(file: File) {
  if (file.size > 64 * 1024 * 1024)
    throw new Error("Backup is larger than the supported 64 MB limit.");
  let total = 0,
    count = 0;
  const data = new Uint8Array(await file.arrayBuffer());
  // Inspect central-directory sizes and paths before starting any decompression worker.
  unzipSync(data, {
    filter: (entry) => {
      if (
        entry.name.includes("..") ||
        entry.name.startsWith("/") ||
        entry.name.includes("\\")
      )
        throw new Error("Unsafe archive path.");
      total += entry.originalSize;
      count++;
      if (total > 64 * 1024 * 1024 || count > 16000)
        throw new Error("Expanded backup exceeds the limit.");
      return false;
    },
  });
  const entries = await new Promise<Record<string, Uint8Array>>(
    (resolve, reject) => {
      unzip(data, (err, out) => (err ? reject(err) : resolve(out)));
    },
  );
  if (!entries["manifest.json"] || !entries["project.json"])
    throw new Error("Missing backup manifest.");
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
  if (
    manifest.schema !== 1 ||
    !manifest.checksums ||
    typeof manifest.checksums !== "object"
  )
    throw new Error("Unsupported backup schema.");
  for (const [name, bytes] of Object.entries(entries)) {
    if (name === "manifest.json") continue;
    if (
      manifest.checksums[name] !==
      (await fingerprint(new Blob([bytes as Uint8Array<ArrayBuffer>])))
    )
      throw new Error("Backup checksum mismatch: " + name);
  }
  for (const name of Object.keys(manifest.checksums))
    if (!entries[name]) throw new Error("Missing backup asset.");
  const p = validateProject(JSON.parse(strFromU8(entries["project.json"])));
  p.id = uid();
  delete p.serverProject;
  if (p.source) {
    p.source.id = uid();
    delete p.source.serverAsset;
  }
  const maskIds = new Map<string, string>();
  for (const l of p.layers)
    for (const [frame, id] of Object.entries(l.model?.frames ?? {})) {
      if (!entries["masks/" + id])
        throw new Error("Missing model mask in backup.");
      if (!maskIds.has(id)) maskIds.set(id, uid());
      l.model!.frames[frame] = maskIds.get(id)!;
    }
  const blob = entries["source.bin"]
    ? new Blob([entries["source.bin"] as Uint8Array<ArrayBuffer>])
    : undefined;
  if (
    blob &&
    p.source &&
    (blob.size !== p.source.size ||
      (await fingerprint(blob)) !== p.source.fingerprint)
  )
    throw new Error("Source fingerprint mismatch.");
  const db = await database(),
    tx = db.transaction(["projects", "assets"], "readwrite");
  try {
    await tx.objectStore("projects").put(p);
    if (blob && p.source) await tx.objectStore("assets").put(blob, p.source.id);
    for (const [oldId, newId] of maskIds)
      await tx
        .objectStore("assets")
        .put(
          new Blob([entries["masks/" + oldId] as Uint8Array<ArrayBuffer>]),
          newId,
        );
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Already aborted. */
    }
    await tx.done.catch(() => {});
    throw error;
  }
  return { project: p, blob };
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
