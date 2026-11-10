import type { Clip, Project, Scene, Track } from "@aiedit/core";
import { clipEnd, findElementIn, newId, ticks } from "@aiedit/core";
import type { ParamBinding, Template, TemplateParam, TimeRule } from "./types.js";

export interface CaptureOptions {
  name: string;
  category?: string;
  tags?: string[];
}

/**
 * Snapshot the selected clips into a Template: zero-based structure +
 * auto-inferred params/bindings/time-rules. The user confirms the inferred
 * params in the UI before saving.
 */
export function captureTemplate(project: Project, clipIds: string[], opts: CaptureOptions): Template {
  const idSet = new Set(clipIds);
  const tracks: Track[] = [];
  const scenes: Record<string, Scene> = {};
  const params: TemplateParam[] = [];
  const bindings: ParamBinding[] = [];
  const timeRules: TimeRule[] = [];

  // collect selected clips per track, preserving track order
  const sourceTracks = project.tracks
    .map((tr) => ({ tr, clips: tr.clips.filter((c) => idSet.has(c.id)) }))
    .filter((g) => g.clips.length > 0);
  if (sourceTracks.length === 0) throw new Error("nothing selected");

  const t0 = Math.min(...sourceTracks.flatMap((g) => g.clips.map((c) => c.start)));

  let pCount = 0;
  for (const { tr, clips } of sourceTracks) {
    const newTrack: Track = {
      id: tr.id, // keep nodeId = original id for binding stability
      kind: tr.kind,
      name: tr.name,
      clips: [],
      muted: false,
      locked: false,
    };
    for (const clip of clips) {
      const copy = JSON.parse(JSON.stringify(clip)) as Clip;
      copy.start -= t0;
      newTrack.clips.push(copy);

      // infer params
      if (clip.kind === "video" || clip.kind === "audio") {
        const key = `footage${++pCount}`;
        params.push({
          key,
          label: `Footage ${pCount}`,
          type: "footage",
          required: true,
        });
        bindings.push({ paramKey: key, nodeId: clip.id, field: { kind: "assetId" } });
        timeRules.push({ nodeId: clip.id, elasticity: { kind: "stretch" } });
      } else if (clip.kind === "text") {
        const key = `text${++pCount}`;
        params.push({
          key,
          label: `Text ${pCount}`,
          type: "text",
          required: false,
          defaultValue: clip.content,
        });
        bindings.push({ paramKey: key, nodeId: clip.id, field: { kind: "textContent" } });
        timeRules.push({ nodeId: clip.id, elasticity: { kind: "fixed" } });
      } else {
        timeRules.push({ nodeId: clip.id, elasticity: { kind: "fixed" } });
      }

      if (clip.kind === "scene" && project.scenes[clip.sceneId]) {
        scenes[clip.sceneId] = JSON.parse(JSON.stringify(project.scenes[clip.sceneId])) as Scene;
        // text elements inside captured scenes become text params too
        const scene = project.scenes[clip.sceneId]!;
        const walk = (els: typeof scene.elements) => {
          for (const el of els) {
            if (el.kind === "text") {
              const key = `text${++pCount}`;
              params.push({ key, label: `Text ${pCount}`, type: "text", required: false, defaultValue: el.content });
              bindings.push({ paramKey: key, nodeId: el.id, field: { kind: "textContent" } });
            }
            if (el.kind === "group") walk(el.elements);
          }
        };
        walk(scene.elements);
      }
    }
    tracks.push(newTrack);
  }

  return {
    schemaVersion: 1,
    id: newId("tpl"),
    name: opts.name,
    meta: {
      ...(opts.category ? { category: opts.category } : {}),
      tags: opts.tags ?? [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      kind: "timeline-fragment",
    },
    root: { tracks, scenes },
    params,
    bindings,
    timeRules,
  };
}
