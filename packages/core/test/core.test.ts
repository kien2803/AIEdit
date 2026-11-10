import { describe, expect, it } from "vitest";
import {
  applyOps, clipEnd, createProject, createTrack, Dispatcher, findClip,
  formatTimecode, makeVideoClip, sec, ticks, timelineDuration,
  type MediaAsset, type Op, type Project,
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

function addClip(p: Project, trackId: string, start = 0): Project {
  const clip = makeVideoClip({
    id: "c1", assetId: "asset1", start, sourceIn: 0, sourceOut: sec(5),
  });
  return applyOps(p, [{ type: "clip.add", trackId, clip }]).next;
}

describe("time", () => {
  it("converts seconds <-> ticks losslessly", () => {
    expect(ticks.toSeconds(ticks.fromSeconds(1.5))).toBeCloseTo(1.5);
    expect(sec(1)).toBe(90_000);
  });
  it("formats timecode", () => {
    expect(formatTimecode(sec(61.5), { num: 30, den: 1 })).toBe("00:01:01:15");
  });
});

describe("ops", () => {
  it("add + remove roundtrip", () => {
    const { p, trackId } = fixtureProject();
    const next = addClip(p, trackId);
    expect(findClip(next, "c1")).toBeDefined();
    const after = applyOps(next, [{ type: "clip.remove", clipId: "c1" }]).next;
    expect(findClip(after, "c1")).toBeUndefined();
  });

  it("rejects clip beyond asset duration", () => {
    const { p, trackId } = fixtureProject();
    const clip = makeVideoClip({ assetId: "asset1", start: 0, sourceIn: 0, sourceOut: sec(20) });
    expect(() => applyOps(p, [{ type: "clip.add", trackId, clip }])).toThrow();
  });

  it("split produces two clips covering the same source range", () => {
    const { p, trackId } = fixtureProject();
    const withClip = addClip(p, trackId);
    const op: Op = { type: "clip.split", clipId: "c1", at: sec(2), newClipId: "c2" };
    const { next } = applyOps(withClip, [op]);
    const left = findClip(next, "c1")!.clip;
    const right = findClip(next, "c2")!.clip;
    expect(left.duration).toBe(sec(2));
    expect(right.start).toBe(sec(2));
    expect(right.duration).toBe(sec(3));
    if (left.kind === "video" && right.kind === "video") {
      expect(left.sourceOut).toBe(sec(2));
      expect(right.sourceIn).toBe(sec(2));
    }
    expect(clipEnd(left)).toBe(right.start);
  });

  it("split respects speed", () => {
    const { p, trackId } = fixtureProject();
    const clip = makeVideoClip({
      id: "c1", assetId: "asset1", start: 0, sourceIn: 0, sourceOut: sec(10), speed: 2,
    });
    expect(clip.duration).toBe(sec(5)); // 10s source at 2x = 5s timeline
    const { next } = applyOps(p, [{ type: "clip.add", trackId, clip }]);
    const { next: split } = applyOps(next, [
      { type: "clip.split", clipId: "c1", at: sec(2), newClipId: "c2" },
    ]);
    const left = findClip(split, "c1")!.clip;
    if (left.kind === "video") expect(left.sourceOut).toBe(sec(4)); // 2s timeline * 2x
  });

  it("trim adjusts sourceIn by speed-scaled delta", () => {
    const { p, trackId } = fixtureProject();
    const clip = makeVideoClip({
      id: "c1", assetId: "asset1", start: 0, sourceIn: 0, sourceOut: sec(10), speed: 2,
    });
    let cur = applyOps(p, [{ type: "clip.add", trackId, clip }]).next;
    cur = applyOps(cur, [{ type: "clip.trim", clipId: "c1", edge: "in", delta: sec(1) }]).next;
    const c = findClip(cur, "c1")!.clip;
    if (c.kind === "video") {
      expect(c.start).toBe(sec(1));
      expect(c.sourceIn).toBe(sec(2)); // 1s timeline at 2x = 2s source
    }
  });

  it("setSpeed keeps timeline duration, changes sourceOut", () => {
    const { p, trackId } = fixtureProject();
    let cur = addClip(p, trackId);
    cur = applyOps(cur, [{ type: "clip.setSpeed", clipId: "c1", speed: 2 }]).next;
    const c = findClip(cur, "c1")!.clip;
    if (c.kind === "video") {
      expect(c.duration).toBe(sec(5));
      expect(c.sourceOut).toBe(sec(10)); // 5s timeline * 2x
    }
  });
});

describe("dispatcher undo/redo", () => {
  it("roundtrips add/split/trim/move", () => {
    const { p, trackId } = fixtureProject();
    const d = new Dispatcher(p);
    const clip = makeVideoClip({ id: "c1", assetId: "asset1", start: 0, sourceIn: 0, sourceOut: sec(5) });
    d.dispatch([{ type: "clip.add", trackId, clip }], "add clip");
    d.dispatch([{ type: "clip.split", clipId: "c1", at: sec(2), newClipId: "c2" }], "split");
    d.dispatch([{ type: "clip.move", clipId: "c2", start: sec(6) }], "move");
    d.dispatch([{ type: "clip.trim", clipId: "c1", edge: "out", delta: sec(1) }], "trim");

    expect(findClip(d.project, "c1")!.clip.duration).toBe(sec(3));
    expect(findClip(d.project, "c2")!.clip.start).toBe(sec(6));

    d.undo(); // untrim
    expect(findClip(d.project, "c1")!.clip.duration).toBe(sec(2));
    d.undo(); // unmove
    expect(findClip(d.project, "c2")!.clip.start).toBe(sec(2));
    d.undo(); // unsplit
    expect(findClip(d.project, "c2")).toBeUndefined();
    expect(findClip(d.project, "c1")!.clip.duration).toBe(sec(5));
    d.undo(); // unadd
    expect(findClip(d.project, "c1")).toBeUndefined();
    expect(d.canUndo).toBe(false);

    d.redo();
    d.redo();
    d.redo();
    d.redo();
    expect(findClip(d.project, "c1")!.clip.duration).toBe(sec(3));
    expect(findClip(d.project, "c2")!.clip.start).toBe(sec(6));
  });

  it("records ops with context into the log", () => {
    const { p, trackId } = fixtureProject();
    const d = new Dispatcher(p);
    const clip = makeVideoClip({ id: "c1", assetId: "asset1", start: 0, sourceIn: 0, sourceOut: sec(5) });
    d.dispatch([{ type: "clip.add", trackId, clip }], "add", {
      playheadAt: sec(3), selection: ["c1"], activeTool: "select",
    });
    expect(d.log).toHaveLength(1);
    expect(d.log[0]!.context.playheadAt).toBe(sec(3));
    expect(d.log[0]!.ops[0]!.type).toBe("clip.add");
    expect(d.log[0]!.inverse[0]!.type).toBe("clip.remove");
  });

  it("redo stack clears on new dispatch", () => {
    const { p, trackId } = fixtureProject();
    const d = new Dispatcher(p);
    d.dispatch(
      [{ type: "clip.add", trackId, clip: makeVideoClip({ assetId: "asset1", start: 0, sourceIn: 0, sourceOut: sec(5) }) }],
      "add",
    );
    d.undo();
    d.dispatch([{ type: "track.add", track: createTrack("audio", "A1", "a1") }], "new track");
    expect(d.canRedo).toBe(false);
  });
});

describe("placement", () => {
  it("resolvePlacement finds nearest free gap", async () => {
    const { resolvePlacement, applyOps, createTrack, makeVideoClip } = await import("../src/index.js");
    const { p } = fixtureProject();
    const t2 = createTrack("video", "V2", "t2");
    const c1 = makeVideoClip({ id: "c1", assetId: "asset1", start: 0, sourceIn: 0, sourceOut: sec(4) });
    const c2 = makeVideoClip({ id: "c2", assetId: "asset1", start: sec(8), sourceIn: 0, sourceOut: sec(4) });
    let cur = applyOps(p, [
      { type: "track.add", track: t2 },
      { type: "clip.add", trackId: "t2", clip: c1 },
      { type: "clip.add", trackId: "t2", clip: c2 },
    ]).next;
    const track = cur.tracks.find((t) => t.id === "t2")!;
    // dropping a 4s clip at t=1 (overlaps c1) -> nearest gap is [4,8] -> start 4
    expect(resolvePlacement(track, undefined, sec(1), sec(4))).toBe(sec(4));
    // no overlap -> keep
    expect(resolvePlacement(track, undefined, sec(5), sec(1))).toBe(sec(5));
    // a 6s clip doesn't fit in the 4s gap; nearest fit is after c2 -> start 12
    expect(resolvePlacement(track, undefined, sec(5), sec(6))).toBe(sec(12));
  });

  it("clampTrimDelta blocks extending into a neighbor", async () => {
    const { clampTrimDelta, applyOps, createTrack, makeVideoClip } = await import("../src/index.js");
    const { p } = fixtureProject();
    const t2 = createTrack("video", "V2", "t2");
    const c1 = makeVideoClip({ id: "c1", assetId: "asset1", start: 0, sourceIn: 0, sourceOut: sec(4) });
    const c2 = makeVideoClip({ id: "c2", assetId: "asset1", start: sec(4), sourceIn: sec(2), sourceOut: sec(6) });
    let cur = applyOps(p, [
      { type: "track.add", track: t2 },
      { type: "clip.add", trackId: "t2", clip: c1 },
      { type: "clip.add", trackId: "t2", clip: c2 },
    ]).next;
    const track = cur.tracks.find((t) => t.id === "t2")!;
    const clip = track.clips.find((c) => c.id === "c2")!;
    // trimming 'in' left by 2s would overlap c1 — clamp to 0
    expect(clampTrimDelta(track, clip, "in", -sec(2))).toBe(0);
    expect(clampTrimDelta(track, clip, "in", sec(1))).toBe(sec(1));
  });

  it("rippleDeleteOps removes and shifts later clips", async () => {
    const { rippleDeleteOps, applyOps, createTrack, makeVideoClip, findClip } = await import("../src/index.js");
    const { p } = fixtureProject();
    const t2 = createTrack("video", "V2", "t2");
    const mk = (id: string, start: number) =>
      makeVideoClip({ id, assetId: "asset1", start, sourceIn: 0, sourceOut: sec(2) });
    let cur = applyOps(p, [
      { type: "track.add", track: t2 },
      { type: "clip.add", trackId: "t2", clip: mk("c1", 0) },
      { type: "clip.add", trackId: "t2", clip: mk("c2", sec(4)) },
      { type: "clip.add", trackId: "t2", clip: mk("c3", sec(8)) },
    ]).next;
    const ops = rippleDeleteOps(cur.tracks, ["c1"]);
    const next = applyOps(cur, ops).next;
    expect(findClip(next, "c1")).toBeUndefined();
    expect(findClip(next, "c2")!.clip.start).toBe(sec(2));
    expect(findClip(next, "c3")!.clip.start).toBe(sec(6));
  });
});

describe("model v2: keyframes, scenes, timeRemap", () => {
  it("key.toggle converts static <-> keyframed, key.set adds keys", async () => {
    const { makeTextClip, sample, ticks } = await import("../src/index.js");
    const { p, trackId } = fixtureProject();
    const clip = makeTextClip({ id: "tc1", start: 0, duration: sec(4), content: "k" });
    let cur = applyOps(p, [{ type: "clip.add", trackId, clip }]).next;
    cur = applyOps(cur, [{ type: "key.toggle", clipId: "tc1", field: "transform", keyframed: true }]).next;
    cur = applyOps(cur, [
      { type: "key.set", clipId: "tc1", field: "transform", at: sec(2),
        value: { x: 100, y: 0, scaleX: 2, scaleY: 2, rotation: 0, opacity: 1 } },
    ]).next;
    const c = findClip(cur, "tc1")!.clip;
    const t = sample(c.transform, sec(1));
    expect(t.x).toBeCloseTo(50);
    expect(t.scaleX).toBeCloseTo(1.5);
  });

  it("bezier ease differs from linear", async () => {
    const { cubicBezierY } = await import("../src/index.js");
    // ease-out cubic (0.25,1) shape: early progress > linear
    expect(cubicBezierY(0.25, 1, 0.25, 1, 0.5)).toBeGreaterThan(0.8);
    expect(cubicBezierY(0, 0, 1, 1, 0.5)).toBeCloseTo(0.5);
  });

  it("spring overshoots then settles to 1", async () => {
    const { springOut } = await import("../src/index.js");
    expect(springOut(0.4, 100, 8)).toBeGreaterThan(1.0);
    expect(springOut(1, 100, 8)).toBeCloseTo(1, 2);
  });

  it("split slices keyframes between the two clips", async () => {
    const { makeTextClip } = await import("../src/index.js");
    const { p, trackId } = fixtureProject();
    const clip = makeTextClip({ id: "tc1", start: 0, duration: sec(4), content: "k" });
    clip.transform = { keys: [
      { at: 0, value: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }, ease: { kind: "linear" } },
      { at: sec(3), value: { x: 300, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 }, ease: { kind: "linear" } },
    ] };
    let cur = applyOps(p, [{ type: "clip.add", trackId, clip }]).next;
    cur = applyOps(cur, [{ type: "clip.split", clipId: "tc1", at: sec(2), newClipId: "tc2" }]).next;
    const l = findClip(cur, "tc1")!.clip;
    const r = findClip(cur, "tc2")!.clip;
    expect("keys" in l.transform && l.transform.keys).toHaveLength(1);
    expect("keys" in r.transform && r.transform.keys[0]!.at).toBe(sec(1));
  });

  it("timeRemap overrides speed in sourceTimeAt", async () => {
    const { sourceTimeAt } = await import("../src/index.js");
    const clip = makeVideoClip({ assetId: "a1", start: 0, sourceIn: 0, sourceOut: sec(4) });
    clip.timeRemap = { keys: [
      { at: 0, value: 0, ease: { kind: "linear" } },
      { at: sec(4), value: sec(2), ease: { kind: "linear" } }, // ramp to half speed
    ] };
    expect(sourceTimeAt(clip, sec(2))).toBe(sec(1));
    delete clip.timeRemap;
    expect(sourceTimeAt(clip, sec(2))).toBe(sec(2));
  });

  it("scene ops: upsert + element ops + undo", async () => {
    const { makeScene, makeSceneClip, makeShapeElement, makeSceneTextElement, findElementIn } = await import("../src/index.js");
    const { p, trackId } = fixtureProject();
    const d = new Dispatcher(p);
    const scene = makeScene({ id: "sc1", duration: sec(4) });
    scene.elements.push(
      makeShapeElement({ id: "sh1", fill: "#ff0000" }),
      makeSceneTextElement({ id: "te1", content: "hello" }),
    );
    d.dispatch([
      { type: "scene.upsert", scene },
      { type: "clip.add", trackId, clip: makeSceneClip({ sceneId: "sc1", start: 0, duration: sec(4) }) },
    ], "add scene");
    expect(d.project.scenes["sc1"]).toBeDefined();
    d.dispatch([{ type: "element.set", sceneId: "sc1", elementId: "sh1", patch: { fill: "#00ff00" } }], "recolor");
    expect((findElementIn(d.project.scenes["sc1"]!.elements, "sh1") as { fill: string }).fill).toBe("#00ff00");
    d.undo();
    expect((findElementIn(d.project.scenes["sc1"]!.elements, "sh1") as { fill: string }).fill).toBe("#ff0000");
    // clip.add requires existing scene
    expect(() => applyOps(d.project, [
      { type: "clip.add", trackId, clip: makeSceneClip({ sceneId: "nope", start: 0, duration: sec(1) }) },
    ])).toThrow();
  });
});

describe("redo stability", () => {
  it("redo of a split reuses the same generated clip id", async () => {
    const { makeVideoClip } = await import("../src/index.js");
    const { p, trackId } = fixtureProject();
    const d = new Dispatcher(p);
    d.dispatch([{ type: "clip.add", trackId, clip: makeVideoClip({ id: "c1", assetId: "asset1", start: 0, sourceIn: 0, sourceOut: sec(5) }) }], "add");
    d.dispatch([{ type: "clip.split", clipId: "c1", at: sec(2) }], "split");
    const rightId = d.project.tracks[0]!.clips[1]!.id;
    d.undo();
    expect(d.project.tracks[0]!.clips).toHaveLength(1);
    d.redo();
    expect(d.project.tracks[0]!.clips).toHaveLength(2);
    expect(d.project.tracks[0]!.clips[1]!.id).toBe(rightId); // stable, not regenerated
  });
});
