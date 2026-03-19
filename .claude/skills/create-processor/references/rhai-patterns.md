# Rhai Scripting Patterns for LogTapper Processors

## Table of Contents

1. [Scope and Available Data](#scope)
2. [Emitting Data](#emitting)
3. [Field Access Patterns](#fields)
4. [Variable Patterns](#vars)
5. [Map Operations](#maps)
6. [Type System](#types)
7. [History Access](#history)
8. [Common Patterns](#patterns)
9. [Gotchas and Pitfalls](#gotchas)
10. [Engine Limits](#limits)

---

## Scope and Available Data {#scope}

Every script invocation receives four scope variables:

### `line` (read-only map)

| Field | Type | Description |
|---|---|---|
| `raw` | string | Full raw log line text |
| `timestamp` | i64 | Nanoseconds since 2000-01-01 UTC |
| `level` | string | "V", "D", "I", "W", "E", or "F" |
| `tag` | string | Log tag (e.g., "WifiStateMachine") |
| `pid` | i64 | Process ID |
| `tid` | i64 | Thread ID |
| `message` | string | Message portion after tag |
| `source_id` | string | Session identifier |
| `source_type` | string | "logcat", "bugreport", or "kernel" |
| `section` | string | Bugreport section name, or "" |
| `line_number` | i64 | 0-indexed position in source |
| `is_streaming` | bool | Whether processing live ADB stream |
| `source_name` | string | Human-readable source name |

### `fields` (read/write map)

Populated by the extract stage. Keys are field names from extract declarations. **Not all fields are guaranteed to exist** — if a regex doesn't match a line, its field is absent.

**Scripts can enrich `fields` with computed values.** New or changed fields are merged back into the pipeline after script execution, making them visible to downstream stages (Aggregate, Output). This is the correct way to set computed grouping keys:

```rhai
// Compute a burst key from multiple extracted fields
fields.burst_key = fields.service + ":" + fields.exception;
```

The enrichment is per-line — each line starts fresh from the Extract stage output.

### `vars` (read/write map)

Declared in the processor YAML `vars:` section. Persists across all lines in the pipeline run. Only declared variables can be written — writes to undeclared names are silently ignored.

### `_emits` (push-only array)

Cleared before each line. Push Rhai map literals to emit structured data.

---

## Emitting Data {#emitting}

```rhai
// CORRECT — push a map literal to _emits
_emits.push(#{
    fd_count: fd,
    fd_state: "critical",
    heap_pct: 85,
});

// WRONG — emit() does not exist. Compiles but crashes at runtime.
// All var updates and emissions for this line are lost.
emit(#{ fd_count: fd });
```

If an emission does not include a `timestamp` key, the engine automatically injects `line.timestamp`. If you need a custom timestamp, include it explicitly.

You can push multiple emissions per line:

```rhai
_emits.push(#{ event_type: "start", ts: line.timestamp });
_emits.push(#{ event_type: "metric", value: fields.count });
```

---

## Field Access Patterns {#fields}

Always guard field access — extraction is conditional on regex match:

```rhai
// Single field guard
if "fd_count" in fields {
    let fd = fields.fd_count;
    // safe to use fd
}

// Multiple field guard
if "heap_used" in fields && "heap_max" in fields {
    if fields.heap_max > 0 {
        let pct = (fields.heap_used * 100) / fields.heap_max;
    }
}

// Early return pattern (common)
if !("required_field" in fields) {
    return;
}
let val = fields.required_field;
```

**Never access a field without checking existence first.** Accessing a missing key returns `()` (unit type), and comparing `() > 0` throws a type error that silently aborts the script.

---

## Variable Patterns {#vars}

### Simple counters and peaks

```rhai
vars.event_count += 1;

if value > vars.peak_value {
    vars.peak_value = value;
}
```

### Conditional accumulation

```rhai
if fd > 1000 {
    vars.critical_count += 1;
} else if fd >= 500 {
    vars.elevated_count += 1;
}
```

### String state tracking

```rhai
vars.last_state = "connected";
vars.last_ssid = fields.ssid;
```

### Undeclared variables

Writing to a variable not declared in the YAML `vars:` section is silently ignored. The variable won't appear in `vars` on subsequent lines. Always declare every variable you intend to use.

---

## Map Operations {#maps}

### Key existence

```rhai
// CORRECT
if "mykey" in my_map { ... }

// WRONG — contains_key is NOT registered
if my_map.contains_key("mykey") { ... }  // runtime error
```

### Nested map mutation (copy-modify-writeback)

Rhai maps are value-copied on read. Mutating a map read from `vars` does not update the original — you must write it back:

```rhai
// CORRECT — copy, modify, write back
let dist = vars.state_distribution;
if fd_state in dist {
    dist[fd_state] = dist[fd_state] + 1;
} else {
    dist[fd_state] = 1;
}
vars.state_distribution = dist;

// WRONG — mutation is lost
vars.state_distribution[fd_state] = 1;  // does NOT persist
```

### Building maps from scratch

```rhai
let detail = #{
    app: fields.app_name,
    exception: fields.exception_class,
    count: 1,
};
```

---

## Type System {#types}

### Integer/Float mixing

Rhai has strict type separation. Mixing throws:

```rhai
// WRONG — i64 vs f64 comparison
if vars.count > 5.5 { ... }

// CORRECT — convert
if vars.count.to_float() > 5.5 { ... }
```

### String concatenation with numbers

```rhai
// WRONG — type error
let key = "service_" + vars.count;

// CORRECT — convert to string
let key = "service_" + vars.count.to_string();
```

### Integer division

Integer division truncates (floor division):

```rhai
let pct = (used * 100) / total;  // integer result
```

For float division, convert first:

```rhai
let pct = (used.to_float() * 100.0) / total.to_float();
```

### Boolean values

```rhai
let active = true;
let inactive = false;
if active { ... }
```

### Conditional expressions (ternary-style)

```rhai
let label = if value > 100 { "high" } else { "normal" };
```

---

## History Access {#history}

Two registered functions provide access to preceding lines (up to 1000):

```rhai
// Check how many history entries exist
let count = history_len();

// Get the most recent previous line
if history_len() > 0 {
    let prev = history_get(history_len() - 1);
    // prev.timestamp, prev.level, prev.tag, prev.message, prev.pid, prev.tid
    if prev.tag == "AndroidRuntime" {
        // previous line was from AndroidRuntime
    }
}

// Lookback pattern — search for a recent event
let i = history_len() - 1;
while i >= 0 {
    let h = history_get(i);
    if h.tag == "ActivityManager" && h.message.contains("ANR") {
        // found a recent ANR
        break;
    }
    i -= 1;
}
```

History is lazily populated — if your script never calls `history_len()` or `history_get()`, no history is built (saving memory).

---

## Common Patterns {#patterns}

### Classification with emission

```rhai
if !("value" in fields) { return; }
let v = fields.value;

let state = "normal";
if v > 1000 { state = "critical"; vars.critical_count += 1; }
else if v >= 500 { state = "elevated"; }

if v > vars.peak { vars.peak = v; }

_emits.push(#{ value: v, state: state });
```

### Deduplication guard

```rhai
// Skip if this is the same value as last time
if "value" in fields && fields.value == vars.last_value {
    return;
}
vars.last_value = fields.value;
```

### Burst key derivation

```rhai
// Build a grouping key for burst detection
let key = "";
if "service" in fields {
    key = fields.service;
}
if "exception" in fields {
    key = key + ":" + fields.exception;
}
if key == "" { key = "unknown"; }

_emits.push(#{ burst_key: key, error_type: fields.exception });
```

### Boot spike detection

```rhai
if "sync_num" in fields {
    let sn = fields.sync_num;
    if sn == 1 && vars.baseline == 0 {
        vars.baseline = fields.value;
    } else if sn == 2 && vars.baseline > 0 && vars.spike == 0 {
        let delta = fields.value - vars.baseline;
        if delta > 0 { vars.spike = delta; }
    }
}
```

---

## Gotchas and Pitfalls {#gotchas}

### 1. `emit()` does not exist
Calling `emit(...)` compiles but throws at runtime. Use `_emits.push(#{...})`.

### 2. `contains_key()` does not exist
Use `"key" in map` instead of `map.contains_key("key")`.

### 3. Script errors are silent
Any runtime error (type mismatch, division by zero, missing function) silently skips all var updates and emissions for that line. The processor continues to the next line. The error is counted internally and the first error message is reported in results.

### 4. Unit type comparisons crash
`() > 0` is a type error. This happens when you access a missing field without a guard. Always check `"field" in fields` first.

### 5. Nested map writes don't persist
`vars.my_map["key"] = value` does NOT work. Use the copy-modify-writeback pattern.

### 6. Integer overflow
Rhai uses i64. For very large counters or timestamps, be aware of overflow (unlikely in practice but worth noting for multiplication).

### 7. String methods
Available: `contains()`, `starts_with()`, `ends_with()`, `trim()`, `len()`, `to_upper()`, `to_lower()`, `split()`, `sub_string()`. Check the Rhai docs if unsure about a specific method.

### 8. `package` and reserved keywords in field access
`fields.package` causes a **silent parse error** — the script never compiles, producing 0 emissions with no visible error. Use bracket notation: `fields["package"]`. Same for map literals: `#{ "package": value }` not `#{ package: value }`.

Other reserved words that break dot access: `type`, `fn`, `let`, `if`, `else`, `return`, `true`, `false`, `for`, `while`, `loop`, `break`, `continue`, `in`, `is`, `import`, `export`, `as`, `private`, `static`, `global`, `throw`, `try`, `catch`, `null`, `this`, `print`, `debug`, `switch`, `do`, `const`, `type_of`, `is_def_var`.

**When in doubt, use bracket notation:** `fields["my_field"]` always works.

### 9. `trim()` returns void
`trim()`, `trim_start()`, and `trim_end()` mutate the string **in-place** and return `()` (void). Assigning the result silently stores `()`, and any subsequent method call aborts the script.

```rhai
// WRONG — x becomes () (void), script will crash on next use of x
let x = some_string.trim();

// CORRECT — copy then mutate in place
let x = some_string;
x.trim();
// x is now trimmed
```

### 10. `cast: int` failure falls back to string
If an extracted field has `cast: int` but the regex captures non-numeric text, the value becomes a JSON string instead of 0. Comparisons like `fields.value > 100` will then throw a type error. Ensure your regex capture group only matches digits (`\d+`), or guard with a type check.

### 11. `==` across types is safe
Comparing different types with `==` returns `false` (not a type error). `() == 0` is false. This is safe for equality checks but NOT for ordering — `() > 0` throws.

---

## Engine Limits {#limits}

| Limit | Value |
|---|---|
| Max operations per script | 1,000,000 |
| Max string size | 500,000 chars |
| Max array size | 100,000 elements |
| Max map size | 10,000 entries |
| Max call stack depth | 32 |
| History buffer | 1,000 lines |

Scripts that exceed these limits are terminated mid-execution, and that line's vars/emissions are lost.
