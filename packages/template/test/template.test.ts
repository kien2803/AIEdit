import { describe, expect, it } from "vitest";
import {
  applyOps, createProject, createTrack, findClip, findElementIn,
  makeScene, makeSceneClip, makeSceneTextElement, makeTextClip, makeVideoClip,
  sec, type MediaAsset, type Project,
} from "@aiedit/core";
import { captureTemplate, instantiateTemplate } from "../src/index.js";

function fixture(): { p: Project; trackId: string } {
  const p = createProject();
  for (const [id, dur] of [["a1", 10], ["a2", 7]] as const) {
    const a: MediaAsset = {
      id, name: `${id}.mp4`, kind: "video", sourceUrl: `blob:${id}`,
      durationTicks: sec(dur), width: 1920, height: 1080, hasAudio: true,
    };
    p.assets[id] = a;
  }
  p.tracks.push(createTrack("video", "V1", "t1"));
  return { p, trackId: "t1" };
}

describe("capture + instantiate", () => {
  it("captures structure and infers footage/text params", () => {
    const { p, trackId } = fixture();
    const v = makeVideoClip({ id: "c1", assetId: "a1", start: sec(5), sourceIn: 0, sourceOut: sec(4) });
    const t = makeTextClip({ id: "c2", start: sec(6), duration: sec(3), content: "TITLE" });
    const cur = applyOps(p, [
      { type: "clip.add", trackId, clip: v },
      { type: "clip.add", trackId, clip: t },
    ]).next;

    const tpl = captureTemplate(cur, ["c1", "c2"], { name: "intro" });
    // zero-based
    expect(tpl.root.tracks[0]!.clips[0]!.start).toBe(0);
    expect(tpl.root.tracks[0]!.clips[1]!.start).toBe(sec(1));
    // params inferred
    expect(tpl.params.map((x) => x.type).sort()).toEqual(["footage", "text"]);
    const footageBinding = tpl.bindings.find((b) => b.field.kind === "assetId")!;
    expect(footageBinding.nodeId).toBe("c1");
    // time rule: footage stretches
    expect(tpl.timeRules.find((r) => r.nodeId === "c1")!.elasticity.kind).toBe("stretch");
  });

  it("instantiates with new footage: stretch rule extends later clips", () => {
    const { p, trackId } = fixture();
    const v = makeVideoClip({ id: "c1", assetId: "a1", start: 0, sourceIn: 0, sourceOut: sec(4) });
    const t = makeTextClip({ id: "c2", start: sec(4), duration: sec(2), content: "TITLE" });
    const cur = applyOps(p, [
      { type: "clip.add", trackId, clip: v },
      { type: "clip.add", trackId, clip: t },
    ]).next;
    const tpl = captureTemplate(cur, ["c1", "c2"], { name: "x" });
    const footageKey = tpl.params.find((x) => x.type === "footage")!.key;
    const textKey = tpl.params.find((x) => x.type === "text")!.key;

    const { ops, nodeMap } = instantiateTemplate(tpl, {
      [footageKey]: { kind: "footage", assetId: "a2" },  // 7s > template's 4s
      [textKey]: { kind: "text", text: "NEW TITLE" },
    }, cur, sec(20));

    const next = applyOps(cur, ops).next;
    const newVideo = findClip(next, nodeMap.get("c1")!)!.clip;
    const newText = findClip(next, nodeMap.get("c2")!)!.clip;
    expect(newVideo.start).toBe(sec(20));
    expect(newVideo.duration).toBe(sec(7)); // stretched to a2 duration
    expect(newText.start).toBe(sec(20 + 7)); // shifted by stretch
    if (newText.kind === "text") expect(newText.content).toBe("NEW TITLE");
    expect(newVideo.id).not.toBe("c1");
    // new track created
    expect(next.tracks.length).toBe(2);
  });

  it("captures scene clips and scene text elements as params", () => {
    const { p, trackId } = fixture();
    const scene = makeScene({ id: "sc1", duration: sec(4) });
    scene.elements.push(makeSceneTextElement({ id: "te1", content: "inner" }));
    const clip = makeSceneClip({ id: "sc", sceneId: "sc1", start: 0, duration: sec(4) });
    const cur = applyOps(p, [
      { type: "scene.upsert", scene },
      { type: "clip.add", trackId, clip },
    ]).next;
    const tpl = captureTemplate(cur, ["sc"], { name: "lower3rd" });
    expect(tpl.root.scenes["sc1"]).toBeDefined();
    expect(tpl.params.some((x) => x.type === "text")).toBe(true);

    const textKey = tpl.params.find((x) => x.type === "text")!.key;
    const { ops, nodeMap } = instantiateTemplate(tpl, { [textKey]: { kind: "text", text: "replaced" } }, cur, 0);
    const next = applyOps(cur, ops).next;
    const newSceneId = nodeMap.get("sc1")!;
    const el = findElementIn(next.scenes[newSceneId]!.elements, nodeMap.get("te1")!)!;
    expect((el as { content: string }).content).toBe("replaced");
  });

  it("throws on missing required param", () => {
    const { p, trackId } = fixture();
    const v = makeVideoClip({ id: "c1", assetId: "a1", start: 0, sourceIn: 0, sourceOut: sec(4) });
    const cur = applyOps(p, [{ type: "clip.add", trackId, clip: v }]).next;
    const tpl = captureTemplate(cur, ["c1"], { name: "x" });
    expect(() => instantiateTemplate(tpl, {}, cur, 0)).toThrow(/missing required/);
  });
});
