import React, { useCallback, useMemo, useRef, useState } from "react";
import type { Clip, ClipId, TimeTicks, Track } from "@aiedit/core";
import { clampTrimDelta, clipEnd, findClip, formatTimecode, resolvePlacement, ticks } from "@aiedit/core";
import { useEditor } from "./store.js";

type Drag =
  | { kind: "move"; clipId: ClipId; grabOffset: TimeTicks; delta: TimeTicks; trackIndex: number }
  | { kind: "trim"; clipId: ClipId; edge: "in" | "out"; delta: TimeTicks }
  | { kind: "scrub" };

const SNAP_PX = 8;
const TRACK_H = 56;
const RULER_H = 28;

export function Timeline(): React.ReactElement {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const seek = useEditor((s) => s.seek);
  const select = useEditor((s) => s.select);
  const dispatch = useEditor((s) => s.dispatch);
  const setTool = useEditor((s) => s.setTool);
  const setZoom = useEditor((s) => s.setZoom);
  const zoomFit = useEditor((s) => s.zoomFit);
  const splitAtPlayhead = useEditor((s) => s.splitAtPlayhead);
  const addTextClip = useEditor((s) => s.addTextClip);
  const addSceneClip = useEditor((s) => s.addSceneClip);
  const addIntroScene = useEditor((s) => s.addIntroScene);
  const addAdjustmentClip = useEditor((s) => s.addAdjustmentClip);
  const cutSilences = useEditor((s) => s.cutSilences);
  const dropOnTimeline = useEditor((s) => s.dropOnTimeline);
  const peaks = useEditor((s) => s.peaks);

  const [drag, setDrag] = useState<Drag | null>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const pxPerTick = pxPerSec / 90000;
  const end = Math.max(playhead + 5 * 90000, ...project.tracks.flatMap((t) => t.clips.map((c) => clipEnd(c))), 10 * 90000);
  const contentW = ticks.toSeconds(end) * pxPerSec + 200;

  const toTime = useCallback(
    (clientX: number): TimeTicks => {
      const rect = laneRef.current!.getBoundingClientRect();
      return Math.max(0, Math.round((clientX - rect.left + laneRef.current!.scrollLeft) / pxPerTick));
    },
    [pxPerTick],
  );

  const trackIndexAt = useCallback(
    (clientY: number, kind: Track["kind"]): number => {
      const stack = laneRef.current?.querySelector(".tl-lane-stack");
      if (!stack) return -1;
      const rect = stack.getBoundingClientRect();
      const idx = Math.floor((clientY - rect.top + laneRef.current!.scrollTop) / TRACK_H);
      if (idx < 0 || idx >= project.tracks.length) return -1;
      return project.tracks[idx]!.kind === kind ? idx : -1;
    },
    [project.tracks],
  );

  const snapTargets = useMemo(() => {
    const ts = new Set<TimeTicks>([playhead, 0]);
    for (const tr of project.tracks) {
      for (const c of tr.clips) {
        ts.add(c.start); ts.add(clipEnd(c));
        // analysis edges (silence) become snap targets, mapped through clip speed
        if ((c.kind === "video" || c.kind === "audio") && c.speed > 0) {
          const sil = project.assets[c.assetId]?.analysis?.find((a) => a.kind === "silence");
          for (const g of sil?.segments ?? []) {
            const t0 = c.start + Math.round((g.start - c.sourceIn) / c.speed);
            const t1 = c.start + Math.round((g.end - c.sourceIn) / c.speed);
            if (t0 > c.start && t0 < clipEnd(c)) ts.add(t0);
            if (t1 > c.start && t1 < clipEnd(c)) ts.add(t1);
          }
        }
      }
    }
    return ts;
  }, [project, playhead]);

  const snap = useCallback(
    (t: TimeTicks): TimeTicks => {
      let best = t, bestD = SNAP_PX;
      for (const target of snapTargets) {
        const d = Math.abs(target - t) * pxPerTick;
        if (d < bestD) { best = target; bestD = d; }
      }
      return best;
    },
    [snapTargets, pxPerTick],
  );

  const onRulerDown = (e: React.MouseEvent) => {
    seek(toTime(e.clientX));
    setDrag({ kind: "scrub" });
  };

  const onClipDown = (e: React.MouseEvent, clip: Clip, track: Track) => {
    e.stopPropagation();
    const t = toTime(e.clientX);
    if (tool === "blade") {
      dispatch([{ type: "clip.split", clipId: clip.id, at: t }], "split");
      return;
    }
    if (e.shiftKey) {
      select(selection.includes(clip.id) ? selection.filter((id) => id !== clip.id) : [...selection, clip.id]);
    } else if (!selection.includes(clip.id)) {
      select([clip.id]);
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const edgeZone = 8;
    if (e.clientX - rect.left < edgeZone) {
      setDrag({ kind: "trim", clipId: clip.id, edge: "in", delta: 0 });
    } else if (rect.right - e.clientX < edgeZone) {
      setDrag({ kind: "trim", clipId: clip.id, edge: "out", delta: 0 });
    } else {
      setDrag({ kind: "move", clipId: clip.id, grabOffset: t - clip.start, delta: 0, trackIndex: project.tracks.indexOf(track) });
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    if (drag.kind === "scrub") { seek(toTime(e.clientX)); return; }
    const loc = findClip(project, drag.clipId);
    if (!loc) return;
    const clip = loc.clip;
    const t = toTime(e.clientX);

    if (drag.kind === "move") {
      let ns = t - drag.grabOffset;
      const snappedStart = snap(ns);
      if (snappedStart !== ns) {
        ns = snappedStart;
      } else {
        const se = snap(ns + clip.duration);
        if (se !== ns + clip.duration) ns = se - clip.duration;
      }
      ns = Math.max(0, ns);
      const ti = trackIndexAt(e.clientY, clip.kind === "audio" ? "audio" : clip.kind === "text" ? "text" : "video");
      if (ns - clip.start !== drag.delta || ti !== drag.trackIndex) {
        setDrag({ ...drag, delta: ns - clip.start, trackIndex: ti });
      }
    } else {
      const isMedia = clip.kind !== "text";
      let delta: TimeTicks;
      if (drag.edge === "in") {
        delta = snap(t) - clip.start;
        delta = Math.min(delta, clip.duration - 1);
        if (isMedia && "sourceIn" in clip) {
          delta = Math.max(delta, -Math.round(clip.sourceIn / Math.abs(clip.speed)));
        }
      } else {
        delta = snap(t) - clipEnd(clip);
        delta = Math.max(delta, 1 - clip.duration);
        if (isMedia && "sourceOut" in clip) {
          const asset = project.assets[(clip as { assetId: string }).assetId];
          if (asset?.durationTicks !== undefined) {
            const maxDelta = Math.round((asset.durationTicks - (clip as { sourceOut: number }).sourceOut) / Math.abs((clip as { speed: number }).speed));
            delta = Math.min(delta, maxDelta);
          }
        }
      }
      delta = clampTrimDelta(loc.track, clip, drag.edge, delta);
      if (delta !== drag.delta) setDrag({ ...drag, delta });
    }
  };

  const onMouseUp = () => {
    if (!drag) return;
    if (drag.kind === "move" && (drag.delta !== 0 || drag.trackIndex !== -1)) {
      const loc = findClip(project, drag.clipId);
      if (loc) {
        const targetTrack =
          drag.trackIndex >= 0 ? project.tracks[drag.trackIndex]! : loc.track;
        const desired = Math.max(0, loc.clip.start + drag.delta);
        const start = resolvePlacement(targetTrack, drag.clipId, desired, loc.clip.duration);
        if (start !== null && (start !== loc.clip.start || targetTrack.id !== loc.track.id)) {
          dispatch(
            [{ type: "clip.move", clipId: drag.clipId, start, trackId: targetTrack.id }],
            "move clip",
          );
        }
      }
    } else if (drag.kind === "trim" && drag.delta !== 0) {
      dispatch([{ type: "clip.trim", clipId: drag.clipId, edge: drag.edge, delta: drag.delta }], "trim clip");
    }
    setDrag(null);
  };

  // visual projection of a clip under the active drag
  const view = (clip: Clip): { start: TimeTicks; duration: TimeTicks; ghost?: boolean } => {
    if (drag && "clipId" in drag && drag.clipId === clip.id) {
      if (drag.kind === "move") return { start: clip.start + drag.delta, duration: clip.duration };
      if (drag.edge === "in") return { start: clip.start + drag.delta, duration: clip.duration - drag.delta };
      return { start: clip.start, duration: clip.duration + drag.delta };
    }
    return { start: clip.start, duration: clip.duration };
  };

  const tickMarks = useMemo(() => {
    const step = pxPerSec > 120 ? 1 : pxPerSec > 40 ? 5 : 30; // seconds
    const marks = [];
    for (let s = 0; s * 90000 < end + step * 90000; s += step) {
      marks.push({ t: s * 90000, label: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` });
    }
    return marks;
  }, [pxPerSec, end]);

  return (
    <div className="tl-root">
      <div className="tl-toolbar">
        <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")} title="Select (V)">⬚</button>
        <button className={tool === "blade" ? "active" : ""} onClick={() => setTool("blade")} title="Blade (B)">✂</button>
        <button onClick={splitAtPlayhead} title="Split at playhead (S)">Split</button>
        <button onClick={addTextClip} title="Add text (T)">T</button>
        <button onClick={addSceneClip} title="Add scene (motion graphics)">⬒ Scene</button>
        <button onClick={addIntroScene} title="Demo: AIedit logo intro animation">★ Intro</button>
        <button onClick={addAdjustmentClip} title="Add adjustment layer">Adj</button>
        <button
          onClick={() => selection.length === 1 && cutSilences(selection[0]!)}
          disabled={selection.length !== 1}
          title="Cut silent ranges + ripple (silence detected on import)"
        >Cut sil</button>
        <span className="tl-zoom">
          <button onClick={() => setZoom(pxPerSec / 1.4)}>−</button>
          <button onClick={() => setZoom(pxPerSec * 1.4)}>+</button>
          <button onClick={zoomFit} title="Fit timeline">Fit</button>
        </span>
      </div>
      <div className="tl-body">
        <div className="tl-trackheads">
          <div style={{ height: RULER_H }} />
          {project.tracks.map((tr) => (
            <div key={tr.id} className="tl-trackhead" style={{ height: TRACK_H }}>
              <span>{tr.name}</span>
              <button
                className={tr.muted ? "muted" : ""}
                onClick={() => dispatch([{ type: "track.set", trackId: tr.id, patch: { muted: !tr.muted } }], "mute track")}
                title="Mute"
              >{tr.muted ? "🔇" : "🔊"}</button>
            </div>
          ))}
        </div>
        <div
          className="tl-lanes"
          ref={laneRef}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        >
          <div className="tl-ruler" style={{ width: contentW, height: RULER_H }} onMouseDown={onRulerDown}>
            {tickMarks.map((m) => (
              <span key={m.t} className="tl-tick" style={{ left: ticks.toSeconds(m.t) * pxPerSec }}>
                {m.label}
              </span>
            ))}
          </div>
          <div
            className="tl-lane-stack"
            style={{ width: contentW }}
            onMouseDown={(e) => { if (e.target === e.currentTarget) select([]); }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const assetId = e.dataTransfer.getData("aiedit/asset");
              if (!assetId) return;
              const stack = e.currentTarget.getBoundingClientRect();
              const ti = Math.floor((e.clientY - stack.top) / TRACK_H);
              dropOnTimeline(assetId, snap(toTime(e.clientX)), ti);
            }}
          >
            {project.tracks.map((tr, ti) => (
              <div
                key={tr.id}
                className={`tl-track tl-track-${tr.kind}${drag?.kind === "move" && drag.trackIndex === ti ? " dragover" : ""}`}
                style={{ height: TRACK_H }}>
                {tr.clips.map((clip) => {
                  const v = view(clip);
                  const isSel = selection.includes(clip.id);
                  return (
                    <div
                      key={clip.id}
                      className={`tl-clip ${isSel ? "sel" : ""} kind-${clip.kind}`}
                      style={{
                        left: ticks.toSeconds(v.start) * pxPerSec,
                        width: Math.max(2, ticks.toSeconds(v.duration) * pxPerSec),
                      }}
                      onMouseDown={(e) => onClipDown(e, clip, tr)}
                      title={clipLabel(clip)}
                    >
                      {"assetId" in clip && peaks[(clip as { assetId: string }).assetId] && (
                        <ClipWave
                          peaks={peaks[(clip as { assetId: string }).assetId]!}
                          clip={clip}
                        />
                      )}
                      {silenceBands(clip, project).map((b, i) => (
                        <i key={`s${i}`} className="tl-silence" style={{ left: `${b.x * 100}%`, width: `${b.w * 100}%` }} />
                      ))}
                      {"keys" in clip.transform && clip.transform.keys.map((k) => (
                        <i
                          key={k.at}
                          className="tl-key"
                          style={{ left: ticks.toSeconds(k.at) * pxPerSec }}
                          title="keyframe"
                        />
                      ))}
                      <span className="tl-clip-label">{clipLabel(clip)}</span>
                      <i className="tl-edge l" /><i className="tl-edge r" />
                    </div>
                  );
                })}
              </div>
            ))}
            <div className="tl-playhead" style={{ left: ticks.toSeconds(playhead) * pxPerSec }} />
          </div>
        </div>
      </div>
      <div className="tl-status">{formatTimecode(playhead, project.settings.fps)}</div>
    </div>
  );
}

function clipLabel(clip: Clip): string {
  if (clip.kind === "text") return `T: ${clip.content.slice(0, 24)}`;
  return clip.id.slice(0, 12);
}

function ClipWave({ peaks, clip }: { peaks: number[]; clip: Clip }): React.ReactElement {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const project = useEditor((s) => s.project);
  React.useEffect(() => {
    const cnv = ref.current!;
    const el = cnv.parentElement!;
    const w = el.clientWidth, h = el.clientHeight;
    if (w < 4) return;
    cnv.width = w; cnv.height = h;
    const ctx = cnv.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    const asset = "assetId" in clip ? project.assets[(clip as { assetId: string }).assetId] : undefined;
    const total = asset?.durationTicks ?? clip.duration;
    const si = "sourceIn" in clip ? clip.sourceIn : 0;
    const so = "sourceOut" in clip ? clip.sourceOut : clip.duration;
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const srcT = si + ((so - si) * x) / w;
      const idx = Math.floor((srcT / total) * peaks.length);
      const amp = Math.max(0.03, peaks[Math.min(peaks.length - 1, Math.max(0, idx))] ?? 0);
      const hh = amp * mid;
      ctx.fillRect(x, mid - hh, 1, hh * 2);
    }
  });
  return <canvas ref={ref} className="tl-wave" />;
}


/** Silence ranges as fractions of the clip box (source-time → clip-local). */
function silenceBands(clip: Clip, project: { assets: Record<string, { analysis?: { kind: string; segments: { start: TimeTicks; end: TimeTicks; score: number }[] }[] }> }): { x: number; w: number }[] {
  if (clip.kind !== "video" && clip.kind !== "audio" || clip.speed <= 0) return [];
  const sil = project.assets[clip.assetId]?.analysis?.find((a) => a.kind === "silence");
  if (!sil) return [];
  const out: { x: number; w: number }[] = [];
  for (const g of sil.segments) {
    const s = (g.start - clip.sourceIn) / clip.speed;
    const e = (g.end - clip.sourceIn) / clip.speed;
    const x0 = Math.max(0, s / clip.duration);
    const x1 = Math.min(1, e / clip.duration);
    if (x1 > x0) out.push({ x: x0, w: x1 - x0 });
  }
  return out;
}
