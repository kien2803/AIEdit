import React, { useState } from "react";
import { useEditor } from "./store.js";

const PRESETS = [
  { label: "OpenAI", baseURL: "https://api.openai.com", model: "gpt-4o-mini" },
  { label: "OpenRouter", baseURL: "https://openrouter.ai/api", model: "openai/gpt-4o-mini" },
  { label: "Local (Ollama/LM Studio)", baseURL: "http://localhost:11434", model: "qwen2.5" },
  { label: "Custom", baseURL: "", model: "" },
];

export function SettingsDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const llm = useEditor((s) => s.llm);
  const setLLM = useEditor((s) => s.setLLM);
  const [form, setForm] = useState(llm);

  return (
    <div className="sd-backdrop" onClick={onClose}>
      <div className="sd-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>AI Settings</h3>
        <p className="sd-note">
          OpenAI-compatible endpoint. Key stays in localStorage — browser calls the API directly.
        </p>
        <label className="in-num"><span>Preset</span>
          <select
            onChange={(e) => {
              const p = PRESETS[Number(e.target.value)]!;
              setForm({ ...form, baseURL: p.baseURL || form.baseURL, model: p.model || form.model });
            }}
          >
            {PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
          </select>
        </label>
        <label className="in-num"><span>Base URL</span>
          <input value={form.baseURL} onChange={(e) => setForm({ ...form, baseURL: e.target.value })} placeholder="https://api.openai.com" />
        </label>
        <label className="in-num"><span>Model</span>
          <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="gpt-4o-mini" />
        </label>
        <label className="in-num"><span>API key</span>
          <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." />
        </label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={() => { setForm({ baseURL: "", model: "", apiKey: "" }); setLLM({ baseURL: "", model: "", apiKey: "" }); }}>Clear</button>
          <button onClick={() => { setLLM(form); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}
