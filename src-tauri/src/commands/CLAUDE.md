# commands/ — Tauri IPC Adapters

Every public function in this directory is a `#[tauri::command]` registered in
`src-tauri/src/lib.rs`. The frontend calls these via `invoke()` in
`src-shared/bridge/commands.ts`. **Adding a command here without registering it in `lib.rs`
silently fails at runtime.**

**All business logic lives in `src-tauri/src/services/` — see `services/CLAUDE.md`.**
A command in this directory should be three lines: build a `ServiceCtx`, call one
service function, `Ok(result?)`.

```rust
#[tauri::command]
pub async fn some_command(app: AppHandle, arg: Foo) -> Result<Bar, String> {
    Ok(services::domain::do_thing(&crate::commands::adapters::ui_ctx(&app), arg)?)
}
```

`app: AppHandle` (or `app_handle`) replaced most commands' old `state: State<'_,
Arc<AppState>>` parameter across Waves 1–2 — Tauri injects both, so the JS-visible
`invoke()` argument list is unaffected either way. If you're writing more than a few
lines of actual logic in a command body, that logic almost certainly belongs in
`services/` instead — search there first.

## `commands/adapters.rs` — where Tauri meets the service traits

The one file where `services/`'s abstractions (`EventSink`, `AppPaths`, `Spawner`,
`Sink<T>`) get real Tauri implementations:

- `TauriSink` — `EventSink` via `AppHandle::emit`. Emission failures are logged and
  swallowed (a dropped notification must not fail the operation that produced it).
- `TauriProgressSink` — `ProgressSink`, dispatches on `ProgressEvent` variant to the
  matching Tauri event name (`ProgressEvent::event_name()` is the source of truth).
- `ChannelSink<T>` / `AdbChannelSink` — `Sink<T>` over a Tauri IPC `Channel<T>`, one pane,
  not a broadcast. The UI half of the ADB streaming split (see below); `RingSink<T>` in
  `services/events.rs` is the agent half of the same trait.
- `TauriPaths` — `AppPaths` via `AppHandle::path().app_data_dir()`.
- `TauriSpawner` — `Spawner` via `tauri::async_runtime::spawn` specifically, not
  `tokio::spawn` (the background file indexer and the ADB reader task depend on landing
  on that runtime).
- `ui_ctx(&AppHandle) -> ServiceCtx` — the one place `Caller::Ui` is constructed. Every
  command that calls a service goes through this.

## What still legitimately needs a live `AppHandle` (cannot move to `services/`)

- **Autosave flushing** (`workspace/autosave.rs`) — `schedule_autosave(&AppState)` itself
  is already handle-free and callable from a service; only the timer/flush machinery that
  owns the debounce needs the handle.
- **Window, dialog, decorations, single-instance, file associations, `open-file`** — all
  in `lib.rs`'s `setup()`, native OS/webview integration with no service-layer equivalent.
- **MCP bridge start/stop** (`commands/mcp.rs::start_mcp_bridge`) — the one caller of
  `mcp_bridge::BridgeCtx::new(app)`.
- **In-app update** (`commands/app_update.rs`) — builds the updater plugin's `Updater`
  from the handle so `lib.rs::on_app_exit` runs in its `on_before_exit` (Windows exits the
  process from inside the plugin, bypassing `RunEvent::Exit`), and calls `app.restart()`
  after the macOS/Linux install. The frontend never calls `plugin:updater` directly; a
  test in `src-shared/bridge/updater.test.ts` fails if it does. The sidecar the exit
  cleanup kills is the file the installer overwrites — `tests/nsis_hooks.rs` pins the
  installer-side fallback for builds that predate this.

Everything else that used to need `AppHandle` — event emission, path resolution,
spawning, ADB batch delivery — now goes through the trait objects above.

## AppState locking rules

`AppState` uses `std::sync::Mutex` (not async). Rules:

1. **Never hold a lock across an `.await` point.** Acquire, use, drop before any async call.
2. **Never hold `sessions` while trying to acquire `pipeline_results`** (or vice versa) —
   that lock ordering is undefined and could deadlock.
3. Lock with `lock_or_err(&state.foo, "foo")?` (defined in `mod.rs`) — propagate poison as
   a consistent `"foo lock poisoned"` error. Never use raw `.lock().map_err(|_| "...")`
   inline. `services/` has the same rule under a different name (`lock_svc`, which
   produces `ServiceError` instead of `String` — see `services/CLAUDE.md`).

`AppState` itself is held as `Arc<AppState>` (`State<'_, Arc<AppState>>` in commands,
`.state::<Arc<AppState>>()` where resolved manually) — this is what lets a service clone
the state handle into its own `spawn_blocking`/spawned task instead of resolving it out of
a Tauri handle each time.

