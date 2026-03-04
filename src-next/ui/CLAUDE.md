# src-next/ui/ — Primitive UI Components

## Purpose

Stateless design-system building blocks. No business logic, no context access, no IPC calls.

## Rules

- No imports from `context/`, `hooks/`, or `bridge/`
- Props-driven only — parent components supply all data
- CSS modules for scoped styling
