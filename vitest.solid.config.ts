import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { solidAliases } from "./solid.aliases";

export default defineConfig({
  // `hot: false` — solid-refresh injects a /@solid-refresh import that Vitest's
  // module runner cannot resolve; HMR is meaningless in a test run anyway.
  plugins: [solid({ hot: false })],
  resolve: {
    conditions: ["development", "browser"],
    dedupe: ["solid-js"],
    // Single source of truth, shared with vite.solid.config.ts.
    alias: solidAliases,
  },
  test: {
    environment: "jsdom",
    include: ["src-solid/**/*.test.{ts,tsx}"],
  },
});
