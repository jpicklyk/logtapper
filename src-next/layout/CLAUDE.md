# src-next/layout/ — Structural Shell Components

## Purpose

Pure layout and structural rendering — no business logic, no direct context access beyond layout state.

## CenterArea split tree

`CenterArea` renders a `SplitNode` tree recursively:
- **Split nodes** have `left`/`right` children + `splitRatio` — rendered as flex containers with a DragHandle
- **Leaf nodes** have a `panes` array + `activeIndex` — rendered as TabBar + PaneContent

Layout state (`SplitNode`, `CenterPane`) is managed by `useWorkspaceLayout` in `hooks/`.
