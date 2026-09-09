import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  test: {
    // Patterns must be depth-agnostic: `.claude/worktrees/*` holds full repo
    // checkouts, so a root-relative pattern like 'eslint-local-rules/**' matches
    // only this copy and lets every worktree's tests into the run. Excluding
    // '.claude/**' keeps collection to the working tree — without it, vitest
    // also executes each worktree's src-next suite against whatever commit that
    // worktree is parked on.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/eslint-local-rules/**',
      '.claude/**',
      'src-tauri/**',
    ],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows"
        ? "chrome105"
        : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? true : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
