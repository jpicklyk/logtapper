# src-shared/ — Framework-free modules

Everything here is plain TypeScript: no React, no Solid, no JSX. `src-solid/` imports it
through the aliases in `solid.aliases.ts` (mirrored in `tsconfig.json` `paths`, pinned by
`src-solid/aliases.test.ts`); nothing here imports a frontend. ESLint Block 5 enforces
both directions.

These modules were the shared half of the retired React app (`src-next/`). They kept their
unit tests, which run in the normal `npm test` suite.

## Module map

| Dir | Alias | Owns |
|---|---|---|
| `bridge/` | `@bridge` | every `invoke()`/`listen()` wrapper, the IPC type surface (`types.ts`), and `generated/` — ts-rs output, never hand-edited |
| `viewport/` | `@viewport` | the `DataSource` contract, its cache-backed implementation, the fetch scheduler, copy-text, per-session scroll memory |
| `cache/` | `@cache` | `CacheManager` — the bounded LRU line budget — and its per-view handles |
| `filter/` | `@filter` | the `package:/tag:/level:` mini-language: parser, AST, evaluator |
| `bench/` | `@bench` | the viewer benchmark harness the bench gate drives over CDP |
| `utils/` | (none) | `clamp`, sorted-set intersection, path basename/dirname, localStorage helpers, number/size/time formatting, diagnostics |
| `workspace/` | `@workspace` | the pure `.ltw` rules: app-state payload, list reconciliation, restore plans, artifact pairing, restore trust, extra-session import |
| `pipeline/` | `@pipeline` | the default processor chain's localStorage seed |
| `fileinfo/` | `@fileinfo` | bugreport section-tree shaping, section descriptions, reopen-as options, timestamp/duration formatting |
| `processors/` | `@processors` | state-tracker variable grouping and value formatting |
| `analysis/` | `@analysis` | analysis-artifact attribution and the pending-selection handoff |
| `timeline/` | `@timeline` | device-state timeline math: zoom, pan, tick steps |
| `viewer/` | `@viewer` | absolute-line ↔ rendered-index mapping |
| `bookmarks/` | `@bookmarks` | bookmark markdown export |

## Rules

1. **No framework import, in either direction.** Not `react`, not `solid-js`, and never a
   path into `src-solid/`. A module that needs reactivity belongs in the frontend; what
   lives here is the part a second frontend could reuse unchanged.
2. **Barrels are the public API** (CLAUDE.md principle 9). The bottom eight modules in the
   table above are **barrel-only** from `src-solid/`: `from '@workspace'`, never
   `from '@workspace/restorePlan'` — ESLint Block 4 fails the deep path, and
   `solid.aliases.ts`'s `solidBarrelAliases` is the list both it and the test read.
   `@bridge`, `@viewport`, `@cache`, `@filter` and `@bench` keep file-level reach on
   purpose: `@bridge/types` is the IPC type surface with ~100 importers, and
   `@bridge/commands`, `@bridge/events` and `@viewport/copyText` are partial-mocked by
   specifier in tests — a re-exporting barrel would break those mocks.
3. **`bridge/generated/` is machine-written.** `cargo test --test export_bindings`
   (`npm run gen:types`) regenerates it from the Rust types; `TS_RS_EXPORT_DIR` in
   `.cargo/config.toml` points here. `npm run check:types` fails on any diff, so never
   hand-edit a file there — change the Rust struct.
4. **`bridge/commands.ts` and `bridge/events.ts` are the only authorized `invoke()` /
   `listen()` callers** (they carry the ESLint exemption). Everything else, here and in
   `src-solid/`, goes through their wrappers.
