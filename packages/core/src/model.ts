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

export type Clip = VideoClip | AudioClip | TextClip;

interface ClipBase {
  id: ClipId;
  /** Position on the timeline. */
  start: TimeTicks;
  /** Length on the timeline. */
  duration: TimeTicks;
  transform: Keyframed<Transform>;
  effects: EffectInstance[];
  enabled: boolean;
}

export interface VideoClip extends ClipBase {
  kind: "video";
  assetId: AssetId;
  /** In/out points in source media time. */
  sourceIn: TimeTicks;
  sourceOut: TimeTicks;
  /** Playback rate; negative = reverse. */
  speed: number;
  gain: number; // linear multiplier, 1 = unity
}

export interface AudioClip extends ClipBase {
  kind: "audio";
  assetId: AssetId;
  sourceIn: TimeTicks;
  sourceOut: TimeTicks;
  speed: number;
  gain: number;
  pan: number; // -1..1
}

export interface TextClip extends ClipBase {
  kind: "text";
  content: string;
  style: TextStyle;
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

export interface Keyframe<T> {
  at: TimeTicks; // clip-local time (0 = clip start)
  value: T;
  /** Interpolation to next key. */
  ease: "linear" | "hold";
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
    schemaVersion: 1,
    settings: {
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      sampleRate: 48_000,
      ...over,
    },
    assets: {},
    tracks: [],
  };
}

export function createTrack(kind: Track["kind"], name: string, id: TrackId): Track {
  return { id, kind, name, clips: [], muted: false, locked: false };
}
