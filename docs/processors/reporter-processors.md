# Reporter Processors

Reporter processors are the most common processor type in LogTapper. They scan log lines, extract structured data, run optional computation, and surface results as dashboard metrics, tables, and charts.

## 1. Overview

Every reporter follows a five-stage pipeline:

```
filter -> extract -> script -> aggregate -> output
```

Not all stages are required. A simple reporter may use only `filter` and `aggregate` to count matching lines. A complex one may run Rhai scripts to compute derived metrics and emit structured events for charting.

Stage summary:

| Stage | Required | Purpose |
|---|---|---|
| filter | No | Select which log lines to process |
| extract | No | Capture regex groups into named fields |
| script | No | Run Rhai per-line logic; update vars; emit data |
| aggregate | No | Summarize emissions (count, group, burst detection) |
| output | No | Define dashboard views and charts |

If no `filter` stage is present, all lines pass through to subsequent stages.

---

## 2. YAML Structure

The following is a fully annotated reporter definition showing every available field.

```yaml
meta:
  id: "my-processor-id"           # kebab-case, unique across all installed processors
  name: "Human Readable Name"
  version: "1.0.0"
  author: "YourName"
  description: "What this processor detects and why it matters."
  tags: [relevant, domain, tags]

# Restrict to specific bugreport sections. Omit entirely for logcat-only processors.
# Lines outside listed sections are skipped before any pipeline stage runs.
sections:
  - "SYSTEM LOG"

vars:
  - name: my_counter
    type: int          # int, float, bool, string, map, list
    default: 0
    display: true      # show this var in the processor dashboard
    label: "Counter Label"

  # Map vars can render as a two-column table in the dashboard:
  - name: my_distribution
    type: map
    default: {}
    display: true
    label: "Distribution"
    display_as: table
    columns: ["key_col", "value_col"]

pipeline:
  - stage: filter
    rules:
      - type: tag_match
        tags: ["MyTag"]
      - type: message_contains
        value: "key phrase"
    # Multiple rules are AND-ed. See filter-reference.md for all rule types.

  - stage: extract
    fields:
      - name: value
        pattern: 'key:\s*(\d+)'   # capture group 1 becomes the field value
        cast: int                   # optional: int or float (default: string)

  - stage: script
    runtime: rhai
    src: |
      # Runs once per matching line. Has access to: line, fields, vars, _emits
      if !("value" in fields) { return; }
      let v = fields.value;
      if v > vars.my_counter { vars.my_counter = v; }
      _emits.push(#{ value: v });

  - stage: aggregate
    type: count           # count, count_by, or burst_detector

  - stage: output
    views:
      - type: table
        source: emissions
        columns: ["value"]
    charts:
      - id: my_chart
        type: time_series
        title: "Values Over Time"
        source: emissions
        x: { field: timestamp, label: "Time" }
        y: { field: value, label: "Value" }

schema:
  source_types: ["logcat"]        # logcat, bugreport, or both
  emissions:
    - name: value
      type: int
      description: "The extracted value"
  mcp:
    summary:
      template: "Peak: {{my_counter}}"
      include_vars: [my_counter]
    signals: []
```

---

## 3. Pipeline Stages Walkthrough

### Filter

The filter stage selects which lines enter the rest of the pipeline. Multiple rules within a single filter stage are AND-ed — a line must satisfy all rules to pass. For OR logic, use `message_contains_any` or a single regex with alternation.

```yaml
- stage: filter
  rules:
    - type: tag_match
      tags: ["ActivityManager"]
    - type: message_contains_any
      values: ["ANR in", "Application Not Responding"]
```

See [Filter Reference](filter-reference.md) for the complete list of rule types including `level_min`, `message_regex`, `source_id_match`, and others.

### Extract

The extract stage maps regex capture groups to named fields. Fields are available in the script stage as `fields.name`.

```yaml
- stage: extract
  fields:
    - name: heap_used
      pattern: '(\d+)MB/\d+MB'
      cast: int
    - name: heap_max
      pattern: '\d+MB/(\d+)MB'
      cast: int
```

Key points:

- `name`: the field name accessible in scripts as `fields.name`
- `pattern`: a regex where capture group 1 becomes the field value
- `cast`: optional. `int` or `float`. If the cast fails (e.g., non-numeric string), the value is stored as a string rather than producing an error or a zero value
- If the pattern does not match the line, the field is not added to `fields` — always guard with `if "fieldname" in fields` before accessing in a script

### Script

