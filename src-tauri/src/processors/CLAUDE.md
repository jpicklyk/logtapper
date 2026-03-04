# processors/ — YAML-Defined Processor System

## Processor types

The unified registry uses `AnyProcessor { meta: ProcessorMeta, kind: ProcessorKind }`. Five processor kinds exist in sub-directories:

- `reporter/` — filter → extract → Rhai script → aggregate → output (the most complex type)
- `transformer/` — line mutation (field replace/add/set/drop) or `builtin: pii_anonymizer`
- `state_tracker/` — state machine with typed fields and transitions
- `correlator/` — cross-source event correlation with time/line windows
- `annotator/` — schema stub only, no engine yet

This file covers the **reporter** subsystem in detail. Other types are documented in their respective sub-directories.

## YAML schema

The canonical reference for the reporter schema is the sample YAML in schema tests and `claude/generator.rs:GENERATOR_SYSTEM_PROMPT`. When debugging parse errors, check `reporter/schema.rs` for serde tag/rename annotations — mismatches silently produce 0 matches.

## Storage — disk-persisted

Installed processors are saved to `{app_data_dir}/processors/{id}.yaml` and loaded on startup in `lib.rs`. Pipeline results (`AppState::pipeline_results`) are in-memory only; a new `run_pipeline` call replaces previous results for the same sessionId.

## Registry flow

`registry.rs` fetches a registry JSON, downloads processor YAML, verifies SHA-256 (skipped if empty — dev mode), then calls `validate_for_install()` and installs to AppState + disk.

## Filter rule evaluation

All `FilterRule` entries in a filter stage are **AND**-ed. Any `false` return exits `process_line` immediately (no extraction, no script, no emission). To OR multiple patterns, use a single `message_regex` with `pattern: "foo|bar"` or `message_contains_any`.
