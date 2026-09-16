import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { solidAliases } from "./solid.aliases";

export default defineConfig({
  // A separate config from vite.config.ts rather than a `test` block in it:
  // this one needs `solid({ hot: false })` — solid-refresh injects a
  // /@solid-refresh import that Vitest's module runner cannot resolve, and HMR
  // is meaningless in a test run anyway — and it must not inherit
  // `root: "src-solid"`, since src-shared/ carries tests too.
  plugins: [solid({ hot: false })],
  resolve: {
    conditions: ["development", "browser"],
    dedupe: ["solid-js"],
    // Single source of truth, shared with vite.config.ts.
    alias: solidAliases,
  },
  test: {
    environment: "jsdom",
    // src-shared/ carries its own unit tests (they moved with the modules out
    // of the React tree, which used to run them under its own vitest config).
    include: ["src-solid/**/*.test.{ts,tsx}", "src-shared/**/*.test.ts"],
  },
});
