import type { Clip, Project, Track } from "@aiedit/core";
import { clipEnd } from "@aiedit/core";
import type { TimeTicks } from "@aiedit/core";

/** All clips active at timeline time t, grouped per track. */
export function activeClipsAt(p: Project, t: TimeTicks): { track: Track; clip: Clip }[] {
  const out: { track: Track; clip: Clip }[] = [];
  for (const track of p.tracks) {
    for (const clip of track.clips) {
      if (clip.enabled && clip.start <= t && clipEnd(clip) > t) {
        out.push({ track, clip });
      }
    }
  }
  return out;
}
