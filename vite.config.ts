import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { solidAliases } from "./solid.aliases";

const host = process.env.TAURI_DEV_HOST;

// The frontend build. `root` is src-solid/ (its own index.html is the entry);
// the shared framework-free modules are reached through the aliases, which are
// absolute, so they resolve from outside the root.
export default defineConfig({
  root: "src-solid",
  plugins: [solid()],
  resolve: {
    // Two entry points (app + tests) must share one solid-js instance.
    dedupe: ["solid-js"],
    // Single source of truth, shared with vitest.config.ts.
    alias: solidAliases,
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
