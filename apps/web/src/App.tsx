import React, { useEffect } from "react";
import { ChatPanel, ErrorBoundary, Inspector, MediaBin, Preview, SettingsDialog, Timeline, useEditor } from "@aiedit/ui";

function RightPanel(): React.ReactElement {
  const [tab, setTab] = React.useState<"inspector" | "chat">("inspector");
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="right-tabs">
        <button className={tab === "inspector" ? "active" : ""} onClick={() => setTab("inspector")}>Inspector</button>
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>AI Chat</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {tab === "inspector" ? <Inspector /> : <ChatPanel />}
      </div>
    </div>
  );
}

export function App(): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useEditor.getState();
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "z" && !e.shiftKey) { e.preventDefault(); s.undo(); return; }
      if (mod && (e.key === "Z" || e.key === "y")) { e.preventDefault(); s.redo(); return; }
      if (mod && e.key === "c") { e.preventDefault(); s.copySelection(); return; }
      if (mod && e.key === "v") { e.preventDefault(); s.paste(); return; }
      if (mod && e.key === "d") { e.preventDefault(); s.duplicateSelection(); return; }
      switch (e.key) {
        case " ": e.preventDefault(); s.togglePlay(); break;
        case "Delete": case "Backspace": s.deleteSelected(e.shiftKey); break;
        case "v": case "V": s.setTool("select"); break;
        case "b": case "B": s.setTool("blade"); break;
        case "s": case "S": s.splitAtPlayhead(); break;
        case "t": case "T": s.addTextClip(); break;
        case "ArrowLeft": s.seek(s.playhead - (e.shiftKey ? 90000 : 3000)); break;
        case "ArrowRight": s.seek(s.playhead + (e.shiftKey ? 90000 : 3000)); break;
        case ",": s.nudgeSelection(-3000); break;
        case ".": s.nudgeSelection(3000); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const saveProject = useEditor((s) => s.saveProject);
  const setAspect = useEditor((s) => s.setAspect);
  const loadProject = useEditor((s) => s.loadProject);
  const exportSession = useEditor((s) => s.exportSession);
  const exportVideo = useEditor((s) => s.exportVideo);
  const exportProgress = useEditor((s) => s.exportProgress);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  return (
    <ErrorBoundary>
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
        <select
          className="aspect-sel"
          title="Canvas aspect"
          defaultValue="16:9"
          onChange={(e) => {
            const [w, h] = e.target.value.split("x").map(Number);
            setAspect(w!, h!);
          }}
        >
          <option value="1920x1080">16:9</option>
          <option value="1080x1920">9:16</option>
          <option value="1080x1080">1:1</option>
          <option value="1080x1350">4:5</option>
        </select>
        <button onClick={() => setSettingsOpen(true)} title="AI settings">⚙</button>
        <button onClick={exportSession} title="Export edit session log (training data)">Export log</button>
        <button onClick={() => void exportVideo()} disabled={exportProgress !== null}>
          {exportProgress === null ? "Export MP4" : `Exporting ${(exportProgress * 100).toFixed(0)}%`}
        </button>
      </div>
      <div className="app-bin"><MediaBin /></div>
      <div className="app-preview"><Preview /></div>
      <div className="app-inspector"><RightPanel /></div>
      <div className="app-timeline"><Timeline /></div>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
    </ErrorBoundary>
  );
}
