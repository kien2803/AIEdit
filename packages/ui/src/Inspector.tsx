import React from "react";
import type { Clip, SceneElement, Transform } from "@aiedit/core";
import { findClip, sample, staticOf, ticks, findElementIn } from "@aiedit/core";
import { EFFECT_REGISTRY, makeEffect } from "@aiedit/engine";
import { newId } from "@aiedit/core";
import { useEditor } from "./store.js";
import { GraphEditor } from "./GraphEditor.jsx";

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
  const playhead = useEditor((s) => s.playhead);
  const local = playhead - clip.start;
  const tr: Transform = sample(clip.transform, Math.max(0, Math.min(clip.duration - 1, local)));

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

      <TransformSection clip={clip} tr={tr} setTransform={setTransform} />

      {"keys" in clip.transform && <GraphEditor clip={clip} />}

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

      {clip.kind === "scene" && <SceneSection clipId={clip.id} sceneId={clip.sceneId} />}

      <div className="in-sec">
        <h4>Transitions</h4>
        <TransitionRow clip={clip} edge="in" />
        <TransitionRow clip={clip} edge="out" />
      </div>

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


function TransformSection({ clip, tr, setTransform }: {
  clip: Clip; tr: Transform; setTransform: (p: Partial<Transform>) => void;
}) {
  const dispatch = useEditor((s) => s.dispatch);
  const playhead = useEditor((s) => s.playhead);
  const keyframed = "keys" in clip.transform;
  const local = Math.max(0, Math.min(clip.duration - 1, playhead - clip.start));
  const keys = "keys" in clip.transform ? clip.transform.keys : [];
  const nearKey = keys.find((k) => Math.abs(k.at - local) < 3000);

  const write = (patch: Partial<Transform>) => {
    if (keyframed) {
      dispatch([{
        type: "key.set", clipId: clip.id, field: "transform", at: local,
        value: { ...tr, ...patch },
      }], "keyframe");
    } else {
      setTransform(patch);
    }
  };

  return (
    <div className="in-sec">
      <h4>
        Transform{" "}
        <button
          className={keyframed ? "active" : ""}
          title={keyframed ? "Keyframes on" : "Enable keyframes"}
          onClick={() => dispatch([{ type: "key.toggle", clipId: clip.id, field: "transform", keyframed: !keyframed }], "toggle keyframes")}
        >◆</button>
      </h4>
      {keyframed && (
        <div className="in-meta" style={{ marginBottom: 6 }}>
          <span>{keys.length} keys</span>
          {nearKey && (
            <button onClick={() => dispatch([{ type: "key.remove", clipId: clip.id, field: "transform", at: nearKey.at }], "remove key")}>
              ✕ key here
            </button>
          )}
        </div>
      )}
      <Num label="X" value={tr.x} step={1} onChange={(v) => write({ x: v })} />
      <Num label="Y" value={tr.y} step={1} onChange={(v) => write({ y: v })} />
      <Num label="Scale" value={tr.scaleX} step={0.05} min={0.01}
        onChange={(v) => write({ scaleX: v, scaleY: v })} />
      <Num label="Rotation°" value={(tr.rotation * 180) / Math.PI} step={1}
        onChange={(v) => write({ rotation: (v * Math.PI) / 180 })} />
      <Slider label="Opacity" value={tr.opacity} onChange={(v) => write({ opacity: v })} />
    </div>
  );
}

function TransitionRow({ clip, edge }: { clip: Clip; edge: "in" | "out" }) {
  const dispatch = useEditor((s) => s.dispatch);
  const cur = clip.transitions?.[edge];
  const apply = (type: "fade" | "dip-black" | "none", durSec: number) => {
    const next = { ...(clip.transitions ?? {}) };
    if (type === "none" || durSec <= 0) delete next[edge];
    else next[edge] = { type, duration: ticks.fromSeconds(durSec) };
    dispatch([{ type: "clip.replace", clipId: clip.id, clip: { ...clip, transitions: next } }], "transition");
  };
  return (
    <div className="in-num">
      <span>{edge === "in" ? "In" : "Out"}</span>
      <select
        value={cur?.type ?? "none"}
        onChange={(e) => apply(e.target.value as "fade" | "dip-black", cur ? ticks.toSeconds(cur.duration) : 0.5)}
      >
        <option value="none">none</option>
        <option value="fade">fade</option>
        <option value="dip-black">dip-black</option>
      </select>
      {cur && (
        <input type="number" value={Number(ticks.toSeconds(cur.duration).toFixed(2))} step={0.1} min={0.1}
          style={{ width: 60 }}
          onChange={(e) => apply(cur.type, Number(e.target.value))} />
      )}
    </div>
  );
}

function SceneSection({ clipId, sceneId }: { clipId: string; sceneId: string }) {
  const project = useEditor((s) => s.project);
  const dispatch = useEditor((s) => s.dispatch);
  const scene = project.scenes[sceneId];
  const [selEl, setSelEl] = React.useState<string | null>(null);
  if (!scene) return null;
  const flat = (els: SceneElement[], depth = 0): { el: SceneElement; depth: number }[] =>
    els.flatMap((el) => [{ el, depth }, ...(el.kind === "group" ? flat(el.elements, depth + 1) : [])]);
  const selected = selEl ? findElementIn(scene.elements, selEl) : undefined;
  return (
    <div className="in-sec">
      <h4>Scene elements</h4>
      <div className="in-el-list">
        {flat(scene.elements).map(({ el, depth }) => (
          <div
            key={el.id}
            className={`in-el ${selEl === el.id ? "sel" : ""}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => setSelEl(el.id)}
          >
            <span className="in-el-kind">{el.kind}</span>
            <span>{el.name}</span>
            <button onClick={(e) => {
              e.stopPropagation();
              dispatch([{ type: "element.remove", sceneId, elementId: el.id }], "remove element");
            }}>✕</button>
          </div>
        ))}
      </div>
      {selected && <ElementInspector sceneId={sceneId} el={selected} />}
    </div>
  );
}

function ElementInspector({ sceneId, el }: { sceneId: string; el: SceneElement }) {
  const dispatch = useEditor((s) => s.dispatch);
  const tr = staticOf(el.transform);
  const set = (patch: Parameters<typeof dispatch>[0] extends never[] ? never : import("@aiedit/core").ElementPatch) =>
    dispatch([{ type: "element.set", sceneId, elementId: el.id, patch }], "edit element");
  return (
    <div style={{ marginTop: 8 }}>
      <Num label="X" value={tr.x} step={1}
        onChange={(v) => set({ transform: { static: { ...tr, x: v } } })} />
      <Num label="Y" value={tr.y} step={1}
        onChange={(v) => set({ transform: { static: { ...tr, y: v } } })} />
      {el.kind === "shape" && (
        <label className="in-num"><span>Fill</span>
          <input type="color" value={el.fill} onChange={(e) => set({ fill: e.target.value })} />
        </label>
      )}
      {el.kind === "text" && (
        <>
          <textarea value={el.content} onChange={(e) => set({ content: e.target.value })} />
          <Num label="Font size" value={el.style.fontSize} step={4} min={8}
            onChange={(v) => set({ fontSize: v })} />
        </>
      )}
    </div>
  );
}
