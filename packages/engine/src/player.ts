import type { AdjustmentClip, AudioClip, Clip, FootageElement, MediaAsset, Project, Scene, SceneClip, SceneElement, VideoClip } from "@aiedit/core";
import { clipEnd, sourceTimeAt, ticks, timelineEnd, findElementIn } from "@aiedit/core";
import type { TimeTicks } from "@aiedit/core";
import { PlaybackClock } from "./clock.js";
import { Compositor } from "./compositor.js";
import { MediaPool } from "./mediaPool.js";
import { activeClipsAt } from "./resolve.js";
import { CanvasSceneRenderer, type SceneRenderContext } from "./sceneRenderer.js";
import { uniformsFor, NEUTRAL_UNIFORMS } from "./effects.js";

const DRIFT_TOLERANCE_S = 0.08;

/**
 * PreviewPlayer binds a Project to a canvas: it owns the clock, media pool
 * and compositor, syncs media elements to the clock, and renders each frame.
 * Headless-compatible design: renderAt() needs no DOM except media elements.
 */
export class PreviewPlayer {
  clock = new PlaybackClock();
  private compositor: Compositor;
  private pool = new MediaPool();
  private project: Project;
  private raf = 0;
  private listeners = new Set<(t: TimeTicks) => void>();
  private textRenderers = new Map<string, { canvas: HTMLCanvasElement; dirtyFor: string }>();
  private sceneRenderer = new CanvasSceneRenderer();

  constructor(private canvas: HTMLCanvasElement, project: Project) {
    this.project = project;
    this.compositor = new Compositor(canvas, project);
    for (const a of Object.values(project.assets)) this.pool.registerAsset(a);
  }

  setProject(p: Project): void {
    // register any new assets
    for (const a of Object.values(p.assets)) this.pool.registerAsset(a);
    this.project = p;
  }

