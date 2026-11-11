import React, { useRef, useState } from "react";
import type { Op } from "@aiedit/core";
import { parsePromptSmart } from "./llm.js";
import { useEditor } from "./store.js";

interface Msg {
  role: "user" | "ai";
  text: string;
  ops?: Op[];
  label?: string;
  applied?: boolean;
}

export function ChatPanel(): React.ReactElement {
  const [msgs, setMsgs] = useState<Msg[]>([{
    role: "ai",
    text: "Hi! I'm the (rule-based, for now) edit assistant. Try: \"text Hello\", \"speed 2\", \"split\", \"cut silences\", \"intro\".",
  }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const llm = useEditor((s) => s.llm);
  const dispatch = useEditor((s) => s.dispatch);
  const bottomRef = useRef<HTMLDivElement>(null);

  const runAction = (action: string) => {
    const s = useEditor.getState();
    switch (action) {
      case "split": s.splitAtPlayhead(); break;
      case "deleteSelected": s.deleteSelected(); break;
      case "cutSilences": s.cutSilences(s.selection[0]!); break;
      case "introScene": s.addIntroScene(); break;
      case "sceneClip": s.addSceneClip(); break;
      case "undo": s.undo(); break;
      case "redo": s.redo(); break;
      case "togglePlay": s.togglePlay(); break;
      case "exportVideo": void s.exportVideo(); break;
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    const s = useEditor.getState();
    void parsePromptSmart(text, { project: s.project, playhead: s.playhead, selection: s.selection }, llm)
      .then((parsed) => {
        setMsgs((m) => [
          ...m,
          {
            role: "ai", text: parsed.reply,
            ...(parsed.ops ? { ops: parsed.ops, label: parsed.label } : {}),
          },
        ]);
        if (parsed.action) runAction(parsed.action);
      })
      .finally(() => {
        setBusy(false);
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 30);
      });
  };

  const apply = (i: number) => {
    setMsgs((m) => {
      const msg = m[i]!;
      if (msg.ops && !msg.applied) dispatch(msg.ops, msg.label ?? "ai prompt");
      return m.map((x, j) => (j === i ? { ...x, applied: true } : x));
    });
  };

  return (
    <div className="cp-root">
      <div className="cp-msgs">
        {msgs.map((m, i) => (
          <div key={i} className={`cp-msg ${m.role}`}>
            <div>{m.text}</div>
            {m.ops && (
              <button className="cp-apply" disabled={m.applied} onClick={() => apply(i)}>
                {m.applied ? "✓ applied" : `Apply (${m.ops.length} ops)`}
              </button>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="cp-input">
        <input
          value={input}
          disabled={busy}
          placeholder={busy ? "Thinking…" : llm.apiKey ? "Prompt… (LLM)" : "Prompt… (rules)"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button onClick={send} disabled={busy}>{busy ? "…" : "➤"}</button>
      </div>
    </div>
  );
}
