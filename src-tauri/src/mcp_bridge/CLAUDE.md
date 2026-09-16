# mcp_bridge/ — HTTP Bridge for the MCP Server

A TypeScript MCP server process (stdio transport) talks to Claude Code/Desktop. That
process queries THIS local Axum HTTP server on `127.0.0.1:40404` to drive LogTapper on an
agent's behalf. Every handler is a thin adapter: build a `ServiceCtx` via `BridgeCtx::svc`,
call one `services::*` function, return `Result<Json<T>, ServiceError>` — see
`services/CLAUDE.md` for what lives on the other side of that call.

```
mcp_bridge/
  mod.rs        BridgeCtx, ROUTES, router(), start()
  middleware.rs record_activity, require_local (+ is_trusted_request)
  respond.rs    IntoResponse for ServiceError, client_name(), a few shared JSON helpers
  routes/*.rs   one file per domain — activity, artifacts, export, filters, insights,
                lines, pipeline, processors, search, sessions, settings, stream, timeline,
                tracker, watches, workspace
```

## `BridgeCtx`

```rust
pub struct BridgeCtx { pub state: Arc<AppState>, pub events: Arc<dyn EventSink>,
                        pub paths: Arc<dyn AppPaths>, pub spawner: Arc<dyn Spawner> }
BridgeCtx::new(app: AppHandle<Wry>) -> Self        // commands::mcp::start_mcp_bridge, the only caller
BridgeCtx::from_parts(state, events, paths, spawner) -> Self   // in-process router tests, no Tauri handle
BridgeCtx::svc(&self, client: &str) -> ServiceCtx  // one of exactly two places a Caller is built
```

**No `AppHandle` field.** Earlier in the service-layer migration `BridgeCtx` carried an
`Option<AppHandle<Wry>>` for four handlers that hadn't converted to `ServiceCtx` yet
(open/close session, bookmark/analysis mutations, pipeline run). All four converted by the
end of Wave 2; the field was deleted. **Nothing may reintroduce it** — reach for `state`,
`events`, `paths`, or `spawner`. This is also why `router(ctx)` can be built and driven
with `tower::ServiceExt::oneshot` in tests with no live webview at all
(`tests/support/mod.rs::app()`).

## `router()` / `start()` split

`pub fn router(ctx: BridgeCtx) -> Router` builds the whole route table plus both
middleware layers; `pub async fn start(ctx, shutdown_rx)` only binds, serves, and does
port-flag bookkeeping (`mcp_bridge_port`, `mcp_bridge_shutdown`) — `start` clones
`Arc<AppState>` out of `ctx` *before* `router(ctx)` consumes it, which is why that
bookkeeping still works after the move.

**Middleware order is load-bearing and easy to get backwards.** In axum, layers wrap
inside-out in the order `.layer()` is called — the *last* call is the *outermost* wrapper
and therefore runs *first*. `router()` adds `record_activity` before `require_local`, so
`require_local` is outermost: a non-local request is turned away before
`record_activity` ever stamps `mcp_last_activity`. If you reorder these, untrusted traffic
can stamp activity timestamps before being rejected.

**Agent anonymization is decided in `services::policy`, never here.** A bridge caller is
always `Caller::Agent`, so every raw-line route is redacted unless the user persisted the
`agent_raw_access` opt-out (Settings → General → MCP Integration). `GET
/mcp/settings/agent_access` reads that flag; there is deliberately **no write route** for
it — `routes/settings.rs`'s module doc explains why, and nothing may add one.

`require_local`'s `is_trusted_request` (in `middleware.rs`) checks Host (must be exactly
`127.0.0.1:40404` or `localhost:40404`), Origin (must be absent — a real MCP client never
sets it; a browser always does), and Referer (if present, must start with the bridge's own
origin) — CSRF/DNS-rebind defense, independent of and layered on top of the caller-based
policy gates in `services::policy`.

## Route table — append-only

`pub const ROUTES: &[(&str, &str)]` near the top of `mod.rs` is the single source of truth
for the *expected* route list, in the same order `router()` registers them. **The two are
two independently-maintained lists, not one generated from the other** — axum's
`.route(path, get(handler))` needs each handler's concrete type at the call site, so a
generic table can't drive registration without much heavier macro machinery. Two tests
guard against drift:

