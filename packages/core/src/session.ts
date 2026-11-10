import type { OpBatch } from "./ops.js";
import type { Project } from "./model.js";

/**
 * Export a session's op log as JSONL — one OpBatch per line.
 * This is the raw behavioral corpus: "editor at state X with playhead/selection
 * context performed ops Y". Analysis features are attached to assets, so the
 * same context the AI will later consume is embedded in each sample.
 */
export function exportSessionLog(log: readonly OpBatch[]): string {
  return log.map((b) => JSON.stringify(b)).join("\n");
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 2);
}

export function deserializeProject(json: string): Project {
  const p = JSON.parse(json) as Project;
  if (typeof p.schemaVersion !== "number") throw new Error("bad project file");
  return p;
}
