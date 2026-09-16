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

## Content Security Policy (`tauri.conf.json`'s `app.security`)

`app.security.csp` (production) and `app.security.devCsp` (dev) are directive-map objects
— see `node_modules/@tauri-apps/cli/config.schema.json`'s `SecurityConfig`/`Csp` defs. Both
frontends (Solid `dist-solid/` by default; the legacy React `dist/` via `tauri.react.conf.json`) and the bench
configs (`scripts/bench/*.bench.conf.json`) share this policy: every overlay only overrides
`build`, never `app`, so there is exactly one `app.security` to keep in sync — pinned by
`overlays_do_not_override_security` in `src-tauri/tests/csp_config.rs`.

**Current policy** (identical in `csp` and `devCsp` except `connect-src`):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: asset: http://asset.localhost; font-src 'self' data:;
connect-src 'self' ipc: http://ipc.localhost [+ ws://localhost:1420 ws://localhost:1421
  http://localhost:1420 http://localhost:1421 in devCsp only];
object-src 'none'; base-uri 'self'; frame-ancestors 'none';
```

Pinned by `src-tauri/tests/csp_config.rs` (`cargo test --test csp_config`).

**Per-directive justification** — only deviate from `'self'`/`'none'` where something in
the app actually needs it:

- **`style-src 'self' 'unsafe-inline'`** — the one real exception, needed by two runtime
  (not build-time) sources, neither of which a hash or nonce can cover:
  - CodeMirror's `style-mod` package injects a `<style>` element via
    `document.createElement('style')` *after* page load (see `node_modules/style-mod/src/style-mod.js`);
    Tauri's build-time asset processing only nonces `<style>` tags already present in the
    shipped HTML (`tauri_utils::html::inject_nonce_token`'s `style` selector), so a tag
    created later by running JS never gets that nonce.
  - `src-solid/theme/applyTheme.ts`'s `applyTheme()` sets user-theme color overrides via
    `root.style.setProperty(key, value)` on `<html>` — an inline *style attribute*
    mutation, which `style-src` governs exactly like a `<style>` element (CSP does not
    distinguish the two without `'unsafe-hashes'`, which still needs a static, enumerable
    hash list — impossible for colors only known at runtime).
  - Verified live: injecting a `document.createElement('style')` into a running
    **production** build (real CSP header, not dev) took effect; see "How this was
    verified" below.
- **`script-src 'self'` — no exception.** The FOUC-prevention theme bootstrap used to be an
  inline `<script>` block in both `index.html` files. It is now `public/theme-bootstrap.js`
  (react) / `src-solid/public/theme-bootstrap.js` (solid), loaded via
  `<script src="/theme-bootstrap.js">`, specifically so no script-src exception is needed:
  a same-origin `<script src>` is already covered by `'self'`. (Tauri's build-time CSP
  hashing — `tauri-codegen`'s `CspHashes` — only hashes `.js`/`.mjs` *files* and never
  populates its `inline_scripts`/`styles` maps for inline `<script>`/`<style>` *content* in
  this Tauri version (2.10.3 / tauri-codegen 2.5.5), so an inline script block would have
  needed `'unsafe-inline'` or a hand-computed `'sha256-...'` hash that breaks every time the
  script's bytes change. Externalizing it avoids that fragility entirely.)
- **`img-src`/`font-src`** — fontsource (`@fontsource/geist`, `@fontsource/jetbrains-mono`)
  is imported as CSS (`@import '@fontsource/.../400.css'` in `styles/globals.css`) and Vite
  bundles those `@font-face` rules plus their `.woff2`/`.woff` files into the app's own
  `dist/assets/`, so they load from `'self'` — no external font CDN involved. `asset:`
  and `http://asset.localhost` are included for the Tauri asset protocol even though
  `app.security.assetProtocol.enable` is currently `false` (nothing in `src-next`/
  `src-solid` calls `convertFileSrc`/uses `asset://` yet) — harmless now, ready if that
  protocol is turned on later.
