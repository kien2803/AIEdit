import { produce, type Draft } from "immer";
import type {
  AudioClip, Clip, ClipId, EffectInstance, MediaAsset, Project, TextClip, TextStyle, Track, TrackId, VideoClip,
} from "./model.js";
import { DEFAULT_TRANSFORM } from "./model.js";
import type { TimeTicks } from "./time.js";
import { clipEnd, findClip, findTrack, sourceTimeAt } from "./query.js";
import { newId } from "./id.js";

/**
 * Every edit is an immutable Operation. The dispatcher records ops + context;
 * that append-only log is what later becomes behavioral training data.
 */
export type Op =
  | { type: "asset.add"; asset: MediaAsset }
  | { type: "asset.remove"; assetId: string }
  | { type: "track.add"; track: Track }
  | { type: "track.remove"; trackId: TrackId }
  | { type: "track.set"; trackId: TrackId; patch: Partial<Pick<Track, "name" | "muted" | "locked">> }
  | { type: "clip.add"; trackId: TrackId; clip: Clip }
  | { type: "clip.remove"; clipId: ClipId }
  /** Replace the whole clip object — generic escape hatch; also the universal inverse. */
  | { type: "clip.replace"; clipId: ClipId; clip: Clip }
  | { type: "clip.move"; clipId: ClipId; start: TimeTicks; trackId?: TrackId }
  /** delta is timeline ticks; positive 'in' trims later, positive 'out' extends. */
  | { type: "clip.trim"; clipId: ClipId; edge: "in" | "out"; delta: TimeTicks }
  | { type: "clip.split"; clipId: ClipId; at: TimeTicks; newClipId?: ClipId }
  | { type: "clip.setSpeed"; clipId: ClipId; speed: number }
  | { type: "clip.set"; clipId: ClipId; patch: ClipPatch }
  | { type: "effect.add"; clipId: ClipId; effect: EffectInstance }
  | { type: "effect.remove"; clipId: ClipId; effectId: string }
  | { type: "effect.setParam"; clipId: ClipId; effectId: string; key: string; value: number };

export interface ClipPatch {
  enabled?: boolean;
  gain?: number;
  pan?: number;
  content?: string;
  textStyle?: Partial<TextStyle>;
  /** Replace transform with a static value (keyframe editing comes later). */
  transform?: Clip["transform"];
}

/** Context recorded with every dispatched batch — the future training signal. */
export interface EditContext {
  playheadAt: TimeTicks;
  selection: ClipId[];
  activeTool: string;
  sessionId: string;
  timestamp: number;
}

export interface OpBatch {
  ops: Op[];
  inverse: Op[];
  context: EditContext;
  label: string;
}

