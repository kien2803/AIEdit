import type { Clip, Scene, Track, Transform, TimeTicks } from "@aiedit/core";

/**
 * A Template is a parameterized timeline fragment. Instantiation emits a plain
 * Op batch — so applying a template goes through the dispatcher and is logged
 * like any human edit (training data: structure + params + post-apply diffs).
 */
export interface Template {
  schemaVersion: number;
  id: string;
  name: string;
  meta: {
    author?: string;
    category?: string;
    tags: string[];
    createdAt: number;
    updatedAt: number;
    kind: "timeline-fragment";
  };
  /** Captured structure. Clip/scene ids here are "node ids" for bindings. */
  root: {
    tracks: Track[];         // clips reference scenes/assets by id
    scenes: Record<string, Scene>;
  };
  params: TemplateParam[];
  bindings: ParamBinding[];
  timeRules: TimeRule[];
}

export type ParamType = "footage" | "text" | "color" | "number" | "duration";

export interface TemplateParam {
  key: string;
  label: string;
  type: ParamType;
  required: boolean;
  defaultValue?: unknown;
  constraints?: {
    minDurationSec?: number;
    aspect?: "16:9" | "9:16" | "1:1" | "any";
    maxLength?: number;
    range?: [number, number];
  };
}

export type BoundField =
  | { kind: "assetId" }
  | { kind: "textContent" }
  | { kind: "effectParam"; effectId: string; param: string }
  | { kind: "clipDuration" };

export interface ParamBinding {
  paramKey: string;
  /** nodeId = the clip/element id inside root (stable, not index-based). */
  nodeId: string;
  field: BoundField;
}

/**
 * How a segment reacts when a bound param changes its natural duration —
 * "responsive design for time".
 */
export interface TimeRule {
  nodeId: string;
  elasticity:
    | { kind: "fixed" }
    | { kind: "stretch" }
    | { kind: "freeze"; at: "in" | "out" }
    | { kind: "loop" }
    | { kind: "fit" };
}

/** Values supplied at instantiation. */
export interface ParamValues {
  [paramKey: string]:
    | { kind: "footage"; assetId: string }
    | { kind: "text"; text: string }
    | { kind: "color"; color: string }
    | { kind: "number"; value: number }
    | { kind: "duration"; ticks: TimeTicks }
    | undefined;
}

export interface TemplateLibrary {
  [id: string]: Template;
}

export function serializeTemplate(t: Template): string {
  return JSON.stringify(t, null, 2);
}

export function deserializeTemplate(json: string): Template {
  const t = JSON.parse(json) as Template;
  if (typeof t.schemaVersion !== "number" || !t.root || !Array.isArray(t.params)) {
    throw new Error("bad template file");
  }
  return t;
}
