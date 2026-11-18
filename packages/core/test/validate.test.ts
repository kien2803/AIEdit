import { describe, expect, it } from "vitest";
import {
  createProject, createTrack, makeVideoClip, sec, validateOps,
  type MediaAsset, type Project,
} from "../src/index.js";

function fixtureProject(): { p: Project; trackId: string; assetId: string } {
  const p = createProject({ fps: { num: 30, den: 1 } });
  const asset: MediaAsset = {
    id: "asset1", name: "a.mp4", kind: "video", sourceUrl: "blob:x",
    durationTicks: sec(10), width: 1920, height: 1080, hasAudio: true,
  };
  p.assets[asset.id] = asset;
  const track = createTrack("video", "V1", "t1");
  p.tracks.push(track);
  return { p, trackId: track.id, assetId: asset.id };
}

describe("validateOps (LLM safety)", () => {
  it("accepts a valid clip.add batch", () => {
    const { p, trackId, assetId } = fixtureProject();
    const clip = makeVideoClip({ assetId, start: 0, sourceIn: 0, sourceOut: sec(4) });
    const r = validateOps(p, [{ type: "clip.add", trackId, clip }]);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("rejects ops not on the whitelist", () => {
    const { p } = fixtureProject();
    const r = validateOps(p, [{ type: "asset.remove", assetId: "asset1" }]);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toMatch(/not allowed/);
  });

  it("rejects non-op objects", () => {
    const { p } = fixtureProject();
    const r = validateOps(p, ["delete everything", { type: "clip.remove" }]);
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects references to ids that do not exist", () => {
    const { p } = fixtureProject();
    const r = validateOps(p, [{ type: "clip.remove", clipId: "ghost" }]);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toMatch(/unknown clip/);
  });

  it("allows ops referencing entities created earlier in the same batch", () => {
    const { p } = fixtureProject();
    const track = createTrack("video", "V2", "t2");
    const clip = makeVideoClip({ id: "newclip", assetId: "asset1", start: 0, sourceIn: 0, sourceOut: sec(4) });
    const r = validateOps(p, [
      { type: "track.add", track },
      { type: "clip.add", trackId: "t2", clip },
      { type: "clip.move", clipId: "newclip", start: sec(1) },
    ]);
    expect(r.ok).toBe(true);
  });

  it("catches semantic errors via dry-run (sourceOut beyond asset duration)", () => {
    const { p, trackId, assetId } = fixtureProject();
    const clip = makeVideoClip({ assetId, start: 0, sourceIn: 0, sourceOut: sec(999) });
    const r = validateOps(p, [{ type: "clip.add", trackId, clip }]);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toMatch(/dry-run failed/);
  });

  it("caps batch size", () => {
    const { p, trackId } = fixtureProject();
    const ops = Array.from({ length: 70 }, (_, i) => ({
      type: "clip.add",
      trackId,
      clip: makeVideoClip({ id: `c${i}`, assetId: "asset1", start: 0, sourceIn: 0, sourceOut: sec(1) }),
    }));
    const r = validateOps(p, ops);
    expect(r.ok).toBe(false);
    expect(r.issues[0]!.message).toMatch(/too large/);
  });

  it("never mutates the project", () => {
    const { p, trackId, assetId } = fixtureProject();
    const clip = makeVideoClip({ assetId, start: 0, sourceIn: 0, sourceOut: sec(4) });
    const before = JSON.stringify(p);
    validateOps(p, [{ type: "clip.add", trackId, clip }]);
    expect(JSON.stringify(p)).toBe(before);
  });
});
