import { create } from "zustand";
import type { AnalysisTrack, ClipId, MediaAsset, Op, Project, TimeTicks } from "@aiedit/core";
import {
  createProject, createTrack, deserializeProject, Dispatcher,
  exportSessionLog, makeAudioClip, makeVideoClip, makeTextClip,
  findClip, makeScene, makeSceneClip, makeShapeElement, makeSceneTextElement,
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
  /** LLM settings (localStorage). Empty apiKey = rule-based parser. */
  llm: { baseURL: string; model: string; apiKey: string };
  setLLM(v: { baseURL: string; model: string; apiKey: string }): void;

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
  addIntroScene(): void;
  splitAtPlayhead(): void;
  deleteSelected(ripple?: boolean): void;
  cutSilences(clipId: ClipId): void;
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
    llm: loadLLM(),
    setLLM: (v) => {
      set({ llm: v });
      try { localStorage.setItem("aiedit.llm.v1", JSON.stringify(v)); } catch { /* */ }
    },

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
        // decode audio peaks in background — feeds waveform + silence analysis
        void computePeaks(url).then((pk) => {
          if (!pk) return;
          set({ peaks: { ...get().peaks, [asset.id]: pk } });
          const silence = detectSilence(pk, asset.durationTicks);
          if (silence.length) {
            get().dispatch([{
              type: "asset.set", assetId: asset.id,
              patch: { analysis: [{ kind: "silence", segments: silence }] },
            }], "detect silence");
          }
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

    /**
     * Built-in "AIedit" logo intro — demo scene exercising spring keyframes,
     * per-char text animators, and particle burst, all editable afterwards.
     */
    addIntroScene: () => {
      const s = get();
      const ops: Op[] = [];
      let track = s.project.tracks.find((t) => t.kind === "video");
      if (!track) {
        track = createTrack("video", "V1", newId("track"));
        ops.push({ type: "track.add", track });
      }
      const dur = sec(4.5);
      const scene = makeScene({ duration: dur, name: "AIedit intro" });
      const ACCENT = "#4f8cff";

      // logo mark: springs in
      scene.elements.push(makeShapeElement({
        name: "Mark", shape: "rect", fill: ACCENT, w: 220, h: 220, cornerRadius: 48,
        transform: { keys: [
          { at: 0, value: { x: 0, y: -60, scaleX: 0.2, scaleY: 0.2, rotation: -0.5, opacity: 0 }, ease: { kind: "linear" } },
          { at: sec(0.9), value: { x: 0, y: -60, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }, ease: { kind: "spring", stiffness: 140, damping: 9 } },
        ] },
      }));

      // wordmark: per-char rise + fade
      scene.elements.push(makeSceneTextElement({
        name: "Wordmark", content: "AIedit",
        style: { fontFamily: "sans-serif", fontSize: 150, color: "#ffffff", align: "center" },
        transform: { static: { x: 0, y: 120, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 } },
        animators: [{ selector: "chars", range: [0.15, 0.55], animate: { y: 60, opacity: 1 } }],
      }));

      // accent underline: wipes left→right via scaleX
      scene.elements.push(makeShapeElement({
        name: "Underline", shape: "rect", fill: ACCENT, w: 560, h: 10, cornerRadius: 5,
        transform: { keys: [
          { at: sec(1.1), value: { x: -280, y: 220, scaleX: 0, scaleY: 1, rotation: 0, opacity: 1 }, ease: { kind: "linear" } },
          { at: sec(1.55), value: { x: 0, y: 220, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }, ease: { kind: "bezier", cx1: 0, cy1: 0, cx2: 0.58, cy2: 1 } },
        ] },
      }));

      // particle burst
      scene.elements.push({
        kind: "emitter",
        id: newId("el"), name: "Burst",
        start: sec(1.2), end: dur,
        transform: { static: { x: 0, y: -60, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 } },
        enabled: true,
        particle: {
          rate: 90, lifetime: 1.4, speed: 380, spread: Math.PI * 2,
          direction: -Math.PI / 2, size: 4, color: ACCENT, gravity: 320,
        },
      });

      const clip = makeSceneClip({ sceneId: scene.id, start: s.playhead, duration: dur });
      ops.push({ type: "scene.upsert", scene }, { type: "clip.add", trackId: track.id, clip });
      s.dispatch(ops, "add intro scene");
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

    /**
     * First rule-based "proposal": cut a clip's silent ranges and ripple the
     * remainder closed — one semantic batch, fully logged like any human edit.
     */
    cutSilences: (clipId) => {
      const s = get();
      const loc = findClip(s.project, clipId);
      if (!loc) return;
      const clip = loc.clip;
      if (clip.kind !== "video" && clip.kind !== "audio") return;
      const asset = s.project.assets[clip.assetId];
      const silence = asset?.analysis?.find((a) => a.kind === "silence");
      if (!silence || clip.speed <= 0) return;

      const sp = clip.speed;
      // silence ranges overlapping [sourceIn, sourceOut] → timeline coords
      const segs = silence.segments
        .filter((g) => g.end > clip.sourceIn && g.start < clip.sourceOut)
        .map((g) => ({
          tl0: clip.start + Math.max(0, Math.round((g.start - clip.sourceIn) / sp)),
          tl1: clip.start + Math.max(0, Math.round((g.end - clip.sourceIn) / sp)),
        }))
        .filter((g) => g.tl1 > clip.start && g.tl0 < clip.start + clip.duration)
        .sort((a, b) => a.tl0 - b.tl0);
      if (!segs.length) return;

      // kept parts = complement of silence within the clip
      const kept: { start: TimeTicks; end: TimeTicks }[] = [];
      let cur = clip.start;
      const clipEndT = clip.start + clip.duration;
      for (const g of segs) {
        if (g.tl0 > cur) kept.push({ start: cur, end: Math.min(g.tl0, clipEndT) });
        cur = Math.max(cur, g.tl1);
      }
      if (cur < clipEndT) kept.push({ start: cur, end: clipEndT });
      if (!kept.length || kept.length === 1 && kept[0]!.start === clip.start && kept[0]!.end === clipEndT) return;

      const removed = clip.duration - kept.reduce((n, k) => n + (k.end - k.start), 0);
      const ops: Op[] = [{ type: "clip.remove", clipId }];
      let place = clip.start;
      for (const k of kept) {
        const nc = JSON.parse(JSON.stringify(clip)) as typeof clip;
        nc.id = newId("clip");
        nc.start = place;
        nc.duration = k.end - k.start;
        nc.sourceIn = clip.sourceIn + Math.round((k.start - clip.start) * sp);
        nc.sourceOut = clip.sourceIn + Math.round((k.end - clip.start) * sp);
        ops.push({ type: "clip.add", trackId: loc.track.id, clip: nc });
        place += nc.duration;
      }
      // ripple: shift subsequent clips on the same track
      for (const c of loc.track.clips) {
        if (c.id !== clipId && c.start >= clip.start + clip.duration) {
          ops.push({ type: "clip.move", clipId: c.id, start: c.start - removed });
        }
      }
      s.dispatch(ops, "cut silences");
      set({ selection: [] });
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
  const dpr = window.devicePixelRatio || 1;
  cnv.width = plan.width;
  cnv.height = plan.height;
  // CSS size / dpr so the backing store stays exactly plan.width×plan.height
  cnv.style.cssText = `position:fixed;left:-9999px;top:0;width:${plan.width / dpr}px;height:${plan.height / dpr}px`;
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


/** peaks (0..1) → silence segments in source ticks. Threshold ~ -28dBFS. */
function detectSilence(peaks: number[], durationTicks: TimeTicks | undefined): AnalysisTrack["segments"] {
  if (!durationTicks) return [];
  const dur: TimeTicks = durationTicks;
  const THRESH = 0.035;
  const MIN_SEC = 0.4;
  const n = peaks.length;
  const out: AnalysisTrack["segments"] = [];
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    if (peaks[i]! < THRESH) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      push(i);
      runStart = -1;
    }
  }
  if (runStart >= 0) push(n);
  function push(endIdx: number): void {
    const s = Math.round((runStart / n) * dur);
    const e = Math.round((endIdx / n) * dur);
    if ((e - s) / 90_000 >= MIN_SEC) out.push({ start: s, end: e, score: 1 });
  }
  return out;
}

function loadLLM(): { baseURL: string; model: string; apiKey: string } {
  try {
    return JSON.parse(localStorage.getItem("aiedit.llm.v1") ?? "") as never;
  } catch {
    return { baseURL: "https://api.openai.com", model: "gpt-4o-mini", apiKey: "" };
  }
}
