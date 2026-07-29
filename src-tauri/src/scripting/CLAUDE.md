# scripting/ — Rhai Sandbox

## What scripts see

Scripts receive a Rhai scope built once via `bridge.rs:build_scope()` and updated in-place on subsequent lines via `update_scope()`. The `vars` map persists across lines without rebuilding; only `line`, `fields`, and `_emits` are refreshed per invocation. Four variables are always available:

| Variable | Rhai type | Access | Contents |
|---|---|---|---|
| `line` | map | read-only | `raw`, `timestamp` (i64 nanos), `level` (string), `tag`, `pid` (i64), `tid` (i64), `message`, `source_id`, `source_type` (string), `section` (string, "" if none), `line_number` (i64), `is_streaming` (bool), `source_name` (string) |
| `fields` | map | read/write | Capture groups from upstream Extract stages (keys = field names, values = typed per `cast:`). Scripts can add/modify fields; enrichments are merged back into the pipeline FieldVec for downstream stages (Aggregate). |
| `vars` | map | read/write | Processor-declared variables; persists across all lines |
| `history` | array of maps | read-only | Up to 1,000 preceding lines; each map has same keys as `line` |

## How `emit()` works

There is **no native Rhai `emit()` function** registered on the engine. Instead, scripts push to the `_emits` internal scope variable:

```rhai
// Correct way to emit a row:
_emits.push(#{ field1: value1, field2: value2 });
```

After `engine.run_ast_with_scope()` returns, `bridge.rs:drain_emissions()` extracts `_emits` from the scope and converts each map to `HashMap<String, JsonValue>`.

`Emission.line_num` is set to `line.source_line_num` from the enclosing `ProcessorRun::process_line()` call, not from inside the script.

## Safety limits

Limits are set in `engine.rs:ScriptEngine::new()` and enforced at **runtime**. A script exceeding any limit returns an error that propagates through `ProcessorRun::process_line()` as a silent skip.

## AST cache

`ScriptEngine` caches compiled `AST` objects keyed by the raw source string. The cache is unbounded. Because one `ScriptEngine` lives per `ProcessorRun` (which lives for a single pipeline run), the cache is effectively per-run and cleared after `ProcessorRun::finish()`.

## Script validation at install time

`scripting/sandbox.rs:validate_for_install()` compiles the script and checks complexity. This runs when loading YAML via `load_processor_yaml` or `install_from_registry`. It does **not** re-run on every pipeline execution.

## Coupling to `processors/vars.rs`

`bridge.rs` imports `dynamic_to_json` and `VarStore` from `processors/vars.rs`. If the `VarStore` API changes, `bridge.rs` must be updated in tandem.

## Authoring gotchas

- **`emit()` is NOT a registered function.** Use `_emits.push(#{ key: val })` instead. Calling `emit(...)` compiles but throws at runtime, aborting the entire script.
- Map key existence: use `key in map`, not `map.contains_key(key)` — `contains_key` is not registered.
- Nested map mutation: copy → modify → write back (`let m = vars.mymap; m[k] = v; vars.mymap = m`).
- Integer/float mixing throws: use `.to_float()` to convert. `() > 0` is a type error — guard with `if "field" in fields`.
- String concatenation with ints: use `some_int.to_string()`.
- Script runtime errors silently skip **both** var updates and emissions for that line.
