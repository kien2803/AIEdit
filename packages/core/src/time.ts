/**
 * Time is always integer "ticks" at a fixed timescale (like MPEG-TS timescale).
 * Never store float seconds in the project model — frame accuracy requires
 * rational/integer arithmetic.
 */
export const TIMESCALE = 90_000; // ticks per second
export type TimeTicks = number; // int

export interface Rational {
  num: number;
  den: number;
}

export const ticks = {
  fromSeconds(sec: number): TimeTicks {
    return Math.round(sec * TIMESCALE);
  },
  toSeconds(t: TimeTicks): number {
    return t / TIMESCALE;
  },
  /** Duration of `count` frames at the given rational fps. */
  framesToTicks(count: number, fps: Rational): TimeTicks {
    return Math.round((count * fps.den * TIMESCALE) / fps.num);
  },
  ticksToFrames(t: TimeTicks, fps: Rational): number {
    return Math.floor((t * fps.num) / (fps.den * TIMESCALE));
  },
};

export function formatTimecode(t: TimeTicks, fps: Rational): string {
  const sign = t < 0 ? "-" : "";
  const abs = Math.abs(t);
  const fpsF = fps.num / fps.den;
  const totalFrames = Math.floor((abs * fpsF) / TIMESCALE);
  const framesPerSec = Math.max(1, Math.round(fpsF));
  const f = totalFrames % framesPerSec;
  const totalSec = Math.floor(totalFrames / framesPerSec);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}
