import type { Clip, ClipId, Track } from "./model.js";
import type { TimeTicks } from "./time.js";
import { clipEnd } from "./query.js";

export interface Interval {
  start: TimeTicks;
  end: TimeTicks;
  clipId: ClipId;
}

export function occupiedIntervals(track: Track, ignore?: ClipId): Interval[] {
  return track.clips
    .filter((c) => c.id !== ignore)
    .map((c) => ({ start: c.start, end: clipEnd(c), clipId: c.id }))
    .sort((a, b) => a.start - b.start);
}

function overlaps(start: TimeTicks, end: TimeTicks, iv: Interval): boolean {
  return start < iv.end && end > iv.start;
}

/**
 * Find the nearest non-overlapping start on a track for a clip of `duration`.
 * Returns null if no placement exists near the desired position (caller should
 * snap back / reject the drop).
 */
export function resolvePlacement(
  track: Track,
  ignoreClipId: ClipId | undefined,
  desiredStart: TimeTicks,
  duration: TimeTicks,
): TimeTicks | null {
  const ivs = occupiedIntervals(track, ignoreClipId);
  const fits = (s: TimeTicks) =>
    s >= 0 && !ivs.some((iv) => overlaps(s, s + duration, iv));
  if (fits(desiredStart)) return desiredStart;

  // Candidate placements: abutting each occupied interval on either side.
  const candidates: TimeTicks[] = [];
  for (const iv of ivs) {
    candidates.push(iv.end);
    candidates.push(iv.start - duration);
  }
  candidates.push(0);
  let best: TimeTicks | null = null;
  for (const c of candidates) {
    if (!fits(c)) continue;
    if (best === null || Math.abs(c - desiredStart) < Math.abs(best - desiredStart)) best = c;
  }
  return best;
}

/**
 * Clamp a trim delta so the resized edge does not overlap neighbors on the
 * same track. (Source-media bounds are clamped separately by the caller.)
 */
export function clampTrimDelta(track: Track, clip: Clip, edge: "in" | "out", delta: TimeTicks): TimeTicks {
  const ivs = occupiedIntervals(track, clip.id);
  if (edge === "in") {
    const nearestEndBefore = ivs
      .filter((iv) => iv.end <= clip.start)
      .reduce((m, iv) => Math.max(m, iv.end), 0);
    const minStart = Math.max(0, nearestEndBefore);
    return Math.min(Math.max(delta, minStart - clip.start), clip.duration - 1);
  }
  const nearestStartAfter = ivs
    .filter((iv) => iv.start >= clipEnd(clip))
    .reduce((m, iv) => Math.min(m, iv.start), Number.MAX_SAFE_INTEGER);
  const maxEnd = nearestStartAfter === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER / 4 : nearestStartAfter;
  return Math.max(Math.min(delta, maxEnd - clipEnd(clip)), 1 - clip.duration);
}

/**
 * Ripple-delete: ops that remove `clipIds` and shift later clips on the same
 * track left by the removed duration. Returns [] if nothing selected.
 */
export function rippleDeleteOps(tracks: Track[], clipIds: ClipId[]): import("./ops.js").Op[] {
  const ops: import("./ops.js").Op[] = [];
  const idSet = new Set(clipIds);
  for (const track of tracks) {
    const removed = track.clips.filter((c) => idSet.has(c.id)).sort((a, b) => a.start - b.start);
    if (removed.length === 0) continue;
    for (const c of track.clips) {
      if (idSet.has(c.id)) {
        ops.push({ type: "clip.remove", clipId: c.id });
        continue;
      }
      const shift = removed
        .filter((r) => clipEnd(r) <= c.start)
        .reduce((s, r) => s + r.duration, 0);
      if (shift > 0) ops.push({ type: "clip.move", clipId: c.id, start: c.start - shift });
    }
  }
  return ops;
}
