import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // NOTE: do NOT add @aiedit/* to optimizeDeps.include — prebundled workspace
  // packages go stale when exports change (caused a blank-page bug). Vite
  // transforms their TS directly as linked source.
});