export function defaultContext(partial: Partial<EditContext> = {}): EditContext {
  return {
    playheadAt: 0,
    selection: [],
    activeTool: "select",
    sessionId: "unknown",
    timestamp: Date.now(),
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// apply + inverse
// ---------------------------------------------------------------------------

function isMediaClip(c: Clip): c is VideoClip | AudioClip {
  return c.kind === "video" || c.kind === "audio";
}

function assertValid(p: Project, op: Op): void {
  switch (op.type) {
    case "clip.add": {
      const clip = op.clip;
      if (clip.duration <= 0) throw new Error("clip.add: duration must be > 0");
      if (isMediaClip(clip)) {
        if (!p.assets[clip.assetId]) throw new Error(`clip.add: unknown asset ${clip.assetId}`);
        if (clip.sourceOut <= clip.sourceIn) throw new Error("clip.add: sourceOut <= sourceIn");
        const dur = p.assets[clip.assetId]!.durationTicks;
        if (dur !== undefined && clip.sourceOut > dur + 1) {
          throw new Error("clip.add: sourceOut beyond asset duration");
        }
      }
      break;
    }
    case "clip.trim": {
      const loc = findClip(p, op.clipId);
      if (!loc) throw new Error(`clip.trim: unknown clip ${op.clipId}`);
      const c = loc.clip;
      if (op.edge === "in") {
        const newDur = c.duration - op.delta;
        if (newDur <= 0) throw new Error("clip.trim: would produce non-positive duration");
        if (isMediaClip(c) && c.sourceIn + Math.round(op.delta * Math.abs(c.speed)) < 0) {
          throw new Error("clip.trim: sourceIn out of range");
        }
      } else {
        const newDur = c.duration + op.delta;
        if (newDur <= 0) throw new Error("clip.trim: would produce non-positive duration");
      }
      break;
    }
    case "clip.split": {
      const loc = findClip(p, op.clipId);
      if (!loc) throw new Error(`clip.split: unknown clip ${op.clipId}`);
      const c = loc.clip;
      if (op.at <= c.start || op.at >= clipEnd(c)) {
        throw new Error("clip.split: at must be strictly inside the clip");
      }
      break;
    }
    case "clip.setSpeed": {
      if (op.speed === 0 || !Number.isFinite(op.speed)) throw new Error("clip.setSpeed: bad speed");
      break;
    }
    default:
      break;
  }
}

function applyOne(d: Draft<Project>, op: Op): void {
  switch (op.type) {
    case "asset.add":
      d.assets[op.asset.id] = op.asset as Draft<MediaAsset>;
      break;
    case "asset.remove":
      delete d.assets[op.assetId];
      break;
    case "track.add":
      d.tracks.push(op.track);
      break;
    case "track.remove": {
      const i = d.tracks.findIndex((t) => t.id === op.trackId);
      if (i >= 0) d.tracks.splice(i, 1);
      break;
    }
    case "track.set": {
      const t = d.tracks.find((t) => t.id === op.trackId);
      if (t) Object.assign(t, op.patch);
      break;
    }
    case "clip.add": {
      const t = d.tracks.find((t) => t.id === op.trackId);
      if (!t) throw new Error(`clip.add: unknown track ${op.trackId}`);
      t.clips.push(op.clip as Draft<Clip>);
      t.clips.sort((a, b) => a.start - b.start);
      break;
    }
    case "clip.remove": {
      for (const t of d.tracks) {
        const i = t.clips.findIndex((c) => c.id === op.clipId);
        if (i >= 0) {
          t.clips.splice(i, 1);
          break;
        }
      }
      break;
    }
    case "clip.replace": {
      for (const t of d.tracks) {
        const i = t.clips.findIndex((c) => c.id === op.clipId);
        if (i >= 0) {
          t.clips[i] = op.clip as Draft<Clip>;
          t.clips.sort((a, b) => a.start - b.start);
          break;
        }
      }
      break;
    }
    case "clip.move": {
      const loc = locate(d, op.clipId);
      loc.clip.start = op.start;
      if (op.trackId && op.trackId !== loc.track.id) {
        const target = d.tracks.find((t) => t.id === op.trackId);
        if (!target) throw new Error(`clip.move: unknown track ${op.trackId}`);
        loc.track.clips.splice(loc.clipIndex, 1);
        target.clips.push(loc.clip);
      }
      loc.track.clips.sort((a, b) => a.start - b.start);
      break;
    }
    case "clip.trim": {
      const loc = locate(d, op.clipId);
      const c = loc.clip;
      if (op.edge === "in") {
        if (isMediaClip(c)) c.sourceIn += Math.round(op.delta * Math.abs(c.speed));
        c.start += op.delta;
        c.duration -= op.delta;
      } else {
        c.duration += op.delta;
        if (isMediaClip(c)) c.sourceOut += Math.round(op.delta * Math.abs(c.speed));
      }
      break;
    }
    case "clip.split": {
      const loc = locate(d, op.clipId);
      const c = loc.clip;
      const right: Clip = splitClip(c, op.at, op.newClipId ?? newId("clip"));
      loc.track.clips.splice(loc.clipIndex + 1, 0, right as Draft<Clip>);
      break;
    }
    case "clip.setSpeed": {
      const loc = locate(d, op.clipId);
      const c = loc.clip;
      if (!isMediaClip(c)) throw new Error("clip.setSpeed: not a media clip");
      c.speed = op.speed;
      c.sourceOut = c.sourceIn + Math.round(c.duration * Math.abs(op.speed));
      break;
    }
    case "clip.set": {
      const loc = locate(d, op.clipId);
      const c = loc.clip;
      const p = op.patch;
      if (p.enabled !== undefined) c.enabled = p.enabled;
      if (p.transform !== undefined) c.transform = p.transform as Draft<Clip["transform"]>;
      if (isMediaClip(c) && p.gain !== undefined) c.gain = p.gain;
      if (c.kind === "audio" && p.pan !== undefined) c.pan = p.pan;
      if (c.kind === "text") {
        if (p.content !== undefined) c.content = p.content;
        if (p.textStyle) Object.assign(c.style, p.textStyle);
      }
      break;
    }
    case "effect.add": {
      const loc = locate(d, op.clipId);
      loc.clip.effects.push(op.effect as Draft<EffectInstance>);
      break;
    }
    case "effect.remove": {
      const loc = locate(d, op.clipId);
      const i = loc.clip.effects.findIndex((e) => e.id === op.effectId);
      if (i >= 0) loc.clip.effects.splice(i, 1);
      break;
    }
    case "effect.setParam": {
      const loc = locate(d, op.clipId);
      const e = loc.clip.effects.find((e) => e.id === op.effectId);
      if (e) e.params[op.key] = op.value;
      break;
    }
  }
}

function locate(d: Draft<Project>, clipId: ClipId) {
  for (const t of d.tracks) {
    const i = t.clips.findIndex((c) => c.id === clipId);
    if (i >= 0) return { track: t, clip: t.clips[i]!, clipIndex: i };
  }
  throw new Error(`unknown clip ${clipId}`);
}

/** Split clip c at timeline time `at`; mutates c (left part) and returns the right part. */
function splitClip(c: Clip, at: TimeTicks, rightId: ClipId): Clip {
  const leftDur = at - c.start;
  const rightDur = c.start + c.duration - at;

  const right = JSON.parse(JSON.stringify(c)) as Clip;
  right.id = rightId;
  right.start = at;
  right.duration = rightDur;
  if (isMediaClip(c) && isMediaClip(right)) {
    const mid = sourceTimeAt(c, at);
    right.sourceIn = mid;
    right.sourceOut = c.sourceOut;
    c.sourceOut = mid;
  }
  c.duration = leftDur;
  return right;
}

// ---------------------------------------------------------------------------
// inverse computation (runs against pre-state)
// ---------------------------------------------------------------------------

function inverseOf(p: Project, op: Op): Op[] {
  switch (op.type) {
    case "asset.add":
      return [{ type: "asset.remove", assetId: op.asset.id }];
    case "asset.remove": {
      const a = p.assets[op.assetId];
      return a ? [{ type: "asset.add", asset: snapshot(a) }] : [];
    }
    case "track.add":
      return [{ type: "track.remove", trackId: op.track.id }];
    case "track.remove": {
      const t = findTrack(p, op.trackId);
      if (!t) return [];
      return [
        { type: "track.add", track: snapshot(t) },
        // track.add appends at end; restoring index would need extra op — accept for now
      ];
    }
    case "track.set": {
      const t = findTrack(p, op.trackId);
      if (!t) return [];
      const patch: Partial<Pick<Track, "name" | "muted" | "locked">> = {};
      for (const k of Object.keys(op.patch) as (keyof typeof patch)[]) {
        (patch as Record<string, unknown>)[k] = t[k];
      }
      return [{ type: "track.set", trackId: op.trackId, patch }];
    }
    case "clip.add":
      return [{ type: "clip.remove", clipId: op.clip.id }];
    case "clip.remove": {
      const loc = findClip(p, op.clipId);
      if (!loc) return [];
      return [{ type: "clip.add", trackId: loc.track.id, clip: snapshot(loc.clip) }];
    }
    case "clip.replace": {
      const loc = findClip(p, op.clipId);
      return loc ? [{ type: "clip.replace", clipId: op.clipId, clip: snapshot(loc.clip) }] : [];
    }
    case "clip.move": {
      const loc = findClip(p, op.clipId);
      if (!loc) return [];
      const inv: Op = { type: "clip.move", clipId: op.clipId, start: loc.clip.start };
      if (op.trackId) inv.trackId = loc.track.id;
      return [inv];
    }
    case "clip.trim":
      return [{ type: "clip.trim", clipId: op.clipId, edge: op.edge, delta: -op.delta }];
    case "clip.split": {
      const loc = findClip(p, op.clipId);
      if (!loc) return [];
      const rightId = op.newClipId ?? "(generated)";
      // We must know the generated id at dispatch time — dispatcher injects it.
      void rightId;
      return [{ type: "clip.replace", clipId: op.clipId, clip: snapshot(loc.clip) }, { type: "clip.remove", clipId: "" }];
    }
    case "clip.setSpeed": {
      const loc = findClip(p, op.clipId);
      if (!loc || !isMediaClip(loc.clip)) return [];
      return [{ type: "clip.setSpeed", clipId: op.clipId, speed: loc.clip.speed }];
    }
    case "clip.set": {
      const loc = findClip(p, op.clipId);
      if (!loc) return [];
      return [{ type: "clip.replace", clipId: op.clipId, clip: snapshot(loc.clip) }];
    }
    case "effect.add":
      return [{ type: "effect.remove", clipId: op.clipId, effectId: op.effect.id }];
    case "effect.remove": {
      const loc = findClip(p, op.clipId);
      const e = loc?.clip.effects.find((e) => e.id === op.effectId);
      return loc && e ? [{ type: "effect.add", clipId: op.clipId, effect: snapshot(e) }] : [];
    }
    case "effect.setParam": {
      const loc = findClip(p, op.clipId);
      const e = loc?.clip.effects.find((e) => e.id === op.effectId);
      const prev = e?.params[op.key];
      return prev !== undefined
        ? [{ type: "effect.setParam", clipId: op.clipId, effectId: op.effectId, key: op.key, value: prev }]
        : [];
    }
  }
}

function snapshot<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Apply a user-intent batch of ops. Returns next project + inverse ops (for undo).
 * Ops in a batch apply in order; inverse ops are stored in reverse order.
 */
export function applyOps(project: Project, ops: Op[]): { next: Project; inverse: Op[] } {
  // Fill in generated split ids up-front so inverses can reference them.
  const resolved = ops.map((op) =>
    op.type === "clip.split" && !op.newClipId ? { ...op, newClipId: newId("clip") } : op,
  );
  for (const op of resolved) assertValid(project, op);

  const inverse: Op[] = [];
  for (let i = resolved.length - 1; i >= 0; i--) {
    const inv = inverseOf(project, resolved[i]!);
    // fixup split inverse: replace placeholder with real id
    for (const io of inv) {
      if (io.type === "clip.remove" && io.clipId === "") {
        io.clipId = (resolved[i] as { newClipId: string }).newClipId;
      }
      inverse.push(io);
    }
  }

  const next = produce(project, (d) => {
    for (const op of resolved) applyOne(d, op);
  });
  return { next, inverse };
}

/** Apply inverse/undo ops (already computed). Does not produce new inverses. */
export function applyRaw(project: Project, ops: Op[]): Project {
  return produce(project, (d) => {
    for (const op of ops) applyOne(d, op);
  });
}

export function makeVideoClip(input: {
  id?: ClipId;
  assetId: string;
  start: TimeTicks;
  sourceIn: TimeTicks;
  sourceOut: TimeTicks;
  speed?: number;
}): VideoClip {
  const speed = input.speed ?? 1;
  return {
    kind: "video",
    id: input.id ?? newId("clip"),
    assetId: input.assetId,
    start: input.start,
    duration: Math.round((input.sourceOut - input.sourceIn) / Math.abs(speed)),
    sourceIn: input.sourceIn,
    sourceOut: input.sourceOut,
    speed,
    gain: 1,
    transform: { static: { ...DEFAULT_TRANSFORM } },
    effects: [],
    enabled: true,
  };
}

export function makeTextClip(input: {
  id?: ClipId;
  start: TimeTicks;
  duration: TimeTicks;
  content: string;
}): TextClip {
  return {
    kind: "text",
    id: input.id ?? newId("clip"),
    start: input.start,
    duration: input.duration,
    content: input.content,
    style: { fontFamily: "sans-serif", fontSize: 64, color: "#ffffff", align: "center" },
    transform: { static: { ...DEFAULT_TRANSFORM } },
    effects: [],
    enabled: true,
  };
}

export function makeAudioClip(input: {
  id?: ClipId;
  assetId: string;
  start: TimeTicks;
  sourceIn: TimeTicks;
  sourceOut: TimeTicks;
  speed?: number;
}): AudioClip {
  const speed = input.speed ?? 1;
  return {
    kind: "audio",
    id: input.id ?? newId("clip"),
    assetId: input.assetId,
    start: input.start,
    duration: Math.round((input.sourceOut - input.sourceIn) / Math.abs(speed)),
    sourceIn: input.sourceIn,
    sourceOut: input.sourceOut,
    speed,
    gain: 1,
    pan: 0,
    transform: { static: { ...DEFAULT_TRANSFORM } },
    effects: [],
    enabled: true,
  };
}
