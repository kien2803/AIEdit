import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // workspace packages ship raw TS — let Vite prebundle them
    include: ["@aiedit/core", "@aiedit/engine", "@aiedit/ui"],
  },
});