- **`connect-src 'self' ipc: http://ipc.localhost`** — Tauri IPC on Windows answers at
  `http://ipc.localhost`; `ipc:` covers other platforms. Neither frontend calls
  `fetch`/`WebSocket`/`XMLHttpRequest` directly (checked via `grep -rn 'fetch(\|WebSocket(\|XMLHttpRequest' src-next src-solid` — zero hits): all data access goes through
  Tauri's `invoke()`/event system. The MCP bridge (`127.0.0.1:40404`) is a separate
  transport the frontend never calls (see this file's parent `CLAUDE.md`'s "Security
  model" section) and is deliberately **not** in `connect-src`.
- **`object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`** — no `<object>`/
  `<embed>`/`<base>` tag anywhere in either frontend, and the app never expects to be
  framed. `frame-ancestors` is a header-only directive (CSP ignores it when delivered via
  `<meta>`) — Tauri delivers this CSP as a genuine `Content-Security-Policy` HTTP response
  header on the custom-protocol-served HTML (`protocol/tauri.rs`), not a meta tag, so it
  is actually enforced.
- Never add `'unsafe-eval'` or a bare `*` source to any directive — pinned by
  `csp_config.rs`.

**`devCsp` vs `csp`**: `devCsp` additionally allows `ws://localhost:1420`,
`ws://localhost:1421`, `http://localhost:1420`, `http://localhost:1421` in `connect-src` for
the Vite dev servers' HMR websocket (React on 1420, Solid on 1421).

**Important gotcha — `devCsp` is not actually enforced by `npx tauri dev` on desktop.**
Verified by reading `tauri-2.10.3`'s `manager/webview.rs`: `PROXY_DEV_SERVER =
cfg!(all(dev, mobile))` is `false` on Windows/macOS/Linux, so with a `devUrl` set the
webview navigates **directly** to `http://localhost:1420` (Vite's own server) — Tauri's CSP
injection (`AppManager::csp()` → `set_csp()` → the `Content-Security-Policy` response
header) only runs for HTML served through Tauri's own custom-protocol asset handler
(`protocol/tauri.rs`), which a direct devUrl navigation never touches. Confirmed empirically:
`fetch(location.href).then(r => [...r.headers.entries()])` against a running `npx tauri dev`
session shows no `content-security-policy` header and `document.querySelector('meta[http-equiv="Content-Security-Policy"]')`
is `null`. `devCsp` is still declared correctly (and is what a mobile dev session, which
does proxy, would use) — during ordinary desktop `npx tauri dev`, the sanitizer
(`src-solid/editor/sanitize.ts`'s allowlist hast sanitizer; react-markdown's default
`allowDangerousHtml: false`) is the only thing standing between markdown content and the
DOM, so never relax either sanitizer on the assumption "CSP will catch it in dev."

CSP **is** enforced (as a real response header, confirmed with exact contents) once the
`custom-protocol` cargo feature is active — i.e. `npx tauri build` and
`npx tauri build --debug --no-bundle` (which the CLI runs as
`cargo build --features custom-protocol ...`) — regardless of `devUrl`/`frontendDist`. Note
that `npx tauri dev --config scripts/bench/*.bench.conf.json` (`devUrl: null`) still runs
without `custom-protocol` (the CLI's `dev` command always passes `--no-default-features`
with no `custom-protocol`), so it serves `frontendDist` from a plain ephemeral
`http://127.0.0.1:<port>/` HTTP server with **no** CSP header either — that config exists
for the frontend performance bench harness (`scripts/bench.md`), not CSP verification.

**How this was verified**: built with `npx tauri build --debug --no-bundle` (adds
`custom-protocol`, the same feature production bundling uses) for each config, ran the
resulting `target/debug/log-tapper.exe` with
`$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9223"`, and drove it
over CDP (`Runtime.evaluate` + `Log`/`Runtime` event collection). Confirmed for both apps:
the exact `Content-Security-Policy` header contents; opening a real log file
(`bench:logcat-1m.log` via the `open-file` event / `window.__benchApp.open()`); opening
Settings (React); switching themes and setting a `style.setProperty()` custom property
(Solid, mirroring `applyTheme()`'s override mechanism) — all with **zero** CSP console
violations. Two direct proof-of-enforcement checks against the live production CSP: (1)
`document.createElement('script')` + `appendChild` with a side-effecting body does **not**
execute (`script-src` has no `'unsafe-inline'`/matching hash) — the concrete reason a
`<script>` tag that slipped past a sanitizer bug still couldn't run; (2)
`document.createElement('style')` + `appendChild` **does** take effect (`style-src
'unsafe-inline'` is both necessary and sufficient for CodeMirror's `style-mod`).
**Local-only note**: verifying this required a temporary `identifier` change in
`tauri.conf.json` for the run (`tauri-plugin-single-instance` otherwise hands off to
whatever `log-tapper.exe` instance is already running under the real identifier and exits
immediately) — reverted before committing; never ship a temporary identifier change.

**To extend the policy**: add the new source to both `csp` and `devCsp` in
`tauri.conf.json` (unless it is dev-only, like the HMR websocket ports), update the
matching directive's required-sources list in `src-tauri/tests/csp_config.rs`, and add a
justification bullet here naming the actual code path that needs it — a directive change
with no concrete offending code path is a sign the relaxation is unnecessary.
