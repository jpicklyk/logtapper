# services/ — The Service Layer

The only implementation of LogTapper's capabilities. Two transports — the React UI over
Tauri commands, and AI agents over the MCP HTTP bridge — both adapt to this layer instead
of each hand-rolling the same logic. `commands/*` and `mcp_bridge/routes/*` are thin
adapters: build a `ServiceCtx`, call one service function, marshal one
`Result<T, ServiceError>`.

**Hard rule: no `use tauri` anywhere under `services/`.** Pinned by
`tests::services_module_never_imports_tauri` in `mod.rs`, which reads every `.rs` file in
this directory at test time (skips comment lines) — a new file is covered automatically,
no registration needed. Tauri-side implementations of `EventSink`/`AppPaths`/`Spawner`
live in `commands/adapters.rs`, never here.

## ServiceCtx — built in exactly three places

```rust
ServiceCtx::new(state: Arc<AppState>, events: Arc<dyn EventSink>, paths: Arc<dyn AppPaths>,
                spawner: Arc<dyn Spawner>, caller: Caller) -> ServiceCtx
```

`Clone + Send + Sync + 'static` — a service moves its own clone into `spawn_blocking`
rather than the "clone the handle, re-resolve state inside" dance the pre-service code
did. Accessors: `.state()`, `.state_arc()`, `.events()`, `.paths()`, `.spawner()`,
`.caller()`, `.with_caller(c)` (same state, different identity — used where one transport
acts on another's behalf), `.journal(action, session_id, summary)`.

1. `commands::adapters::ui_ctx(&AppHandle)` — every `#[tauri::command]` calls this. Stamps
   `Caller::Ui`.
2. `mcp_bridge::BridgeCtx::svc(client: &str)` — every bridge route handler calls this.
   Stamps `Caller::Agent { client }`, `client` from the `X-LogTapper-Client` header
   (default `"mcp"`, never trusted for authorization, only for the activity feed).
3. `services::testing::test_ctx()` — a `TestCtxBuilder`, Tauri-free, for every test.

Never construct one anywhere else. `BridgeCtx` used to also carry an `Option<AppHandle<Wry>>`
for four handlers that hadn't converted yet (open/close session, artifact mutations,
pipeline run) — the last of those converted in Wave 2 and the field is gone. Nothing may
reintroduce it.

## Caller

```rust
#[serde(rename_all = "camelCase", tag = "kind")]
enum Caller { Ui, Agent { client: String } }   // { "kind": "ui" } / { "kind": "agent", "client": "..." }
```

