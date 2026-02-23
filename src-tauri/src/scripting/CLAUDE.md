# scripting/ — Rhai Sandbox

## What scripts see

Scripts receive a Rhai scope built once via `bridge.rs:build_scope()` and updated in-place on subsequent lines via `update_scope()`. The `vars` map persists across lines without rebuilding; only `line`, `fields`, and `_emits` are refreshed per invocation. Four variables are always available:

| Variable | Rhai type | Access | Contents |
|---|---|---|---|
| `line` | map | read-only | `raw`, `timestamp` (i64 nanos), `level` (string), `tag`, `pid` (i64), `tid` (i64), `message`, `source_id` |
| `fields` | map | read-only | Capture groups from upstream Extract stages (keys = field names, values = typed per `cast:`) |
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

Set in `engine.rs:ScriptEngine::new()`:

| Limit | Value |
|---|---|
| Max operations | 1,000,000 |
| Max string size | 50,000 chars |
| Max array size | 100,000 elements |
| Max map size | 10,000 entries |
| Max call levels | 32 |
| Optimization | `Simple` |

These are enforced at **runtime**. A script exceeding a limit returns an error string that propagates through `ProcessorRun::process_line()` as a silent skip (the error is currently discarded).

## AST cache

`ScriptEngine` caches compiled `AST` objects keyed by the raw source string. The cache is unbounded. Because one `ScriptEngine` lives per `ProcessorRun` (which lives for a single pipeline run), the cache is effectively per-run and cleared after `ProcessorRun::finish()`.

## Script validation at install time

`scripting/sandbox.rs:validate_for_install()` compiles the script and checks complexity (≤ 5,000 nodes). This runs when loading YAML via `load_processor_yaml` or `install_from_registry`. It does **not** re-run on every pipeline execution.

## Coupling to `processors/vars.rs`

`bridge.rs` imports `dynamic_to_json` and `VarStore` from `processors/vars.rs`. If the `VarStore` API changes, `bridge.rs` must be updated in tandem.
