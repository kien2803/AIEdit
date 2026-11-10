import React, { useEffect, useRef } from "react";
import { PreviewPlayer } from "@aiedit/engine";
import { formatTimecode, timelineEnd } from "@aiedit/core";
import { useEditor } from "./store.js";

export function Preview(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<PreviewPlayer | null>(null);
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const seek = useEditor((s) => s.seek);
  const setPlayer = useEditor((s) => s.setPlayer);
  const togglePlay = useEditor((s) => s.togglePlay);
  const player = useEditor((s) => s.player);

  useEffect(() => {
    const p = new PreviewPlayer(canvasRef.current!, useEditor.getState().project);
    playerRef.current = p;
    setPlayer(p);
    const off = p.onTick((t) => useEditor.setState({ playhead: t }));
    return () => { off(); p.dispose(); setPlayer(null); };
  }, [setPlayer]);

  useEffect(() => { playerRef.current?.setProject(project); }, [project]);

  const playing = player?.playing ?? false;

  return (
    <div className="pv-root">
      <canvas ref={canvasRef} className="pv-canvas" />
      <div className="pv-transport">
        <button onClick={() => seek(0)} title="Start">⏮</button>
        <button onClick={togglePlay} title="Play/Pause (Space)">{playing ? "⏸" : "▶"}</button>
        <button onClick={() => seek(timelineEnd(project))} title="End">⏭</button>
        <span className="pv-tc">{formatTimecode(playhead, project.settings.fps)}</span>
      </div>
    </div>
  );
}
