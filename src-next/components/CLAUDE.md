# src-next/components/ — Application Components

## Structure

Each component has its own subdirectory with:
- `ComponentName.tsx` — implementation
- `ComponentName.module.css` — scoped styles
- `index.ts` — barrel export (re-exports component + types)

## Rules

1. **Selector hooks only** — components import from `../../context` barrel, never raw context hooks (`useSessionContext`, etc.). Raw hooks are for domain hooks in `hooks/` only.

2. **Hooks barrel** — import domain hooks from `../../hooks` barrel, not direct file paths.

3. **React.memo on boundaries** (principle #3) — every component that receives props from a context-consuming parent is wrapped in `React.memo`.

4. **No business logic** — components handle rendering and user interaction. State management and IPC live in hooks.

5. **Local state stays local** (principle #5) — `useBookmarks`, `useAnalysis`, `useWatches`, `useFilter` are colocated with their consumer components, not hoisted to context.

