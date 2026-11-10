import React from "react";
import type { Clip, Transform } from "@aiedit/core";
import { findClip, ticks } from "@aiedit/core";
import { EFFECT_REGISTRY, makeEffect } from "@aiedit/engine";
import { newId } from "@aiedit/core";
import { useEditor } from "./store.js";

export function Inspector(): React.ReactElement {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const dispatch = useEditor((s) => s.dispatch);

  const loc = selection.length === 1 ? findClip(project, selection[0]!) : undefined;
  const clip = loc?.clip;

  return (
    <div className="in-root">
      <div className="in-head">Inspector</div>
      {!clip && <div className="in-empty">Select a clip</div>}
      {clip && <ClipInspector clip={clip} />}
    </div>
  );
}

function Num({ label, value, onChange, step = 0.01, min, max }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number;
}) {
  return (
    <label className="in-num">
      <span>{label}</span>
      <input
        type="number" value={Number(value.toFixed(3))} step={step}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Slider({ label, value, onChange, min = 0, max = 1, step = 0.01 }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
}) {
  return (
    <label className="in-slider">
      <span>{label}</span>
      <input type="range" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value))} />
      <em>{value.toFixed(2)}</em>
    </label>
  );
}

function ClipInspector({ clip }: { clip: Clip }) {
  const dispatch = useEditor((s) => s.dispatch);
  const project = useEditor((s) => s.project);

  const isMedia = clip.kind === "video" || clip.kind === "audio";
  const tr: Transform = "static" in clip.transform ? clip.transform.static : clip.transform.keys[0]?.value ?? {
    x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1,
  };

  const setTransform = (patch: Partial<Transform>) =>
    dispatch([{ type: "clip.set", clipId: clip.id, patch: { transform: { static: { ...tr, ...patch } } } }], "transform");

  return (
    <div className="in-body">
      <div className="in-sec">
        <h4>{clip.kind} clip</h4>
        <div className="in-meta">
          <span>start {ticks.toSeconds(clip.start).toFixed(2)}s</span>
          <span>dur {ticks.toSeconds(clip.duration).toFixed(2)}s</span>
          {isMedia && "speed" in clip && <span>{clip.speed}×</span>}
        </div>
      </div>

      {isMedia && "speed" in clip && (
        <div className="in-sec">
          <h4>Timing</h4>
          <Num label="Speed" value={clip.speed} step={0.1}
            onChange={(v) => v !== 0 && dispatch([{ type: "clip.setSpeed", clipId: clip.id, speed: v }], "set speed")} />
          <Slider label="Gain" value={clip.gain} max={2}
            onChange={(v) => dispatch([{ type: "clip.set", clipId: clip.id, patch: { gain: v } }], "set gain")} />
        </div>
      )}

      <div className="in-sec">
        <h4>Transform</h4>
        <Num label="X" value={tr.x} step={1} onChange={(v) => setTransform({ x: v })} />
        <Num label="Y" value={tr.y} step={1} onChange={(v) => setTransform({ y: v })} />
        <Num label="Scale" value={tr.scaleX} step={0.05} min={0.01}
          onChange={(v) => setTransform({ scaleX: v, scaleY: v })} />
        <Num label="Rotation°" value={(tr.rotation * 180) / Math.PI} step={1}
          onChange={(v) => setTransform({ rotation: (v * Math.PI) / 180 })} />
        <Slider label="Opacity" value={tr.opacity} onChange={(v) => setTransform({ opacity: v })} />
      </div>

      {clip.kind === "text" && (
        <div className="in-sec">
          <h4>Text</h4>
          <textarea
            value={clip.content}
            onChange={(e) => dispatch([{ type: "clip.set", clipId: clip.id, patch: { content: e.target.value } }], "edit text")}
          />
          <Num label="Font size" value={clip.style.fontSize} step={4} min={8}
            onChange={(v) => dispatch([{ type: "clip.set", clipId: clip.id, patch: { textStyle: { fontSize: v } } }], "font size")} />
          <label className="in-num">
            <span>Color</span>
            <input type="color" value={clip.style.color}
              onChange={(e) => dispatch([{ type: "clip.set", clipId: clip.id, patch: { textStyle: { color: e.target.value } } }], "text color")} />
          </label>
        </div>
      )}

      <div className="in-sec">
        <h4>Effects</h4>
        {clip.effects.map((e) => {
          const spec = EFFECT_REGISTRY[e.type];
          return (
            <div key={e.id} className="in-effect">
              <div className="in-effect-head">
                <span>{spec?.label ?? e.type}</span>
                <button onClick={() => dispatch([{ type: "effect.remove", clipId: clip.id, effectId: e.id }], "remove fx")}>✕</button>
              </div>
              {spec && Object.keys(spec.defaults).map((k) => (
                <Slider
                  key={k} label={k} value={e.params[k] ?? spec.defaults[k]!}
                  min={k === "contrast" || k === "saturation" ? 0 : -2} max={2}
                  onChange={(v) => dispatch([{ type: "effect.setParam", clipId: clip.id, effectId: e.id, key: k, value: v }], "fx param")}
                />
              ))}
            </div>
          );
        })}
        <button
          onClick={() => dispatch([{ type: "effect.add", clipId: clip.id, effect: makeEffect("color.basic", newId("fx")) }], "add color")}
        >+ Color</button>
      </div>
    </div>
  );
}
