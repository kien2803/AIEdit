import type { ExportPlan } from "./plan.js";

export interface ExportFiles {
  /** file name (as in plan.inputs[].file) -> bytes */
  [file: string]: Uint8Array;
}

export interface FFmpegRunner {
  run(plan: ExportPlan, files: ExportFiles, onProgress?: (frac: number) => void): Promise<Uint8Array>;
}

/** Browser runner: ffmpeg.wasm (single-threaded core, no COOP/COEP needed). */
export class WasmRunner implements FFmpegRunner {
  async run(plan: ExportPlan, files: ExportFiles, onProgress?: (frac: number) => void): Promise<Uint8Array> {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const { toBlobURL, fetchFile } = await import("@ffmpeg/util");
    const ffmpeg = new FFmpeg();
    // Pinned single-threaded core (~25MB on first export, then cached).
    // NOTE: the Tauri shell should serve these from bundled local files instead.
    const CORE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpeg.on("progress", ({ progress }) => onProgress?.(Math.max(0, Math.min(1, progress))));
    try {
      for (const inp of plan.inputs) {
        const data = files[inp.file];
        if (!data) throw new Error(`missing input ${inp.file}`);
        await ffmpeg.writeFile(inp.file, await fetchFile(new Blob([data as never])));
      }
      await ffmpeg.exec(plan.argv);
      const out = await ffmpeg.readFile(plan.outFile);
      return typeof out === "string" ? new TextEncoder().encode(out) : new Uint8Array(out);
    } finally {
      ffmpeg.terminate();
    }
  }
}