Not a permission level — an identity. `policy.rs` is the only place identity becomes a
decision; an individual service should never `match ctx.caller()` for authorization (it's
fine to read `.is_agent()` for behavior that isn't a security gate, e.g. journaling).

## ServiceError

```rust
enum ServiceError {
    NotFound(String),                              // NOT_FOUND            404
    InvalidArg { code: &'static str, message },     // INVALID_ARGUMENT | INVALID_PATH | INVALID_REGEX | INVALID_SOURCE_TYPE | UNSUPPORTED_PROCESSOR_TYPE   400
    Forbidden  { code: &'static str, message },     // NOT_ALLOWED          403
    Conflict(String),                               // CONFLICT             409
    Cancelled,                                       // CANCELLED            499
    LockPoisoned(&'static str),                     // LOCK_POISONED        500   message == "{name} lock poisoned"
    Internal(String),                                // INTERNAL             500
}
```

`.message()`, `.code()`, `.http_status() -> u16` (bare `u16` — `services/` needs no
transport crate). `impl From<ServiceError> for String` lets `commands/*` keep
`Result<T, String>` with messages reproducing the pre-service strings verbatim (use the
`ServiceError::session_not_found(id)`-style constructors where one exists — `"Session '{id}'
not found"` is the dominant spelling). **`impl IntoResponse for ServiceError` lives in
`mcp_bridge/respond.rs`, not here** — services stay HTTP-unaware; the bridge is the only
place a `ServiceError` becomes a real status code + `{ "error": { "code", "message" } }`
envelope (`services::wire::WireError`/`WireErrorDetail`).

Use `lock_svc(&mutex, "name")` (in `mod.rs`) instead of `commands::lock_or_err` inside a
service — same `"{name} lock poisoned"` message, but it returns `ServiceError` not
`String`.

## Sinks — `events.rs`

- `EventSink` — `emit_json(event, Value)`. `TauriSink` (broadcast to every webview) lives
  in `commands/adapters.rs`; `RecordingSink` (test double) in `testing.rs`.
- `ProgressSink` — `on_progress(&ProgressEvent)`. `ProgressEvent::{Pipeline,Search,Filter,Index}`
  each wrap a struct byte-identical to the pre-service payload. **`ProgressEvent::event_name()`
  is the single source of truth for the four wire names** (`pipeline-progress`,
  `search-progress`, `filter-progress`, `file-index-progress`) — `TauriProgressSink` emits
  the typed payload directly (not JSON) under that name, so serialization is unchanged.
- `Sink<T>` — `send(item)`. Two implementations of the same trait, one per transport: UI
  gets `ChannelSink<T>` (a Tauri IPC `Channel<T>`, one pane, not a broadcast —
  `AdbChannelSink` is the `ChannelSink<AdbStreamEvent>` alias); an agent gets `RingSink<T>`.
- `RingSink<T>` — bounded ring (`cap` 0 coerces to 1; agent streaming uses
  `AGENT_RING_CAPACITY = 2000`). Sequence numbers start at **1**, so `since=0` means
  "everything still retained". `drain_since` is **non-destructive** — two independent
  consumers can each hold their own cursor. A `gap` (evicted events) is detectable when
  `first().seq > since + 1`.

## AppPaths / Spawner (`paths.rs`)

`AppPaths::app_data_dir()`; `Spawner::spawn(BoxFuture)`. `TauriSpawner` calls
`tauri::async_runtime::spawn` specifically (not `tokio::spawn`) — the background file
indexer and the ADB reader task depend on landing on that runtime. Test doubles
(`FixedPaths`, `NullSpawner`) live in `testing.rs`.

## Policy gates (`policy.rs`)

- **`authorize_open(ctx, path) -> Result<PathBuf, ServiceError>`** — `Ui` passes through
  (native dialog is consent, only canonicalized via `simplified_path`); `Agent` runs
  `bridge_access::validate_open_path` against the allowlist + already-open sessions.
  Denied and nonexistent are **deliberately indistinguishable** (`Forbidden`/`NOT_ALLOWED`,
  same message) — never add a branch that tells them apart; it lets an agent probe the
  filesystem.
- **`authorize_write_dest(ctx, raw) -> Result<PathBuf, ServiceError>`** — the write-side
  twin, for a destination that usually doesn't exist yet. `Ui` passes through untouched.
  `Agent`: the destination's **parent directory** (which must exist) is validated the same
  way `authorize_open` validates a whole path; the file name itself must be a single plain
  segment (no NTFS ADS suffix). This is the **one, unified** function — Wave-2 packages
  (export, workspace save, stream save) each independently built the identical
  allowlist+parent-containment+hygiene logic before this consolidation; if you're tempted
  to write a fourth copy, you're looking for this function.
- **`should_anonymize_for(ctx, pathway) -> bool`** — the one place the anonymizer *mode*
  (`AnonymizerConfig::mode`: `All` / `External` / `None`, default `External`, written only by
  `settings::set_anonymizer_config`) and the caller's identity become a redaction decision.
  `Pathway` is about the *destination* of the raw text, not the transport:

  | mode       | `Ui`, `Internal` | `Ui`, `External` | `Agent` (either pathway)     |
  |------------|------------------|------------------|------------------------------|
  | `All`      | redacted         | redacted         | redacted unless raw access   |
  | `External` | raw              | redacted         | redacted unless raw access   |
  | `None`     | raw              | raw              | raw                          |

  `Internal` = stays in the app: viewer pages (`lines`), search/filter results, pipeline
  result lines, stream events to a pane, the in-chain `__pii_anonymizer` of a `Ui` stream
  (`pipeline::resolve_effective_chain`, `stream::resolve_stream_chain`). `External` = leaves
  the tool: `.lts` export (`export::run`), `stream::save_live_capture`, clipboard/bookmark
  Markdown (`settings::anonymize_text`), analysis hand-off exports. **Every new raw-text
  pathway names its `Pathway` at the decision site** — never re-derive the table locally,
  and never add a per-surface checkbox. An agent is outside the tool by definition, so its
  pathway never matters; `None` means none *everywhere*, agents included — acceptable only
  because both inputs are `Ui`-only persisted settings with a persistent visible warning
  (the same consent class as `agent_raw_access`). Raw access itself:
  `settings::set_agent_raw_access`, persisted to `{app_data_dir}/mcp_agent_access.json`
  (`AgentAccessFile`), loaded in `lib.rs::setup` like the allowlist.
  `settings::agent_access` computes the wire view (`McpAgentAccess { agent_raw_access,
  anonymizer_mode, effective_agent_raw }`) once for `GET /mcp/settings/agent_access` *and*
  `McpStatus`, so the presence pill and the agent never disagree.
- **`should_anonymize(ctx, _session_id) -> bool`** — the `Internal` shorthand; every read
  path uses it. The `session_id` parameter is accepted and ignored: the decision is global
  on purpose, so nothing a session carries — above all its pipeline chain — can widen what
  an agent sees. (The per-session `mcp_anonymize` map this replaced was mirrored from
  `chain.includes('__pii_anonymizer')` by the frontend and therefore turned agent
  anonymization *off* for the default chain.)
- **`redact_line(ctx, session_id, raw, max_chars) -> String`** / **`redact_lines(ctx,
  session_id, &mut [String], max_chars)`** — the choke points for raw log text leaving the
  backend. **Anonymize first, truncate second** — load-bearing order, so a redaction token
  is never cut mid-token by the length cap. Every service returning raw text routes through
  one of them: lines, search, pipeline matched lines, insights message text, section
  previews, stream events, filters, export. Page-shaped services go through
  `lines::redact_view_lines` (→ `redact_lines`), which takes the anonymizer's locks **once
  per page** rather than once per line — under mode `All` this is the viewer's scroll path
  — and recomputes search highlights against the redacted text. Both reuse the session's
  persistent `LogAnonymizer` (cached in `mcp_anonymizers`) so token numbering is stable
  across calls (`anonymize_session_text` / `anonymize_session_lines` are the unconditional
  mechanism behind them — the decision belongs to `should_anonymize_for`). Never call these
  while holding `sessions` — collect the raw text, drop that lock, then redact (the
  `agent_raw_access`/`anonymizer_config`/`mcp_anonymizers` locks must never nest under
  `sessions`). Known limitations: search and filters *match* on raw text (under `All`,
  searching for an email finds the line and shows `<EMAIL-1>`; searching for `<EMAIL-1>`
  finds nothing); token numbering is per session per app run.
- **`deny_agent_gate_mutation(ctx, what) -> Result<(), ServiceError>`** — an agent may
  never widen its own gate. Called first by `set_anonymizer_config`, `set_open_allowlist`,
  `set_agent_raw_access` (the sharpest case — it decides whether an agent sees PII at all,
  and has no bridge write route), `add_source`/`remove_source` (marketplace sources are a
  supply-chain surface, same risk class). `Ui` passes; `Agent` gets `Forbidden`. A differently-worded inline check is used
  for `pii_mappings` (a *read*, not a mutation — the helper's message says "may not
  *modify*", the wrong word for a read) — same `Forbidden`/`NOT_ALLOWED` shape.

## Activity journal (`activity.rs`)

`AppState.activity: ActivityJournal` — `Mutex<VecDeque<ActivityEntry>>`, cap **500**
(`ACTIVITY_CAP`; `with_cap()` for tests). `ActivityEntry { id, ts, caller, action,
session_id, summary }`, ids monotonic for the process lifetime. `push()` returns the
stored entry; `ServiceCtx::journal()` emits **that exact value** as the `activity` Tauri
event and HTTP-pollable via `GET /mcp/activity?since=&limit=` (`list(limit, since_id)`
returns `id > since_id`, keeping the newest when `limit` cuts).

**Journal from services only, never adapters** — that's what makes the feed complete
across both transports instead of per-transport. **Mutations only — reads are never
journaled.** Journaled actions: `session.{open,close}`, `pipeline.run`, `bookmark.*`,
`analysis.*`, `watch.{create,cancel}`, `filter.{create,cancel,close}`,
`workspace.{save,load,switch}`, `processor.*`, `pack.*`, `stream.{start,stop,save}`,
`export.run`, `settings.*`, `chain.update` (only when membership or enablement changed — a
pure reorder emits `chain-update` and autosaves but is not feed-worthy). Two documented non-journal mutations: `analyses::set_workspace`
(restoring a workspace must not immediately re-persist itself as a caller action) and
`workspace::restore_session` (the enclosing `workspace.load`/`workspace.switch` entry
already records it).

## Catalog events & provenance (`processors.rs`)

Every processor/pack install, uninstall, and update — from either caller — emits
`catalog-update` (`CatalogUpdateEvent { caller, action: "install"|"uninstall"|"update", ids
}`) after the journal call, via `services::processors::emit_catalog_update` (a no-op for
an empty `ids`, e.g. `update_all_from_source` finding nothing outdated). Mutation sites:
`processors.rs`'s `install_yaml`/`install_from_file`/`uninstall`/`install_pack_yaml`/
`load_pack_from_file`/`uninstall_pack`, and `marketplace.rs`'s `update_processor`/
`update_all_from_source`/`install_from_marketplace`/`install_pack_from_marketplace`/
`uninstall_pack_from_marketplace`. **Never** `add_source`/`remove_source` — those are the
human-only supply-chain gate (`policy::deny_agent_gate_mutation`), not a catalog change.

Every processor installed by either caller is stamped with `_installed_by` provenance in
its persisted YAML (`processors::marketplace::Provenance.installed_by`, alongside the
existing `_source`/`_installed_version`/`_installed_at`/`_sha256`): `"ui"` or
`"agent:<client>"`, from `services::processors::caller_provenance(ctx.caller())`. A
marketplace install embeds it via `build_provenance_yaml`'s `installed_by` parameter; a
raw YAML install (`validate_and_install`) appends `_installed_by: <v>` to the caller's
YAML directly, since it never goes through `build_provenance_yaml`. `AnyProcessor.installed_by`
is populated at startup (`lib.rs::load_persisted_processors`) from the parsed
`Provenance.installed_by`, next to the existing `_source` copy, and exposed on
`ProcessorSummary.installed_by` (`skip_serializing_if` + `#[ts(optional)]`, absent for a
built-in or a processor installed before this field existed). Packs get no provenance.

## Lock discipline

A service function holds **at most one** `AppState` lock, never across an `.await`. A
read needing two locks goes through `snapshot.rs`. Two documented, deliberate exceptions
that predate the service layer and must stay as-is:

1. `pipeline_run_locks` is the **outermost** lock in `services::pipeline::run`, held for
   the whole run so two concurrent runs on the same session can't interleave writes to
   `pipeline_results`/`state_tracker_results`/`correlator_results`.
2. `stream_epochs` → the per-session stream-state map, in that order, in
   `services::stream` — the epoch-guard pattern that stops a late/in-flight ADB batch from
   resurrecting state a `stop` already cleared. Writers always use `get_mut`, never
   `or_default`, so a cleared session is never recreated even when the epoch compares
   equal.

Every raw-line read is `source.meta_at(n)` / `source.raw_line(n)` — never direct
indexing; these adjust for stream eviction transparently.

## `services/testing.rs` — the `test-support` feature

```rust
test_ctx() -> TestCtxBuilder
  .caller(Caller) / .agent("name")
  .with_session(id, n) / .with_pii_session(id, n) / .with_session_object(s)
  .allowlist(dir) / .agent_raw_access(bool) / .anonymizer_mode(AnonymizerMode)
  .build() -> (ServiceCtx, TempDir)
  .build_recording() -> (ServiceCtx, Arc<RecordingSink>, TempDir)
```

**Keep the `TempDir` alive** — it backs the ctx's `app_data_dir`. `RecordingSink`
implements `EventSink` + `ProgressSink` + `Sink<T>`; assert with `.events()`,
`.events_named(n)`, `.only_event(n)`, `.progress_events()`. Fixtures —
`fixture_session(id, n)`, `fixture_session_with_pii(id, n)`, `fixture_session_from(id,
lines)` — build an in-memory `StreamLogSource`, no file, no mmap.

`Cargo.toml` has `[features] test-support = []`. Integration tests under
`src-tauri/tests/` self-depend on `log-tapper` with that feature enabled (so plain `cargo
test`, no extra flags, links against `services::testing`) — see
`src-tauri/tests/support/mod.rs`'s shared harness (`app()`, `ctx_only()`,
`trusted_headers()`, `get`/`send_json`) used by both `bridge_http.rs` and
`wire_parity.rs`.

## ts-rs — deriving `TS` on a new IPC type

- Derive `#[derive(TS)]` on the struct/enum, `#[serde(rename_all = "camelCase")]` as
  usual. Add **one line** to `ROOT_TYPES!` in `src-tauri/tests/export_bindings.rs` only if
  the type crosses the IPC boundary **directly** (a command return, an event payload, or a
  `wire.rs` envelope) — a type reachable only as a field of a root is picked up by ts-rs's
  own dependency walk and needs no line of its own.
- `HashMap<String, T>` → `#[ts(type = "Record<string, T>")]`. `serde_json::Value` /
  `serde_yaml::Value` / any opaque frontend-owned JSON → `#[ts(type = "unknown")]`, never
  `any`. Every `u64`/`i64` on an IPC-reachable field → `#[ts(type = "number")]` (Tauri IPC
  is JSON; a `u64` arrives in JS as a plain number, and ts-rs's default `bigint` is wrong
  here) — guarded by `no_bigint_escapes_into_the_bindings`, which scans every generated
  file and names the offending one.
- **`#[ts(type = ...)]` kills ts-rs's dependency tracking.** If the override's value
  mentions a named Rust type (e.g. `Record<string, FieldChange>`), you must (a) write the
  import by hand as a TS inline import (`Record<string, import('./FieldChange').FieldChange>`)
  and (b) add that named type as its own `ROOT_TYPES!` entry, or its file is never
  generated and the import 404s. `#[ts(as = ...)]` preserves dependency tracking but needs
  a real Rust type, so it doesn't help for a `Record<>`/`unknown` override.
- `#[ts(optional)]` only where `#[serde(skip_serializing_if = ...)]` actually exists on
  that field — everywhere else `Option<T>` becomes a truthful `T | null`, not `?: T`. Fix
  the resulting `tsc` fallout at call sites; never loosen a generated type back to
  optional to make a caller compile.
- Run `npm run gen:types` (wraps `cargo test --test export_bindings`) to regenerate;
  `npm run check:types` (part of `lint:all`) fails on drift.

## Adding a service function, a route, and a command

1. Write the function in `services/<domain>.rs`: takes `&ServiceCtx` (or owned `ServiceCtx`
   if it spawns its own async work), returns `Result<T, ServiceError>`. One lock at a time.
   Redact any raw text via `policy::redact_line` before returning it. Journal if it's a
   mutation.
2. Bridge route: add the handler to the right `mcp_bridge/routes/*.rs` file (`pub(crate)
   async fn h_...`, `HeaderMap` last param if it needs `client_name(&headers)` from
   `respond.rs`), build `ctx.svc(client_name(&headers))`, return
   `Result<Json<T>, ServiceError>` — `?` does the whole error mapping via `IntoResponse`.
   Append one entry to **both** `ROUTES` (the pinned literal near the top of
   `mcp_bridge/mod.rs`) and `router()`'s `.route(...)` chain, in the same relative
   position — **both are append-only from Wave 1 on**; the `route_table_matches_expected`
   test only catches the two drifting from each other, not from the live router (that's
   `tests/bridge_http.rs`'s `route_table_probe_every_route_resolves_through_the_live_router`,
   which also pins the total route count — bump it in the same change).
3. Tauri command (only if the UI needs it): `commands/<domain>.rs`, first param
   `app: AppHandle`, body `Ok(services::<domain>::fn(&ui_ctx(&app), ...)?)`, register in
   `lib.rs`'s `generate_handler!` list.

## Wave-2 deviations worth remembering

- **ADB streaming never writes `state_tracker_results`/`correlator_results`.** Tracker
  state during a live stream lives in `stream_tracker_state`, not the file-mode maps —
  `services::stream` deliberately does not call
  `services::pipeline::store_tracker_and_correlator_results`. Don't "fix" this without
  re-deriving why `stop`'s epoch-guard comment depends on it staying that way.
- **`services::pipeline::resolve_effective_chain` is the only authority for "what
  processors run".** It resolves an explicit id list (bare→qualified, unknown = `InvalidArg`)
  or, for `None`/empty, `session_pipeline_meta[session].active − disabled` filtered to
  installed/`@lts-` ids, then force-includes `__pii_anonymizer` when `should_anonymize`
  (the `Internal` pathway: a `Ui` chain only under mode `All`).
  A stream start with no `session_pipeline_meta` entry yet can't use the same "requested
  absent" branch (see `services::stream::resolve_stream_chain`) — but any explicit list,
  from any transport, must resolve through this function, never re-derived locally.
- **`total` in a search route means two different things.** `GET .../search` stops at
  `limit` (early-stop scan), so `total == returned`. `GET .../search_with_context` scans
  the whole requested range for an exact count, so `total` can exceed `returned`. This is
  `services::search::SearchHitsRequest`'s `count_all_matches` knob, kept because the two
  bridge handlers were written independently years apart — not yet unified. Don't assume
  `SearchHits.total` means the same thing across both routes without checking which one
  produced it.
- **`GET /mcp/sessions/{id}/events`'s `Page.total` is the page's own length, not "how many
  transitions exist".** `tracker::recent_events` caps and does not report what it walked
  past — raise `limit` for more, don't read `total` as a count of everything available.
