# src-next/ui/ — Primitive UI Components

## Purpose

Stateless design-system building blocks. No business logic, no context access, no IPC calls.

## Components

| Component | Props | Description |
|---|---|---|
| `Button` | label, onClick, variant, disabled | Standard button with variants |
| `IconButton` | icon, onClick, title, size | Icon-only button with tooltip |
| `Input` | value, onChange, placeholder | Text input field |
| `Tooltip` | content, children | Hover tooltip wrapper |
| `Modal` | open, onClose, children | Portal-based modal overlay |
| `Badge` | count, variant | Notification/count badge |
| `Spinner` | size | Loading spinner animation |
| `Icon` | name, size | SVG icon renderer |

## Rules

- No imports from `context/`, `hooks/`, or `bridge/`
- Props-driven only — parent components supply all data
- CSS modules for scoped styling
