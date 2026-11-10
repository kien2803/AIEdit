import type { EaseSpec, Project } from "./model.js";

/**
 * Forward-migrate project documents to the current schemaVersion.
 * v1 -> v2: ease strings become EaseSpec objects; `scenes` map added.
 */
export function migrateProject(p: Project): Project {
  if (p.schemaVersion >= 2) return p;
  p.scenes ??= {};
  const migrateEase = (e: unknown): EaseSpec => {
    if (typeof e === "string") return { kind: e as "linear" | "hold" };
    return e as EaseSpec;
  };
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o["at"] === "number" && "ease" in o) o["ease"] = migrateEase(o["ease"]);
    for (const val of Object.values(o)) walk(val);
  };
  walk(p.tracks);
  p.schemaVersion = 2;
  return p;
}
