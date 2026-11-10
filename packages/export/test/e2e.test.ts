import { describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProject, createTrack, makeVideoClip, sec, type MediaAsset,
} from "@aiedit/core";
import { buildExportPlan } from "../src/plan.js";

const hasFFmpeg = (() => {
  try { execSync("ffmpeg -version", { stdio: "ignore" }); return true; }
  catch { return false; }
})();

describe.skipIf(!hasFFmpeg)("e2e: real ffmpeg run", () => {
  it("renders a 3s output from a generated source", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiedit-e2e-"));
    const src = join(dir, "in0.mp4");
    execFileSync("ffmpeg", [
      "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440",
      "-t", "10", "-c:v", "libopenh264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      "-y", src,
    ], { stdio: "ignore" });

    const p = createProject({ width: 640, height: 360, fps: { num: 30, den: 1 } });
    const a: MediaAsset = {
      id: "a1", name: "in0.mp4", kind: "video", sourceUrl: src,
      durationTicks: sec(10), width: 640, height: 360, hasAudio: true,
    };
    p.assets[a.id] = a;
    p.tracks.push(createTrack("video", "V1", "t1"));
    // two sequential clips: [0-2s] from source 0-2, [2-5s] from source 4-7 at 1x
    p.tracks[0]!.clips.push(
      makeVideoClip({ id: "c1", assetId: "a1", start: 0, sourceIn: 0, sourceOut: sec(2) }),
      makeVideoClip({ id: "c2", assetId: "a1", start: sec(2), sourceIn: sec(4), sourceOut: sec(7) }),
    );

    const plan = buildExportPlan(p, {}, { videoCodecArgs: ["libopenh264"] });
    for (const inp of plan.inputs) {
      const asset = p.assets[inp.assetId!]!;
      writeFileSync(join(dir, inp.file), readFileSync(asset.sourceUrl));
    }
    execFileSync("ffmpeg", plan.argv, { cwd: dir, stdio: "ignore" });
    const out = join(dir, plan.outFile);
    expect(existsSync(out)).toBe(true);
    const probe = execFileSync("ffprobe", [
      "-v", "quiet", "-show_entries", "format=duration",
      "-of", "csv=p=0", out,
    ]).toString().trim();
    expect(parseFloat(probe)).toBeCloseTo(5, 0);
  });
});
