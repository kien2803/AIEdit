import { create } from "zustand";
import type { ClipId, MediaAsset, Op, Project, TimeTicks } from "@aiedit/core";
import {
  createProject, createTrack, deserializeProject, Dispatcher,
  exportSessionLog, makeAudioClip, makeVideoClip, makeTextClip,
  makeScene, makeSceneClip, makeShapeElement, makeSceneTextElement,
  makeAdjustmentClip, newId, resolvePlacement, rippleDeleteOps, sec, serializeProject,
  timelineEnd, ticks,
} from "@aiedit/core";
import { PreviewPlayer } from "@aiedit/engine";
import { buildExportPlan, buildFramePlan, WasmRunner } from "@aiedit/export";
import { captureTemplate, deserializeTemplate, instantiateTemplate, serializeTemplate, type ParamValues, type Template } from "@aiedit/template";

export type Tool = "select" | "blade";

interface EditorState {
  dispatcher: Dispatcher;
  project: Project;
  player: PreviewPlayer | null;
  playhead: TimeTicks;
  selection: ClipId[];
  tool: Tool;
  pxPerSec: number;
  /** Audio peaks per asset (0..1 normalized), computed async on import. */
  peaks: Record<string, number[]>;
  /** 0..1 while exporting, null when idle. */
  exportProgress: number | null;
  templates: Template[];

  setPlayer(p: PreviewPlayer | null): void;
  dispatch(ops: Op[], label: string): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;

  select(ids: ClipId[]): void;
  setTool(t: Tool): void;
  setZoom(pxPerSec: number): void;
  seek(t: TimeTicks): void;
  togglePlay(): void;

  importFiles(files: FileList | File[]): Promise<void>;
  addToTimeline(assetId: string): void;
  dropOnTimeline(assetId: string, at: TimeTicks, trackIndex: number): void;
  addTextClip(): void;
  addSceneClip(): void;
  addAdjustmentClip(): void;
  splitAtPlayhead(): void;
  deleteSelected(ripple?: boolean): void;
  newProject(): void;
  saveTemplate(name: string): void;
  applyTemplate(id: string, values: ParamValues): void;
  deleteTemplate(id: string): void;
  saveProject(): void;
  loadProject(file: File): Promise<void>;
  exportSession(): void;
  exportVideo(): Promise<void>;
}

