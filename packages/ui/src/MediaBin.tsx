import React, { useRef } from "react";
import { ticks } from "@aiedit/core";
import { useEditor } from "./store.js";
import { TemplatesPanel } from "./TemplatesPanel.jsx";

export function MediaBin(): React.ReactElement {
  const project = useEditor((s) => s.project);
  const importFiles = useEditor((s) => s.importFiles);
  const addToTimeline = useEditor((s) => s.addToTimeline);
  const inputRef = useRef<HTMLInputElement>(null);

  const assets = Object.values(project.assets);

  return (
    <div className="mb-root">
      <div className="mb-head">
        <span>Media</span>
        <button onClick={() => inputRef.current?.click()}>Import</button>
        <input
          ref={inputRef} type="file" multiple hidden
          accept="video/*,audio/*,image/*"
          onChange={(e) => { if (e.target.files) void importFiles(e.target.files); e.target.value = ""; }}
        />
      </div>
      <div className="mb-list" style={{ flex: "0 0 55%" }}>
        {assets.length === 0 && <div className="mb-empty">Import media to start</div>}
        {assets.map((a) => (
          <div
            key={a.id}
            className="mb-item"
            onDoubleClick={() => addToTimeline(a.id)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("aiedit/asset", a.id);
              e.dataTransfer.effectAllowed = "copy";
            }}
          >
            <span className={`mb-kind kind-${a.kind}`}>{a.kind[0]!.toUpperCase()}</span>
            <span className="mb-name" title={a.name}>{a.name}</span>
            <span className="mb-dur">{a.durationTicks !== undefined ? `${ticks.toSeconds(a.durationTicks).toFixed(1)}s` : "—"}</span>
            <button onClick={() => addToTimeline(a.id)} title="Add to timeline">+</button>
          </div>
        ))}
      </div>
      <TemplatesPanel />
    </div>
  );
}
