import type { AssetId, Clip, MediaAsset } from "@aiedit/core";

export interface MediaHandle {
  clipId: string;
  el: HTMLVideoElement;
  /** For text/scene clips: a 2D canvas rendered by the compositor. */
  canvas?: HTMLCanvasElement;
}

/**
 * One media element per clip instance (not per asset) — two clips from the
 * same asset at different source points need independent playheads.
 * Elements are pooled by clip id and released when the clip leaves range.
 */
export class MediaPool {
  private handles = new Map<string, MediaHandle>();
  private assetOf = new Map<string, MediaAsset>();

  registerAsset(a: MediaAsset): void {
    this.assetOf.set(a.id, a);
  }

  /** Element for this clip, creating it lazily. Returns undefined for text clips. */
  ensure(clip: Clip, assetId?: AssetId): MediaHandle | undefined {
    const existing = this.handles.get(clip.id);
    if (existing) return existing;
    if (clip.kind === "text" || clip.kind === "scene") {
      const h: MediaHandle = { clipId: clip.id, el: undefined as never, canvas: document.createElement("canvas") };
      this.handles.set(clip.id, h);
      return h;
    }
    if (clip.kind === "adjustment") {
      const h: MediaHandle = { clipId: clip.id, el: undefined as never };
      this.handles.set(clip.id, h);
      return h;
    }
    const id = assetId ?? (clip as { assetId: string }).assetId;
    const asset = this.assetOf.get(id);
    if (!asset) return undefined;
    const el = document.createElement("video");
    el.src = asset.proxyUrl ?? asset.sourceUrl;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.playsInline = true;
    const h: MediaHandle = { clipId: clip.id, el };
    this.handles.set(clip.id, h);
    return h;
  }

  get(clipId: string): MediaHandle | undefined {
    return this.handles.get(clipId);
  }

  /** Element-level media (footage inside scenes), keyed independently of clips. */
  ensureKey(key: string, assetId: string): MediaHandle | undefined {
    const existing = this.handles.get(key);
    if (existing) return existing;
    const asset = this.assetOf.get(assetId);
    if (!asset) return undefined;
    const el = document.createElement("video");
    el.src = asset.proxyUrl ?? asset.sourceUrl;
    el.preload = "auto";
    el.playsInline = true;
    const h: MediaHandle = { clipId: key, el };
    this.handles.set(key, h);
    return h;
  }

  /** Drop handles for clips no longer active. */
  retain(activeClipIds: Set<string>): void {
    for (const [id, h] of this.handles) {
      if (!activeClipIds.has(id)) {
        h.el?.pause();
        h.el?.removeAttribute("src");
        h.el?.load();
        this.handles.delete(id);
      }
    }
  }

  allHandles(): MediaHandle[] {
    return [...this.handles.values()];
  }

  dispose(): void {
    this.retain(new Set());
  }
}
