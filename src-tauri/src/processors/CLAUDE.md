# processors/ — YAML Schema, Interpreter, Registry

## YAML schema (`schema.rs`) — critical serde annotations

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

The sample YAML in `schema.rs` tests and the full schema in `claude/generator.rs:GENERATOR_SYSTEM_PROMPT` are the canonical references.

## ProcessorRun lifecycle (`interpreter.rs`)

```
ProcessorRun::new(def)        — creates VarStore from def.vars defaults; no Rhai engine yet
ProcessorRun::process_line()  — called once per log line:
  1. Filter stage  — all rules ANDed; any failure short-circuits (returns early)
  2. Extract stage — regex captures stored in per-line `fields` SmallVec<[(String, JsonValue); 4]>
  3. Script stage  — Rhai executes; fields/vars/emissions updated
  4. Aggregate stage — declarative counters (Count, CountBy, etc.)
  (lines that pass all stages are added to matched_line_nums)
ProcessorRun::finish()        — consumes run, returns RunResult { emissions, vars, matched_line_nums }
```

`ScriptEngine` is created lazily on first Script stage encounter (`script_engine.get_or_insert_with`). One engine per `ProcessorRun`.

## VarStore / Rhai marshaling (`vars.rs`)

- `VarStore` holds `rhai::Dynamic` values. Type coercion at declaration time maps YAML `VarType` → initial `Dynamic`.
- `to_rhai_map()` — converts VarStore to a Rhai map for script scope (`vars` binding).
- `update_from_rhai()` — merges mutated Rhai map back to VarStore after script execution. Only updates keys that already exist as declarations; unknown keys are silently ignored.
- `to_json()` — converts final VarStore to `HashMap<String, serde_json::Value>` for IPC return.
- `dynamic_to_json()` is also exported for use in `scripting/bridge.rs` (drain_emissions).

## Storage — in-memory only

Installed processors live exclusively in `AppState::processors` (a `HashMap` in a `Mutex`). There is **no disk persistence**. Processors are lost when the app restarts. This is a known limitation.

Pipeline results (`AppState::pipeline_results`) are also in-memory. Overwriting happens per-session: a new `run_pipeline` call replaces the previous results for the same sessionId.

## Registry flow (`registry.rs`)

```
fetch_registry(url)  →  HTTP GET → parse Vec<RegistryEntry> JSON
download_processor(entry, client)  →  HTTP GET YAML → verify_sha256 → return yaml string
  verify_sha256:  empty sha256 in entry = skip check (dev/local mode)
  non-empty sha256 = must match SHA-256 of downloaded bytes (hex string)
```

After download: `ProcessorDef::from_yaml()` + `validate_for_install()` (Rhai syntax check) before installing to `AppState::processors`.

## Filter rule evaluation

All `FilterRule` entries in a `FilterStage.rules` list are **AND**-ed. Any `false` return exits `process_line` immediately (no extraction, no script, no emission). To OR multiple patterns, use a single `message_regex` with `pattern: "foo|bar"`.
