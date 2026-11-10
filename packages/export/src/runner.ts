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
    return this.runPhases(
      [plan.argv],
      files,
      plan.outFile,
      onProgress ? [onProgress] : undefined,
    );
  }

  /**
   * Run sequential ffmpeg phases. files maps runner-fs names to bytes;
   * each argv is one exec() call. onProgress[i] gets that phase's progress.
   */
  async runPhases(
    argvs: string[][],
    files: ExportFiles,
    outFile: string,
    onProgress?: ((frac: number) => void)[],
  ): Promise<Uint8Array> {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const { toBlobURL } = await import("@ffmpeg/util");
    const ffmpeg = new FFmpeg();
    // Pinned single-threaded core (~25MB on first export, then cached).
    // NOTE: the Tauri shell should serve these from bundled local files instead.
    const CORE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, "application/wasm"),
    });
    let phase = 0;
    ffmpeg.on("progress", ({ progress }) =>
      onProgress?.[phase]?.(Math.max(0, Math.min(1, progress))));
    try {
      for (const [file, data] of Object.entries(files)) {
        await ffmpeg.writeFile(file, data as never);
      }
      for (let i = 0; i < argvs.length; i++) {
        phase = i;
        const code = await ffmpeg.exec(argvs[i]!);
        if (code !== 0) throw new Error(`ffmpeg phase ${i} exited ${code}`);
      }
      const out = await ffmpeg.readFile(outFile);
      return typeof out === "string" ? new TextEncoder().encode(out) : new Uint8Array(out);
    } finally {
      ffmpeg.terminate();
    }
  }
}