  onTick(fn: (t: TimeTicks) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get time(): TimeTicks {
    return this.clock.now();
  }
  get playing(): boolean {
    return this.clock.playing;
  }

  play(): void {
    if (this.clock.now() >= timelineEnd(this.project)) this.clock.seek(0);
    this.clock.play();
    this.startLoop();
  }

  pause(): void {
    this.clock.pause();
  }

  toggle(): void {
    if (this.clock.playing) this.pause();
    else this.play();
  }

  seek(t: TimeTicks): void {
    this.clock.seek(Math.max(0, t));
    if (!this.clock.playing) this.renderFrame();
  }

  private startLoop(): void {
    if (this.raf) return;
    const loop = () => {
      const t = this.clock.now();
      if (t >= timelineEnd(this.project) && timelineEnd(this.project) > 0) {
        this.clock.pause();
        this.clock.seek(timelineEnd(this.project));
      }
      this.renderFrame();
      for (const fn of this.listeners) fn(this.clock.now());
      this.raf = this.clock.playing ? requestAnimationFrame(loop) : 0;
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Render the current clock time: sync elements + composite. */
  renderFrame(): void {
    const t = this.clock.now();
    this.renderAt(t);
    for (const fn of this.listeners) fn(t);
  }

  /** Render an arbitrary time — the API a headless AI harness would use. */
  renderAt(t: TimeTicks): void {
    const p = this.project;
    const active = activeClipsAt(p, t);
    const activeIds = new Set<string>();

    this.compositor.resizeCanvas();
    this.compositor.beginScene();

    // Draw order: tracks[0] is topmost -> draw last. Visual kinds only.
    const visual = active.filter(({ clip }) => clip.kind !== "audio" && clip.kind !== "adjustment");
    for (let i = visual.length - 1; i >= 0; i--) {
      const { clip } = visual[i]!;
      activeIds.add(clip.id);
      const handle = this.pool.ensure(clip);
      if (!handle) continue;

      if (clip.kind === "text") {
        const cnv = this.renderText(clip);
        this.compositor.drawClip(clip, handle, cnv, cnv.width, cnv.height, t, this.transitionFade(clip, t));
      } else if (clip.kind === "scene") {
        const scene = p.scenes[clip.sceneId];
        if (!scene || !handle.canvas) continue;
        this.syncSceneFootage(scene, t - clip.start, clip.id, activeIds);
        this.renderSceneCanvas(handle.canvas, scene, t - clip.start);
        this.compositor.drawClip(clip, handle, handle.canvas, p.settings.width, p.settings.height, t, this.transitionFade(clip, t));
      } else if (clip.kind === "video") {
        const el = handle.el;
        if (!el) continue;
        this.syncElement(el, clip, t);
        if (el.readyState >= 2) {
          this.compositor.drawClip(clip, handle, el, el.videoWidth || 16, el.videoHeight || 9, t, this.transitionFade(clip, t));
        }
      }
    }

    // audio clips + audio of video clips
    for (const { track, clip } of active) {
      activeIds.add(clip.id);
      if (clip.kind === "audio") {
        const handle = this.pool.ensure(clip);
        if (handle?.el) {
          this.syncElement(handle.el, clip, t);
          this.applyAudioState(handle.el, clip, track.muted, t);
        }
      } else if (clip.kind === "video") {
        const el = this.pool.get(clip.id)?.el;
        if (el) this.applyAudioState(el, clip, track.muted, t);
      }
    }

    // adjustment layer: first active adjustment clip's effects = post uniforms
    const adj = active.find(({ clip }) => clip.kind === "adjustment" && clip.enabled)?.clip;
    const post = adj ? uniformsFor(adj.effects) : NEUTRAL_UNIFORMS;
    this.compositor.finishScene(post);

    this.pool.retain(activeIds);
  }

  /** Fade multiplier from edge transitions (fade / dip-black ≈ opacity ramp). */
  private transitionFade(clip: Clip, t: TimeTicks): number {
    const trs = clip.transitions;
    if (!trs) return 1;
    const local = t - clip.start;
    let f = 1;
    if (trs.in && trs.in.duration > 0) f = Math.min(f, local / trs.in.duration);
    if (trs.out && trs.out.duration > 0) f = Math.min(f, (clip.duration - local) / trs.out.duration);
    return Math.max(0, f);
  }

  /** Ensure footage elements inside the scene have synced media elements. */
  private syncSceneFootage(scene: Scene, sceneT: TimeTicks, clipId: string, activeIds: Set<string>): void {
    const walk = (els: SceneElement[]) => {
      for (const el of els) {
        if (el.kind === "group") { walk(el.elements); continue; }
        if (el.kind !== "footage" || !el.enabled) continue;
        if (sceneT < el.start || sceneT >= el.end) continue;
        const key = `${clipId}:${el.id}`;
        activeIds.add(key);
        const h = this.pool.ensureKey(key, el.assetId);
        if (!h?.el) continue;
        const src = el.sourceIn + Math.round((sceneT - el.start) * Math.abs(el.speed));
        this.syncRaw(h.el, src, this.clock.playing ? Math.abs(el.speed) * this.clock.rate : 0);
      }
    };
    walk(scene.elements);
  }

  private renderSceneCanvas(cnv: HTMLCanvasElement, scene: Scene, sceneT: TimeTicks): void {
    const { width: W, height: H } = this.project.settings;
    if (cnv.width !== W || cnv.height !== H) { cnv.width = W; cnv.height = H; }
    const ctx = cnv.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    const sctx: SceneRenderContext = {
      project: this.project,
      mediaFor: (key, assetId) => this.pool.ensureKey(`${scene.id}:${key}`, assetId),
      syncMedia: (el, src) => this.syncRaw(el, src, 0),
    };
    this.sceneRenderer.render(scene, sceneT, ctx, sctx);
  }

  private syncElement(el: HTMLVideoElement, clip: VideoClip | AudioClip, t: TimeTicks): void {
    const expected = sourceTimeAt(clip, t);
    const playing = this.clock.playing;
    const rate = (clip.speed >= 0 ? clip.speed : -clip.speed) * this.clock.rate;
    const playingForward = playing && clip.speed >= 0;
    this.syncRawCommon(el, expected, playingForward, rate);
  }

  /** Low-level sync: keep element at `srcTicks` (paused stepping or rate playback). */
  private syncRaw(el: HTMLVideoElement, srcTicks: TimeTicks, rate: number): void {
    this.syncRawCommon(el, srcTicks, rate > 0, rate);
  }

  private syncRawCommon(el: HTMLVideoElement, expectedTicks: TimeTicks, playingForward: boolean, rate: number): void {
    const expected = ticks.toSeconds(expectedTicks);
    if (playingForward) {
      // forward playback: let element run, correct drift
      el.playbackRate = Math.max(0.0625, Math.min(16, rate));
      if (Math.abs(el.currentTime - expected) > DRIFT_TOLERANCE_S) {
        el.currentTime = expected;
      }
      if (el.paused) void el.play().catch(() => {});
    } else {
      // paused or reverse: step frame-accurately (reverse isn't natively playable)
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - expected) > 1 / 60) {
        el.currentTime = Math.max(0, Math.min(el.duration || expected, expected));
      }
    }
  }

  private applyAudioState(el: HTMLVideoElement, clip: VideoClip | AudioClip, trackMuted: boolean, t: TimeTicks): void {
    const local = t - clip.start;
    let fade = 1;
    if (clip.fadeIn && clip.fadeIn > 0) fade = Math.min(fade, local / clip.fadeIn);
    if (clip.fadeOut && clip.fadeOut > 0) fade = Math.min(fade, (clip.duration - local) / clip.fadeOut);
    fade = Math.max(0, Math.min(1, fade));
    el.muted = trackMuted || !clip.enabled || clip.gain <= 0 || fade <= 0;
    el.volume = Math.max(0, Math.min(1, clip.gain * fade));
  }

  private textCanvasFor(clip: Clip & { kind: "text" }): HTMLCanvasElement {
    let entry = this.textRenderers.get(clip.id);
    const key = JSON.stringify([clip.content, clip.style, this.project.settings.width]);
    if (!entry || entry.dirtyFor !== key) {
      const cnv = entry?.canvas ?? document.createElement("canvas");
      const ctx = cnv.getContext("2d")!;
      ctx.font = `${clip.style.fontSize}px ${clip.style.fontFamily}`;
      const w = Math.min(this.project.settings.width, Math.ceil(ctx.measureText(clip.content).width) + 40);
      const h = Math.ceil(clip.style.fontSize * 1.5) + 20;
      cnv.width = Math.max(2, w);
      cnv.height = Math.max(2, h);
      entry = { canvas: cnv, dirtyFor: key };
      this.textRenderers.set(clip.id, entry);
    }
    return entry.canvas;
  }

  private renderText(clip: Clip & { kind: "text" }): HTMLCanvasElement {
    const cnv = this.textCanvasFor(clip);
    const ctx = cnv.getContext("2d")!;
    ctx.clearRect(0, 0, cnv.width, cnv.height);
    ctx.font = `${clip.style.fontSize}px ${clip.style.fontFamily}`;
    ctx.fillStyle = clip.style.color;
    ctx.textAlign = clip.style.align;
    ctx.textBaseline = "middle";
    const x = clip.style.align === "left" ? 20 : clip.style.align === "right" ? cnv.width - 20 : cnv.width / 2;
    ctx.fillText(clip.content, x, cnv.height / 2);
    return cnv;
  }

  /**
   * Wait until every live media element has finished seeking/has data —
   * required for frame-accurate export (render→capture loops).
   */
  async waitForMediaReady(timeoutMs = 4000): Promise<void> {
    const els = this.pool.allHandles().map((h) => h.el).filter((e): e is HTMLVideoElement => !!e);
    await Promise.all(
      els.map(
        (el) =>
          new Promise<void>((res) => {
            const done = () => res();
            if (!el.seeking && el.readyState >= 2 && !el.paused) return res();
            if (!el.seeking && el.readyState >= 2 && el.paused) return res();
            el.addEventListener("seeked", done, { once: true });
            el.addEventListener("canplay", done, { once: true });
            setTimeout(done, timeoutMs);
          }),
      ),
    );
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.pool.dispose();
  }
}
