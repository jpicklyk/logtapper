import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // `hot: false` — solid-refresh injects a /@solid-refresh import that Vitest's
  // module runner cannot resolve; HMR is meaningless in a test run anyway.
  plugins: [solid({ hot: false })],
  resolve: {
    conditions: ["development", "browser"],
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
  test: {
    environment: "jsdom",
    include: ["src-solid/**/*.test.{ts,tsx}"],
  },
});