export const useEditor = create<EditorState>((set, get) => {
  const dispatcher = new Dispatcher(createProject());
  dispatcher.subscribe((p) => {
    set({ project: p });
    get().player?.setProject(p);
  });

  return {
    dispatcher,
    project: dispatcher.project,
    player: null,
    playhead: 0,
    selection: [],
    tool: "select",
    pxPerSec: 80,
    peaks: {},
    exportProgress: null,
    templates: loadTemplates(),

    setPlayer: (player) => set({ player }),

    dispatch: (ops, label) => {
      const s = get();
      s.dispatcher.dispatch(ops, label, {
        playheadAt: s.playhead,
        selection: s.selection,
        activeTool: s.tool,
      });
      get().player?.renderFrame();
    },

    undo: () => { get().dispatcher.undo(); get().player?.renderFrame(); },
    redo: () => { get().dispatcher.redo(); get().player?.renderFrame(); },
    canUndo: () => get().dispatcher.canUndo,
    canRedo: () => get().dispatcher.canRedo,

    select: (ids) => set({ selection: ids }),
    setTool: (tool) => set({ tool }),
    setZoom: (pxPerSec) => set({ pxPerSec: Math.max(4, Math.min(400, pxPerSec)) }),

    seek: (t) => {
      set({ playhead: t });
      get().player?.seek(t);
    },
    togglePlay: () => get().player?.toggle(),

    importFiles: async (files) => {
      for (const file of Array.from(files)) {
        const url = URL.createObjectURL(file);
        const meta = await probeMedia(url, file);
        const asset: MediaAsset = {
          id: newId("asset"),
          name: file.name,
          kind: meta.kind,
          sourceUrl: url,
          hasAudio: meta.hasAudio,
          ...(meta.durationTicks !== undefined ? { durationTicks: meta.durationTicks } : {}),
          ...(meta.width !== undefined ? { width: meta.width } : {}),
          ...(meta.height !== undefined ? { height: meta.height } : {}),
        };
        get().dispatch([{ type: "asset.add", asset }], `import ${file.name}`);
        // decode audio peaks in background — feeds waveform + later analysis
        void computePeaks(url).then((pk) => {
          if (pk) set({ peaks: { ...get().peaks, [asset.id]: pk } });
        }).catch(() => {});
      }
    },

    addToTimeline: (assetId) => {
      const s = get();
      const asset = s.project.assets[assetId];
      if (!asset?.durationTicks) return;
      // find or create a track of matching kind
      const wantKind = asset.kind === "audio" ? "audio" : "video";
      let track = s.project.tracks.find((t) => t.kind === wantKind);
      const ops: Op[] = [];
      if (!track) {
        track = createTrack(wantKind, wantKind === "video" ? "V1" : "A1", newId("track"));
        ops.push({ type: "track.add", track });
      }
      // append after last clip on that track (or at playhead if empty)
      const end = track.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      const clip = asset.kind === "audio"
        ? makeAudioClip({ assetId, start: end, sourceIn: 0, sourceOut: asset.durationTicks })
        : makeVideoClip({ assetId, start: end, sourceIn: 0, sourceOut: asset.durationTicks });
      ops.push({ type: "clip.add", trackId: track.id, clip });
      s.dispatch(ops, "add to timeline");
      set({ selection: [clip.id] });
    },

    addTextClip: () => {
      const s = get();
      let track = s.project.tracks.find((t) => t.kind === "text");
      const ops: Op[] = [];
      if (!track) {
        track = createTrack("text", "T1", newId("track"));
        // text track goes on top
        ops.unshift({ type: "track.add", track });
      }
      const clip = makeTextClip({ start: s.playhead, duration: sec(4), content: "New text" });
      ops.push({ type: "clip.add", trackId: track.id, clip });
      s.dispatch(ops, "add text");
      set({ selection: [clip.id] });
    },

    addSceneClip: () => {
      const s = get();
      const ops: Op[] = [];
      let track = s.project.tracks.find((t) => t.kind === "video");
      if (!track) {
        track = createTrack("video", "V1", newId("track"));
        ops.push({ type: "track.add", track });
      }
      const dur = sec(4);
      const scene = makeScene({ duration: dur });
      scene.elements.push(
        makeShapeElement({ shape: "rect", fill: "#4f8cff", w: 600, h: 200, cornerRadius: 24 }),
        makeSceneTextElement({ content: "Scene text", style: { fontFamily: "sans-serif", fontSize: 64, color: "#ffffff", align: "center" } }),
      );
      const clip = makeSceneClip({ sceneId: scene.id, start: s.playhead, duration: dur });
      ops.push({ type: "scene.upsert", scene }, { type: "clip.add", trackId: track.id, clip });
      s.dispatch(ops, "add scene");
      set({ selection: [clip.id] });
    },

    addAdjustmentClip: () => {
      const s = get();
      let track = s.project.tracks.find((t) => t.kind === "video");
      const ops: Op[] = [];
      if (!track) {
        track = createTrack("video", "V1", newId("track"));
        ops.push({ type: "track.add", track });
      }
      const clip = makeAdjustmentClip({ start: s.playhead, duration: sec(4) });
      ops.push({ type: "clip.add", trackId: track.id, clip });
      s.dispatch(ops, "add adjustment");
      set({ selection: [clip.id] });
    },

    splitAtPlayhead: () => {
      const s = get();
      const t = s.playhead;
      const ops: Op[] = [];
      const targets = s.selection.length
        ? s.project.tracks.flatMap((tr) => tr.clips.filter((c) => s.selection.includes(c.id)))
        : s.project.tracks.flatMap((tr) => tr.clips);
      for (const c of targets) {
        if (c.start < t && t < c.start + c.duration) {
          ops.push({ type: "clip.split", clipId: c.id, at: t });
        }
      }
      if (ops.length) s.dispatch(ops, "split");
    },

    dropOnTimeline: (assetId, at, trackIndex) => {
      const s = get();
      const asset = s.project.assets[assetId];
      if (!asset?.durationTicks || asset.kind === "image") return;
      const wantKind = asset.kind === "audio" ? "audio" : "video";
      const ops: Op[] = [];
      let track = s.project.tracks[trackIndex];
      if (!track || track.kind !== wantKind) {
        track = s.project.tracks.find((t) => t.kind === wantKind);
      }
      if (!track) {
        track = createTrack(wantKind, wantKind === "video" ? "V1" : "A1", newId("track"));
        ops.push({ type: "track.add", track });
      }
      const dur = asset.durationTicks;
      const start = resolvePlacement(track, undefined, at, dur);
      if (start === null) return;
      const clip = asset.kind === "audio"
        ? makeAudioClip({ assetId, start, sourceIn: 0, sourceOut: dur })
        : makeVideoClip({ assetId, start, sourceIn: 0, sourceOut: dur });
      ops.push({ type: "clip.add", trackId: track.id, clip });
      s.dispatch(ops, "drop media");
      set({ selection: [clip.id] });
    },

    deleteSelected: (ripple = false) => {
      const s = get();
      const ops = ripple
        ? rippleDeleteOps(s.project.tracks, s.selection)
        : (s.selection.map((id) => ({ type: "clip.remove", clipId: id })) as Op[]);
      if (ops.length) {
        s.dispatch(ops, ripple ? "ripple delete" : "delete");
        set({ selection: [] });
      }
    },

    saveTemplate: (name) => {
      const s = get();
      if (!s.selection.length) return;
      const tpl = captureTemplate(s.project, s.selection, { name });
      const templates = [...s.templates, tpl];
      set({ templates });
      persistTemplates(templates);
    },

    applyTemplate: (id, values) => {
      const s = get();
      const tpl = s.templates.find((t) => t.id === id);
      if (!tpl) return;
      const { ops, warnings } = instantiateTemplate(tpl, values, s.project, s.playhead);
      for (const w of warnings) console.warn("template:", w);
      s.dispatch(ops, `apply template "${tpl.name}"`);
    },

    deleteTemplate: (id) => {
      const templates = get().templates.filter((t) => t.id !== id);
      set({ templates });
      persistTemplates(templates);
    },

    saveProject: () => {
      const blob = new Blob([serializeProject(get().project)], { type: "application/json" });
      downloadBlob(blob, "project.aiedit.json");
    },

    loadProject: async (file) => {
      const p = deserializeProject(await file.text());
      const d = new Dispatcher(p);
      d.subscribe((np) => {
        set({ project: np });
        get().player?.setProject(np);
      });
      set({ dispatcher: d, project: d.project, selection: [], playhead: 0 });
      get().player?.setProject(d.project);
    },

    exportSession: () => {
      const blob = new Blob([exportSessionLog(get().dispatcher.log)], { type: "application/jsonl" });
      downloadBlob(blob, `session-${Date.now()}.jsonl`);
    },

    exportVideo: async () => {
      const s = get();
      if (s.exportProgress !== null) return;
      const needsFrames = s.project.tracks.some((t) =>
        t.clips.some((c) => c.kind === "scene" || c.kind === "adjustment"));
      if (needsFrames) return exportFrameRender(get, set);
      set({ exportProgress: 0 });
      try {
        const project = s.project;
        // 1. render text clips to PNGs (same rasterizer as preview text path)
        const textDims: Record<string, { w: number; h: number }> = {};
        const files: Record<string, Uint8Array> = {};
        for (const track of project.tracks) {
          for (const clip of track.clips) {
            if (clip.kind !== "text") continue;
            const { png, w, h } = renderTextPng(clip, project.settings.width);
            files[`text0.png`] = png; // placeholder — real name resolved below
            textDims[clip.id] = { w, h };
          }
        }
        // 2. plan (needs textDims for overlay placement)
        const plan = buildExportPlan(project, textDims);
        // 3. resolve input files
        for (const inp of plan.inputs) {
          if (inp.assetId) {
            const url = project.assets[inp.assetId]!.sourceUrl;
            const buf = await (await fetch(url)).arrayBuffer();
            files[inp.file] = new Uint8Array(buf);
          } else if (inp.textClipId) {
            const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === inp.textClipId);
            if (clip?.kind === "text") {
              const { png } = renderTextPng(clip, project.settings.width);
              files[inp.file] = png;
            }
          }
        }
        // 4. run
        const runner = new WasmRunner();
        const out = await runner.run(plan, files, (f) => set({ exportProgress: f }));
        downloadBlob(new Blob([out as never], { type: "video/mp4" }), `aiedit-${Date.now()}.mp4`);
      } catch (e) {
        console.error("export failed", e);
        alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        set({ exportProgress: null });
      }
    },

    newProject: () => {
      const d = new Dispatcher(createProject());
      d.subscribe((p) => {
        set({ project: p });
        get().player?.setProject(p);
      });
      set({ dispatcher: d, project: d.project, selection: [], playhead: 0 });
    },
  };
});

