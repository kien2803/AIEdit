import type { AudioClip, Clip, MediaAsset, Project, VideoClip } from "@aiedit/core";
import { clipEnd, sourceTimeAt, ticks, timelineEnd } from "@aiedit/core";
import type { TimeTicks } from "@aiedit/core";
import { PlaybackClock } from "./clock.js";
import { Compositor } from "./compositor.js";
import { MediaPool } from "./mediaPool.js";
import { activeClipsAt } from "./resolve.js";

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
    this.compositor.clear();

    // Draw order: tracks[0] is topmost -> draw last. Visual kinds only.
    const visual = active.filter(({ clip }) => clip.kind !== "audio");
    for (let i = visual.length - 1; i >= 0; i--) {
      const { clip } = visual[i]!;
      activeIds.add(clip.id);
      const handle = this.pool.ensure(clip);
      if (!handle) continue;

      if (clip.kind === "text") {
        const cnv = this.renderText(clip);
        this.compositor.drawClip(clip, handle, cnv, cnv.width, cnv.height, t);
      } else {
        const el = handle.el;
        if (!el) continue;
        this.syncElement(el, clip, t);
        if (el.readyState >= 2) {
          this.compositor.drawClip(clip, handle, el, el.videoWidth || 16, el.videoHeight || 9, t);
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
          this.applyAudioState(handle.el, clip, track.muted);
        }
      } else if (clip.kind === "video") {
        const el = this.pool.get(clip.id)?.el;
        if (el) this.applyAudioState(el, clip, track.muted);
      }
    }

    this.pool.retain(activeIds);
  }

  private syncElement(el: HTMLVideoElement, clip: VideoClip | AudioClip, t: TimeTicks): void {
    const expected = ticks.toSeconds(sourceTimeAt(clip, t));
    const playing = this.clock.playing;
    const rate = Math.abs(clip.speed) * this.clock.rate;

    if (playing && clip.speed >= 0) {
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

  private applyAudioState(el: HTMLVideoElement, clip: VideoClip | AudioClip, trackMuted: boolean): void {
    el.muted = trackMuted || !clip.enabled || clip.gain <= 0;
    el.volume = Math.max(0, Math.min(1, clip.gain));
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

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.pool.dispose();
  }
}
