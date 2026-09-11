import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Parallel Solid frontend. Disjoint root from vite.config.ts so
// @vitejs/plugin-react and vite-plugin-solid never see the same .tsx.
export default defineConfig({
  root: "src-solid",
  plugins: [solid()],
  resolve: {
    // Two entry points (app + tests) must share one solid-js instance.
    dedupe: ["solid-js"],
    alias: {
      "@bridge": r("./src-next/bridge"),
      "@viewport": r("./src-next/viewport"),
      "@cache": r("./src-next/cache"),
      "@events": r("./src-next/events"),
      "@filter": r("./src-next/filter"),
      "@bench": r("./src-next/bench"),
    },
  },
  // Not inherited from the root config — a custom `root` gets its own.
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  server: {
    port: 1421,
    strictPort: true,
    host: host || false,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "../dist-solid",
    emptyOutDir: true,
    target:
      process.env.TAURI_ENV_PLATFORM === "windows"
        ? "chrome105"
        : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? true : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
