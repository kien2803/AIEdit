import React, { useState } from "react";
import type { ParamValues, Template } from "@aiedit/template";
import { useEditor } from "./store.js";

export function TemplatesPanel(): React.ReactElement {
  const templates = useEditor((s) => s.templates);
  const selection = useEditor((s) => s.selection);
  const saveTemplate = useEditor((s) => s.saveTemplate);
  const applyTemplate = useEditor((s) => s.applyTemplate);
  const deleteTemplate = useEditor((s) => s.deleteTemplate);
  const assets = useEditor((s) => s.project.assets);
  const [openId, setOpenId] = useState<string | null>(null);
  const [values, setValues] = useState<ParamValues>({});

  const tpl = templates.find((t) => t.id === openId);

  return (
    <div className="tp-root">
      <div className="mb-head">
        <span>Templates</span>
        <button
          disabled={!selection.length}
          title="Save selected clips as template"
          onClick={() => {
            const name = window.prompt("Template name", `Template ${templates.length + 1}`);
            if (name) saveTemplate(name);
          }}
        >Save</button>
      </div>
      <div className="mb-list">
        {templates.length === 0 && <div className="mb-empty">Select clips → Save</div>}
        {templates.map((t) => (
          <div key={t.id}>
            <div className="mb-item">
              <span className="mb-kind kind-image">T</span>
              <span className="mb-name" title={t.name}>{t.name}</span>
              <span className="mb-dur">{t.params.length}p</span>
              <button onClick={() => { setOpenId(openId === t.id ? null : t.id); setValues({}); }}>
                {openId === t.id ? "▾" : "Apply"}
              </button>
              <button onClick={() => deleteTemplate(t.id)}>✕</button>
            </div>
            {openId === t.id && tpl && (
              <div className="tp-form">
                {tpl.params.map((p) => (
                  <label key={p.key} className="in-num">
                    <span>{p.label}</span>
                    {p.type === "footage" ? (
                      <select
                        value={values[p.key]?.kind === "footage" ? (values[p.key] as { assetId: string }).assetId : ""}
                        onChange={(e) => setValues({ ...values, [p.key]: e.target.value ? { kind: "footage", assetId: e.target.value } : undefined })}
                      >
                        <option value="">— pick asset —</option>
                        {Object.values(assets).filter((a) => a.kind !== "image").map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    ) : p.type === "text" ? (
                      <input
                        value={values[p.key]?.kind === "text" ? (values[p.key] as { text: string }).text : String(p.defaultValue ?? "")}
                        onChange={(e) => setValues({ ...values, [p.key]: { kind: "text", text: e.target.value } })}
                      />
                    ) : (
                      <input type="number"
                        value={values[p.key]?.kind === "number" ? (values[p.key] as { value: number }).value : Number(p.defaultValue ?? 0)}
                        onChange={(e) => setValues({ ...values, [p.key]: { kind: "number", value: Number(e.target.value) } })}
                      />
                    )}
                  </label>
                ))}
                <button onClick={() => { applyTemplate(tpl.id, values); setOpenId(null); }}>
                  Insert at playhead
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
