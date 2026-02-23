# processors/ — YAML-Defined Processor System

## Processor types

The unified registry uses `AnyProcessor { meta: ProcessorMeta, kind: ProcessorKind }`. Five processor kinds exist in sub-directories:

- `reporter/` — filter → extract → Rhai script → aggregate → output (the most complex type)
- `transformer/` — line mutation (field replace/add/set/drop) or `builtin: pii_anonymizer`
- `state_tracker/` — state machine with typed fields and transitions
- `correlator/` — cross-source event correlation with time/line windows
- `annotator/` — schema stub only, no engine yet

This file covers the **reporter** subsystem in detail. Other types are documented in their respective sub-directories.

## YAML schema (`reporter/schema.rs`) — critical serde annotations

These annotations are the most common source of parse errors:

```
PipelineStage  →  #[serde(tag = "stage", rename_all = "lowercase")]
                  stage: filter | extract | script | aggregate | correlate | output

FilterRule     →  #[serde(tag = "type", rename_all = "snake_case")]
                  type: tag_match | message_contains | message_contains_any
                       | message_regex | level_min | time_range

VarDecl.var_type → #[serde(rename = "type")]
                   type: int | float | bool | string | map | list

VarDecl.display_as → #[serde(rename_all = "lowercase")]
                      display_as: table | value
```

The sample YAML in schema tests and the full schema in `claude/generator.rs:GENERATOR_SYSTEM_PROMPT` are the canonical references.

## ProcessorRun lifecycle (`reporter/engine.rs`)

```
ProcessorRun::new(def)        — creates VarStore from def.vars defaults; no Rhai engine yet
ProcessorRun::process_line()  — called once per log line:
  1. Filter stage  — all rules ANDed; any failure short-circuits (returns early)
  2. Extract stage — regex captures stored in per-line `fields` SmallVec<[(String, JsonValue); 4]>
  3. Script stage  — Rhai executes; fields/vars/emissions updated
  4. Aggregate stage — declarative counters (Count, CountBy, BurstDetector, etc.)
  (lines that pass all stages are added to matched_line_nums)
ProcessorRun::finish()        — consumes run, returns RunResult { emissions, vars, matched_line_nums }
```

`ScriptEngine` is created lazily on first Script stage encounter (`script_engine.get_or_insert_with`). One engine per `ProcessorRun`.

## VarStore / Rhai marshaling (`reporter/vars.rs`)

- `VarStore` holds `rhai::Dynamic` values. Type coercion at declaration time maps YAML `VarType` → initial `Dynamic`.
- `to_rhai_map()` — converts VarStore to a Rhai map for script scope (`vars` binding).
- `update_from_rhai()` — merges mutated Rhai map back to VarStore after script execution. Only updates keys that already exist as declarations; unknown keys are silently ignored.
- `to_json()` — converts final VarStore to `HashMap<String, serde_json::Value>` for IPC return.
- `dynamic_to_json()` is also exported for use in `scripting/bridge.rs` (drain_emissions).

## Storage — disk-persisted

Installed processors are saved to `{app_data_dir}/processors/{id}.yaml` and loaded on startup in `lib.rs`. The in-memory registry is `AppState::processors`.

Pipeline results (`AppState::pipeline_results`) are in-memory only. A new `run_pipeline` call replaces previous results for the same sessionId.

## Registry flow (`registry.rs`)

```
fetch_registry(url)  →  HTTP GET → parse Vec<RegistryEntry> JSON
download_processor(entry, client)  →  HTTP GET YAML → verify_sha256 → return yaml string
  verify_sha256:  empty sha256 in entry = skip check (dev/local mode)
  non-empty sha256 = must match SHA-256 of downloaded bytes (hex string)
```

After download: YAML is parsed, Rhai scripts validated via `validate_for_install()`, then installed to AppState and persisted to disk.

## Filter rule evaluation

All `FilterRule` entries in a filter stage are **AND**-ed. Any `false` return exits `process_line` immediately (no extraction, no script, no emission). To OR multiple patterns, use a single `message_regex` with `pattern: "foo|bar"` or `message_contains_any`.
