# processors/ — YAML-Defined Processor System

## Processor types

The unified registry uses `AnyProcessor { meta: ProcessorMeta, kind: ProcessorKind }`, stored in `AppState::processors`. The `type:` YAML field dispatches to the correct schema; **omitting it defaults to `reporter`.** Five processor kinds exist in sub-directories:

- `reporter/` — filter → extract → Rhai script → aggregate → output (the most complex type)
- `transformer/` — line mutation (field replace/add/set/drop) or `builtin: pii_anonymizer`
- `state_tracker/` — state machine with typed fields and transitions
- `correlator/` — cross-source event correlation with time/line windows

Built-in processors have IDs starting with `__` (e.g. `__pii_anonymizer`), are loaded via `include_str!`, and cannot be uninstalled.

This file covers the **reporter** subsystem in detail. Other types are documented in their respective sub-directories.

## Layered pipeline execution

Both `run_pipeline` (file mode) and `flush_batch` (streaming) follow the same model:

```
Raw lines ─► Pre-filter (tag union, Aho-Corasick, RegexSet) ─► skip unneeded lines
    │
    ▼ Parse (only lines that pass pre-filter) → LineContext
    │
    ▼ Layer 1: Transformers (sequential per line)
    │   Modifies message/fields; may drop line (returns None)
    ▼ Layer 2a/2b/2c: rayon::scope — one task per processor, each iterates all lines
    │   2a: StateTrackers — records StateTransitions
    │   2b: Reporters — Filter / Extract / Script / Aggregate
    │   2c: Correlators — cross-source event matching
```

**Pre-filter:** `quick_extract_tag()` + Aho-Corasick/RegexSet check whether any Layer 2 processor could match. `collect_prefilter_info()` builds the descriptor from reporter, tracker, and correlator defs only — transformers are excluded by its signature, deliberately. An unfiltered processor sets `has_tag_unfiltered` or `has_content_unfiltered`, which switches off the matching pre-filter stage for the whole run. Transformers are nonetheless subject to declared `source_types` enforcement; see the root `CLAUDE.md` for why that distinction is safety-critical.

**Parser dispatch:** `parser_for(&source_type)` selects the correct parser (Logcat, Kernel, Bugreport) based on the session's detected source type.

## YAML schema

The canonical reference for the reporter schema is the sample YAML in schema tests and `claude/generator.rs:GENERATOR_SYSTEM_PROMPT`. When debugging parse errors, check `reporter/schema.rs` for serde tag/rename annotations — mismatches silently produce 0 matches.

## Storage — disk-persisted

Installed processors are saved to `{app_data_dir}/processors/{id}.yaml` and loaded on startup in `lib.rs`. Pipeline results (`AppState::pipeline_results`) are in-memory only; a new `run_pipeline` call replaces previous results for the same sessionId.

## Registry flow

`registry.rs` fetches a registry JSON, downloads processor YAML, verifies SHA-256 (skipped if empty — dev mode), then calls `validate_for_install()` and installs to AppState + disk.

## Filter rule evaluation

All `FilterRule` entries in a filter stage are **AND**-ed. Any `false` return exits `process_line` immediately (no extraction, no script, no emission). To OR multiple patterns, use a single `message_regex` with `pattern: "foo|bar"` or `message_contains_any`.

## YAML authoring gotchas

- `validate_for_install()` only validates Rhai syntax — invalid filter regexes pass install but silently produce 0 matches at runtime.
- The state tracker engine fires the **first matching transition only** per line, in YAML order. Most-specific patterns must come first.