async function probeMedia(url: string, file: File): Promise<{
  kind: MediaAsset["kind"];
  durationTicks?: TimeTicks;
  width?: number;
  height?: number;
  hasAudio: boolean;
}> {
  if (file.type.startsWith("image/")) {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("bad image"));
      img.src = url;
    });
    return { kind: "image", width: img.naturalWidth, height: img.naturalHeight, hasAudio: false };
  }
  const el = document.createElement("video");
  el.preload = "metadata";
  el.src = url;
  await new Promise<void>((res, rej) => {
    el.onloadedmetadata = () => res();
    el.onerror = () => rej(new Error(`cannot read ${file.name}`));
  });
  const isAudio = file.type.startsWith("audio/") || el.videoWidth === 0;
  return {
    kind: isAudio ? "audio" : "video",
    durationTicks: ticks.fromSeconds(el.duration || 0),
    ...(el.videoWidth ? { width: el.videoWidth, height: el.videoHeight } : {}),
    hasAudio: true,
  };
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function computePeaks(url: string): Promise<number[] | null> {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const audio = await ctx.decodeAudioData(buf);
    const n = audio.length;
    const buckets = 2048;
    const peaks = new Array<number>(buckets).fill(0);
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const data = audio.getChannelData(ch);
      const step = Math.max(1, Math.floor(n / buckets));
      for (let b = 0; b < buckets; b++) {
        let m = 0;
        const start = b * step;
        for (let i = start; i < Math.min(start + step, n); i += Math.max(1, Math.floor(step / 64))) {
          const v = Math.abs(data[i]!);
          if (v > m) m = v;
        }
        peaks[b] = Math.max(peaks[b]!, m);
      }
    }
    const max = Math.max(...peaks, 1e-6);
    return peaks.map((p) => p / max);
  } finally {
    void ctx.close();
  }
}

