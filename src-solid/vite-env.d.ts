/// <reference types="vite/client" />
// Needed because tsconfig.solid.json only includes src-solid/: shared
// framework-free modules under src-next/ (e.g. utils/diagnostics.ts) read
// import.meta.env and would otherwise fail to type-check from this project.

declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
