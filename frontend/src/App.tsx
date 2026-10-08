import { useEffect, useRef, useState } from "react";
import {
  History,
  newProject,
  newLayer,
  uid,
  stateAt,
  editLayer,
  compatibleResult,
  type Project,
  type Source,
} from "./domain";
import { CanvasEditor, type Tool, type Mode } from "./CanvasEditor";
import { LocalMedia, fingerprint } from "./media";
import * as storage from "./storage";
import { evaluate } from "./mask";
import * as api from "./api";
import "./styles.css";

const tools: [Tool, string, string][] = [
  ["select", "Select subject", "◎"],
  ["rectangle", "Rectangle", "▭"],
  ["ellipse", "Ellipse", "◯"],
  ["polygon", "Polygon", "⬡"],
  ["pen", "Pen path", "⌁"],
  ["lasso", "Lasso", "◌"],
  ["brush", "Brush", "✎"],
  ["erase", "Erase", "⊖"],
  ["transform", "Transform", "↗"],
  ["move", "Move", "✥"],
];
export default function App() {
  const history = useRef(new History(newProject())),
    [project, setProject] = useState(history.current.current),
    current = useRef(project),
    [frame, setFrame] = useState(0),
    [active, setActive] = useState(project.layers[0].id),
    [media, setMedia] = useState<LocalMedia>(),
    [blob, setBlob] = useState<Blob>(),
    [pending, setPending] = useState<File>(),
    [proxy, setProxy] = useState<string>(),
    [tool, setTool] = useState<Tool>("rectangle"),
    [mode, setMode] = useState<Mode>("overlay"),
    [saveStatus, setSaveStatus] = useState("Not saved"),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [brush, setBrush] = useState({ radius: 24, softness: 0.3, strength: 1 }),
    [operation, setOperation] = useState<
      "add" | "subtract" | "intersect" | "replace"
    >("add"),
    [overlay, setOverlay] = useState({ color: "#a7f3b6", opacity: 0.4 }),
    [zoom, setZoom] = useState(1),
    [playing, setPlaying] = useState(false),
    [negative, setNegative] = useState(false),
    [caps, setCaps] = useState<api.Capabilities>(),
    [job, setJob] = useState<api.Job>(),
    [uploadProgress, setUploadProgress] = useState<[number, number]>(),
    [busy, setBusy] = useState(false),
    [sheet, setSheet] = useState<
      "projects" | "export" | "online" | "diagnostics" | null
    >(null),
    [projects, setProjects] = useState<Project[]>([]),
    [layersOpen, setLayersOpen] = useState(true),
    [exportFormat, setExportFormat] = useState("mp4"),
    [resolution, setResolution] = useState("original"),
    [includeSource, setIncludeSource] = useState(true),
    [readyFrame, setReadyFrame] = useState(-1),
    [timelineZoom, setTimelineZoom] = useState(1),
    [keyDestination, setKeyDestination] = useState(0),
    [thumbnails, setThumbnails] = useState<{ frame: number; url: string }[]>(
      [],
    ),
    [trackDirection, setTrackDirection] = useState<
      "forward" | "backward" | "both"
    >("forward");
  const importInput = useRef<HTMLInputElement>(null),
    backupInput = useRef<HTMLInputElement>(null),
    relinkInput = useRef<HTMLInputElement>(null),
    finish = useRef<(() => void) | null>(null),
    cancel = useRef<(() => void) | null>(null),
    operationController = useRef<AbortController | null>(null),
    audio = useRef<HTMLVideoElement>(null),
    sourceUrl = useRef(""),
    mediaRef = useRef<LocalMedia | undefined>(undefined),
    importController = useRef<AbortController | null>(null),
    saveGeneration = useRef(0);
  current.current = project;
  const layer = project.layers.find((l) => l.id === active),
    state = layer ? stateAt(layer, frame) : undefined,
    source = project.source,
    maxFrame = (source?.frames.length ?? 1) - 1;
  function replace(p: Project) {
    history.current.current = p;
    current.current = p;
    setProject(p);
  }
  function commit(p: Project) {
    const next = history.current.commit(p);
    current.current = next;
    setProject(next);
  }
  function acceptOnlineLinks(p: Project) {
    const now = current.current;
    if (now.id !== p.id || now.source?.fingerprint !== p.source?.fingerprint)
      return;
    if (now.revision === p.revision) {
      replace(p);
      return;
    }
    const merged = structuredClone(now);
    merged.source = p.source;
    merged.serverProject = p.serverProject;
    for (const layer of merged.layers) {
      const prepared = p.layers.find((l) => l.id === layer.id)?.model;
      if (
        layer.model &&
        prepared &&
        layer.model.revision === prepared.revision &&
        layer.model.checkpoint === prepared.checkpoint
      )
        layer.model = prepared;
    }
    replace(merged);
  }
  function mutate(fn: (p: Project) => void) {
    const p = structuredClone(current.current);
    fn(p);
    commit(p);
  }
  function edit(fn: (s: NonNullable<typeof state>) => void) {
    commit(editLayer(current.current, active, frame, fn));
  }
  function jump(n: number) {
    setPlaying(false);
    setFrame(Math.max(0, Math.min(maxFrame, n)));
  }
  function showError(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
  }
  useEffect(() => setReadyFrame(-1), [frame, source?.id, media, proxy]);
  useEffect(() => {
    setThumbnails([]);
    if (!source || (!media && !proxy)) return;
    const controller = new AbortController();
    const run = async () => {
      const images: { frame: number; url: string }[] = [];
      for (let i = 0; i < 8; i++) {
        controller.signal.throwIfAborted();
        const index = Math.round((i * maxFrame) / 7);
        const image = media
          ? await media.frame(index, controller.signal)
          : await api.exactFrame(proxy!, index, controller.signal);
        const c = document.createElement("canvas");
        c.width = 80;
        c.height = Math.max(1, Math.round((source.height / source.width) * 80));
        c.getContext("2d")!.drawImage(image, 0, 0, c.width, c.height);
        if (image instanceof ImageBitmap) image.close();
        images.push({ frame: index, url: c.toDataURL("image/jpeg", 0.7) });
        setThumbnails([...images]);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    void run().catch((e) => {
      if (!controller.signal.aborted) showError(e);
    });
    return () => controller.abort();
  }, [media, proxy, source?.id]);
  useEffect(() => {
    const saved = localStorage.getItem("rototools-last");
    if (saved) storage.load(saved).then(openLoaded).catch(showError);
    void refreshCaps();
    return () => {
      mediaRef.current?.close();
      if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
    };
  }, []);
  async function refreshCaps() {
    try {
      setCaps(await api.request("/capabilities", {}, false));
    } catch {
      setCaps(undefined);
    }
  }
  useEffect(() => {
    if (!sheet) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector(".sheet") as HTMLElement;
    const items = () => [
      ...dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]),input:not([disabled]),select:not([disabled])",
      ),
    ];
    items()[0]?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const elements = items(),
        first = elements[0],
        last = elements[elements.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener("keydown", trap);
    return () => {
      dialog.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [sheet]);
  useEffect(() => {
    setSaveStatus("Saving…");
    const n = ++saveGeneration.current;
    const timer = setTimeout(() => {
      storage
        .save(project, blob)
        .then(() => {
          if (n === saveGeneration.current) {
            setSaveStatus("Saved on this device");
            localStorage.setItem("rototools-last", project.id);
          }
        })
        .catch((e) => {
          if (n === saveGeneration.current)
            setSaveStatus("Save failed — export a backup");
          showError(e);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [project, blob]);
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) {
        setPlaying(false);
        void storage.save(current.current, blob).catch(showError);
      } else {
        void refreshCaps();
        const pendingJob = localStorage.getItem("rototools-job");
        if (pendingJob && !busy) {
          void recoverJob(JSON.parse(pendingJob));
        }
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [blob, busy]);
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    sourceUrl.current = url;
    if (audio.current) audio.current.src = url;
    return () => {
      URL.revokeObjectURL(url);
      sourceUrl.current = "";
    };
  }, [blob]);
  useEffect(() => {
    if (!audio.current) return;
    audio.current.muted = project.mute;
  }, [project.mute]);
  useEffect(() => {
    if (!playing || !source || !audio.current) return;
    const video = audio.current;
    let canceled = false,
      raf = 0;
    video.currentTime = frame / 30;
    void video
      .play()
      .catch(() =>
        setMessage(
          "Audio playback is unavailable for this codec. Frame preview remains available.",
        ),
      );
    const start = performance.now(),
      first = frame;
    const tick = () => {
      if (canceled) return;
      const n = Math.min(
        project.outFrame,
        Math.floor(((performance.now() - start) / 1000) * 30) + first,
      );
      setFrame(n);
      if (n >= project.outFrame) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    if (!("requestVideoFrameCallback" in video))
      raf = requestAnimationFrame(tick);
    // Presented mediaTime is authoritative when the browser supplies it.
    let callback = 0;
    if ("requestVideoFrameCallback" in video) {
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (canceled) return;
        setFrame(
          Math.min(
            project.outFrame,
            Math.max(project.inFrame, Math.floor(meta.mediaTime * 30 + 1e-5)),
          ),
        );
        callback = video.requestVideoFrameCallback(onFrame);
      };
      callback = video.requestVideoFrameCallback(onFrame);
    }
    return () => {
      canceled = true;
      cancelAnimationFrame(raf);
      if (callback) video.cancelVideoFrameCallback(callback);
      video.pause();
    };
  }, [playing]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input,select,textarea")) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        replace(e.shiftKey ? history.current.redo() : history.current.undo());
      }
      if (e.key === "ArrowRight") jump(frame + 1);
      if (e.key === "ArrowLeft") jump(frame - 1);
      if (e.key === "Escape") {
        cancel.current?.();
        setSheet(null);
      }
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [frame, maxFrame]);
  async function openLoaded(data: { project: Project; blob?: Blob }) {
    const old = mediaRef.current;
    setPlaying(false);
    setError("");
    setFrame(0);
    setProxy(undefined);
    setPending(undefined);
    setMedia(undefined);
    setBlob(data.blob);
    history.current = new History(data.project);
    replace(data.project);
    setActive(data.project.layers[0]?.id ?? "");
    setSheet(null);
    if (data.blob && data.project.source) {
      const m = new LocalMedia(data.blob);
      try {
        await m.inspect(data.project.source.name);
        m.source = data.project.source;
        mediaRef.current = m;
        setMedia(m);
        old?.close();
      } catch (e) {
        m.close();
        old?.close();
        mediaRef.current = undefined;
        if (data.project.serverProject) {
          try {
            const online = await api.request<{ proxy: string }>(
              "/projects/" + data.project.serverProject + "/preview",
            );
            if (current.current.id === data.project.id) {
              setProxy(online.proxy);
              setMessage("Using exact online preview frames for this browser.");
            }
          } catch {
            showError(e);
          }
        } else showError(e);
      }
    } else {
      old?.close();
      mediaRef.current = undefined;
      if (data.project.source)
        setMessage(
          "The original clip is missing. Choose Relink original; your saved edits are available.",
        );
    }
    const pendingJob = localStorage.getItem("rototools-job");
    if (pendingJob && !busy) {
      try {
        const saved = JSON.parse(pendingJob);
        if (saved.projectId === data.project.id) void recoverJob(saved);
      } catch {
        localStorage.removeItem("rototools-job");
      }
    }
  }
  async function importFile(file: File) {
    importController.current?.abort();
    const controller = new AbortController();
    importController.current = controller;
    setBusy(true);
    setMessage("Inspecting the clip on this device…");
    setError("");
    const m = new LocalMedia(file);
    try {
      const s = await m.inspect(file.name, controller.signal);
      const p = newProject();
      p.name = file.name.replace(/\.[^.]+$/, "").slice(0, 120);
      p.source = s;
      p.outFrame = s.frames.length - 1;
      history.current = new History(p);
      replace(p);
      setActive(p.layers[0].id);
      setFrame(0);
      mediaRef.current?.close();
      mediaRef.current = m;
      setMedia(m);
      setBlob(file);
      setPending(undefined);
      setProxy(undefined);
      setMessage("Ready. Manual edits stay on this device.");
    } catch (e) {
      m.close();
      if (!controller.signal.aborted) {
        setPending(file);
        showError(e);
        setMessage(
          "You can choose Prepare online to validate and convert this clip using FFmpeg.",
        );
      }
    } finally {
      if (importController.current === controller) {
        setBusy(false);
        importController.current = null;
      }
    }
  }
  async function relink(file: File) {
    if (!source) return;
    if (
      file.size !== source.size ||
      (await fingerprint(file)) !== source.fingerprint
    )
      throw new Error(
        "This is a different clip. Select the exact original file to preserve the frame map.",
      );
    await openLoaded({ project, blob: file });
    setMessage("Original clip relinked.");
  }
  async function prepareOnline(signal: AbortSignal) {
    const file = pending ?? blob;
    if (!file) throw new Error("Import or relink the original clip first.");
    const before = current.current,
      s = before.source;
    const hash = pending
      ? await fingerprint(file)
      : (s?.fingerprint ?? (await fingerprint(file)));
    const uploaded = await api.upload(
      file,
      { name: pending?.name ?? s?.name ?? "source", fingerprint: hash },
      (n, t) => setUploadProgress([n, t]),
      signal,
    );
    setUploadProgress(undefined);
    const queued = await api.request<api.Job>("/media/inspect", {
      method: "POST",
      headers: api.idempotent(),
      body: JSON.stringify(uploaded),
      signal,
    });
    localStorage.setItem(
      "rototools-job",
      JSON.stringify({ id: queued.id, kind: "prepare", projectId: before.id }),
    );
    const done = await api.waitJob(queued, setJob, signal);
    localStorage.removeItem("rototools-job");
    let p = structuredClone(current.current);
    const prepared = done.result.source as Source;
    if (pending) {
      p = newProject();
      p.name = pending.name.slice(0, 120);
      p.source = prepared;
      p.outFrame = prepared.frames.length - 1;
      history.current = new History(p);
      setActive(p.layers[0].id);
      setBlob(pending);
      setFrame(0);
      setPending(undefined);
      mediaRef.current?.close();
      mediaRef.current = undefined;
      setMedia(undefined);
      replace(p);
    } else {
      if (p.id !== before.id || p.source?.fingerprint !== hash)
        throw new Error(
          "Project changed during preparation. The result was not applied.",
        );
      if (
        p.source.width !== prepared.width ||
        p.source.height !== prepared.height ||
        p.source.frames.length !== prepared.frames.length
      )
        throw new Error(
          "Online and local frame maps differ. Reimport using Prepare online before applying edits.",
        );
      p.source = { ...prepared, id: p.source.id };
    }
    delete p.serverProject;
    p = await api.sync(p);
    acceptOnlineLinks(p);
    setProxy(done.result.proxy);
    return p;
  }
  async function ensureOnline(signal: AbortSignal) {
    let p = current.current;
    if (!p.source?.serverAsset || !p.serverProject)
      p = await prepareOnline(signal);
    else p = await api.sync(p);
    acceptOnlineLinks(p);
    return p;
  }
  async function online(action: "prepare" | "export" | "select" | "track") {
    if (busy) return;
    setSheet(null);
    setBusy(true);
    setError("");
    setMessage("Online processing — uploading only if needed.");
    const controller = new AbortController();
    operationController.current = controller;
    try {
      const p =
        action === "prepare"
          ? await prepareOnline(controller.signal)
          : await ensureOnline(controller.signal);
      if (action === "prepare") {
        setMessage("Online preparation complete.");
        return;
      }
      let queued: api.Job;
      if (action === "export")
        queued = await api.request(
          "/projects/" + p.serverProject + "/exports",
          {
            method: "POST",
            headers: api.idempotent(),
            body: JSON.stringify({
              revision: p.revision,
              format: exportFormat,
              resolution,
            }),
            signal: controller.signal,
          },
        );
      else {
        const start =
            action === "select"
              ? frame
              : trackDirection === "forward"
                ? frame
                : p.inFrame,
          end =
            action === "select"
              ? frame
              : trackDirection === "backward"
                ? frame
                : p.outFrame;
        queued = await api.request(
          "/projects/" + p.serverProject + "/tracking",
          {
            method: "POST",
            headers: api.idempotent(),
            body: JSON.stringify({
              revision: p.revision,
              layerId: active,
              start,
              end,
              anchor: frame,
              direction: action === "select" ? "frame" : trackDirection,
            }),
            signal: controller.signal,
          },
        );
      }
      localStorage.setItem(
        "rototools-job",
        JSON.stringify({ id: queued.id, kind: queued.kind, projectId: p.id }),
      );
      const done = await api.waitJob(queued, setJob, controller.signal);
      localStorage.removeItem("rototools-job");
      await applyJob(done);
    } catch (e) {
      if (controller.signal.aborted)
        setMessage(
          "Upload paused. Choose the operation again to resume from the confirmed offset.",
        );
      else showError(e);
    } finally {
      setBusy(false);
      setUploadProgress(undefined);
      operationController.current = null;
      void refreshCaps();
    }
  }
  async function applyJob(done: api.Job) {
    if (done.kind === "export") {
      const output = await api.asset(done.result.asset);
      storage.download(
        output,
        "rototools-r" +
          done.result.revision +
          "." +
          (
            { mp4: "mp4", prores: "mov", matte: "mkv", png: "zip" } as Record<
              string,
              string
            >
          )[done.result.format],
      );
      setMessage("Export ready from revision " + done.result.revision + ".");
    }
    if (done.kind === "track") {
      if (!compatibleResult(current.current, done.result)) {
        setMessage(
          "This result belongs to an older edit revision. It was kept online and has not replaced your edits.",
        );
        return;
      }
      for (const frames of Object.values(done.result.frames) as Record<
        string,
        string
      >[])
        for (const id of Object.values(frames))
          await storage.putAsset(id, await api.asset(id));
      if (!compatibleResult(current.current, done.result)) {
        setMessage(
          "The project changed while masks were downloading. Older results were kept separately.",
        );
        return;
      }
      mutate((p) => {
        for (const l of p.layers) {
          const frames = done.result.frames[l.id];
          if (frames)
            l.model = {
              revision: done.result.revision,
              provider: done.result.provider,
              checkpoint: done.result.checkpoint,
              frames: { ...l.model?.frames, ...frames },
            };
        }
      });
      setMessage(
        "Model results applied. Review frames: " +
          (done.result.reviewFrames.join(", ") || "none flagged") +
          ". Review indicators are heuristics.",
      );
    }
  }
  async function recoverJob(saved: {
    id: string;
    kind: string;
    projectId: string;
  }) {
    if (saved.projectId !== current.current.id) return;
    setBusy(true);
    try {
      const j = await api.request<api.Job>("/jobs/" + saved.id);
      const done = await api.waitJob(j, setJob, new AbortController().signal);
      if (done.kind === "prepare")
        setMessage(
          "Preparation finished online. Choose Prepare online to reconnect the prepared clip.",
        );
      else await applyJob(done);
      localStorage.removeItem("rototools-job");
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }
  async function cancelJob() {
    if (importController.current) {
      importController.current.abort();
      setMessage("Import canceled.");
      return;
    }
    if (uploadProgress) {
      operationController.current?.abort();
      return;
    }
    if (job && ["queued", "running"].includes(job.state)) {
      setJob(
        await api.request("/jobs/" + job.id + "/cancel", { method: "POST" }),
      );
    } else operationController.current?.abort();
  }
  function addPrompt(x: number, y: number, label: 0 | 1) {
    if (!layer || layer.locked) return;
    mutate((p) => {
      const l = p.layers.find((l) => l.id === active)!;
      let prompt = l.prompts.find((p) => p.frame === frame);
      if (!prompt) {
        prompt = { frame, points: [] };
        l.prompts.push(prompt);
      }
      if (prompt.points.length >= 64)
        throw new Error("Maximum 64 prompt points per frame.");
      prompt.points.push({ x, y, label });
    });
  }
  async function exportBackup() {
    try {
      storage.download(
        await storage.backup(project, includeSource),
        project.name + ".rototools.zip",
      );
      setMessage(
        "Portable backup downloaded. Keep it somewhere independent of browser storage.",
      );
    } catch (e) {
      showError(e);
    }
  }
  async function exportPNG() {
    try {
      const s = project.source;
      if (!s || !media || readyFrame !== frame)
        throw new Error("An exact local frame must be ready.");
      const c = document.createElement("canvas");
      c.width = Math.min(s.width, 480);
      c.height = Math.round((s.height * c.width) / s.width);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(await media.frame(frame), 0, 0, c.width, c.height);
      const image = ctx.getImageData(0, 0, c.width, c.height);
      if (project.layers.some((l) => l.model?.frames[String(frame)]))
        throw new Error(
          "Use online PNG sequence export to include model masks.",
        );
      const a = evaluate(project, frame, c.width, c.height);
      for (let i = 0; i < a.length; i++)
        image.data[i * 4 + 3] = Math.round(a[i] * 255);
      ctx.putImageData(image, 0, 0);
      const output = await new Promise<Blob>((resolve, reject) =>
        c.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("PNG encoding failed."))),
          "image/png",
        ),
      );
      storage.download(output, `frame-${frame}-preview.png`);
      setMessage(
        "PNG downloaded at " +
          c.width +
          " × " +
          c.height +
          " preview resolution, with straight alpha.",
      );
    } catch (e) {
      showError(e);
    }
  }
  async function removeProject() {
    if (project.serverProject)
      await api.request("/projects/" + project.serverProject, {
        method: "DELETE",
      });
    await storage.remove(project.id);
    localStorage.removeItem("rototools-last");
    await openLoaded({ project: newProject() });
    setMessage(
      "Project and its cached assets deleted. Your original file is untouched.",
    );
  }
  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files[0]) void importFile(e.dataTransfer.files[0]);
      }}
    >
      <header className="topbar">
        <button
          className="brand"
          onClick={() => {
            void storage.list().then(setProjects);
            setSheet("projects");
          }}
        >
          <span className="brand-mark">◉</span> rototools{" "}
          <span className="brand-tag">STUDIO</span>
        </button>
        <div className="project-title">
          <input
            aria-label="Project name"
            maxLength={120}
            value={project.name}
            onChange={(e) =>
              mutate((p) => {
                p.name = e.target.value;
              })
            }
          />
          <small
            className={saveStatus.startsWith("Save failed") ? "danger" : ""}
          >
            {saveStatus}
          </small>
        </div>
        <div className="header-actions">
          <button
            aria-label="Undo"
            disabled={!history.current.past.length}
            onClick={() => replace(history.current.undo())}
          >
            ↶
          </button>
          <button
            aria-label="Redo"
            disabled={!history.current.future.length}
            onClick={() => replace(history.current.redo())}
          >
            ↷
          </button>
          <button
            className="accent"
            onClick={() => {
              void refreshCaps();
              setSheet("export");
            }}
            disabled={!source}
          >
            Export <span>↗</span>
          </button>
        </div>
      </header>
      <div className="workspace-bar">
        <div>
          <span className="status-dot" />{" "}
          <span>
            {busy ? "Processing" : source ? "Editing" : "Ready to import"}
          </span>
          <span className="separator">/</span>
          <span className="muted">
            {source
              ? `${source.width} × ${source.height} · ${source.duration.toFixed(2)}s`
              : "One clip. Unlimited creative control."}
          </span>
        </div>
        <button onClick={() => importInput.current?.click()} disabled={busy}>
          ＋ Import clip
        </button>
        <button onClick={() => setSheet("online")} disabled={busy}>
          Prepare online
        </button>
        {source && !blob && (
          <button onClick={() => relinkInput.current?.click()}>
            Relink original
          </button>
        )}
        <button
          onClick={() => setLayersOpen((s) => !s)}
          aria-expanded={layersOpen}
        >
          Layers
        </button>
      </div>
      <main className={"editor-grid " + (!layersOpen ? "no-layers" : "")}>
        <section className="editing-area">
          <div className="preview-bar">
            <label>
              View{" "}
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as Mode)}
              >
                <option value="overlay">Mask overlay</option>
                <option value="original">Original</option>
                <option value="matte">Grayscale matte</option>
                <option value="checkerboard">Transparency</option>
                <option value="light">Light background</option>
                <option value="dark">Dark background</option>
              </select>
            </label>
            <span className="muted">
              {readyFrame === frame ? "Exact frame ready" : "Frame pending"}
            </span>
            <button
              onClick={() => document.documentElement.requestFullscreen?.()}
              aria-label="Expand editing view"
            >
              ⛶
            </button>
          </div>
          <CanvasEditor
            project={project}
            frame={frame}
            active={active}
            tool={tool}
            mode={mode}
            media={media}
            proxy={proxy}
            brush={brush}
            operation={operation}
            overlay={overlay}
            onCommit={commit}
            onPrompt={addPrompt}
            negative={negative}
            onError={showError}
            onReady={setReadyFrame}
            zoom={zoom}
            setZoom={setZoom}
            finishRef={finish}
            cancelRef={cancel}
          />
          <div className="tools" role="toolbar" aria-label="Mask tools">
            {tools.map(([id, label, icon]) => (
              <button
                key={id}
                className={tool === id ? "selected" : ""}
                onClick={() => setTool(id)}
                disabled={id === "select" && !caps?.model.ready}
                title={
                  id === "select" && !caps?.model.ready
                    ? "SAM 2.1 unavailable: " +
                      (caps?.model.reason ?? "processing service disconnected")
                    : label
                }
                aria-pressed={tool === id}
              >
                <span>{icon}</span>
                {label}
              </button>
            ))}
          </div>
          <div className="tool-settings">
            <span className="eyebrow">
              {tools.find((t) => t[0] === tool)?.[1]}
            </span>
            {!["move", "transform", "select"].includes(tool) && (
              <label>
                Combine{" "}
                <select
                  value={operation}
                  onChange={(e) =>
                    setOperation(e.target.value as typeof operation)
                  }
                >
                  <option value="add">Add</option>
                  <option value="subtract">Subtract</option>
                  <option value="intersect">Intersect</option>
                  <option value="replace">Replace</option>
                </select>
              </label>
            )}
            {["brush", "erase"].includes(tool) && (
              <>
                <label>
                  Size{" "}
                  <input
                    type="range"
                    min="1"
                    max="200"
                    value={brush.radius * 2}
                    onChange={(e) =>
                      setBrush({ ...brush, radius: +e.target.value / 2 })
                    }
                  />
                  {brush.radius * 2}px
                </label>
                <label>
                  Softness{" "}
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step=".05"
                    value={brush.softness}
                    onChange={(e) =>
                      setBrush({ ...brush, softness: +e.target.value })
                    }
                  />
                </label>
                <label>
                  Strength{" "}
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step=".05"
                    value={brush.strength}
                    onChange={(e) =>
                      setBrush({ ...brush, strength: +e.target.value })
                    }
                  />
                </label>
              </>
            )}
            {["polygon", "pen"].includes(tool) && (
              <>
                <button onClick={() => finish.current?.()}>Close path ↵</button>
                <span className="muted">
                  {tool === "pen"
                    ? "Tap anchors; drag to set curve handles."
                    : "Tap to add vertices."}
                </span>
              </>
            )}
            <button onClick={() => cancel.current?.()}>Cancel gesture</button>
            {tool === "select" && (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={negative}
                    onChange={(e) => setNegative(e.target.checked)}
                  />{" "}
                  Remove point
                </label>
                <button
                  onClick={() => online("select")}
                  disabled={
                    busy || !layer?.prompts.some((p) => p.frame === frame)
                  }
                >
                  Run selection online
                </button>
              </>
            )}
            {tool === "transform" && state && (
              <>
                <label>
                  Rotate{" "}
                  <input
                    type="number"
                    min="-360"
                    max="360"
                    value={state.rotation}
                    onChange={(e) =>
                      edit((s) => {
                        s.rotation = Math.max(
                          -360,
                          Math.min(360, +e.target.value || 0),
                        );
                      })
                    }
                  />
                  °
                </label>
                <label>
                  Scale X{" "}
                  <input
                    type="number"
                    min=".01"
                    max="10"
                    step=".05"
                    value={state.sx}
                    onChange={(e) =>
                      edit((s) => {
                        s.sx = Math.max(
                          0.01,
                          Math.min(10, +e.target.value || 1),
                        );
                      })
                    }
                  />
                </label>
                <label>
                  Scale Y{" "}
                  <input
                    type="number"
                    min=".01"
                    max="10"
                    step=".05"
                    value={state.sy}
                    onChange={(e) =>
                      edit((s) => {
                        s.sy = Math.max(
                          0.01,
                          Math.min(10, +e.target.value || 1),
                        );
                      })
                    }
                  />
                </label>
              </>
            )}
          </div>
        </section>
        {layersOpen && (
          <aside className="inspector">
            <div className="panel-heading">
              <h2>Masks & layers</h2>
              <button
                onClick={() => {
                  if (project.layers.length >= 16) {
                    showError("Maximum 16 layers.");
                    return;
                  }
                  const l = newLayer("Mask " + (project.layers.length + 1));
                  l.keys[0].frame = frame;
                  mutate((p) => p.layers.push(l));
                  setActive(l.id);
                }}
                aria-label="Add layer"
              >
                ＋
              </button>
            </div>
            <div className="layer-list">
              {project.layers.map((l, i) => (
                <div
                  key={l.id}
                  className={"layer-row " + (active === l.id ? "active" : "")}
                >
                  <button
                    className="layer-name"
                    onClick={() => setActive(l.id)}
                  >
                    <span className="layer-icon">▱</span>
                    <span>
                      {l.name}
                      <small>
                        {l.model
                          ? "AI + manual"
                          : `${l.keys.length} keyframe${l.keys.length === 1 ? "" : "s"}`}
                      </small>
                    </span>
                  </button>
                  <button
                    aria-label={(l.visible ? "Hide " : "Show ") + l.name}
                    onClick={() =>
                      mutate((p) => {
                        p.layers[i].visible = !l.visible;
                      })
                    }
                  >
                    {l.visible ? "◉" : "○"}
                  </button>
                  <button
                    aria-label={(l.locked ? "Unlock " : "Lock ") + l.name}
                    onClick={() =>
                      mutate((p) => {
                        p.layers[i].locked = !l.locked;
                      })
                    }
                  >
                    {l.locked ? "▣" : "◇"}
                  </button>
                </div>
              ))}
            </div>
            {layer && state && (
              <>
                <div className="inspector-section">
                  <label>
                    Layer name
                    <input
                      value={layer.name}
                      maxLength={120}
                      onChange={(e) =>
                        mutate((p) => {
                          p.layers.find((l) => l.id === active)!.name =
                            e.target.value;
                        })
                      }
                    />
                  </label>
                  <label>
                    Layer combination
                    <select
                      value={layer.op}
                      disabled={layer.locked}
                      onChange={(e) =>
                        mutate((p) => {
                          p.layers.find((l) => l.id === active)!.op = e.target
                            .value as typeof layer.op;
                        })
                      }
                    >
                      <option value="add">Add</option>
                      <option value="subtract">Subtract</option>
                      <option value="intersect">Intersect</option>
                      <option value="replace">Replace</option>
                    </select>
                  </label>
                  <div className="button-row">
                    <button
                      onClick={() => {
                        const l = structuredClone(layer);
                        l.id = uid();
                        l.name = (l.name + " copy").slice(0, 120);
                        delete l.model;
                        mutate((p) => p.layers.push(l));
                        setActive(l.id);
                      }}
                      disabled={project.layers.length >= 16}
                    >
                      Duplicate
                    </button>
                    <button
                      onClick={() =>
                        mutate((p) => {
                          const i = p.layers.findIndex((l) => l.id === active);
                          if (i > 0)
                            [p.layers[i - 1], p.layers[i]] = [
                              p.layers[i],
                              p.layers[i - 1],
                            ];
                        })
                      }
                    >
                      Move up
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        mutate((p) => {
                          p.layers = p.layers.filter((l) => l.id !== active);
                        });
                        setActive(current.current.layers[0]?.id ?? "");
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <div className="inspector-section">
                  <h3>Edges</h3>
                  <label>
                    Opacity <output>{Math.round(state.opacity * 100)}%</output>
                    <input
                      aria-label="Layer opacity"
                      type="range"
                      min="0"
                      max="1"
                      step=".01"
                      value={state.opacity}
                      disabled={layer.locked}
                      onChange={(e) =>
                        edit((s) => {
                          s.opacity = +e.target.value;
                        })
                      }
                    />
                  </label>
                  <label>
                    Feather <output>{state.feather.toFixed(1)} px</output>
                    <input
                      aria-label="Feather"
                      type="range"
                      min="0"
                      max="64"
                      step=".5"
                      value={state.feather}
                      disabled={layer.locked}
                      onChange={(e) =>
                        edit((s) => {
                          s.feather = +e.target.value;
                        })
                      }
                    />
                  </label>
                  <label>
                    Expand / contract{" "}
                    <output>{state.expansion.toFixed(1)} px</output>
                    <input
                      aria-label="Expansion"
                      type="range"
                      min="-64"
                      max="64"
                      value={state.expansion}
                      disabled={layer.locked}
                      onChange={(e) =>
                        edit((s) => {
                          s.expansion = +e.target.value;
                        })
                      }
                    />
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={state.invert}
                      disabled={layer.locked}
                      onChange={(e) =>
                        edit((s) => {
                          s.invert = e.target.checked;
                        })
                      }
                    />{" "}
                    Invert mask
                  </label>
                  <p className="hint">
                    Feather softens the outline. Fine-edge hair matting is
                    unavailable.
                  </p>
                </div>
                <div className="inspector-section">
                  <h3>Animation & corrections</h3>
                  <button
                    onClick={() => edit(() => {})}
                    disabled={!source || layer.locked}
                  >
                    ◇ Add keyframe here
                  </button>
                  <label>
                    Interpolation
                    <select
                      value={
                        layer.keys.find((k) => k.frame === frame)
                          ?.interpolation ?? "linear"
                      }
                      disabled={layer.locked}
                      onChange={(e) =>
                        mutate((p) => {
                          const l = p.layers.find((l) => l.id === active)!;
                          let k = l.keys.find((k) => k.frame === frame);
                          if (!k) {
                            k = {
                              frame,
                              state: stateAt(l, frame),
                              interpolation: "linear",
                            };
                            l.keys.push(k);
                          }
                          k.interpolation = e.target.value as "hold" | "linear";
                        })
                      }
                    >
                      <option value="linear">Linear</option>
                      <option value="hold">Hold</option>
                    </select>
                  </label>
                  <p className="hint">
                    Matching anchors animate. Changed topology and painted
                    strokes hold.
                  </p>
                  <div className="key-list">
                    {layer.keys.map((k) => (
                      <button
                        key={k.frame}
                        className={k.frame === frame ? "selected" : ""}
                        onClick={() => jump(k.frame)}
                      >
                        ◇ {k.frame}
                      </button>
                    ))}
                  </div>
                  <label>
                    Destination frame
                    <input
                      type="number"
                      min="0"
                      max={maxFrame}
                      value={keyDestination}
                      onChange={(e) =>
                        setKeyDestination(
                          Math.max(
                            0,
                            Math.min(maxFrame, Math.round(+e.target.value)),
                          ),
                        )
                      }
                    />
                  </label>
                  <div className="button-row">
                    <button
                      disabled={
                        layer.locked ||
                        layer.keys.some((k) => k.frame === keyDestination)
                      }
                      onClick={() =>
                        mutate((p) => {
                          p.layers
                            .find((l) => l.id === active)!
                            .keys.push({
                              frame: keyDestination,
                              state: stateAt(layer, frame),
                              interpolation: "linear",
                            });
                        })
                      }
                    >
                      Copy key
                    </button>
                    <button
                      disabled={
                        layer.locked ||
                        !layer.keys.some((k) => k.frame === frame) ||
                        layer.keys.some((k) => k.frame === keyDestination)
                      }
                      onClick={() =>
                        mutate((p) => {
                          p.layers
                            .find((l) => l.id === active)!
                            .keys.find((k) => k.frame === frame)!.frame =
                            keyDestination;
                        })
                      }
                    >
                      Move key
                    </button>
                    <button
                      disabled={
                        layer.locked ||
                        layer.keys.length <= 1 ||
                        !layer.keys.some((k) => k.frame === frame)
                      }
                      onClick={() =>
                        mutate((p) => {
                          const l = p.layers.find((l) => l.id === active)!;
                          l.keys = l.keys.filter((k) => k.frame !== frame);
                        })
                      }
                    >
                      Delete key
                    </button>
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={layer.protected.includes(frame)}
                      onChange={(e) =>
                        mutate((p) => {
                          const l = p.layers.find((l) => l.id === active)!;
                          l.protected = e.target.checked
                            ? [...l.protected, frame]
                            : l.protected.filter((f) => f !== frame);
                        })
                      }
                    />{" "}
                    Protect correction frame
                  </label>
                  <label>
                    Tracking direction
                    <select
                      value={trackDirection}
                      onChange={(e) =>
                        setTrackDirection(
                          e.target.value as typeof trackDirection,
                        )
                      }
                    >
                      <option value="forward">Forward to out</option>
                      <option value="backward">Backward to in</option>
                      <option value="both">Both within range</option>
                    </select>
                  </label>
                  <button
                    disabled={
                      !caps?.model.ready ||
                      busy ||
                      !layer.prompts.some((p) => p.frame === frame)
                    }
                    onClick={() => online("track")}
                  >
                    Track online
                  </button>
                  <p className="hint">
                    Manual corrections stay above model masks. Tracking does not
                    replace them.
                  </p>
                </div>
              </>
            )}
            <div className="inspector-section">
              <h3>Preview appearance</h3>
              <label>
                Overlay color
                <input
                  type="color"
                  value={overlay.color}
                  onChange={(e) =>
                    setOverlay({ ...overlay, color: e.target.value })
                  }
                />
              </label>
              <label>
                Overlay strength
                <input
                  aria-label="Overlay strength"
                  type="range"
                  min=".05"
                  max=".85"
                  step=".05"
                  value={overlay.opacity}
                  onChange={(e) =>
                    setOverlay({ ...overlay, opacity: +e.target.value })
                  }
                />
              </label>
              <button onClick={() => setSheet("diagnostics")}>
                Capabilities & diagnostics
              </button>
            </div>
          </aside>
        )}
      </main>
      <section className="timeline">
        <div className="transport">
          <div className="button-row">
            <button
              aria-label="Jump to start"
              onClick={() => jump(project.inFrame)}
            >
              ⏮
            </button>
            <button aria-label="Previous frame" onClick={() => jump(frame - 1)}>
              ‹
            </button>
            <button
              className="play"
              aria-label={playing ? "Pause" : "Play"}
              disabled={!source}
              onClick={() => {
                if (frame >= project.outFrame) setFrame(project.inFrame);
                setPlaying((s) => !s);
              }}
            >
              {playing ? "Ⅱ" : "▶"}
            </button>
            <button aria-label="Next frame" onClick={() => jump(frame + 1)}>
              ›
            </button>
            <button
              aria-label="Jump to end"
              onClick={() => jump(project.outFrame)}
            >
              ⏭
            </button>
            <span className="time">
              {(frame / 30).toFixed(3)}{" "}
              <span className="muted">
                / {(source?.duration ?? 0).toFixed(3)}
              </span>
            </span>
          </div>
          <div className="button-row">
            <span className="frame-label">
              FRAME {String(frame).padStart(4, "0")}
            </span>
            <label>
              Timeline zoom
              <select
                value={timelineZoom}
                onChange={(e) => setTimelineZoom(+e.target.value)}
              >
                <option value="1">1×</option>
                <option value="2">2×</option>
                <option value="4">4×</option>
              </select>
            </label>
          </div>
        </div>
        <div className="timeline-scroll">
          <div
            style={{ width: `${timelineZoom * 100}%` }}
            className="timeline-track"
          >
            <div className="ruler">
              {Array.from({ length: 11 }, (_, i) => (
                <span key={i}>
                  {((i * (source?.duration ?? 0)) / 10).toFixed(1)}s
                </span>
              ))}
            </div>
            <input
              aria-label="Timeline frame"
              className="scrubber"
              type="range"
              min="0"
              max={maxFrame}
              step="1"
              value={frame}
              onChange={(e) => jump(+e.target.value)}
            />
            <div className="thumbnails">
              {thumbnails.map((t) => (
                <button
                  key={t.frame}
                  onClick={() => jump(t.frame)}
                  aria-label={"Jump to thumbnail frame " + t.frame}
                >
                  <img src={t.url} alt={"Video frame " + t.frame} />
                </button>
              ))}
            </div>
            <div className="markers">
              {layer?.keys.map((k) => (
                <button
                  key={"k" + k.frame}
                  title={"Manual keyframe " + k.frame}
                  onClick={() => jump(k.frame)}
                  style={{ left: `${(k.frame / (maxFrame || 1)) * 100}%` }}
                >
                  ◇
                </button>
              ))}
              {layer?.prompts.map((p) => (
                <button
                  key={"p" + p.frame}
                  title={"Prompt " + p.frame}
                  onClick={() => jump(p.frame)}
                  style={{ left: `${(p.frame / (maxFrame || 1)) * 100}%` }}
                >
                  ＋
                </button>
              ))}
              {layer?.protected.map((f) => (
                <button
                  key={"c" + f}
                  title={"Protected correction " + f}
                  onClick={() => jump(f)}
                  style={{ left: `${(f / (maxFrame || 1)) * 100}%` }}
                >
                  ▣
                </button>
              ))}
            </div>
            <div className="range-status">
              <span>◇ keyframe</span>
              <span>＋ prompt</span>
              <span>▣ protected</span>
              <span>
                {layer?.model
                  ? `${Object.keys(layer.model.frames).length} tracked frames`
                  : "No tracked frames"}
              </span>
            </div>
          </div>
        </div>
        <div className="range-controls">
          <label>
            In frame
            <input
              aria-label="In frame"
              type="number"
              min="0"
              max={project.outFrame}
              value={project.inFrame}
              onChange={(e) =>
                mutate((p) => {
                  p.inFrame = Math.max(
                    0,
                    Math.min(p.outFrame, Math.round(+e.target.value)),
                  );
                })
              }
            />
          </label>
          <button
            onClick={() =>
              mutate((p) => {
                p.inFrame = Math.min(frame, p.outFrame);
              })
            }
          >
            Set in
          </button>
          <label>
            Out frame
            <input
              aria-label="Out frame"
              type="number"
              min={project.inFrame}
              max={maxFrame}
              value={project.outFrame}
              onChange={(e) =>
                mutate((p) => {
                  p.outFrame = Math.max(
                    p.inFrame,
                    Math.min(maxFrame, Math.round(+e.target.value)),
                  );
                })
              }
            />
          </label>
          <button
            onClick={() =>
              mutate((p) => {
                p.outFrame = Math.max(frame, p.inFrame);
              })
            }
          >
            Set out
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={project.mute}
              onChange={(e) =>
                mutate((p) => {
                  p.mute = e.target.checked;
                })
              }
            />{" "}
            Mute audio
          </label>
          <span className="muted">30 fps editing timeline</span>
        </div>
      </section>
      <footer>
        <span className="muted">
          {busy ? "Online processing" : "On this device"} · Private by default
        </span>
        <span className="muted">Two fingers to pan & zoom · Esc cancels</span>
      </footer>
      {(message || error || busy) && (
        <div
          className={"notice " + (error ? "error" : "")}
          role={error ? "alert" : "status"}
        >
          <span>
            {error || message}
            {job &&
              busy &&
              ` · ${job.state} · ${job.progress}/${job.total || "?"} frames`}
            {uploadProgress &&
              ` · ${Math.round(uploadProgress[0] / 1048576)}/${Math.round(uploadProgress[1] / 1048576)} MB uploaded`}
          </span>
          {job?.kind === "track" && job.result && (
            <button onClick={() => void applyJob(job).catch(showError)}>
              Apply completed frames
            </button>
          )}
          {busy ? (
            <button onClick={cancelJob}>Cancel</button>
          ) : (
            <button
              onClick={() => {
                setError("");
                setMessage("");
              }}
              aria-label="Dismiss message"
            >
              ×
            </button>
          )}
        </div>
      )}
      {sheet && (
        <div className="sheet-backdrop" onClick={() => setSheet(null)}>
          <section
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={sheet}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-heading">
              <h2>
                {sheet === "export"
                  ? "Export your work"
                  : sheet === "projects"
                    ? "Your projects"
                    : sheet === "online"
                      ? "Prepare for online processing"
                      : "Capabilities & diagnostics"}
              </h2>
              <button onClick={() => setSheet(null)} aria-label="Close dialog">
                ×
              </button>
            </div>
            {sheet === "online" && (
              <>
                <p>
                  Send this clip to the processing server for media conversion,
                  subject selection, tracking, or export. Manual edits stay
                  local until you choose this action.
                </p>
                <p className="hint">
                  Private media is retained for {caps?.retentionHours ?? 24}{" "}
                  hours. No media is used for training. You can delete online
                  media with the project.
                </p>
                <button
                  className="accent"
                  disabled={busy || !caps?.workerReady || (!blob && !pending)}
                  onClick={() => online("prepare")}
                >
                  Upload & prepare online
                </button>
                <p className="hint">
                  {!caps?.workerReady
                    ? "Processing worker is offline. Start the API and worker using the README."
                    : "Native FFmpeg will validate orientation, codec, timing and SDR color."}
                </p>
              </>
            )}
            {sheet === "export" && (
              <>
                <p>Exports use a saved snapshot of your current edits.</p>
                <label>
                  Format
                  <select
                    value={exportFormat}
                    onChange={(e) => setExportFormat(e.target.value)}
                  >
                    <option value="mp4">Composited MP4 · opaque</option>
                    <option value="matte">
                      Lossless grayscale matte · MKV
                    </option>
                    <option value="png">RGBA PNG sequence · ZIP</option>
                    <option value="prores">ProRes 4444 · MOV with alpha</option>
                  </select>
                </label>
                <label>
                  Resolution
                  <select
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  >
                    <option value="original">Original</option>
                    <option value="720">720p · no upscaling</option>
                    <option value="1080">1080p · no upscaling</option>
                  </select>
                </label>
                <label>
                  MP4 background
                  <input
                    type="color"
                    value={project.background}
                    onChange={(e) =>
                      mutate((p) => {
                        p.background = e.target.value;
                      })
                    }
                  />
                </label>
                <p className="hint">
                  Online export sends the source clip and editing data to your
                  private processing server.{" "}
                  {exportFormat === "prores"
                    ? "Transparency is verified through FFmpeg; receiving editor compatibility varies."
                    : exportFormat === "matte"
                      ? "White keeps the subject; black removes it. FFV1 preserves exact grayscale values."
                      : ""}
                </p>
                {source &&
                  (source.width % 2 || source.height % 2) &&
                  exportFormat === "mp4" && (
                    <p className="hint">
                      Odd dimensions receive one pixel of padding at the
                      right/bottom for H.264.
                    </p>
                  )}
                <button
                  className="accent"
                  disabled={
                    busy || !caps?.exports.formats.includes(exportFormat)
                  }
                  onClick={() => online("export")}
                >
                  Render online & download
                </button>
                {!caps?.workerReady && (
                  <p className="hint">
                    Start the processing worker to enable video exports.
                  </p>
                )}
                <hr />
                <button onClick={exportPNG}>
                  Download current preview PNG · local
                </button>
                <p className="hint">
                  A still image with transparency at up to 480 pixels wide. For
                  full-resolution frames, use online PNG sequence export.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={includeSource}
                    onChange={(e) => setIncludeSource(e.target.checked)}
                  />{" "}
                  Include original source in backup
                </label>
                <button onClick={exportBackup}>
                  Download portable project
                </button>
              </>
            )}
            {sheet === "projects" && (
              <>
                <div className="button-row">
                  <button onClick={() => openLoaded({ project: newProject() })}>
                    New project
                  </button>
                  <button onClick={() => backupInput.current?.click()}>
                    Restore backup
                  </button>
                  <button
                    onClick={() =>
                      void navigator.storage
                        ?.persist()
                        .then((granted) =>
                          setMessage(
                            granted
                              ? "Persistent storage granted. Keep an independent backup."
                              : "Persistent storage was not granted. Export a backup.",
                          ),
                        )
                    }
                  >
                    Request persistent storage
                  </button>
                </div>
                {projects.map((p) => (
                  <button
                    className="project-card"
                    key={p.id}
                    onClick={() =>
                      void storage.load(p.id).then(openLoaded).catch(showError)
                    }
                  >
                    <strong>{p.name}</strong>
                    <small>
                      Revision {p.revision} ·{" "}
                      {new Date(p.updated).toLocaleDateString()}
                    </small>
                  </button>
                ))}
                <button
                  className="danger"
                  onClick={() => void removeProject().catch(showError)}
                >
                  Delete current project & online media
                </button>
                <p className="hint">
                  Deleting clears this project's browser cache and related
                  private server media. Your original file and downloaded
                  backups stay untouched.
                </p>
              </>
            )}
            {sheet === "diagnostics" && (
              <>
                <p>
                  Local decoding:{" "}
                  {"VideoDecoder" in window
                    ? "WebCodecs available; each codec is checked on import"
                    : "Unavailable; use online preparation"}
                </p>
                <p>
                  AI selection:{" "}
                  {caps?.model.ready
                    ? "SAM 2.1 worker ready"
                    : "Unavailable — " +
                      (caps?.model.reason ?? "API disconnected")}
                </p>
                <p>Human matting: unavailable. Edge controls remain usable.</p>
                <p>
                  Verified server export formats:{" "}
                  {caps?.exports.formats.join(", ") || "none yet"}
                </p>
                <p>Physical iPhone / Android testing: pending.</p>
                <p>
                  Limits: 30 seconds, 256 MB, 4096 pixels, 16 layers. Preview
                  width ≤480 pixels. Local backup ≤64 MB.
                </p>
                <button
                  onClick={() =>
                    void navigator.storage
                      ?.estimate()
                      .then((s) =>
                        setMessage(
                          `Browser storage: ${Math.round((s.usage ?? 0) / 1048576)} MB used of approximately ${Math.round((s.quota ?? 0) / 1048576)} MB available.`,
                        ),
                      )
                  }
                >
                  Check local storage
                </button>
                <button onClick={refreshCaps}>Refresh capabilities</button>
              </>
            )}
          </section>
        </div>
      )}
      <input
        hidden
        type="file"
        ref={importInput}
        accept="video/*,.mov,.mp4"
        onChange={(e) => {
          if (e.target.files?.[0]) void importFile(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <input
        hidden
        type="file"
        ref={backupInput}
        accept=".zip"
        onChange={(e) => {
          if (e.target.files?.[0])
            void storage
              .restore(e.target.files[0])
              .then(openLoaded)
              .catch(showError);
          e.target.value = "";
        }}
      />
      <input
        hidden
        type="file"
        ref={relinkInput}
        accept="video/*,.mov,.mp4"
        onChange={(e) => {
          if (e.target.files?.[0])
            void relink(e.target.files[0]).catch(showError);
          e.target.value = "";
        }}
      />
      <video
        ref={audio}
        className="audio-video"
        aria-hidden="true"
        playsInline
        preload="metadata"
      />
    </div>
  );
}