The script stage runs a Rhai program once per matching line. It has access to four variables:

- `line`: the raw log line string
- `fields`: a map of values extracted by the extract stage (and any fields the script itself writes)
- `vars`: the processor's persistent state across all lines
- `_emits`: a list; push maps onto it to emit structured data

See [Rhai Scripting Reference](rhai-scripting.md) for the complete language guide.

Critical rules for scripts:

- Use `_emits.push(#{ key: value })` to emit data. Do NOT call `emit()` — it is not registered and will abort the script at runtime.
- Check field existence with `"fieldname" in fields` before accessing. Missing fields cause a runtime error.
- Integer/float mixing throws a type error. Use `.to_float()` to convert when needed.
- Nested map mutation requires copy-modify-writeback: `let m = vars.mymap; m[k] = v; vars.mymap = m;`

The script stage can also enrich `fields` with computed values that downstream stages or chart sources can reference:

```rhai
fields.heap_pct = (fields.heap_used * 100) / fields.heap_max;
```

### Aggregate

The aggregate stage operates on the full set of emissions after all lines are processed. It is optional — if omitted, raw emissions are still available for output views.

See [Section 5](#5-aggregate-stage) for full details on all three aggregate types.

### Output

The output stage defines what appears in the processor dashboard.

```yaml
- stage: output
  views:
    - type: table
      source: emissions        # or: vars
      columns: ["col1", "col2"]
      sort: "col1"             # optional: sort column
  charts:
    - id: unique_chart_id
      type: time_series        # or: bar
      title: "Chart Title"
      source: emissions
      x: { field: timestamp, label: "Time" }
      y: { field: value, label: "Value" }
```

Chart types:

- `time_series`: line chart with time on the x-axis
- `bar`: bar chart grouping emissions by an x-axis field

---

## 4. Variables (`vars:`)

Variables persist the processor's accumulated state across all lines in a run. They are initialized once at the start of a pipeline run and updated by the script stage.

```yaml
vars:
  - name: error_count
    type: int
    default: 0
    display: true
    label: "Total Errors"
```

**Types:** `int`, `float`, `bool`, `string`, `map`, `list`

**Defaults:** If `default` is omitted, the zero-value for the type is used: `0`, `0.0`, `false`, `""`, `{}`, `[]`.

**Display:** Set `display: true` to show the variable in the processor dashboard panel. Without this, the var is available to scripts but invisible to users.

**Label:** A human-readable label shown in the dashboard. Auto-generated from the variable name if omitted (`my_counter` becomes `My Counter`).

**Map display as table:** Add `display_as: table` and `columns: [col1, col2]` to render a map variable as a two-column table. The first column shows map keys, the second shows values.

```yaml
- name: error_by_tag
  type: map
  default: {}
  display: true
  label: "Errors by Tag"
  display_as: table
  columns: ["tag", "count"]
```

---

## 5. Aggregate Stage

Three aggregate types are supported. Any other type fails validation at install time.

### `count`

Counts the total number of emissions.

```yaml
- stage: aggregate
  type: count
```

No additional fields required. The result is surfaced as a summary metric.

### `count_by`

Groups emissions by the value of a named field and counts each group.

```yaml
- stage: aggregate
  type: count_by
  field: category
```

`field` must be a key present in the emitted maps. Lines where the field is absent are excluded from the grouping.

### `burst_detector`

Detects rapid-fire events within a sliding time window. Useful for identifying thread storms, crash loops, or log spam.

```yaml
- stage: aggregate
  type: burst_detector
  field: burst_key      # field to group by
  window_ms: 2000       # time window in milliseconds
  threshold: 20         # minimum events in the window to trigger a burst
```

The `field` value is used as the burst group key. You can compute a composite key in the script stage:

```rhai
fields.burst_key = fields.service + ":" + fields.exception;
```

Bursts are surfaced in the dashboard when the event rate exceeds `threshold` within `window_ms` milliseconds for the same key value.

---

## 6. Section Filtering

When analyzing bugreport files, restrict the processor to relevant sections using the top-level `sections:` key. Lines outside the listed sections are skipped entirely — before the filter stage runs — which keeps the pipeline fast.

```yaml
sections:
  - "SYSTEM LOG"
  - "RADIO LOG"
```

Omit `sections:` entirely for processors that only analyze logcat streams. Adding an incorrect section name silently produces zero matches.

For the list of common bugreport section names, see [Filter Reference — Common Bugreport Section Names](filter-reference.md#common-bugreport-section-names).

---

## 7. Complete Example: GC Pressure Monitor

The following is the exact content of `marketplace/processors/gc_pressure_monitor.yaml`, the GC monitoring processor shipped with LogTapper. It demonstrates all major reporter features working together.

```yaml
meta:
  id: "gc-pressure-monitor"
  name: "GC Pressure Monitor"
  version: "1.1.2"
  author: "LogTapper"
  description: "Tracks ART GC events. Monitors heap used/max and GC duration. Classifies heap pressure as normal (<70%), stressed (70-85%), or critical (>85%). Explicit (system-forced) GCs tracked separately."
  tags: ["gc", "heap", "art", "memory", "android"]
  category: memory

# Only matches logcat entries in the SYSTEM LOG section of bugreports
sections:
  - "SYSTEM LOG"

vars:
  - name: gc_count
    type: int
    default: 0
    display: true
    label: "GC Events"

  - name: explicit_gc_count
    type: int
    default: 0
    display: true
    label: "Explicit GC Events"

  - name: critical_count
    type: int
    default: 0
    display: true
    label: "Critical Pressure Events (>85%)"

  - name: peak_heap_pct
    type: int
    default: 0
    display: true
    label: "Peak Heap %"

  - name: pressure_distribution
    type: map
    default: {}
    display: true
    label: "Pressure Distribution"
    display_as: table
    columns: ["pressure_state", "count"]

pipeline:
  - stage: filter
    rules:
      - type: tag_match
        tags: ["art"]
      - type: message_contains_any
        values: ["Background concurrent", "Explicit concurrent"]

  - stage: extract
    fields:
      - name: heap_used
        pattern: '(\d+)MB/\d+MB'
        cast: int
      - name: heap_max
        pattern: '\d+MB/(\d+)MB'
        cast: int
      - name: gc_duration_ms_str
        pattern: '(\d+\.\d+)ms'
      - name: is_explicit
        pattern: '(Explicit) concurrent'

  - stage: script
    runtime: rhai
    src: |
      if !("heap_used" in fields) || !("heap_max" in fields) {
        return;
      }
      if fields.heap_max == 0 {
        return;
      }

      vars.gc_count += 1;

      let heap_pct = (fields.heap_used * 100) / fields.heap_max;

      if heap_pct > vars.peak_heap_pct {
        vars.peak_heap_pct = heap_pct;
      }

      let is_explicit = "is_explicit" in fields;
      if is_explicit {
        vars.explicit_gc_count += 1;
      }

      let pressure_state = "normal";
      if is_explicit {
        pressure_state = "explicit_gc";
      } else if heap_pct > 85 {
        pressure_state = "critical";
        vars.critical_count += 1;
      } else if heap_pct >= 70 {
        pressure_state = "stressed";
      }

      let dist = vars.pressure_distribution;
      if pressure_state in dist {
        dist[pressure_state] = dist[pressure_state] + 1;
      } else {
        dist[pressure_state] = 1;
      }
      vars.pressure_distribution = dist;

      _emits.push(#{
        heap_used: fields.heap_used,
        heap_max: fields.heap_max,
        heap_pct: heap_pct,
        pressure_state: pressure_state,
        is_explicit: is_explicit,
      });

  - stage: output
    views:
      - type: table
        source: emissions
        columns: ["heap_used", "heap_max", "heap_pct", "pressure_state"]
        sort: "heap_pct"

    charts:
      - id: gc_heap_timeline
        type: time_series
        title: "GC Heap Pressure Over Time"
        source: emissions
        x: { field: timestamp, label: "Time" }
        y: { field: heap_pct, label: "Heap %" }
        timeline: { field: heap_pct, color: "#d29922", label: "GC Heap %" }

      - id: gc_pressure_bar
        type: bar
        title: "GC Pressure State Distribution"
        source: emissions
        x: { field: pressure_state, label: "Pressure State" }
        y: { field: pressure_state, label: "Count", aggregation: count }

schema:
  source_types: ["logcat"]
  emissions:
    - name: heap_used
      type: int
      description: "Heap memory used in MB at time of GC"
    - name: heap_max
      type: int
      description: "Maximum heap size in MB"
    - name: heap_pct
      type: int
      description: "Heap usage as percentage (0-100)"
    - name: pressure_state
      type: string
      description: "Classified pressure state (normal, stressed, critical, explicit_gc)"
    - name: is_explicit
      type: bool
      description: "Whether the GC was explicitly triggered by the system"
  mcp:
    summary:
      template: "{{gc_count}} GC events. Peak heap: {{peak_heap_pct}}%. Critical (>85%): {{critical_count}}. Explicit GCs: {{explicit_gc_count}}."
      include_vars: [gc_count, peak_heap_pct, critical_count, explicit_gc_count]
    signals:
      - name: critical_gc_pressure
        severity: critical
        condition: "heap_pct >= 85"
        fields: [heap_used, heap_max, heap_pct, pressure_state]
        format: "Critical GC pressure: heap at {{heap_pct}}% ({{heap_used}}MB/{{heap_max}}MB)"
        type: emission
      - name: stressed_gc_pressure
        severity: warning
        condition: "heap_pct >= 70"
        fields: [heap_used, heap_max, heap_pct, pressure_state]
        format: "Stressed GC pressure: heap at {{heap_pct}}% ({{heap_used}}MB/{{heap_max}}MB)"
        type: emission
```

### Annotation: How each section works

**Filter — targeting ART GC events**

```yaml
- stage: filter
  rules:
    - type: tag_match
      tags: ["art"]
    - type: message_contains_any
      values: ["Background concurrent", "Explicit concurrent"]
```

Both rules are AND-ed. Only lines from the `art` tag that also contain one of the two GC message patterns are processed. Using `message_contains_any` for the OR case is correct — two separate `message_contains` rules would require both strings to appear in the same line.

**Extract — capturing heap metrics**

```yaml
- name: heap_used
  pattern: '(\d+)MB/\d+MB'
  cast: int
- name: heap_max
  pattern: '\d+MB/(\d+)MB'
  cast: int
- name: is_explicit
  pattern: '(Explicit) concurrent'
```

`heap_used` and `heap_max` capture the two sides of the `NNNmb/MMMmb` heap format ART emits. The `is_explicit` field is a presence sentinel — the script checks `"is_explicit" in fields` rather than reading its value, because what matters is whether the pattern matched at all.

**Script — classifying pressure and updating state**

The script guards against missing or zero heap data first, then computes `heap_pct` as an integer percentage. Pressure state is classified with explicit GCs taking priority over the numeric thresholds — this is intentional, as an explicit GC at normal heap usage is a separate concern from organic heap pressure.

The `pressure_distribution` map is updated using the copy-modify-writeback pattern required by Rhai:

```rhai
let dist = vars.pressure_distribution;
if pressure_state in dist {
  dist[pressure_state] = dist[pressure_state] + 1;
} else {
  dist[pressure_state] = 1;
}
vars.pressure_distribution = dist;
```

Directly mutating `vars.pressure_distribution[key]` does not work in Rhai — the map must be copied out, modified, and written back.

**Output — table and two charts**

The table sorts by `heap_pct` descending so the worst GC events appear at the top. The time-series chart shows heap pressure over the log's timeline. The bar chart uses `aggregation: count` on the `pressure_state` field to tally how many emissions fell into each pressure category — no separate aggregate stage is needed because the chart itself performs the grouping.

---

## 8. Simple Example: Just Filter + Extract + Count

Not every processor needs a script stage. The following processor counts all error-level log lines. It uses `level_min` to filter, skips extract and script entirely, and uses `count` to aggregate.

```yaml
meta:
  id: "error-counter"
  name: "Error Line Counter"
  version: "1.0.0"
  author: "MyName"
  description: "Counts error-level log lines."
  tags: [errors, basics]

pipeline:
  - stage: filter
    rules:
      - type: level_min
        level: E

  - stage: aggregate
    type: count

schema:
  source_types: ["logcat", "bugreport"]
  emissions: []
  mcp:
    summary:
      template: "Total error lines counted."
      include_vars: []
    signals: []
```

This is the minimal viable reporter pattern. The `level_min: E` rule matches lines at level Error or above (E, F, WTF). No vars are needed because the count aggregate maintains its own total. The `schema.emissions` array is empty because no `_emits.push` calls are made.

To extend this into a `count_by` variant that breaks down errors by tag, add an extract stage and change the aggregate:

```yaml
pipeline:
  - stage: filter
    rules:
      - type: level_min
        level: E

  - stage: extract
    fields:
      - name: tag
        pattern: '^[A-Z]\s+(\S+)\s*:'   # logcat tag column

  - stage: aggregate
    type: count_by
    field: tag
```

---

## Related References

- [Filter Reference](filter-reference.md) — all filter rule types, level values, and bugreport section names
- [Rhai Scripting Reference](rhai-scripting.md) — language guide, built-in variables, common patterns, and gotchas
