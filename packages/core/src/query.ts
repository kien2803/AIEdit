import type { Clip, ClipId, Project, Track, TrackId, VideoClip, AudioClip } from "./model.js";
import type { TimeTicks } from "./time.js";
import { ticks } from "./time.js";
import { sample } from "./anim.js";

export function clipEnd(c: Clip): TimeTicks {
  return c.start + c.duration;
}

export interface ClipLocation {
  track: Track;
  trackIndex: number;
  clip: Clip;
  clipIndex: number;
}

export function findClip(p: Project, clipId: ClipId): ClipLocation | undefined {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const track = p.tracks[ti]!;
    const ci = track.clips.findIndex((c) => c.id === clipId);
    if (ci >= 0) return { track, trackIndex: ti, clip: track.clips[ci]!, clipIndex: ci };
  }
  return undefined;
}

export function findTrack(p: Project, trackId: TrackId): Track | undefined {
  return p.tracks.find((t) => t.id === trackId);
}

/** Clips on a track overlapping [start, end). */
export function clipsInRange(track: Track, start: TimeTicks, end: TimeTicks): Clip[] {
  return track.clips.filter((c) => c.start < end && clipEnd(c) > start);
}

/** Source-media time inside a clip at timeline time t. */
export function sourceTimeAt(clip: VideoClip | AudioClip, t: TimeTicks): TimeTicks {
  const local = t - clip.start;
  if (clip.timeRemap) return sample(clip.timeRemap, local);
  if (clip.speed < 0) {
    return clip.sourceOut - Math.round(local * -clip.speed);
  }
  return clip.sourceIn + Math.round(local * clip.speed);
}

/** Timeline duration the clip consumes for a given source range & speed. */
export function timelineDuration(sourceIn: TimeTicks, sourceOut: TimeTicks, speed: number): TimeTicks {
  return Math.round((sourceOut - sourceIn) / Math.abs(speed));
}

export function timelineEnd(p: Project): TimeTicks {
  let end = 0;
  for (const tr of p.tracks) for (const c of tr.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function sec(sec: number): TimeTicks {
  return ticks.fromSeconds(sec);
}
