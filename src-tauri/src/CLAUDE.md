# src-tauri/src/ — Rust Backend

Each subdirectory has its own `CLAUDE.md` (`commands/`, `core/`, `processors/`, `scripting/`). The gotchas below apply backend-wide.

## Tauri / Rust gotchas

- `app.emit()` requires `use tauri::Emitter` — it is a trait method, not inherent on `AppHandle`.
- The Rust `regex` crate does **not** support look-ahead (`(?!...)`). `get_or_compile()` returns `Option<&Regex>` (None on invalid) and callers skip — the symptom is 0 matches, not an error.
- `LineContext` string fields (`raw`, `tag`, `message`, `source_id`) are `Arc<str>`, not `String`. Use `Arc::from(s)` to construct, `&*field` or `.as_ref()` for `&str` access, `.to_string()` for an owned `String`.
- Clippy: `impl Default for Foo` where the body only calls field defaults → replace with `#[derive(Default)]`.
