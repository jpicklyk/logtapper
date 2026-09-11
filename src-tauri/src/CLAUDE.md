# src-tauri/src/ — Rust Backend

Each subdirectory has its own `CLAUDE.md` (`commands/`, `core/`, `processors/`,
`scripting/`, `services/`, `mcp_bridge/`). The gotchas below apply backend-wide.

**All business logic lives in `services/`** — read `services/CLAUDE.md` before changing
anything under `commands/` or `mcp_bridge/`, both of which are now thin adapters over it.
`mcp_bridge/CLAUDE.md` covers the HTTP bridge's own structure (route table, error
contract, test harness, Windows build quirks).

## Tauri / Rust gotchas

- `app.emit()` requires `use tauri::Emitter` — it is a trait method, not inherent on `AppHandle`.
- The Rust `regex` crate does **not** support look-ahead (`(?!...)`). `get_or_compile()` returns `Option<&Regex>` (None on invalid) and callers skip — the symptom is 0 matches, not an error.
- `LineContext` string fields (`raw`, `tag`, `message`, `source_id`) are `Arc<str>`, not `String`. Use `Arc::from(s)` to construct, `&*field` or `.as_ref()` for `&str` access, `.to_string()` for an owned `String`.
- Clippy: `impl Default for Foo` where the body only calls field defaults → replace with `#[derive(Default)]`.
- **Windows: `AppHandle<Wry>` must never be referenced from a plain `cargo test` binary
  without the manifest fix in `build.rs`.** Merely linking the type in — even as
  `Option::None` — pulls in Wry's window-class registration code, which needs a
  ComCtl32-v6 manifest a bare test binary doesn't have; the process dies at OS load time
  with `STATUS_ENTRYPOINT_NOT_FOUND`, before `main()`, with no output. See
  `mcp_bridge/CLAUDE.md`'s "Windows test-binary manifest" section for the two
  `cargo:rustc-link-arg[-tests]` directives that fix this and why a workspace-wide
  `rustflags` override is the wrong tool.
- **Windows: while `npx tauri dev` is running, it holds `target/debug/log-tapper.exe`
  open**, which can make `cargo test`/`cargo build`/`npm run check:types` fail to relink.
  Point at an alternate target dir for the duration:
  `$env:CARGO_TARGET_DIR="src-tauri/target-it"` (or `--target-dir src-tauri/target-it`).
- **`TS_RS_EXPORT_DIR` resolves against the invoking shell's cwd, not `--manifest-path`.**
  Running a cargo command against a worktree's `Cargo.toml` from a shell whose cwd is the
  main repo root silently writes generated `.ts` bindings into the *main repo's*
  `src-next/bridge/generated/` instead of the worktree's own copy. Always set
  `$env:TS_RS_EXPORT_DIR` to the worktree's absolute path first when working in a
  worktree — see `mcp_bridge/CLAUDE.md` for the fuller writeup.
