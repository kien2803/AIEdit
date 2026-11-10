import type { EaseSpec, Keyframe, Keyframed } from "./model.js";
import type { TimeTicks } from "./time.js";

/** Sample a Keyframed value at clip-local time. Numbers/objects interpolate. */
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
      const raw = (at - a.at) / (b.at - a.at);
      const f = eased(a.ease, raw);
      return lerpValue(a.value, b.value, f);
    }
  }
  return last.value;
}

function eased(ease: EaseSpec, t: number): number {
  switch (ease.kind) {
    case "hold": return 0;
    case "linear": return t;
    case "bezier": return cubicBezierY(ease.cx1, ease.cy1, ease.cx2, ease.cy2, t);
    case "spring": return springOut(t, ease.stiffness, ease.damping);
  }
}

/** Standard cubic-bezier(x1,y1,x2,y2) easing: solve curve parameter for x=t. */
export function cubicBezierY(x1: number, y1: number, x2: number, y2: number, t: number): number {
  const bx = (u: number) => 3 * u * (1 - u) * (1 - u) * x1 + 3 * u * u * (1 - u) * x2 + u * u * u;
  const by = (u: number) => 3 * u * (1 - u) * (1 - u) * y1 + 3 * u * u * (1 - u) * y2 + u * u * u;
  let u = t;
  for (let i = 0; i < 8; i++) {
    const err = bx(u) - t;
    if (Math.abs(err) < 1e-6) break;
    const d = 3 * (1 - u) * (1 - u) * x1 + 6 * u * (1 - u) * (x2 - x1) + 3 * u * u * (1 - x2);
    if (Math.abs(d) < 1e-6) break;
    u -= err / d;
  }
  return Math.max(0, Math.min(1, by(Math.max(0, Math.min(1, u)))));
}

/** Underdamped spring response, 0→1 with overshoot. stiffness ~ [20..300], damping ~ [2..20]. */
export function springOut(t: number, stiffness = 120, damping = 12): number {
  const T_END = 3; // compressed spring time at t=1
  const raw = springRaw(t * T_END, stiffness, damping);
  // normalize so springOut(1) === 1 exactly (spring hasn't fully settled at T_END)
  const norm = springRaw(T_END, stiffness, damping);
  return raw / norm;
}

function springRaw(ts: number, stiffness: number, damping: number): number {
  const w0 = Math.sqrt(Math.max(1, stiffness));
  const zeta = damping / (2 * w0);
  if (zeta >= 1) {
    const wd = w0 * Math.sqrt(zeta * zeta - 1);
    return 1 - Math.exp(-zeta * w0 * ts) * (Math.cosh(wd * ts) + (zeta * w0 / wd) * Math.sinh(wd * ts));
  }
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w0 * ts) * (Math.cos(wd * ts) + (zeta * w0 / wd) * Math.sin(wd * ts));
}

export function lerpValue(a: unknown, b: unknown, f: number): never {
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

// ---------------------------------------------------------------------------
// Keyframe editing helpers (used by ops)
// ---------------------------------------------------------------------------

const KEY_AT_TOLERANCE = 1000; // ~11ms — keys within this of `at` are "the same key"

export function toKeyframed<T>(k: Keyframed<T>): { keys: Keyframe<T>[] } {
  return "static" in k ? { keys: [{ at: 0, value: k.static, ease: { kind: "linear" } }] } : k;
}

export function staticOf<T>(k: Keyframed<T>): T {
  return "static" in k ? k.static : k.keys[0]?.value ?? sample(k, 0);
}

/** Insert or replace a key at `at`. Returns a new Keyframed (immutable). */
export function setKey<T>(k: Keyframed<T>, at: TimeTicks, value: T, ease?: EaseSpec): { keys: Keyframe<T>[] } {
  const cur = toKeyframed(k);
  const keys = [...cur.keys].sort((a, b) => a.at - b.at);
  const idx = keys.findIndex((key) => Math.abs(key.at - at) <= KEY_AT_TOLERANCE);
  const key: Keyframe<T> = { at, value, ease: ease ?? (idx >= 0 ? keys[idx]!.ease : { kind: "linear" }) };
  if (idx >= 0) keys[idx] = key;
  else keys.splice(keys.findIndex((key) => key.at > at) === -1 ? keys.length : keys.findIndex((key) => key.at > at), 0, key);
  return { keys };
}

export function removeKey<T>(k: Keyframed<T>, at: TimeTicks): { keys: Keyframe<T>[] } {
  const cur = toKeyframed(k);
  const keys = cur.keys.filter((key) => Math.abs(key.at - at) > KEY_AT_TOLERANCE);
  if (keys.length === 0) throw new Error("cannot remove the last keyframe");
  return { keys };
}
