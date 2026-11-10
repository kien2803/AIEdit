import type { Project, Scene, SceneElement, TimeTicks } from "@aiedit/core";
import { sample, ticks, sourceTimeAt } from "@aiedit/core";
import type { FootageElement } from "@aiedit/core";

/**
 * 2D scene renderer (Canvas2D → texture). The SceneRenderer interface is what
 * PixiJS/Three.js implementations will implement later; the engine only knows
 * "render scene at scene-local time into a source the compositor can draw".
 */
export interface SceneRenderer {
  render(scene: Scene, t: TimeTicks, target: CanvasRenderingContext2D, ctx: SceneRenderContext): void;
}

export interface SceneRenderContext {
  project: Project;
  /** Resolve a media element for a footage element (keyed per element). */
  mediaFor(key: string, assetId: string): { el?: HTMLVideoElement } | undefined;
  syncMedia(el: HTMLVideoElement, sourceTicks: TimeTicks, playing: boolean, rate: number): void;
}

export class CanvasSceneRenderer implements SceneRenderer {
  render(scene: Scene, t: TimeTicks, ctx2d: CanvasRenderingContext2D, ctx: SceneRenderContext): void {
    const { project } = ctx;
    const W = project.settings.width, H = project.settings.height;
    ctx2d.save();
    ctx2d.translate(W / 2, H / 2); // element transforms are center-origin
    for (const el of scene.elements) {
      this.renderElement(el, t, ctx2d, ctx);
    }
    ctx2d.restore();
  }

  private renderElement(el: SceneElement, t: TimeTicks, ctx2d: CanvasRenderingContext2D, ctx: SceneRenderContext): void {
    if (!el.enabled || t < el.start || t >= el.end) return;
    const local = t - el.start;
    const tr = sample(el.transform, local);
    ctx2d.save();
    ctx2d.translate(tr.x, tr.y);
    ctx2d.rotate(tr.rotation);
    ctx2d.scale(tr.scaleX, tr.scaleY);
    ctx2d.globalAlpha *= Math.max(0, Math.min(1, tr.opacity));

    switch (el.kind) {
      case "shape": {
        ctx2d.fillStyle = el.fill;
        if (el.shape === "rect") {
          const r = el.cornerRadius ?? 0;
          if (r > 0) {
            ctx2d.beginPath();
            ctx2d.roundRect(-el.w / 2, -el.h / 2, el.w, el.h, r);
            ctx2d.fill();
          } else {
            ctx2d.fillRect(-el.w / 2, -el.h / 2, el.w, el.h);
          }
        } else {
          ctx2d.beginPath();
          ctx2d.ellipse(0, 0, el.w / 2, el.h / 2, 0, 0, Math.PI * 2);
          ctx2d.fill();
        }
        break;
      }
      case "text": {
        ctx2d.fillStyle = el.style.color;
        ctx2d.font = `${el.style.fontSize}px ${el.style.fontFamily}`;
        ctx2d.textAlign = el.style.align;
        ctx2d.textBaseline = "middle";
        ctx2d.fillText(el.content, 0, 0);
        break;
      }
      case "footage": {
        const handle = ctx.mediaFor(el.id, el.assetId);
        if (handle?.el && handle.el.readyState >= 2) {
          const src = el.sourceIn + Math.round(local * Math.abs(el.speed));
          ctx.syncMedia(handle.el, src, false, 0);
          const v = handle.el;
          const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
          const { project } = ctx;
          const fit = Math.min(project.settings.width / vw, project.settings.height / vh);
          ctx2d.drawImage(v, (-vw * fit) / 2, (-vh * fit) / 2, vw * fit, vh * fit);
        }
        break;
      }
      case "group": {
        for (const child of el.elements) this.renderElement(child, t, ctx2d, ctx);
        break;
      }
      case "emitter": {
        this.renderParticles(el, local, ctx2d);
        break;
      }
    }
    ctx2d.restore();
  }

  /** Deterministic particles: particle i born at i/rate, analytic position. */
  private renderParticles(el: Extract<SceneElement, { kind: "emitter" }>, local: TimeTicks, ctx2d: CanvasRenderingContext2D): void {
    const p = el.particle;
    const t = ticks.toSeconds(local);
    const first = Math.max(0, Math.ceil((t - p.lifetime) * p.rate));
    const last = Math.floor(t * p.rate);
    ctx2d.fillStyle = p.color;
    for (let i = first; i <= last; i++) {
      const age = t - i / p.rate;
      if (age < 0 || age > p.lifetime) continue;
      // deterministic per-particle direction jitter
      const jitter = ((i * 2654435761) % 1000) / 1000 - 0.5;
      const dir = p.direction + jitter * p.spread;
      const dist = p.speed * age;
      const x = Math.cos(dir) * dist;
      const y = Math.sin(dir) * dist + 0.5 * p.gravity * age * age;
      ctx2d.globalAlpha = Math.max(0, 1 - age / p.lifetime);
      ctx2d.beginPath();
      ctx2d.arc(x, y, p.size * (1 - (age / p.lifetime) * 0.5), 0, Math.PI * 2);
      ctx2d.fill();
    }
    ctx2d.globalAlpha = 1;
  }
}
