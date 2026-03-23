# Rhai Scripting Reference for LogTapper Processors

Reporter processors can embed Rhai scripts in the `script` stage. Rhai is a lightweight scripting
language embedded in Rust — it is **not** JavaScript, though it looks superficially similar. Scripts
run once per matching log line, after the filter and extract stages have already selected and parsed
the line.

## Table of Contents

1. [Scope Variables](#1-scope-variables)
2. [The `line` Object](#2-the-line-object)
3. [Emitting Data](#3-emitting-data)
4. [Working with Fields](#4-working-with-fields)
5. [Working with Variables](#5-working-with-variables)
6. [Map Operations](#6-map-operations)
7. [Type System](#7-type-system)
8. [History Access](#8-history-access)
9. [Common Patterns](#9-common-patterns)
10. [Gotchas](#10-gotchas-critical)
11. [Engine Limits](#11-engine-limits)
12. [String Methods Available](#12-string-methods-available)

---

## 1. Scope Variables

Every script execution receives four named bindings:

| Name | Type | Access | Lifecycle |
|---|---|---|---|
| `line` | map | read-only | Refreshed per line |
| `fields` | map | read/write | Refreshed per line (populated by the extract stage) |
| `vars` | map | read/write | Persists across all lines in the run |
| `_emits` | array | push-only | Cleared before each line |

`line` contains the parsed log line. `fields` contains values captured by your `extract` stage
regexes. `vars` is where you accumulate state across lines. `_emits` is how you send data out.

---

## 2. The `line` Object

| Field | Type | Description |
|---|---|---|
| `raw` | string | Full raw log line text as it appeared in the source |
| `timestamp` | i64 | Nanoseconds since 2000-01-01 UTC |
| `level` | string | Log level: `"V"`, `"D"`, `"I"`, `"W"`, `"E"`, or `"F"` |
| `tag` | string | Android log tag |
| `pid` | i64 | Process ID |
| `tid` | i64 | Thread ID |
| `message` | string | Message portion of the log line (after tag) |
| `source_id` | string | Internal session identifier |
| `source_type` | string | `"logcat"`, `"bugreport"`, or `"kernel"` |
| `section` | string | Bugreport section name, or `""` for logcat |
| `line_number` | i64 | 0-indexed position of this line in the source file |
| `is_streaming` | bool | `true` when processing a live ADB stream |
| `source_name` | string | Human-readable name of the log source |

All fields are always present. String fields are never null.

---

## 3. Emitting Data

`_emits.push(#{ key: value, ... })` is the **only** way to produce output from a script.

```rhai
// CORRECT
_emits.push(#{
    event: "crash",
    tag: line.tag,
    pid: line.pid,
});
```

```rhai
// WRONG — emit() does not exist. This compiles but crashes at runtime,
// silently discarding all var updates made earlier in the same script.
emit("crash", line.tag);
```

You may push multiple emissions for a single line:

```rhai
_emits.push(#{ type: "start", tag: line.tag });
_emits.push(#{ type: "count", value: vars.count });
```

If the emission map does not include a `timestamp` key, the engine automatically injects
`line.timestamp` for you.

---

## 4. Working with Fields

`fields` is populated by the `extract` stage. If a capture group did not match, that key will not
exist in the map. Always guard before accessing.

```rhai
// CORRECT — guard before use
if !("duration_ms" in fields) { return; }
let ms = fields.duration_ms;
```

```rhai
// WRONG — fields["duration_ms"] returns () (unit type) when missing.
// Comparing () > 100 throws a type error and silently aborts the script.
if fields.duration_ms > 100 {
    _emits.push(#{ slow: true });
}
```

Scripts can also **enrich** fields with computed values. Enriched fields are visible to downstream
aggregate stages:

```rhai
// Build a composite key that the aggregate stage will group by
if ("service" in fields) && ("exception" in fields) {
    fields.burst_key = fields.service + ":" + fields.exception;
}
```

---

## 5. Working with Variables

Variables are declared in the YAML `vars:` section and are accessible as `vars.<name>`. They persist
across every line processed during the pipeline run.

```yaml
vars:
  count: 0
  peak_ms: 0
  last_tag: ""
```

```rhai
// Counter
vars.count += 1;

// Peak tracking
if "duration_ms" in fields {
    let ms = fields.duration_ms.to_float();
    if ms > vars.peak_ms.to_float() {
        vars.peak_ms = ms;
    }
}

// String state
vars.last_tag = line.tag;
```

Writing to a variable name that was **not** declared in the YAML `vars:` section is silently ignored.
The write appears to succeed but the value is dropped.

---

## 6. Map Operations

### Key existence

```rhai
// CORRECT
if "my_key" in fields { ... }

// WRONG — contains_key is not registered and throws a runtime error
if fields.contains_key("my_key") { ... }
```

### Nested map mutation

Direct mutation of a nested map **does not persist**. You must copy the map, modify the copy, then
write it back.

```rhai
// CORRECT — copy, modify, writeback
let dist = vars.error_dist;
let key = line.tag;
if key in dist {
    dist[key] += 1;
} else {
    dist[key] = 1;
}
vars.error_dist = dist;
```

```rhai
// WRONG — the assignment targets a temporary copy, vars.error_dist is unchanged
vars.error_dist[line.tag] += 1;
```

This applies to any nested map regardless of depth. The writeback pattern is always required.

---

## 7. Type System

Rhai enforces strict type separation. Mixing types in comparisons or arithmetic throws a runtime
error that silently aborts the script.

### Integer and float

```rhai
// WRONG — mixing int and float throws
let ratio = fields.count / 3.0;

// CORRECT — convert first
let ratio = fields.count.to_float() / 3.0;
```

Integer division truncates toward zero. If you need a fractional result, convert before dividing:

```rhai
let pct = (fields.matched.to_float() / fields.total.to_float()) * 100.0;
```

### String and integer

```rhai
// WRONG — string + int throws
let label = "count=" + vars.count;

// CORRECT
let label = "count=" + vars.count.to_string();
```

### Cross-type comparison

`==` across different types is safe (returns `false`). Ordering operators (`>`, `<`, `>=`, `<=`)
across different types throw.

```rhai
// WRONG — () > 0 throws when field is absent
if fields.size > 0 { ... }

// CORRECT
if ("size" in fields) && (fields.size > 0) { ... }
```

---

## 8. History Access

The engine maintains a rolling buffer of the last 1,000 lines that passed the processor's filter.
History is built lazily — no overhead if you never call these functions.

| Function | Return |
|---|---|
| `history_len()` | `i64` — number of lines in the buffer (0–1000) |
| `history_get(i)` | Map or `()` — index 0 is the most recent previous line |

Each history entry map contains: `timestamp`, `level`, `tag`, `message`, `pid`, `tid`.

`history_get(i)` returns `()` (unit type) if `i` is out of bounds — always guard the result.

### Lookback pattern

```rhai
// Look back through recent history for a matching line
let found = false;
let i = 0;
while i < history_len() {
    let entry = history_get(i);
    if entry == () { break; }
    if entry.tag == "ActivityManager" {
        found = true;
        break;
    }
    i += 1;
}

if found {
    _emits.push(#{ preceded_by_am: true, tag: line.tag });
}
```

---

## 9. Common Patterns

### Classification with emission

Inspect a captured field, classify it, update an accumulator variable, and emit.

```rhai
if !("latency_ms" in fields) { return; }

let ms = fields.latency_ms.to_float();
let bucket = if ms < 100.0 { "fast" } else if ms < 500.0 { "ok" } else { "slow" };

vars.count += 1;
if bucket == "slow" { vars.slow_count += 1; }

_emits.push(#{
    bucket: bucket,
    latency_ms: ms,
    tag: line.tag,
    pid: line.pid,
});
```

### Deduplication guard

Skip lines that carry the same value as the previous occurrence.

```rhai
if !("error_code" in fields) { return; }

let code = fields.error_code;
if code == vars.last_error_code { return; }

vars.last_error_code = code;
vars.unique_errors += 1;

_emits.push(#{
    error_code: code,
    tag: line.tag,
    occurrence: vars.unique_errors,
});
```

### Burst key derivation

Build a composite grouping key from multiple fields, then hand it to the `aggregate` stage.

```rhai
if !("service" in fields) { return; }
if !("exception" in fields) { return; }

// Enrich fields so the aggregate stage can group by this key
fields.burst_key = fields.service + "/" + fields.exception;

_emits.push(#{
    burst_key: fields.burst_key,
    pid: line.pid,
    tag: line.tag,
});
```

---

## 10. Gotchas (CRITICAL)

This section collects the most common mistakes. Read it before debugging unexpected zero-emission
behavior.

---

**Gotcha 1 — `emit()` does not exist**

There is no `emit()` function. Calling it compiles without error but crashes at runtime. The entire
script is aborted for that line: no emissions are produced and no `vars` updates made before the
call are saved.

```rhai
// WRONG
emit("event", line.tag);

// CORRECT
_emits.push(#{ event: "event", tag: line.tag });
```

---

**Gotcha 2 — `contains_key()` does not exist**

The `contains_key` method is not registered on maps. Calling it throws a runtime error.

```rhai
// WRONG
if fields.contains_key("duration") { ... }

// CORRECT
if "duration" in fields { ... }
```

---

**Gotcha 3 — Reserved keywords break dot access**

Rhai keywords cannot appear after a dot. Using a field whose name is a reserved word via dot
notation causes a silent parse failure: the script never runs at all, producing 0 emissions with no
error message.

Dangerous field names: `type`, `fn`, `return`, `import`, `export`, `as`, `private`, `static`,
`global`, `package`, `let`, `if`, `else`, `true`, `false`, `for`, `while`, `loop`, `break`,
`continue`, `in`, `is`, `throw`, `try`, `catch`, `null`, `this`, `print`, `debug`, `switch`, `do`,
`const`, `type_of`, `is_def_var`.

```rhai
// WRONG — "type" is a keyword; script silently fails to parse
let t = fields.type;

// CORRECT — use bracket notation
let t = fields["type"];
```

When in doubt, use bracket notation (`fields["name"]`) for any field name extracted from log data.

---

**Gotcha 4 — `trim()` returns unit, not a string**

`String::trim()` in Rhai mutates in place and returns `()`. Assigning its return value gives you
`()`, not the trimmed string.

```rhai
// WRONG — x is ()
let x = raw_value.trim();

// CORRECT — mutate in place, then use the variable
let x = raw_value;
x.trim();
// x is now the trimmed string
```

---

**Gotcha 5 — `cast: int` failure falls back silently**

When an `extract` stage uses `cast: int`, a value that cannot be parsed as an integer falls back to
a string. If your script then does `fields.value > 100`, it throws a type error (string vs. int)
and silently aborts. Ensure your regex capture group only matches digits, or guard the type:

```rhai
if !("value" in fields) { return; }
// If cast may have failed, the value might be a string
let v = fields.value;
if type_of(v) != "i64" { return; }
if v > 100 { _emits.push(#{ high: true }); }
```

---

**Gotcha 6 — Script errors are silent**

A runtime error (type mismatch, missing method, etc.) aborts the script for that line without any
visible warning in the UI. The processor continues to the next line. If you see unexpected zero
emissions, add defensive guards and check for type issues.

---

**Gotcha 7 — Undeclared vars are silently dropped**

Writing to a key in `vars` that was not declared in the YAML `vars:` section is silently ignored.
Always declare every variable you intend to use.

```yaml
# YAML — declare all vars
vars:
  my_counter: 0
  my_state: ""
```

```rhai
// This write is silently dropped if "my_counter" is not in the YAML vars section
vars.my_counter += 1;
```

---

**Gotcha 8 — Unit type comparisons crash**

When a field is absent, `fields["missing"]` returns `()` (Rhai's unit type). Any comparison
operator applied to `()` throws a runtime error.

```rhai
// WRONG — crashes if "size" is absent
if fields.size > 0 { ... }

// CORRECT
if ("size" in fields) && (fields.size > 0) { ... }
```

---

## 11. Engine Limits

| Limit | Value |
|---|---|
| Max operations per script execution | 1,000,000 |
| Max string size | 500,000 characters |
| Max array size | 100,000 elements |
| Max map size | 10,000 entries |
| Max call stack depth | 32 |
| History buffer | 1,000 lines |

Scripts that exceed the operation limit are aborted for that line. No partial output is emitted.

---

## 12. String Methods Available

The following string methods are available in Rhai scripts:

| Method | Description |
|---|---|
| `contains(s)` | Returns `true` if the string contains substring `s` |
| `starts_with(s)` | Returns `true` if the string starts with `s` |
| `ends_with(s)` | Returns `true` if the string ends with `s` |
| `trim()` | Trims whitespace in place (see Gotcha 4 — returns `()`) |
| `len()` | Returns the character count as `i64` |
| `to_upper()` | Returns an uppercase copy |
| `to_lower()` | Returns a lowercase copy |
| `split(sep)` | Returns an array of strings split on `sep` |
| `sub_string(start, len)` | Returns a substring starting at `start` with length `len` |
| `to_string()` | Converts any value to its string representation |
| `to_float()` | Converts an integer to `f64` |

Note: `to_upper()`, `to_lower()`, and `split()` return new values. `trim()` is the exception — it
mutates in place and returns `()`.
