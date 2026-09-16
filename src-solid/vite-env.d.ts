/// <reference types="vite/client" />
// Needed because the shared framework-free modules under src-shared/ (e.g.
// utils/diagnostics.ts) read import.meta.env and would otherwise fail to
// type-check.

declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