- `route_table_matches_expected` (in `mod.rs`) — pins `ROUTES` rendered as `"METHOD
  /path"` strings against a literal expected list. Catches `ROUTES` drifting from itself,
  not from `router()`.
- `route_table_probe_every_route_resolves_through_the_live_router` (in
  `tests/bridge_http.rs`) — actually drives the real `router()` via
  `tower::ServiceExt::oneshot` for every `ROUTES` entry and asserts none 404/405s. Also
  pins the **total route count** (currently 70).

**To add a route:** append one line to `ROUTES`, one `.route(...)` call to `router()` in
the same relative position, update both pinned literals in the same change, and add the
handler to the right `routes/*.rs` file (or a new file + `pub(super) mod` line in
`routes/mod.rs` for a new domain). Never remove or reorder an existing entry without
checking who depends on route ordering (nobody currently does, by design — keep it that
way).

## Error handling — the one contract

```rust
impl axum::response::IntoResponse for ServiceError { /* in respond.rs */ }
```

Every failing handler answers a real HTTP status plus
`services::wire::WireError { error: WireErrorDetail { code, message } }` — never a bare
200 with an ad hoc `{"error": ...}` body. Status table (from `ServiceError::http_status()`):

| variant | status | code |
|---|---|---|
| `NotFound` | 404 | `NOT_FOUND` |
| `InvalidArg` | 400 | `INVALID_ARGUMENT` \| `INVALID_PATH` \| `INVALID_REGEX` \| `INVALID_SOURCE_TYPE` \| `UNSUPPORTED_PROCESSOR_TYPE` |
| `Forbidden` | 403 | `NOT_ALLOWED` |
| `Conflict` | 409 | `CONFLICT` |
| `Cancelled` | 499 | `CANCELLED` |
| `LockPoisoned` | 500 | `LOCK_POISONED` |
| `Internal` | 500 | `INTERNAL` |

Every handler is `Result<Json<T>, ServiceError>` — `?` does the whole job, no per-route
error mapping. A denied and a nonexistent open-file path render **byte-identically**
(same `Forbidden`/`NOT_ALLOWED`, from `policy::authorize_open`) because `into_response` is
a pure function of the error, not something a handler has to arrange — never special-case
a route to distinguish them. A poisoned `AppState` lock now returns 500 +
`LOCK_POISONED` instead of possibly serving a torn map; the next request just tries again.

`GET /mcp/processors` and `GET /mcp/processors/{id}` are the two remaining routes that
still answer a hand-assembled `Json<Value>` (the YAML-derived processor/tracker/correlator
schema shapes are genuinely heterogeneous) — typing them is a `services::processors`
change, not a bridge one.

## `X-LogTapper-Client`

`respond::client_name(&HeaderMap) -> &str` reads it, defaulting to `"mcp"` (empty value
treated as absent). This is the **one** copy — every route handler that needs the caller's
self-reported client name for `ctx.svc(client_name(&headers))` imports it from `respond`.
Never trusted for authorization, only for the activity feed and journal.

## Test harness

- **`tests/support/mod.rs`** — shared by `bridge_http.rs` and `wire_parity.rs`. `app() ->
  (Router, Arc<AppState>, Arc<RecordingSink>, TempDir)` builds a real `router(ctx)` via
  `BridgeCtx::from_parts`, no Tauri handle. `ctx_only()` hands back the `BridgeCtx` itself
  (for testing `ctx.svc()`/`ServiceCtx::journal` directly). `trusted_headers()` is the
  minimum header set that passes `require_local`. `substitute_placeholders(template)`
  turns a `ROUTES` path template into a requestable path (`{session_id}` → `nosuch`, any
  other `{...}` → `x`). `get`/`get_raw`, `send_json`/`send_json_raw` issue requests (`_raw`
  variants return bytes, needed for byte-identical-body assertions).
- **`tests/bridge_http.rs`** — CSRF wiring, the open-file 403/400 matrix, anonymization
  gating parameterized over every raw-line route (absent configuration ⇒ redacted,
  `agent_raw_access` ⇒ raw — plus the exhaustiveness list that forces a decision for any
  new raw-text route), the route-table probe above, and a status-code matrix (`unknown_ids_yield_404...`, `denied_destinations_yield_403...`,
  `malformed_params_yield_400...`).
