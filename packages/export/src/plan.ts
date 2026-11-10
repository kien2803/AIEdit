import type { Clip, Project, VideoClip, AudioClip } from "@aiedit/core";
import { clipEnd, ticks, type TimeTicks } from "@aiedit/core";

/**
 * Export plan: maps a Project to an ffmpeg invocation.
 * Pure & serializable — unit-testable, and the same plan can feed a wasm
 * runner (browser) or a native runner (Tauri/Node).
 */
export interface ExportPlanInput {
  /** File name inside the runner's filesystem. */
  file: string;
  /** Media asset input — resolved to bytes by the caller. */
  assetId?: string;
  /** Text clip rendered to a PNG by the caller. */
  textClipId?: string;
}

export interface ExportPlan {
  inputs: ExportPlanInput[];
  filterComplex: string;
  argv: string[];
  durationSec: number;
  outFile: string;
  width: number;
  height: number;
  fps: number;
}

interface MediaClipJob {
  clip: VideoClip | AudioClip;
  inputIndex: number;
}

const sec = (t: TimeTicks) => (t / 90000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0";

export interface ExportOptions {
  /** Video encoder + its args. Default libx264 (bundled in @ffmpeg/core). */
  videoCodecArgs?: string[];
}

export function buildExportPlan(
  project: Project,
  textDims: Record<string, { w: number; h: number }> = {},
  options: ExportOptions = {},
): ExportPlan {
  const vCodec = options.videoCodecArgs ?? ["libx264", "-preset", "veryfast", "-crf", "20"];
  const { width: W, height: H } = project.settings;
  const fpsF = project.settings.fps.num / project.settings.fps.den;
  const end = project.tracks
    .flatMap((t) => t.clips)
    .reduce((m, c) => Math.max(m, clipEnd(c)), 0 as TimeTicks);
  const durationSec = ticks.toSeconds(end);
  if (durationSec <= 0) throw new Error("nothing to export");

  const inputs: ExportPlanInput[] = [];
  const inputIndexOf = new Map<string, number>();
  const assetFile = (assetId: string): number => {
    const existing = inputIndexOf.get(assetId);
    if (existing !== undefined) return existing;
    const idx = inputs.length;
    inputs.push({ file: `in${idx}.mp4`, assetId });
    inputIndexOf.set(assetId, idx);
    return idx;
  };
  const textFile = (clipId: string): number => {
    const idx = inputs.length;
    inputs.push({ file: `text${idx}.png`, textClipId: clipId });
    return idx;
  };

  const filters: string[] = [];
  const audioLabels: string[] = [];

  // --- base canvas ---
  filters.push(`color=c=black:s=${W}x${H}:r=${fpsF}:d=${durationSec}[base0]`);

  // --- visual clips: tracks[0] is topmost → overlay last, so iterate reversed ---
  let baseLabel = "base0";
  let overlayCount = 0;

  const visualTracks = project.tracks.filter((t) => t.kind === "video" || t.kind === "text");
  for (let ti = visualTracks.length - 1; ti >= 0; ti--) {
    for (const clip of visualTracks[ti]!.clips) {
      if (!clip.enabled) continue;
      if (clip.kind === "audio") continue;

      overlayCount++;
      const out = `v${overlayCount}`;
      const t0 = sec(clip.start);
      const t1 = sec(clipEnd(clip));

      if (clip.kind === "text") {
        const idx = textFile(clip.id);
        const dims = textDims[clip.id] ?? { w: W / 4, h: clip.style.fontSize * 1.6 };
        const { x, y } = overlayXY(clip, W, H, dims.w, dims.h);
        filters.push(
          `[${baseLabel}][${idx}:v]overlay=${x.toFixed(1)}:${y.toFixed(1)}:enable='between(t,${t0},${t1})'[${out}]`,
        );
      } else {
        const idx = assetFile(clip.assetId);
        const chain = videoChain(project, clip, idx);
        const { x, y } = overlayXY(clip, W, H, clipSrcW(project, clip), clipSrcH(project, clip));
        filters.push(chain);
        filters.push(
          `[${baseLabel}][c${idx}v${clipSuffix(clip.id)}]overlay=${x.toFixed(1)}:${y.toFixed(1)}:enable='between(t,${t0},${t1})'[${out}]`,
        );
      }
      baseLabel = out;
    }
  }

  // --- audio clips (audio tracks + audio of video clips) ---
  let audioJobs = 0;
  for (const track of project.tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (!clip.enabled || clip.kind === "text") continue;
      const asset = project.assets[clip.assetId];
      if (!asset?.hasAudio) continue;
      const idx = assetFile(clip.assetId);
      audioJobs++;
      const lbl = `a${audioJobs}`;
      const chain = audioChain(clip, idx, lbl);
      if (chain) filters.push(chain);
      audioLabels.push(`[${lbl}]`);
    }
  }

  const argv: string[] = [];
  // inputs: media files then text PNGs (looped stills)
  for (const inp of inputs) {
    if (inp.textClipId) {
      argv.push("-loop", "1", "-i", inp.file);
    } else {
      argv.push("-i", inp.file);
    }
  }

  let audioMap: string[] = [];
  if (audioLabels.length === 1) {
    filters.push(`${audioLabels[0]}aresample=48000[aout]`);
    audioMap = ["-map", "[aout]"];
  } else if (audioLabels.length > 1) {
    filters.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:normalize=0,aresample=48000[aout]`);
    audioMap = ["-map", "[aout]"];
  }

  const outFile = "out.mp4";
  argv.push(
    "-filter_complex", filters.join(";"),
    "-map", `[${baseLabel}]`,
    ...(audioMap.length ? audioMap : []),
    "-c:v", ...vCodec,
    "-pix_fmt", "yuv420p", "-r", String(fpsF),
    ...(audioMap.length ? ["-c:a", "aac", "-b:a", "192k"] : []),
    "-t", String(durationSec),
    "-movflags", "+faststart",
    "-y", outFile,
  );

  return { inputs, filterComplex: filters.join(";"), argv, durationSec, outFile, width: W, height: H, fps: fpsF };
}

function clipSuffix(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
}

function clipSrcW(p: Project, clip: VideoClip | AudioClip): number {
  return p.assets[clip.assetId]?.width ?? p.settings.width;
}
function clipSrcH(p: Project, clip: VideoClip | AudioClip): number {
  return p.assets[clip.assetId]?.height ?? p.settings.height;
}

/** Center position of a clip inside the project frame → ffmpeg overlay x:y. */
function overlayXY(clip: Clip, W: number, H: number, srcW: number, srcH: number): { x: number; y: number } {
  const tr = "static" in clip.transform ? clip.transform.static : clip.transform.keys[0]?.value;
  const sx = tr?.scaleX ?? 1, sy = tr?.scaleY ?? 1;
  const fit = Math.min(W / srcW, H / srcH);
  const w = srcW * fit * sx;
  const h = srcH * fit * sy;
  const cx = W / 2 + (tr?.x ?? 0);
  const cy = H / 2 + (tr?.y ?? 0);
  return { x: cx - w / 2, y: cy - h / 2 };
}

/** Filter chain producing a clip's video stream, scaled contain-fit to project size. */
function videoChain(project: Project, clip: VideoClip, inputIdx: number): string {
  const { width: W, height: H } = project.settings;
  const fpsF = project.settings.fps.num / project.settings.fps.den;
  const tr = "static" in clip.transform ? clip.transform.static : clip.transform.keys[0]?.value;
  const sx = tr?.scaleX ?? 1, sy = tr?.scaleY ?? 1;
  const srcW = clipSrcW(project, clip);
  const srcH = clipSrcH(project, clip);
  const fit = Math.min(W / srcW, H / srcH);
  const w = Math.max(2, Math.round(srcW * fit * sx));
  const h = Math.max(2, Math.round(srcH * fit * sy));

  const f: string[] = [];
  f.push(`trim=start=${sec(clip.sourceIn)}:end=${sec(clip.sourceOut)}`);
  f.push("setpts=PTS-STARTPTS");
  if (clip.speed !== 1) {
    f.push(`setpts=PTS/${Math.abs(clip.speed)}`);
    if (clip.speed < 0) f.push("reverse");
  }
  f.push(`fps=${fpsF}`);
  f.push(`scale=${w}:${h}`);
  f.push("setsar=1");
  if (tr?.rotation) f.push(`rotate=${tr.rotation}:c=none:ow=${w}:oh=${h}`);
  if (tr && tr.opacity < 1) f.push(`format=rgba,colorchannelmixer=aa=${tr.opacity.toFixed(3)}`);
  // effect mapping (mirrors the compositor's uniforms, approximate)
  const eq = eqParams(clip);
  if (eq) f.push(eq);
  return `[${inputIdx}:v]${f.join(",")}[c${inputIdx}v${clipSuffix(clip.id)}]`;
}

function eqParams(clip: VideoClip): string | null {
  let brightness = 0, contrast = 1, saturation = 1;
  let rr = 1, bb = 1;
  for (const e of clip.effects) {
    if (!e.enabled || e.type !== "color.basic") continue;
    brightness += (e.params["exposure"] ?? 0) * 0.15; // EV → eq brightness approx
    contrast *= e.params["contrast"] ?? 1;
    saturation *= e.params["saturation"] ?? 1;
    const temp = e.params["temperature"] ?? 0;
    rr *= 1 + temp * 0.1;
    bb *= 1 - temp * 0.1;
  }
  const parts: string[] = [];
  if (brightness !== 0 || contrast !== 1 || saturation !== 1) {
    parts.push(`eq=brightness=${brightness.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}`);
  }
  if (rr !== 1 || bb !== 1) {
    parts.push(`colorchannelmixer=rr=${rr.toFixed(3)}:bb=${bb.toFixed(3)}`);
  }
  return parts.length ? parts.join(",") : null;
}

/** Filter chain producing a clip's audio, or null. */
function audioChain(clip: VideoClip | AudioClip, inputIdx: number, outLbl: string): string | null {
  const f: string[] = [];
  f.push(`atrim=start=${sec(clip.sourceIn)}:end=${sec(clip.sourceOut)}`);
  f.push("asetpts=PTS-STARTPTS");
  let sp = Math.abs(clip.speed);
  if (clip.speed < 0) f.push("areverse");
  while (sp > 2) { f.push("atempo=2.0"); sp /= 2; }
  while (sp < 0.5) { f.push("atempo=0.5"); sp /= 0.5; }
  if (sp !== 1) f.push(`atempo=${sp.toFixed(4)}`);
  const pan = clip.kind === "audio" ? clip.pan : 0;
  if (pan !== 0) {
    const l = Math.cos(((pan + 1) * Math.PI) / 4).toFixed(4);
    const r = Math.sin(((pan + 1) * Math.PI) / 4).toFixed(4);
    f.push(`pan=stereo|c0=${l}*c0|c1=${r}*c1`);
  }
  if (clip.gain !== 1) f.push(`volume=${clip.gain.toFixed(3)}`);
  // delay audio so it lands at the clip's timeline position
  const delayMs = Math.round(ticks.toSeconds(clip.start) * 1000);
  if (delayMs > 0) f.push(`adelay=${delayMs}|${delayMs}`);
  return `[${inputIdx}:a]${f.join(",")}[${outLbl}]`;
}
