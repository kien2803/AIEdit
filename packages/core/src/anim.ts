import type { Keyframed } from "./model.js";
import type { TimeTicks } from "./time.js";

/** Sample a Keyframed value at clip-local time. Numbers interpolate linearly. */
export function sample<T>(k: Keyframed<T>, at: TimeTicks): T {
  if ("static" in k) return k.static;
  const keys = k.keys;
  if (keys.length === 0) throw new Error("Keyframed with no keys");
  if (at <= keys[0]!.at) return keys[0]!.value;
  const last = keys[keys.length - 1]!;
  if (at >= last.at) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (at >= a.at && at < b.at) {
      if (a.ease === "hold") return a.value;
      const f = (at - a.at) / (b.at - a.at);
      return lerpValue(a.value, b.value, f);
    }
  }
  return last.value;
}

function lerpValue(a: unknown, b: unknown, f: number): never {
  if (typeof a === "number" && typeof b === "number") {
    return (a + (b - a) * f) as never;
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const out: Record<string, number> = {};
    for (const k of Object.keys(a as Record<string, number>)) {
      const va = (a as Record<string, number>)[k] ?? 0;
      const vb = (b as Record<string, number>)[k] ?? va;
      out[k] = va + (vb - va) * f;
    }
    return out as never;
  }
  return a as never;
}
