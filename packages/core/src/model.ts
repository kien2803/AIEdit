import type { Rational, TimeTicks } from "./time.js";

export type AssetId = string;
export type TrackId = string;
export type ClipId = string;

/** Serializable project document — the declarative "edit decision list". */
export interface Project {
  schemaVersion: number;
  settings: {
    fps: Rational;
    width: number;
    height: number;
    sampleRate: number;
  };
  assets: Record<AssetId, MediaAsset>;
  scenes: Record<SceneId, Scene>;
  tracks: Track[]; // index 0 = topmost video track
}

export interface MediaAsset {
  id: AssetId;
  name: string;
  kind: "video" | "audio" | "image";
  /** blob: URL, file:// path, or remote URL — resolved by the engine layer. */
  sourceUrl: string;
  durationTicks?: TimeTicks;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  /** Lower-res stand-in for preview; original used on export. */
  proxyUrl?: string;
  /** Analysis outputs attached to this asset (silence, scenes, onsets...). */
  analysis?: AnalysisTrack[];
}

export interface AnalysisTrack {
  kind: "silence" | "scenes" | "onsets" | "speech" | "faces" | "motion";
  segments: { start: TimeTicks; end: TimeTicks; score: number; data?: unknown }[];
}

export interface Track {
  id: TrackId;
  kind: "video" | "audio" | "text";
  name: string;
  clips: Clip[];
  muted: boolean;
  locked: boolean;
}

export type SceneId = string;
export type Clip = VideoClip | AudioClip | TextClip | SceneClip | AdjustmentClip;

interface ClipBase {
  id: ClipId;
  /** Position on the timeline. */
  start: TimeTicks;
  /** Length on the timeline. */
  duration: TimeTicks;
  transform: Keyframed<Transform>;
  effects: EffectInstance[];
  enabled: boolean;
  /** Edge transitions (fade to content below / dip to black). A/B crossfade needs overlap. */
  transitions?: { in?: TransitionSpec; out?: TransitionSpec };
}

export interface TransitionSpec {
  type: "fade" | "dip-black";
  duration: TimeTicks;
}

export interface VideoClip extends ClipBase {
  kind: "video";
  assetId: AssetId;
  /** In/out points in source media time. */
  sourceIn: TimeTicks;
  sourceOut: TimeTicks;
  /** Playback rate; negative = reverse. Ignored when timeRemap is set. */
  speed: number;
  /** Speed ramp / freeze frame: clip-local ticks -> source ticks (absolute). */
  timeRemap?: Keyframed<TimeTicks>;
  gain: number; // linear multiplier, 1 = unity
  /** Audio fade durations at clip edges (CapCut-style). */
  fadeIn?: TimeTicks;
  fadeOut?: TimeTicks;
}

export interface AudioClip extends ClipBase {
  kind: "audio";
  assetId: AssetId;
  sourceIn: TimeTicks;
  sourceOut: TimeTicks;
  speed: number;
  timeRemap?: Keyframed<TimeTicks>;
  gain: number;
  pan: number; // -1..1
  fadeIn?: TimeTicks;
  fadeOut?: TimeTicks;
}

export interface TextClip extends ClipBase {
  kind: "text";
  content: string;
  style: TextStyle;
}

export interface SceneClip extends ClipBase {
  kind: "scene";
  sceneId: SceneId;
}

/** Applies its effects to everything rendered below it in the stack. */
export interface AdjustmentClip extends ClipBase {
  kind: "adjustment";
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number; // px at project resolution
  color: string;
  align: "left" | "center" | "right";
}

export interface Transform {
  /** Center position in project pixels (origin = frame center). */
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** Radians. */
  rotation: number;
  opacity: number; // 0..1
}

export type Keyframed<T> =
  | { static: T }
  | { keys: Keyframe<T>[] };

export type EaseSpec =
  | { kind: "linear" }
  | { kind: "hold" }
  | { kind: "bezier"; cx1: number; cy1: number; cx2: number; cy2: number }
  | { kind: "spring"; stiffness: number; damping: number };

export interface Keyframe<T> {
  at: TimeTicks; // clip-local time (0 = clip start)
  value: T;
  /** Interpolation to next key. */
  ease: EaseSpec;
}

export interface EffectInstance {
  id: string;
  /** Registry type id, e.g. "color.basic". */
  type: string;
  params: Record<string, number>;
  enabled: boolean;
}

export const DEFAULT_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  opacity: 1,
};

export function createProject(over: Partial<Project["settings"]> = {}): Project {
  return {
    schemaVersion: 2,
    settings: {
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      sampleRate: 48_000,
      ...over,
    },
    assets: {},
    scenes: {},
    tracks: [],
  };
}

export function createTrack(kind: Track["kind"], name: string, id: TrackId): Track {
  return { id, kind, name, clips: [], muted: false, locked: false };
}


// ---------------------------------------------------------------------------
// Scenes — nested compositions (motion graphics). Pure data, renderer-agnostic.
// ---------------------------------------------------------------------------

export interface Scene {
  id: SceneId;
  name: string;
  /** Scene duration in its own tick domain. */
  duration: TimeTicks;
  /** Draw order: index 0 = bottommost. */
  elements: SceneElement[];
}

export type SceneElement =
  | ShapeElement
  | SceneTextElement
  | FootageElement
  | GroupElement
  | EmitterElement;

interface ElementBase {
  id: string;
  name: string;
  /** Active window inside the scene's own timeline. */
  start: TimeTicks;
  end: TimeTicks;
  transform: Keyframed<Transform>;
  enabled: boolean;
}

export interface ShapeElement extends ElementBase {
  kind: "shape";
  shape: "rect" | "ellipse";
  fill: string;
  w: number;
  h: number;
  cornerRadius?: number;
}

export interface SceneTextElement extends ElementBase {
  kind: "text";
  content: string;
  style: TextStyle;
  /** Per-range animators (AE-style); renderer may support a subset. */
  animators?: TextAnimator[];
}

export interface TextAnimator {
  selector: "chars" | "words";
  range: [number, number]; // fraction of units affected
  animate: Partial<Pick<Transform, "x" | "y" | "rotation" | "scaleX" | "scaleY" | "opacity">>;
}

export interface FootageElement extends ElementBase {
  kind: "footage";
  assetId: AssetId;
  sourceIn: TimeTicks;
  sourceOut: TimeTicks;
  speed: number;
}

export interface GroupElement extends ElementBase {
  kind: "group";
  elements: SceneElement[];
}

export interface EmitterElement extends ElementBase {
  kind: "emitter";
  particle: ParticleSpec;
}

export interface ParticleSpec {
  rate: number;        // particles/sec
  lifetime: number;    // seconds
  speed: number;       // px/sec
  spread: number;      // radians
  direction: number;   // radians
  size: number;
  color: string;
  gravity: number;     // px/sec^2
}