function renderTextPng(
  clip: { content: string; style: { fontFamily: string; fontSize: number; color: string; align: string } },
  projectWidth: number,
): { png: Uint8Array; w: number; h: number } {
  const cnv = document.createElement("canvas");
  const ctx = cnv.getContext("2d")!;
  ctx.font = `${clip.style.fontSize}px ${clip.style.fontFamily}`;
  const w = Math.min(projectWidth, Math.ceil(ctx.measureText(clip.content).width) + 40);
  const h = Math.ceil(clip.style.fontSize * 1.5) + 20;
  cnv.width = Math.max(2, w);
  cnv.height = Math.max(2, h);
  ctx.font = `${clip.style.fontSize}px ${clip.style.fontFamily}`;
  ctx.fillStyle = clip.style.color;
  ctx.textAlign = clip.style.align as CanvasTextAlign;
  ctx.textBaseline = "middle";
  const x = clip.style.align === "left" ? 20 : clip.style.align === "right" ? w - 20 : w / 2;
  ctx.fillText(clip.content, x, h / 2);
  const dataUrl = cnv.toDataURL("image/png");
  const b64 = dataUrl.split(",")[1]!;
  const bin = atob(b64);
  const png = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) png[i] = bin.charCodeAt(i);
  return { png, w, h };
}


