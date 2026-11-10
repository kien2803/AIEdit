import { describe, expect, it } from "vitest";
import {
  applyOps, createProject, createTrack, makeAudioClip, makeVideoClip,
  makeTextClip, sec, type MediaAsset, type Project,
} from "@aiedit/core";
import { buildExportPlan } from "../src/plan.js";

function proj(clips: Parameters<typeof makeVideoClip>[0][], kind: "video" | "audio" | "text" = "video"): Project {
  const p = createProject({ width: 1280, height: 720, fps: { num: 30, den: 1 } });
  const a: MediaAsset = {
    id: "a1", name: "v.mp4", kind: "video", sourceUrl: "blob:x",
    durationTicks: sec(30), width: 1280, height: 720, hasAudio: true,
  };
  p.assets[a.id] = a;
  p.tracks.push(createTrack(kind, "T", "t1"));
  for (const c of clips) {
    const clip = kind === "audio"
      ? makeAudioClip({ ...c })
      : makeVideoClip({ ...c });
    p.tracks[0]!.clips.push(clip);
  }
  return p;
}

describe("buildExportPlan", () => {
  it("single clip → trim + overlay onto base", () => {
    const p = proj([{ assetId: "a1", start: 0, sourceIn: sec(1), sourceOut: sec(6) }]);
    const plan = buildExportPlan(p);
    expect(plan.durationSec).toBeCloseTo(5);
    expect(plan.inputs).toHaveLength(1);
    const fc = plan.filterComplex;
    expect(fc).toContain("trim=start=1:end=6");
    expect(fc).toContain("color=c=black:s=1280x720");
    expect(fc).toContain("overlay");
    expect(fc).toContain("atrim");
    expect(plan.argv.join(" ")).toContain("-c:v libx264");
  });

  it("two clips at different times get separate enable windows", () => {
    const p = proj([
      { assetId: "a1", start: 0, sourceIn: 0, sourceOut: sec(5) },
      { assetId: "a1", start: sec(5), sourceIn: sec(10), sourceOut: sec(15) },
    ]);
    const plan = buildExportPlan(p);
    expect(plan.durationSec).toBeCloseTo(10);
    expect(plan.filterComplex).toContain("between(t,0,5)");
    expect(plan.filterComplex).toContain("between(t,5,10)");
  });

  it("speed maps to setpts + atempo", () => {
    const p = proj([{ assetId: "a1", start: 0, sourceIn: 0, sourceOut: sec(10), speed: 2 }]);
    const plan = buildExportPlan(p);
    expect(plan.durationSec).toBeCloseTo(5);
    expect(plan.filterComplex).toContain("setpts=PTS/2");
    expect(plan.filterComplex).toContain("atempo=2");
  });

  it("audio clip contributes delayed audio branch", () => {
    const p = proj([{ assetId: "a1", start: sec(3), sourceIn: 0, sourceOut: sec(5) }], "audio");
    const plan = buildExportPlan(p);
    expect(plan.filterComplex).toContain("adelay=3000|3000");
  });

  it("text clip becomes a looped PNG input", () => {
    const p = createProject({ width: 1280, height: 720 });
    p.tracks.push(createTrack("text", "T1", "t1"));
    const tc = makeTextClip({ start: sec(1), duration: sec(3), content: "hi" });
    tc.id = "tx1";
    p.tracks[0]!.clips.push(tc);
    const plan = buildExportPlan(p, { tx1: { w: 200, h: 80 } });
    expect(plan.inputs[0]!.textClipId).toBe("tx1");
    expect(plan.argv.join(" ")).toContain("-loop 1");
    expect(plan.filterComplex).toContain("between(t,1,4)");
  });
});