- **`tests/wire_parity.rs`** — for each shared `services::wire` type, builds the value two
  ways (call the service function directly vs. hit the route through `router()`) and
  asserts key-set + full `assert_eq!` equality, plus a check that the generated `.ts`
  binding's field names cover the JSON keys. Not every wire type has two producers to
  compare yet (`LinePage`/`SearchHits`/`PipelineRunResult` — the Tauri command side hasn't
  converted); the file's own module doc explains each gap.

**To add a route case:** if the route is a pure `Ok(Json(service::fn(&svc, ..)?))`
passthrough, follow an existing full-equality case in `wire_parity.rs` (call the service,
`serde_json::to_value` it, hit the route, `assert_eq!`). If the route narrows or renames
fields, compare only what the route actually carries and add a one-line comment saying
why the rest is withheld (see the correlations/pipeline-detail cases for the pattern).

## Windows test-binary manifest (the `build.rs` story)

Referencing `AppHandle<Wry>` anywhere — even as `Option::None` — used to pull Wry's
window-class registration code into a plain `cargo test` binary, which has no embedded
manifest, so the OS loader resolved comctl32 imports against the legacy v5.82 DLL and the
whole process died at load time (`STATUS_ENTRYPOINT_NOT_FOUND`, before `main()`, no
output). `BridgeCtx` no longer carries an `AppHandle` at all, but the fix in `build.rs`
stays because the unit-test harness (`cargo test --lib`) still constructs types that
reference Wry indirectly through other test code:

```rust
#[cfg(all(windows, target_env = "msvc"))]
{
    // 1. Integration test binaries ([[test]] targets, e.g. bridge_http.exe):
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", manifest.display());
    // 2. The lib's own unit-test harness (cargo test --lib) is NOT a [[test]] target,
    //    so directive 1 doesn't reach it. An embedded manifest here would collide
    //    (CVT1100) with the RT_MANIFEST tauri_build already embeds in the real app
    //    binary, so this asks for an EXTERNAL manifest instead — the loader only
    //    consults one when the image has no embedded manifest, so the app binary
    //    (which has tauri's embedded one) is unaffected:
    println!("cargo:rustc-link-arg=/MANIFEST");
    println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:...Common-Controls...");
}
```

`cargo:rustc-link-arg-tests` is Cargo's own target-kind-scoped mechanism — verified not to
touch the real `log-tapper.exe` (still gets tauri's own manifest) or any dependency's
build script. **Do not** replace this with a workspace-wide `.cargo/config.toml`
`rustflags` override — that was tried first and broke `serde`/`thiserror`/`zerocopy`/etc.'s
own build scripts across the whole workspace.

**Windows/locked-target-dir workaround while the dev app is running:** `npx tauri dev`
holds `src-tauri/target/debug/log-tapper.exe` open, which can make `cargo test`/`npm run
check:types` fail to relink. Run with an alternate target dir:
`$env:CARGO_TARGET_DIR="src-tauri/target-it"; cargo test ...` (or pass
`--target-dir src-tauri/target-it`). This is a manual workaround, not encoded in any
script — `package.json`'s scripts have no way to detect whether the app is running.

## `TS_RS_EXPORT_DIR` cwd gotcha (worktrees)

`.cargo/config.toml`'s `[env] TS_RS_EXPORT_DIR = { value = "src-shared/bridge/generated",
relative = true }` resolves against the **current working directory of the invoking
shell**, not `--manifest-path`. Running `cargo test --test export_bindings
--manifest-path <worktree>/Cargo.toml` from a shell whose cwd is the **main repo root**
silently writes generated `.ts` files into the **main repo's**
`src-shared/bridge/generated/`, not the worktree's — this has happened more than once during
this migration and was reverted each time. **Always set `$env:TS_RS_EXPORT_DIR` to the
worktree's own absolute path** before any `cargo test`/`build`/`clippy` invocation whose
manifest lives in a worktree; an explicitly-set env var wins over the config file's
default (the `[env]` table has no `force = true`).
