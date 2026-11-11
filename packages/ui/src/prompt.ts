import type { ClipId, Project, TimeTicks } from "@aiedit/core";

/** Minimal state handed to the prompt parser (and later, the real model). */
export interface EditorSnapshot {
  project: Project;
  playhead: TimeTicks;
  selection: ClipId[];
}
