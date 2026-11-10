import React, { useEffect } from "react";
import { Inspector, MediaBin, Preview, Timeline, useEditor } from "@aiedit/ui";

export function App(): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useEditor.getState();
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "z" && !e.shiftKey) { e.preventDefault(); s.undo(); return; }
      if (mod && (e.key === "Z" || e.key === "y")) { e.preventDefault(); s.redo(); return; }
      switch (e.key) {
        case " ": e.preventDefault(); s.togglePlay(); break;
        case "Delete": case "Backspace": s.deleteSelected(e.shiftKey); break;
        case "v": case "V": s.setTool("select"); break;
        case "b": case "B": s.setTool("blade"); break;
        case "s": case "S": s.splitAtPlayhead(); break;
        case "t": case "T": s.addTextClip(); break;
        case "ArrowLeft": s.seek(s.playhead - (e.shiftKey ? 90000 : 3000)); break;
        case "ArrowRight": s.seek(s.playhead + (e.shiftKey ? 90000 : 3000)); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const saveProject = useEditor((s) => s.saveProject);
  const loadProject = useEditor((s) => s.loadProject);
  const exportSession = useEditor((s) => s.exportSession);
  const exportVideo = useEditor((s) => s.exportVideo);
  const exportProgress = useEditor((s) => s.exportProgress);
  const fileRef = React.useRef<HTMLInputElement>(null);

  return (
    <div className="app">
      <div className="app-header">
        <span className="brand">AIedit</span>
        <button onClick={saveProject}>Save</button>
        <button onClick={() => fileRef.current?.click()}>Load</button>
        <input
          ref={fileRef} type="file" hidden accept=".json,application/json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadProject(f);
            e.target.value = "";
          }}
        />
        <span className="spacer" />
        <button onClick={exportSession} title="Export edit session log (training data)">Export log</button>
        <button onClick={() => void exportVideo()} disabled={exportProgress !== null}>
          {exportProgress === null ? "Export MP4" : `Exporting ${(exportProgress * 100).toFixed(0)}%`}
        </button>
      </div>
      <div className="app-bin"><MediaBin /></div>
      <div className="app-preview"><Preview /></div>
      <div className="app-inspector"><Inspector /></div>
      <div className="app-timeline"><Timeline /></div>
    </div>
  );
}