/** Frame-render export: compositor renders every frame → mjpeg → ffmpeg. */
async function exportFrameRender(
  get: () => EditorState,
  set: (partial: Partial<EditorState>) => void,
): Promise<void> {
  const project = get().project;
  set({ exportProgress: 0 });
  const plan = buildFramePlan(project);
  const frameTicks = Math.round(90_000 / plan.fps);

  // offscreen player — DOM elements still work (media pool needs DOM)
  const cnv = document.createElement("canvas");
  cnv.width = plan.width;
  cnv.height = plan.height;
  cnv.style.cssText = `position:fixed;left:-9999px;top:0;width:${plan.width}px;height:${plan.height}px`;
  document.body.appendChild(cnv);
  const player = new PreviewPlayer(cnv, project);
  try {
    // 1. render frames → concatenated jpeg stream
    const chunks: Uint8Array[] = [];
    for (let f = 0; f < plan.frameCount; f++) {
      player.renderAt(f * frameTicks);
      await player.waitForMediaReady(2500);
      const dataUrl = cnv.toDataURL("image/jpeg", 0.9);
      const b64 = dataUrl.split(",")[1]!;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      chunks.push(bytes);
      set({ exportProgress: (f / plan.frameCount) * 0.6 });
      if (f % 10 === 0) await new Promise((r) => setTimeout(r, 0)); // yield to UI
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const mjpeg = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { mjpeg.set(c, off); off += c.length; }

    // 2. input files for the audio pass
    const files: Record<string, Uint8Array> = { "frames.mjpeg": mjpeg };
    for (const inp of plan.inputs) {
      if (inp.assetId) {
        const url = project.assets[inp.assetId]!.sourceUrl;
        files[inp.file] = new Uint8Array(await (await fetch(url)).arrayBuffer());
      }
    }

    // 3. run phases
    const argvs = [plan.videoArgv, ...(plan.audioArgv ? [plan.audioArgv] : []), plan.muxArgv];
    const phases = argvs.map((_, i) => (f: number) =>
      set({ exportProgress: 0.6 + ((i + f) / argvs.length) * 0.4 }));
    const runner = new WasmRunner();
    const out = await runner.runPhases(argvs, files, plan.outFile, phases);
    downloadBlob(new Blob([out as never], { type: "video/mp4" }), `aiedit-${Date.now()}.mp4`);
  } catch (e) {
    console.error("frame export failed", e);
    alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    player.dispose();
    cnv.remove();
    set({ exportProgress: null });
  }
}


const TPL_KEY = "aiedit.templates.v1";

function loadTemplates(): Template[] {
  try {
    const raw = localStorage.getItem(TPL_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as string[]).map((j) => deserializeTemplate(j));
  } catch {
    return [];
  }
}

function persistTemplates(templates: Template[]): void {
  try {
    localStorage.setItem(TPL_KEY, JSON.stringify(templates.map((t) => serializeTemplate(t))));
  } catch { /* quota */ }
}