### Pipeline execution — see `services/CLAUDE.md`

Pipeline orchestration (snapshotting the session source, the pre-filter, layered
execution, cancellation, the `pipeline_run_locks` lock-ordering invariant) lives in
`services::pipeline`. `commands/pipeline.rs` is the thin adapter.

## Filter commands — source type universality

`create_filter`, `get_filtered_lines`, `cancel_filter`, and `close_filter` (adapters over
`services::filters`) work for **all source types** — both `FileLogSource` and
`StreamLogSource`. They dispatch through the `LogSource` trait; no source-type guards
exist in the filter path.

Key points:

- **`raw_line(n)` and `meta_at(n)` are transparent to eviction.** `StreamLogSource`
  automatically reads from `SpillFile` for evicted lines and from the in-memory vec for
  retained lines. `total_lines()` includes evicted lines in the count.
- **Never reimplement filter logic in the frontend.** Always call `create_filter` for the
  initial historical scan regardless of source type. Any frontend JS scan that iterates
  `CacheManager` or `getLines` directly will silently miss evicted lines in a
  long-running stream.
- **Snapshot model:** `total_lines` is captured once, at filter-creation time. Lines
  arriving after that snapshot (new ADB batches) are **not** covered by the filter scan —
  the frontend must handle them incrementally (`appendMatches` in `useFilterScan`). Create
  a new filter for newly arrived data; a filter's own `cancel`/`close` never touches
  session history or any other filter.
- **Universal vs source-specific commands:**
  - Universal (file + streaming): `get_lines`, `create_filter` / `get_filtered_lines` /
    `cancel_filter` / `close_filter`, all pipeline commands (`run_pipeline`,
    `get_pipeline_results`, etc.)
  - Streaming only: `save_live_capture`, `start_adb_stream`, `stop_adb_stream`,
    `flush_batch`

## ADB streaming — see `services/stream.rs` and `services/CLAUDE.md`

`start_adb_stream`'s orchestration (child process spawn, the injected `LineSourceFactory`
seam, batching, continuous state, the `stream_epochs` epoch-guard invariant, cancellation)
lives in `services::stream`. `commands/adb.rs` is the thin adapter layer over it —
`start_adb_stream`, `stop_adb_stream`, `flush_batch`,
`update_stream_{processors,trackers,transformers}`, `get_stream_status`.

What's still true regardless of which layer you're in:

- **Batches are delivered over a Tauri IPC `Channel<AdbStreamEvent>` for the UI, not
  broadcast events.** `adb-batch` and `adb-processor-update` are not app-wide events — the
  channel is passed in by the caller (`AdbChannelSink` in `commands/adapters.rs`, wrapping
  `services::events::Sink<AdbStreamEvent>`). An **agent**-started stream instead gets a
  `RingSink` (`services::events`, cap 2000) it polls via `?since=`. The
  `adb-stream-stopped` broadcast emit survives only as a fallback path from
  `services::stream::stop` / the `stop_adb_stream` command. On the frontend,
  `channelActiveRef` in `useStreamSession` guards against late channel messages arriving
  after stop or detach.
- **`AdbStreamEvent::ProcessorsExcluded`** carries the current set of active processors a
  live stream's declared `schema.source_types` check excludes (always vs. `Logcat`) —
  file mode's `PipelineRunSummary.skipped` skip-row equivalent for streaming, which had
  none before. `flush_batch` recomputes eligibility every batch, dedups against
  `AppState::stream_excluded_processors` (a cache only, no epoch guard needed) and sends
  the event once when the set first becomes non-empty and again only when it actually
  changes — never once per batch. The frontend forwards it via the
  `pipeline:adb-processors-excluded` bus event, folded into `PipelineContext`'s per-session
  results as `PipelineRunSummary.skipped` (`applyExcludedProcessors` in
  `context/PipelineContext.tsx`) so `ProcessorDashboard` renders the identical n/a row for
  either path.
- `ChunksTimeout` (tokio-stream) is **not** `Unpin` — `tokio::pin!(stream)` is required
  before using it in `select!`.
- **Always use `source.meta_at(n)` and `source.raw_line(n)` instead of direct indexing** —
  these adjust for eviction offset transparently.
