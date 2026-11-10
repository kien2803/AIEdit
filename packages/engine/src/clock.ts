import { ticks, type TimeTicks } from "@aiedit/core";

/**
 * Playback clock. While playing, time = anchor + wallclock elapsed * rate.
 * The rAF loop reads now() each frame — it never accumulates drift.
 */
export class PlaybackClock {
  private anchor: TimeTicks = 0;
  private wallAnchor = 0;
  playing = false;
  rate = 1;

  now(): TimeTicks {
    if (!this.playing) return this.anchor;
    const elapsed = (performance.now() - this.wallAnchor) / 1000;
    return this.anchor + ticks.fromSeconds(elapsed * this.rate);
  }

  seek(t: TimeTicks): void {
    this.anchor = t;
    this.wallAnchor = performance.now();
  }

  play(): void {
    if (this.playing) return;
    this.wallAnchor = performance.now();
    this.playing = true;
  }

  pause(): void {
    if (!this.playing) return;
    this.anchor = this.now();
    this.playing = false;
  }
}
