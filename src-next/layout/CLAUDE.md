# src-next/layout/ — Structural Shell Components

## Purpose

Pure layout and structural rendering — no business logic, no direct context access beyond layout state.

## Components

| Component | Role |
|---|---|
| `AppShell` | Top-level grid: toolbar + sidebar + center + panels + status bar |
| `CenterArea` | Recursive split-tree renderer — leaf panes with tab bar + content |
| `ToolBar` | Top toolbar with session actions |
| `ToolPane` | Side/bottom panel container |
| `TabBar` | Tab strip for pane content switching |
| `StatusBar` | Bottom status bar |
| `DragHandle` | Split resizer with 10% minimum per side constraint |

## CenterArea split tree

`CenterArea` renders a `SplitNode` tree recursively:
- **Split nodes** have `left`/`right` children + `splitRatio` — rendered as flex containers with a DragHandle
- **Leaf nodes** have a `panes` array + `activeIndex` — rendered as TabBar + PaneContent

Layout state (`SplitNode`, `CenterPane`) is managed by `useWorkspaceLayout` in `hooks/`.
