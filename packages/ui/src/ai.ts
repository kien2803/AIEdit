import type { Op } from "@aiedit/core";
import { createTrack, makeTextClip, newId, sec, resolvePlacement } from "@aiedit/core";
import type { EditorSnapshot } from "./prompt.js";

export interface ParsedIntent {
  reply: string;
  /** Ops to apply (rendered as an Apply proposal in chat). */
  ops?: Op[];
  label?: string;
  /** A direct store action name — for things that need store context. */
  action?: "split" | "deleteSelected" | "cutSilences" | "introScene" | "sceneClip" | "undo" | "redo" | "togglePlay" | "exportVideo";
}

/**
 * Rule-based prompt parser. This is the seam where a real model plugs in
 * later: same signature — text + snapshot → intents/ops. Everything returned
 * goes through the dispatcher and is logged like human edits.
 */
export function parsePrompt(text: string, s: EditorSnapshot): ParsedIntent {
  const t = text.toLowerCase().trim();

  if (/^(play|pause|chạy|dừng)/.test(t)) {
    return { reply: "Toggling playback", action: "togglePlay" };
  }
  if (/undo|hoàn tác|quay lại/.test(t)) return { reply: "Undoing", action: "undo" };
  if (/redo/.test(t)) return { reply: "Redoing", action: "redo" };
  if (/export|xuất/.test(t)) return { reply: "Starting export…", action: "exportVideo" };
  if (/split|cắt tại playhead|chia đôi/.test(t)) {
    return { reply: "Splitting all clips at playhead", action: "split" };
  }
  if (/intro|logo/.test(t)) return { reply: "Adding the AIedit intro scene", action: "introScene" };
  if (/scene/.test(t)) return { reply: "Adding a blank scene clip", action: "sceneClip" };
  if (/silence|im lặng|cắt im/.test(t)) {
    if (s.selection.length !== 1) return { reply: "Select one media clip first, then I can cut its silent ranges." };
    return { reply: "Cutting silent ranges + rippling closed.", action: "cutSilences" };
  }
  if (/delete|xóa|remove/.test(t)) {
    if (!s.selection.length) return { reply: "Nothing selected to delete." };
    return { reply: `Deleting ${s.selection.length} selected clip(s)`, action: "deleteSelected" };
  }

  const speedM = t.match(/speed\s*([\d.]+)|tốc độ\s*([\d.]+)/);
  if (speedM) {
    const v = Number(speedM[1] ?? speedM[2]);
    if (!s.selection.length) return { reply: "Select a clip first." };
    if (!v || !Number.isFinite(v)) return { reply: "Bad speed value." };
    return {
      reply: `Setting speed ${v}× on ${s.selection.length} clip(s)`,
      ops: s.selection.map((id) => ({ type: "clip.setSpeed", clipId: id, speed: v }) as Op),
      label: `speed ${v}`,
    };
  }

  const textM = text.match(/(?:text|chữ|caption)\s*[:"]?\s*(.+)$/i);
  if (textM) {
    const content = textM[1]!.replace(/^["']|["']$/g, "").slice(0, 200);
    if (!content) return { reply: "Text is empty." };
    let track = s.project.tracks.find((tr) => tr.kind === "text");
    const ops: Op[] = [];
    if (!track) {
      track = createTrack("text", "T1", newId("track"));
      ops.push({ type: "track.add", track });
    }
    const clip = makeTextClip({ start: s.playhead, duration: sec(4), content });
    ops.push({ type: "clip.add", trackId: track.id, clip });
    return { reply: `Adding text "${content}" at playhead`, ops, label: "add text" };
  }

  return {
    reply:
      "I can do: play/pause, split, delete, undo/redo, export, " +
      '"speed 2", "text Hello", intro, scene, "cut silences" (select a clip first).',
  };
}
