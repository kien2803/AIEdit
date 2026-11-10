import type { Clip, Op, Project, Track } from "@aiedit/core";
import { findElementIn, newId } from "@aiedit/core";
import type { ParamValues, Template } from "./types.js";

export interface InstantiateResult {
  ops: Op[];
  warnings: string[];
  /** map: template nodeId -> instantiated clip id (useful for tests/UI). */
  nodeMap: Map<string, string>;
}

/**
 * Instantiate a template at timeline position `at` → Op[] the caller dispatches.
 * Creates fresh tracks (so placement never collides) + embedded scenes +
 * bound clips with param values applied and time rules resolved.
 */
export function instantiateTemplate(
  tpl: Template,
  values: ParamValues,
  project: Project,
  at: number,
): InstantiateResult {
  const warnings: string[] = [];

  // ---- validate params ----
  for (const p of tpl.params) {
    const v = values[p.key];
    if (p.required && !v) throw new Error(`missing required param "${p.key}"`);
    if (v?.kind === "footage" && !project.assets[v.assetId]) {
      throw new Error(`footage param "${p.key}": unknown asset ${v.assetId}`);
    }
    if (v?.kind === "footage") {
      const asset = project.assets[v.assetId]!;
      const durSec = asset.durationTicks !== undefined ? asset.durationTicks / 90_000 : 0;
      const min = p.constraints?.minDurationSec;
      if (min !== undefined && durSec < min) {
        warnings.push(`"${p.key}": footage ${durSec.toFixed(1)}s < required ${min}s`);
      }
    }
    if (v?.kind === "text" && p.constraints?.maxLength && v.text.length > p.constraints.maxLength) {
      warnings.push(`"${p.key}": text truncated to ${p.constraints.maxLength} chars`);
      v.text = v.text.slice(0, p.constraints.maxLength);
    }
  }

  const nodeMap = new Map<string, string>();
  const footageParamOf = new Map<string, string>(); // nodeId -> paramKey
  for (const b of tpl.bindings) {
    if (b.field.kind === "assetId") footageParamOf.set(b.nodeId, b.paramKey);
  }
  const ruleOf = new Map(tpl.timeRules.map((r) => [r.nodeId, r.elasticity]));

  const ops: Op[] = [];

  // ---- scenes first (clips reference them) ----
  for (const [oldId, scene] of Object.entries(tpl.root.scenes)) {
    const s = JSON.parse(JSON.stringify(scene)) as typeof scene;
    const newSceneId = newId("scene");
    s.id = newSceneId;
    // remap element ids + apply text bindings
    const remap = (els: typeof s.elements) => {
      for (const el of els) {
        const oldElId = el.id;
        el.id = newId("el");
        nodeMap.set(oldElId, el.id);
        const b = tpl.bindings.find((b) => b.nodeId === oldElId);
        if (b && el.kind === "text") {
          const v = values[b.paramKey];
          if (v?.kind === "text") el.content = v.text;
        }
        if (el.kind === "group") remap(el.elements);
      }
    };
    remap(s.elements);
    nodeMap.set(oldId, newSceneId);
    ops.push({ type: "scene.upsert", scene: s });
  }

  // ---- per track: new track + clips with time-rule propagation ----
  for (const tTrack of tpl.root.tracks) {
    const trackId = newId("track");
    ops.push({
      type: "track.add",
      track: { id: trackId, kind: tTrack.kind, name: tTrack.name, clips: [], muted: false, locked: false },
    });

    const sorted = [...tTrack.clips].sort((a, b) => a.start - b.start);
    let shift = 0; // accumulated time shift from stretch rules
    for (const tClip of sorted) {
      const clip = JSON.parse(JSON.stringify(tClip)) as Clip;
      const newClipId = newId("clip");
      nodeMap.set(tClip.id, newClipId);
      clip.id = newClipId;
      clip.start += shift;

      const rule = ruleOf.get(tClip.id)?.kind ?? "fixed";
      const fp = footageParamOf.get(tClip.id);
      const footageVal = fp ? values[fp] : undefined;

      if ((clip.kind === "video" || clip.kind === "audio") && fp) {
        if (footageVal?.kind === "footage") {
          const asset = project.assets[footageVal.assetId]!;
          clip.assetId = footageVal.assetId;
          const dur = asset.durationTicks ?? tClip.duration;
          clip.sourceIn = 0;
          clip.speed = 1;
          if (rule === "stretch") {
            clip.sourceOut = dur;
            clip.duration = dur;
          } else if (rule === "fit") {
            clip.sourceOut = dur;
            clip.speed = dur / tClip.duration; // squeeze/stretch footage into slot
            clip.duration = tClip.duration;
          } else {
            clip.sourceOut = Math.min(dur, tClip.duration);
            clip.duration = Math.min(dur, tClip.duration);
          }
          shift += clip.duration - tClip.duration;
        } else if (footageVal === undefined && tpl.params.find((p) => p.key === fp)?.required) {
          // required footage not provided — keep original assetId reference (may be dead)
          warnings.push(`param "${fp}": no footage provided, keeping template reference`);
        }
      }

      // text / other bindings on clips
      for (const b of tpl.bindings.filter((b) => b.nodeId === tClip.id)) {
        if (b.field.kind === "textContent" && clip.kind === "text") {
          const v = values[b.paramKey];
          if (v?.kind === "text") clip.content = v.text;
        }
        if (b.field.kind === "clipDuration") {
          const v = values[b.paramKey];
          if (v?.kind === "duration") {
            shift += v.ticks - clip.duration;
            clip.duration = v.ticks;
          }
        }
        if (b.field.kind === "effectParam") {
          const v = values[b.paramKey];
          const e = clip.effects.find((e) => e.id === (b.field as { effectId: string }).effectId);
          if (e && v?.kind === "number") e.params[(b.field as { param: string }).param] = v.value;
        }
      }

      if (clip.kind === "scene" && tClip.kind === "scene") {
        clip.sceneId = nodeMap.get(tClip.sceneId) ?? tClip.sceneId;
      }
      clip.start += at;
      ops.push({ type: "clip.add", trackId, clip });
    }
  }

  return { ops, warnings, nodeMap };
}
