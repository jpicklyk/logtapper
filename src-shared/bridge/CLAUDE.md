# src-shared/bridge/ — Frontend IPC Layer

All Tauri communication goes through this directory. Components and hooks **never** call
`invoke()` or `listen()` directly.

## File organization

- `commands.ts` — thin `invoke()` wrappers; one function per Rust `#[tauri::command]`
- `events.ts` — typed `listen()` wrappers for all Tauri events
- `types.ts` — the import surface for IPC types (~127 importers): re-exports from
  `generated/` plus narrowing aliases and a small set of hand-written types that have no
  Rust struct or that ts-rs cannot express — each carries a one-line comment explaining why
- `generated/` — ts-rs bindings produced by `npm run gen:types`; **never hand-edit** (see
  `.gitattributes` and this file's own header comment)
- `generated.contract.test.ts` — compile-time `satisfies`/`expectTypeOf` checks on the
  highest-traffic generated shapes (`ViewLine`, `SessionMetadata`, `Page<ViewLine>`, …),
  so a shape regression in the Rust side fails `npm run test`, not just `tsc`

## Codegen workflow

```
npm run gen:types    # cargo test --test export_bindings — the ONLY export trigger
npm run check:types  # gen:types && git diff --exit-code -- generated/ && tsc --noEmit
npm run lint:all     # lint && lint:rust && check:types
```

`gen:types` regenerates every `.ts` file under `generated/` plus the sorted barrel
(`index.ts`) from the Rust side's `ROOT_TYPES!` list (`src-tauri/tests/export_bindings.rs`)
and is idempotent — running it twice with no Rust change produces byte-identical output.
`check:types` is what actually gates CI: it regenerates, then fails the build if that
produced a diff (drift between committed bindings and what the Rust source currently
says) or if `tsc` doesn't pass. It is wired into `lint:all`, **not** `build` — a plain
`npm run build` will not catch drift.

**When adding a new Rust IPC struct:** derive `#[derive(TS)]` on it (add one line to
`ROOT_TYPES!` only if it's a direct root — a command return, an event payload, or a
`services::wire` envelope; a field-only type is picked up transitively), run `npm run
gen:types`, then re-export it from `types.ts` before using it in a command wrapper or
event listener. See `services/CLAUDE.md` (backend) for the override rules
(`Record<string,T>`, `unknown`, `number` for `u64`/`i64`, `#[ts(optional)]` policy).

**Stale-file gotcha:** `export_all()` writes files, it never deletes them. Deleting a root
type on the Rust side (or renaming one) leaves an orphaned `.ts` file in `generated/` that
`check:types`'s `git diff` does **not** catch, because nothing regenerates or touches it.
When you delete or rename a root type, delete its stale `generated/*.ts` file by hand,
then re-run `gen:types` so the barrel is rewritten without it.

## `types.ts` — the re-export surface

Three categories, in this order in the file:

1. **Straight re-exports** — `export type { Foo } from './generated'`. The generated shape
   is used as-is. This is the default; most types end up here.
2. **Aliased re-exports** — `export type { Foo as Bar } from './generated'`, used only
   when the generated name collides with an established call-site name and the shapes are
   verified structurally identical first (don't assume — check the generated `.ts` file
   directly; a rename-only assumption has been wrong before, see `LtsEditorTab.viewMode`
   below).
3. **Hand-written / narrowed types**, each with a one-line justification comment. Two
   sub-cases:
   - **No Rust struct at all** — e.g. `SourceType` (the frontend log-source union;
     `core::session::SourceType` is deliberately never derived, and every wire field
     carrying it is a plain Rust `String`). Stays hand-written until someone introduces a
     matching Rust type.
   - **Narrowing alias** — `type Foo = Omit<Generated.Foo, 'field'> & { field: 'a' | 'b' }`.
     Needed wherever the Rust field is a plain `String` that is actually a fixed set of
     literals (ts-rs cannot narrow a `String`) — e.g. `AnalysisUpdateEvent.action`,
     `BookmarkUpdateEvent.action`, `WatchUpdateEvent.action`,
     `WorkspaceRestoredEvent.source`, `FilterInfo.status`, `ProcessorSummary.processorType`,
     `DetectorEntry.tier`, `VarMeta.displayAs`. **Delete the alias** the moment the Rust
     side becomes a real enum with its own `#[derive(TS)]` — at that point the narrowing is
     free and the type can move to category 1.

   **Known limitation: narrowing doesn't thread through nested generated types.** A
   narrowed `ProcessorSummary` still resolves `varsMeta: VarMeta[]` to the *generated*
   `VarMeta` (whose `displayAs` is un-narrowed `string | null`), because only the
   top-level `Omit<>` was rewritten. This has caused zero `tsc` fallout so far (comparing
   a wider type against a literal is always legal) but a future exhaustive `switch` on a
   nested narrowed field needs either the Rust field promoted to an enum, or a second
   explicit `Omit<>` at the point of use.

## `T | null` policy

Every `Option<T>` without `#[serde(skip_serializing_if = ...)]` on the Rust side generates
`T | null` — **required and nullable**, not `?: T`. This is deliberately more truthful
than the pre-codegen hand mirrors (many of which wrote `?:` for a field Rust always
serializes, just sometimes as `null`). When this causes `tsc` fallout at a call site
(an object literal that used to omit the key), **fix the call site** — build from an
all-null base object and spread real values in, the way `useFilterScan.ts`'s
`EMPTY_CRITERIA` and `CreateWatchForm.tsx`'s `buildCriteria()` do for `FilterCriteria`.
Never loosen a generated type back to optional to make a caller compile — that's exactly
the kind of drift codegen exists to prevent.

## Events (`events.ts`)

Same StrictMode-safe async-listener pattern for every listener (see root `CLAUDE.md`'s
React StrictMode section — cancelled flag + immediate unlisten if cleanup already ran).
Current listeners, one per Tauri event: `onBridgeSessionOpened`, `onBridgeSessionClosed`
(`SessionClosedEvent` — fires for **every** session close now, UI-initiated included, not
just bridge-initiated), `onBookmarkUpdate`, `onAnalysisUpdate`, **`onWatchUpdate`**
(`watch-update`, `action: 'created' | 'cancelled'`, upsert-by-`watchId` — fixes a
pre-existing gap where an agent-created watch was invisible to the Watches panel; the
UI-created path had the same gap and is fixed by the same listener), **`onActivity`**
(`activity`, one `ActivityEntry` per journaled mutation from *either* transport — see
`useActivityFeed` for the consumer pattern: fetch `getActivity(200)` once, then append by
`id`, bounded client-side to 200 even though the backend ring holds 500),
`onWorkspaceRestored` (`WorkspaceRestoredEvent`, `source: 'lts' | 'workspace'`),
`onWorkspaceAutoSaved` (`WorkspaceAutoSavedEvent`), **`onChainUpdate`** (`chain-update`,
`ChainUpdateEvent` — the WHOLE new chain, `activeProcessorIds` disabled members included,
plus `caller`; not emitted for a no-op write), **`onPipelineComplete`** (`pipeline-complete`,
`PipelineCompleteEvent` — once per run from either caller, exactly one of `result`/`error`
non-null, a cancel is `result` with empty `summaries`), **`onCatalogUpdate`** (`catalog-update`,
`CatalogUpdateEvent`, `action: 'install' | 'uninstall' | 'update'`, from either caller — the
Solid app's single refresh path for both the analyzer catalog and the packs store's
installed set), plus the pipeline/search/filter/index progress listeners and the ADB stream
listeners.

## Chain resolution is backend-owned

The effective pipeline chain (which processors actually run: requested override, or the
session's active-minus-disabled set, filtered to installed/`@lts-` ids, with
`__pii_anonymizer` force-included when anonymization applies) is resolved once, in Rust
(`services::pipeline::resolve_effective_chain`) — the frontend does **not** recompute it.
The normal run call is:

```ts
await setSessionPipelineMeta(sessionId, chain, disabled);  // push the raw inputs first
const result = await runPipeline(sessionId, null);          // null = "resolve for me"
// result: PipelineRunResult { sessionId, effectiveProcessorIds, summaries }
```

`runPipeline`'s `processorIds` argument is `string[] | null`, and its `anonymize` argument
is gone (the backend decides via `services::policy::should_anonymize`). **Push
`setSessionPipelineMeta` immediately before every run, not only on the override path** —
`usePipelineWiring` debounces its own push by 500ms, and editing the chain then hitting Run
inside that window would otherwise resolve against the *previous* chain server-side. The
extra IPC round trip is the cost of closing that race. `setSessionPipelineMeta` goes through
`services::chain::set` (the same function the bridge's `PUT /mcp/sessions/{id}/chain` calls):
an unchanged chain is a no-op, a changed one emits `chain-update` (with `caller: { kind: 'ui' }`,
so a listener can ignore its own echo), schedules an autosave, and journals `chain.update` when
membership or enablement changed.

An empty effective chain is not an error — `resolve_effective_chain` returns
`InvalidArg("no pipeline chain configured for session {id}")`, which the frontend matches
by substring and treats as a silent no-op (`run:stopped`, not `run:failed`) so disabling
every processor and pressing Run doesn't paint a red banner.
