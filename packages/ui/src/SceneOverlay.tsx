import React, { useRef, useState } from "react";
import type { SceneElement, TimeTicks, Transform } from "@aiedit/core";
import { findClip, sample, setKey, staticOf, ticks } from "@aiedit/core";
import { useEditor } from "./store.js";

/** Element bounding box in project coords (center-origin transform applied). */
function elBox(el: SceneElement, t: TimeTicks, W: number, H: number, assetDims?: { w: number; h: number }): { x: number; y: number; w: number; h: number } | null {
  if (!el.enabled || t < el.start || t >= el.end) return null;
  const tr = sample(el.transform, t - el.start);
  let w = 200, h = 100;
  if (el.kind === "shape") { w = el.w; h = el.h; }
  else if (el.kind === "text") {
    w = Math.max(60, el.content.length * el.style.fontSize * 0.55);
    h = el.style.fontSize * 1.3;
  } else if (el.kind === "footage") {
    w = assetDims?.w ?? W / 2; h = assetDims?.h ?? H / 2;
  } else if (el.kind === "emitter") { w = 120; h = 120; }
  else return null; // group: skip hit-testing children for now
  w *= tr.scaleX; h *= tr.scaleY;
  return { x: W / 2 + tr.x - w / 2, y: H / 2 + tr.y - h / 2, w, h };
}

export function SceneOverlay(): React.ReactElement | null {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const selection = useEditor((s) => s.selection);
  const dispatch = useEditor((s) => s.dispatch);
  const [drag, setDrag] = useState<{ elId: string; dx: number; dy: number; moved: boolean } | null>(null);
  const [selEl, setSelEl] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const loc = selection.length === 1 ? findClip(project, selection[0]!) : undefined;
  if (!loc || loc.clip.kind !== "scene") return null;
  const scene = project.scenes[loc.clip.sceneId];
  if (!scene) return null;

  const sceneT = playhead - loc.clip.start;
  const { width: W, height: H } = project.settings;

  const toProject = (clientX: number, clientY: number) => {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * W, y: ((clientY - r.top) / r.height) * H };
  };

  // topmost first for hit order — render order is bottom→top so iterate reversed
  const visible = [...scene.elements].reverse();

  return (
    <div ref={rootRef} className="sv-root">
      {visible.map((el) => {
        const dims = el.kind === "footage"
          ? { w: project.assets[el.assetId]?.width, h: project.assets[el.assetId]?.height }
          : undefined;
        const box = elBox(el, sceneT, W, H, dims as { w: number; h: number } | undefined);
        if (!box) return null;
        const isSel = selEl === el.id;
        const dragging = drag?.elId === el.id;
        const dx = dragging ? drag.dx : 0, dy = dragging ? drag.dy : 0;
        return (
          <div
            key={el.id}
            className={`sv-box ${isSel ? "sel" : ""}`}
            style={{
              left: `${((box.x + dx) / W) * 100}%`,
              top: `${((box.y + dy) / H) * 100}%`,
              width: `${(box.w / W) * 100}%`,
              height: `${(box.h / H) * 100}%`,
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
              setSelEl(el.id);
              setDrag({ elId: el.id, dx: 0, dy: 0, moved: false });
              const start = toProject(e.clientX, e.clientY);
              const tr0 = sample(el.transform, sceneT - el.start);
              const move = (ev: MouseEvent) => {
                const cur = toProject(ev.clientX, ev.clientY);
                setDrag({
                  elId: el.id,
                  dx: cur.x - start.x, dy: cur.y - start.y, moved: true,
                });
              };
              const up = (ev: MouseEvent) => {
                window.removeEventListener("mousemove", move);
                window.removeEventListener("mouseup", up);
                const cur = toProject(ev.clientX, ev.clientY);
                const ddx = cur.x - start.x, ddy = cur.y - start.y;
                setDrag(null);
                if (Math.abs(ddx) < 2 && Math.abs(ddy) < 2) return;
                const newTr: Transform = { ...tr0, x: tr0.x + ddx, y: tr0.y + ddy };
                const kf = el.transform;
                const nextTransform = "keys" in kf
                  ? setKey(kf, sceneT - el.start, newTr)
                  : ({ static: newTr } as typeof kf);
                dispatch([{
                  type: "element.set", sceneId: scene.id, elementId: el.id,
                  patch: { transform: nextTransform },
                }], "move element");
              };
              window.addEventListener("mousemove", move);
              window.addEventListener("mouseup", up);
            }}
          >
            <span className="sv-label">{el.name}</span>
          </div>
        );
      })}
    </div>
  );
}
