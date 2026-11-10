import React, { useMemo, useRef, useState } from "react";
import type { Clip, EaseSpec, Keyframe, Transform } from "@aiedit/core";
import { sample, ticks, type TimeTicks } from "@aiedit/core";
import { useEditor } from "./store.js";

type Channel = "x" | "y" | "scale" | "rotation" | "opacity";

const CHANNELS: { id: Channel; label: string; get: (t: Transform) => number; set: (tr: Transform, v: number) => Transform; fmt: (v: number) => number }[] = [
  { id: "x", label: "X", get: (t) => t.x, set: (t, v) => ({ ...t, x: v }), fmt: (v) => v },
  { id: "y", label: "Y", get: (t) => t.y, set: (t, v) => ({ ...t, y: v }), fmt: (v) => v },
  { id: "scale", label: "Scale", get: (t) => t.scaleX, set: (t, v) => ({ ...t, scaleX: v, scaleY: v }), fmt: (v) => v },
  { id: "rotation", label: "Rot°", get: (t) => (t.rotation * 180) / Math.PI, set: (t, v) => ({ ...t, rotation: (v * Math.PI) / 180 }), fmt: (v) => v },
  { id: "opacity", label: "Opacity", get: (t) => t.opacity, set: (t, v) => ({ ...t, opacity: v }), fmt: (v) => v },
];

const EASE_PRESETS: { label: string; ease: EaseSpec }[] = [
  { label: "linear", ease: { kind: "linear" } },
  { label: "ease-in", ease: { kind: "bezier", cx1: 0.42, cy1: 0, cx2: 1, cy2: 1 } },
  { label: "ease-out", ease: { kind: "bezier", cx1: 0, cy1: 0, cx2: 0.58, cy2: 1 } },
  { label: "in-out", ease: { kind: "bezier", cx1: 0.42, cy1: 0, cx2: 0.58, cy2: 1 } },
  { label: "spring", ease: { kind: "spring", stiffness: 120, damping: 10 } },
];

interface DragState {
  kind: "key" | "h1" | "h2";
  keyIndex: number;
}

const W = 300, H = 150, PAD = 12;

