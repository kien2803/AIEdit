import type { Op } from "@aiedit/core";
import type { EditorSnapshot } from "./prompt.js";
import type { ParsedIntent } from "./ai.js";
import { parsePrompt } from "./ai.js";

export interface LLMSettings {
  baseURL: string;   // OpenAI-compatible endpoint, e.g. https://api.openai.com or https://openrouter.ai/api
  model: string;
  apiKey: string;
}

const SYSTEM_PROMPT = `You are an editing copilot inside a timeline video editor. The user describes an edit or an animation; you reply with JSON ONLY:

{"reply": "<short human explanation>", "ops": [ <Op>, ... ]}

Op schema (JSON). All times are integer ticks, 90000 ticks = 1 second.
- {"type":"clip.add","trackId":..., "clip":Clip} — clip kinds:
  video: {kind:"video",id,assetId,start,duration,sourceIn,sourceOut,speed,gain,transform:{static:{x,y,scaleX,scaleY,rotation,opacity}},effects:[],enabled:true}
  text:  {kind:"text",id,start,duration,content,style:{fontFamily,fontSize,color,align},transform:{static:...},effects:[],enabled:true}
  scene: {kind:"scene",id,start,duration,sceneId,transform:{static:...},effects:[],enabled:true} (sceneId must exist)
- {"type":"scene.upsert","scene":{id,name,duration,elements:[Element]}}
- {"type":"clip.split","clipId","at"} · {"type":"clip.remove","clipId"} · {"type":"clip.move","clipId","start"} · {"type":"clip.setSpeed","clipId","speed"} · {"type":"clip.trim","clipId","edge":"in"|"out","delta"}
- {"type":"track.add","track":{id,kind:"video"|"audio"|"text",name,clips:[],muted:false,locked:false}}
- {"type":"effect.add","clipId","effect":{id,type:"color.basic",params:{exposure,contrast,saturation,temperature},enabled:true}}

Element (inside scene.elements, draw order bottom→top; transforms are Keyframed):
- shape: {kind:"shape",id,name,start,end,shape:"rect"|"ellipse",fill,w,h,cornerRadius,transform,enabled}
- text:  {kind:"text",id,name,start,end,content,style:{fontFamily,fontSize,color,align},transform,enabled,animators:[{selector:"chars",range:[0,1],animate:{x,y,rotation,scaleX,opacity}}]}
- footage:{kind:"footage",id,name,start,end,assetId,sourceIn,sourceOut,speed,transform,enabled}
- emitter:{kind:"emitter",id,name,start,end,transform,enabled,particle:{rate,lifetime,speed,spread,direction,size,color,gravity}}

Keyframes: transform = {keys:[{at,value:{x,y,scaleX,scaleY,rotation,opacity},ease:{kind:"linear"}|{kind:"bezier",cx1,cy1,cx2,cy2}|{kind:"spring",stiffness,damping}}]} — or {static:{...}}.
Rules: ids are unique strings like "el_1". Only use assetId values that exist in the provided project assets. Scene size = project resolution. For animation requests, build a scene.upsert + a scene clip.add (needs a video track — emit track.add if the project has none, use trackId "track_ai_v1"). Keep "reply" under 120 chars.`;

/** Call an OpenAI-compatible chat endpoint → ParsedIntent (ops validated client-side). */
export async function callLLM(text: string, s: EditorSnapshot, cfg: LLMSettings): Promise<ParsedIntent> {
  const state = {
    playheadSec: s.playhead / 90_000,
    resolution: { w: s.project.settings.width, h: s.project.settings.height },
    assets: Object.values(s.project.assets).map((a) => ({ id: a.id, name: a.name, kind: a.kind, durationSec: (a.durationTicks ?? 0) / 90_000 })),
    tracks: s.project.tracks.map((t) => ({ id: t.id, kind: t.kind, clipCount: t.clips.length })),
    selection: s.selection,
  };
  const res = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Project state: ${JSON.stringify(state)}\n\nRequest: ${text}` },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? "{}";
  const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
  const ops = Array.isArray(json.ops) ? (json.ops.filter((o: { type?: string }) => typeof o?.type === "string") as Op[]) : undefined;
  return {
    reply: typeof json.reply === "string" ? json.reply.slice(0, 400) : "Done",
    ...(ops?.length ? { ops, label: `ai: ${text.slice(0, 30)}` } : {}),
  };
}

/** LLM when configured, rule-based parser otherwise. */
export async function parsePromptSmart(text: string, s: EditorSnapshot, cfg: LLMSettings | null): Promise<ParsedIntent> {
  if (cfg?.apiKey) {
    try {
      return await callLLM(text, s, cfg);
    } catch (e) {
      return { reply: `LLM failed (${e instanceof Error ? e.message : "?"}), falling back to rules.\n` + parsePrompt(text, s).reply };
    }
  }
  return parsePrompt(text, s);
}