export function GraphEditor({ clip }: { clip: Clip }): React.ReactElement | null {
  const dispatch = useEditor((s) => s.dispatch);
  const playhead = useEditor((s) => s.playhead);
  const [channel, setChannel] = useState<Channel>("y");
  const [selKey, setSelKey] = useState<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [draftKeys, setDraftKeys] = useState<Keyframe<Transform>[] | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const ch = CHANNELS.find((c) => c.id === channel)!;
  const kf = clip.transform;
  if (!("keys" in kf)) return null;
  const keys = draftKeys ?? kf.keys;
  const dur = clip.duration;
  const local = Math.max(0, Math.min(dur, playhead - clip.start));

  // value range from keys + sampled curve
  const { vmin, vmax } = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 120; i++) {
      const v = ch.get(sample(kf, (i / 120) * dur));
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    if (hi - lo < 1e-6) { hi = lo + 1; }
    const pad = (hi - lo) * 0.15;
    return { vmin: lo - pad, vmax: hi + pad };
  }, [kf, dur, ch]);

  const tx = (t: TimeTicks) => PAD + (t / dur) * (W - 2 * PAD);
  const ty = (v: number) => PAD + (1 - (v - vmin) / (vmax - vmin)) * (H - 2 * PAD);
  const it = (px: number) => Math.max(0, Math.min(dur, Math.round(((px - PAD) / (W - 2 * PAD)) * dur)));
  const iv = (py: number) => vmin + (1 - (py - PAD) / (H - 2 * PAD)) * (vmax - vmin);

  const curvePts = useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i <= 120; i++) {
      const t = (i / 120) * dur;
      pts.push(`${tx(t).toFixed(1)},${ty(ch.get(sample(kf, t))).toFixed(1)}`);
    }
    return pts.join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kf, dur, ch, vmin, vmax]);

  const toSvg = (e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  /** One semantic op per drag — keeps the op log clean for training data. */
  const commit = (nextKeys: typeof keys) => {
    const c = { ...clip, transform: { keys: nextKeys } } as Clip;
    dispatch([{ type: "clip.replace", clipId: clip.id, clip: c }], "edit curve");
    setDraftKeys(null);
  };

  const endDrag = () => {
    if (draftKeys) commit(draftKeys);
    setDrag(null);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    const { x, y } = toSvg(e);
    const next = keys.map((k: (typeof keys)[number]) => ({ ...k }));
    const ki = drag.keyIndex;
    const key = next[ki]!;
    if (drag.kind === "key") {
      key.at = it(x);
      key.value = ch.set(key.value, iv(y));
    } else {
      const b = next[ki + 1];
      if (!b || key.ease.kind !== "bezier") return;
      const dt = b.at - key.at || 1;
      const dv = ch.get(b.value) - ch.get(key.value);
      const cx = Math.max(0, Math.min(1, (it(x) - key.at) / dt));
      const cy = dv === 0 ? 0 : (iv(y) - ch.get(key.value)) / dv;
      key.ease = drag.kind === "h1"
        ? { ...key.ease, cx1: cx, cy1: cy }
        : { ...key.ease, cx2: cx, cy2: cy };
    }
    setDraftKeys(next as typeof keys);
  };

  const setEaseFor = (ki: number, ease: EaseSpec) => {
    const next = keys.map((k: (typeof keys)[number], i: number) => (i === ki ? { ...k, ease } : { ...k }));
    commit(next as typeof keys);
  };

  return (
    <div className="ge-root">
      <div className="ge-tabs">
        {CHANNELS.map((c) => (
          <button key={c.id} className={channel === c.id ? "active" : ""} onClick={() => setChannel(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="ge-svg"
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onDoubleClick={(e) => {
          const { x, y } = toSvg(e);
          const t = it(x);
          const tr = sample(kf, t);
          const v = ch.set(tr, iv(y));
          dispatch([{ type: "key.set", clipId: clip.id, field: "transform", at: t, value: v }], "add key");
        }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={PAD} x2={W - PAD} y1={PAD + f * (H - 2 * PAD)} y2={PAD + f * (H - 2 * PAD)} className="ge-grid" />
        ))}
        <polyline points={curvePts} className="ge-curve" />
        {/* playhead */}
        <line x1={tx(local)} x2={tx(local)} y1={PAD} y2={H - PAD} className="ge-playhead" />
        {/* bezier handles for selected key */}
        {selKey !== null && keys[selKey] && keys[selKey + 1] && keys[selKey]!.ease.kind === "bezier" && (() => {
          const a = keys[selKey]!, b = keys[selKey + 1]!;
          const e = a.ease as Extract<EaseSpec, { kind: "bezier" }>;
          const dt = b.at - a.at, dv = ch.get(b.value) - ch.get(a.value);
          const h1 = { x: tx(a.at + e.cx1 * dt), y: ty(ch.get(a.value) + e.cy1 * dv) };
          const h2 = { x: tx(a.at + e.cx2 * dt), y: ty(ch.get(a.value) + e.cy2 * dv) };
          return (
            <>
              <line x1={tx(a.at)} y1={ty(ch.get(a.value))} x2={h1.x} y2={h1.y} className="ge-handle-line" />
              <line x1={tx(b.at)} y1={ty(ch.get(b.value))} x2={h2.x} y2={h2.y} className="ge-handle-line" />
              <circle cx={h1.x} cy={h1.y} r={4} className="ge-handle"
                onMouseDown={(e) => { e.stopPropagation(); setDrag({ kind: "h1", keyIndex: selKey }); }} />
              <circle cx={h2.x} cy={h2.y} r={4} className="ge-handle"
                onMouseDown={(e) => { e.stopPropagation(); setDrag({ kind: "h2", keyIndex: selKey }); }} />
            </>
          );
        })()}
        {keys.map((k, i) => (
          <rect
            key={i}
            x={tx(k.at) - 4} y={ty(ch.get(k.value)) - 4} width={8} height={8}
            transform={`rotate(45 ${tx(k.at)} ${ty(ch.get(k.value))})`}
            className={`ge-key ${selKey === i ? "sel" : ""}`}
            onMouseDown={(e) => { e.stopPropagation(); setSelKey(i); setDrag({ kind: "key", keyIndex: i }); }}
          />
        ))}
      </svg>
      <div className="ge-footer">
        {selKey !== null && (
          <>
            <span>{ticks.toSeconds(keys[selKey]!.at).toFixed(2)}s</span>
            {EASE_PRESETS.map((p) => (
              <button key={p.label} onClick={() => setEaseFor(selKey, p.ease)}>{p.label}</button>
            ))}
            <button onClick={() => {
              dispatch([{ type: "key.remove", clipId: clip.id, field: "transform", at: keys[selKey]!.at }], "remove key");
              setSelKey(null);
            }}>✕</button>
          </>
        )}
        <span className="ge-hint">dbl-click = add key</span>
      </div>
    </div>
  );
}
