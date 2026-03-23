---
name: create-processor
description: >
  Create LogTapper processor YAML definitions — reporters, state trackers, and correlators
  for Android log analysis. Use this skill whenever the user wants to create a new processor,
  write a processor YAML, build a log analysis rule, track state from logcat/bugreport,
  detect patterns in logs, correlate events across sources, or add monitoring for an Android
  subsystem. Also use when asked to modify, debug, or fix an existing processor YAML.
---

# Create Processor

You are writing YAML processor definitions for LogTapper, an Android log analysis tool. Processors run against logcat, bugreport/dumpstate, and kernel logs to extract insights, track state, and correlate events.

## Choosing the Right Processor Type

Ask the user what they want to detect. Map their intent to a type:

| User intent | Type | Why |
|---|---|---|
| "Count occurrences", "extract metrics", "detect bursts" | **reporter** | Filter-extract-script-aggregate pipeline; emits structured data |
| "Track state over time", "monitor transitions" | **state_tracker** | State machine with typed fields; produces timeline events |
| "Correlate event A with event B" | **correlator** | Cross-source lookback matching with emit templates |

**Do not create transformers or annotators** — transformers are built-in only (`__pii_anonymizer`), and annotators have no engine yet. If the user asks for one of these, explain the limitation.

## Before Writing YAML

1. **Ask for sample log lines.** You cannot write accurate filters and regex without seeing real data. If the user doesn't provide samples, ask for them or use LogTapper MCP tools (`logtapper_search_with_context`, `logtapper_query`) to find relevant lines in the active session.

2. **Identify the source type.** Is this logcat (live or from bugreport), bugreport-specific (dumpsys sections), or kernel? This determines whether you need `sections:` filtering and which `source_types` to declare in the schema.

3. **Check existing processors and packs.** Search `marketplace/processors/` for similar processors and `marketplace/packs/` for related packs. Reuse proven filter patterns rather than inventing new ones. New processors should typically belong to an existing or new pack.

## Reporter Processors

Reporters follow a pipeline: **filter → extract → script → aggregate → output**. Not all stages are required — simple reporters may skip script and aggregate.

### YAML Structure

```yaml
meta:
  id: "my-processor-id"           # kebab-case, unique
  name: "Human Readable Name"
  version: "1.0.0"
  author: "YourName"
  description: "What this processor detects and why it matters."
  tags: [relevant, domain, tags]

# Restrict to bugreport sections (omit for logcat-only processors)
sections:
  - "SYSTEM LOG"

vars:
  - name: my_counter
    type: int
    default: 0
    display: true
    label: "Counter Label"

pipeline:
  - stage: filter
    rules:
      - type: tag_match
        tags: ["MyTag"]
      - type: message_contains
        value: "key phrase"

  - stage: extract
    fields:
      - name: value
        pattern: 'key:\s*(\d+)'
        cast: int

  - stage: script
    runtime: rhai
    src: |
      if !("value" in fields) { return; }
      let v = fields.value;
      if v > vars.my_counter { vars.my_counter = v; }
      _emits.push(#{ value: v });

  - stage: output
    views:
      - type: table
        source: emissions
        columns: ["value"]

schema:
  source_types: ["logcat"]
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

### Aggregate Stage Options

Three aggregation types are supported:

```yaml
# Count total emissions
- stage: aggregate
  type: count

# Group by a field
- stage: aggregate
  type: count_by
  field: category

# Detect bursts (rapid-fire events in time windows)
- stage: aggregate
  type: burst_detector
  field: burst_key            # field to group by
  window_ms: 2000             # time window
  threshold: 20               # minimum events to trigger
```

Only `count`, `count_by`, and `burst_detector` are supported. Others (`min`, `max`, `avg`, `percentile`, `time_bucket`) will fail validation.

**Computed burst keys:** `burst_detector` reads the grouping `field` from the pipeline fields (extract stage + script enrichments). To use a computed key, set it in the script:
```rhai
fields.burst_key = service + ":" + exception;
```
The enriched field flows to the aggregate stage automatically.

## State Tracker Processors

State trackers model a state machine. Each transition matches a log line and updates typed fields. The first matching transition per line wins (YAML order matters — put specific patterns before general ones).

### YAML Structure

```yaml
type: state_tracker
id: my-state-tracker
name: "My State Tracker"
version: "1.0.0"
author: "YourName"
description: "What state this tracks and why."
tags: [domain, tags]

group: CategoryName                # UI grouping label

state:
  - name: enabled
    type: bool                     # bool, int, float, string
  - name: current_value
    type: int
    default: 0                     # defaults to null if omitted

transitions:
  - name: Feature Enabled
    filter:
      tag: MyService               # prefix match (matches MyService, MyService/123)
      message_contains: "enabled"
    set:
      enabled: true

  - name: Value Updated
    filter:
      tag: MyService
      message_regex: 'value=(\d+)'
    set:
      current_value: $1            # capture group reference

  - name: Feature Disabled
    filter:
      tag: MyService
      message_contains: "disabled"
    set:
      enabled: false
    clear:
      - current_value              # reset to default

output:
  timeline: true                   # emit timeline events
  annotate: true                   # mark matched lines

schema:
  source_types: ["logcat"]
  emissions: []
  mcp:
    summary:
      template: "Tracks MyService state: enabled/disabled and current value."
      include_vars: []
    signals: []
```

### Transition Filter Fields

Each transition filter supports these fields (all optional, AND-ed when multiple are present):

| Field | Match type | Example |
|---|---|---|
| `tag` | Prefix match | `tag: WifiStateMachine` matches "WifiStateMachine" and "WifiStateMachine/102" |
| `tag_regex` | Full regex | `tag_regex: 'Wifi.*Machine'` |
| `message_contains` | Substring | `message_contains: "CMD_ENABLE"` |
| `message_regex` | Regex with captures | `message_regex: 'ssid=([^\s,]+)'` — use `$1` in set |
| `level` | Minimum level | `level: W` (matches W, E, F) |
| `source_type` | Source type | `source_type: logcat` |
| `section` | Bugreport section | `section: "RADIO LOG"` |

### Capture Groups in Set

When a transition filter uses `message_regex` or `tag_regex`, capture groups (`$1`, `$2`, ...) can be used in `set:` values. The captured text is assigned directly — type casting follows the field's declared type.

## Correlator Processors

Correlators detect when event A is followed by (or preceded by) event B within a window. They define named sources, each with their own filter/extract, and a trigger-based correlation rule.

### YAML Structure

```yaml
type: correlator
id: my-correlator
name: "Event A → Event B Correlator"
version: "1.0.0"
author: "YourName"
description: "Detects when event A precedes event B, indicating causal relationship."

sources:
  - id: event_a
    filter:
      - type: tag_match
        tags: [ServiceA]
      - type: message_contains
        value: "threshold exceeded"
    extract:
      - name: count
        pattern: 'count:\s*(\d+)'
        cast: int
    condition: "count > 100"       # optional Rhai boolean expression

  - id: event_b
    filter:
      - type: message_contains_any
        values: ["error X", "failure Y"]
      - type: level_min
        level: E

correlate:
  trigger: event_b                 # which source triggers the check
  within_lines: 50000              # lookback window (lines)
  # within_ms: 30000              # OR lookback window (milliseconds)
  emit: "{{event_a.count}} threshold events preceded {{event_b}} error"
  guidance: >
    Explanation of what this correlation means and how to investigate.

output:
  annotate: true

schema:
  source_types: ["logcat"]
  emissions: []
  mcp:
    summary:
      template: "Correlates event A thresholds with event B errors."
      include_vars: []
    signals: []
```

## Filter Rules Reference

Filters are AND-ed — every rule must pass for a line to match. For OR logic, use `message_contains_any` or `message_regex` with alternation (`foo|bar`).

### Rule Types (ordered by evaluation cost — cheapest first)

| Rule type | YAML | Performance | Notes |
|---|---|---|---|
| `source_type_is` | `source_type: "logcat"` | Fastest | Enum comparison |
| `section_is` | `section: "SYSTEM LOG"` | Fast | String equality on section name |
| `level_min` | `level: W` | Fast | Levels: V, D, I, W, E, F |
| `time_range` | `from: "10:00:00" / to: "11:00:00"` | Fast | HH:MM:SS.mmm format |
| `tag_match` | `tags: ["Watchdog"]` | Fast | Prefix match (sorted binary search) |
| `tag_regex` | `pattern: 'Wifi.*'` | Medium | Full regex on tag field |
| `message_contains` | `value: "FD:"` | Medium | Substring search |
| `message_contains_any` | `values: ["err1", "err2"]` | Medium | OR-semantics substring search |
| `message_regex` | `pattern: 'FD:\s*(\d+)'` | Slowest | Full regex on message field |

**Performance guidance:** Put cheap filters first (source_type, section, level). Use `tag_match` over `tag_regex` when possible. Prefer `message_contains` over `message_regex` for simple substring checks. The pre-filter uses Aho-Corasick and RegexSet to skip lines early — but only if all processors have at least one filterable rule.

### Invalid Regex

`validate_for_install()` only checks Rhai script syntax — **invalid regex patterns pass validation silently** and produce 0 matches at runtime. Always test regex patterns against real log lines before publishing.

## Bugreport Section Filtering

Bugreport (dumpstate) files contain multiple named sections. Use `sections:` at the top level (reporters and state trackers) or `section:` in filter rules to restrict processing to relevant sections.

### Common Section Names

| Section | Content |
|---|---|
| `"SYSTEM LOG"` | Main logcat output (most common) |
| `"RADIO LOG"` | Telephony/radio process logs |
| `"EVENT LOG"` | System event log |
| `"KERNEL LOG"` | Kernel/dmesg output |
| `"DUMPSYS NORMAL"` | Normal-priority dumpsys output (service state dumps) |
| `"MEMORY INFO"` | /proc/meminfo and memory stats |
| `"CPU INFO"` | CPU usage and frequency info |
| `"BUILD INFO"` | Build properties and version info |

Section names are extracted from `------ SECTION NAME (...) ------` headers in bugreport files. The match is exact (case-sensitive).

When a processor declares `sections:`, only lines within those sections are processed. This is both a correctness filter (avoid matching unrelated data) and a performance optimization (skip irrelevant sections entirely).

## Rhai Scripting Guide

Read `references/rhai-patterns.md` for the complete Rhai scripting reference. Key points:

### Scope Variables

| Name | Type | Access | Lifecycle |
|---|---|---|---|
| `line` | map | read-only | Refreshed per line |
| `fields` | map | read-only | Refreshed per line (from extract stage) |
| `vars` | map | read/write | Persists across all lines in the run |
| `_emits` | array | push-only | Cleared before each line |

### Line Object Fields

`line.raw`, `line.timestamp`, `line.level`, `line.tag`, `line.pid`, `line.tid`, `line.message`, `line.source_id`, `line.source_type`, `line.section`, `line.line_number`, `line.is_streaming`, `line.source_name`

### Critical Rules

1. **Use `_emits.push(#{ ... })` to emit data.** There is no `emit()` function — calling it compiles but crashes the script at runtime, losing all var updates and emissions for that line.

2. **`fields` is read/write.** Scripts can enrich `fields` with computed values that flow to downstream stages (e.g., Aggregate). This is the correct way to set a `burst_key` for `burst_detector`:
   ```rhai
   fields.burst_key = service + ":" + exception;
   ```
   New or changed fields are merged into the pipeline after script execution. Extracted fields from the Extract stage are still the starting point — scripts add to them.

3. **Check field existence before access.** Extraction is optional — if the regex doesn't match, the field won't exist. Always guard: `if "field_name" in fields { ... }`

3. **Use `key in map` for existence checks.** `map.contains_key(key)` is NOT registered and will throw a runtime error.

4. **Integer/float mixing throws.** Use `.to_float()` to convert: `if vars.count.to_float() > 5.5 { ... }`

5. **String + int throws.** Use `.to_string()`: `let msg = "count: " + vars.count.to_string();`

6. **Nested map mutation requires copy-modify-writeback:**
   ```rhai
   let m = vars.my_map;
   m["key"] = value;
   vars.my_map = m;
   ```

7. **Script errors are silent.** A runtime error skips all var updates and emissions for that line. The processor continues with the next line. Use `return;` for early exit, not exceptions.

8. **`package` and other reserved keywords break field access.** `fields.package` causes a silent parse error — the script never runs, producing 0 emissions with no error message. Use bracket notation: `fields["package"]`. Same for map literals: `#{ "package": val }`. Other dangerous words: `type`, `fn`, `return`, `import`, `export`, `as`, `private`, `static`, `global`. When in doubt, use bracket notation.

9. **`trim()` returns void, not the trimmed string.** `let x = str.trim()` assigns `()` to `x`, and any subsequent method call on `x` silently aborts the script. Instead, mutate in-place:
   ```rhai
   let x = some_string;  // copy
   x.trim();             // mutates in place
   // x is now trimmed
   ```

10. **`cast: int` failure falls back to string, not 0.** If an extracted value can't parse as int, it becomes a JSON string. Comparisons like `fields.value > 100` will then throw a type error. Guard with type checks or ensure your regex only captures digits.

11. **History access:** `history_len()` returns the count (up to 1000) and `history_get(i)` returns a map with `{ timestamp, level, tag, message, pid, tid }` or `()` if out of bounds.

## Schema and MCP Integration

Every processor should include a `schema:` section declaring its source types, emissions, and MCP integration. This enables the MCP bridge to expose structured insights to external agents.

```yaml
schema:
  source_types: ["logcat", "bugreport"]    # which log types this processor handles
  emissions:
    - name: field_name
      type: int                             # int, float, string, bool
      description: "What this emission field represents"
  mcp:
    summary:
      template: "Peak: {{var_name}}. Count: {{other_var}}."
      include_vars: [var_name, other_var]   # vars to include in MCP context
    signals:
      - name: signal_name
        severity: critical                  # critical, warning, info
        condition: "field_name > threshold" # filter expression on emissions
        fields: [field_name]               # which emission fields to include
        format: "Alert: {{field_name}} exceeded threshold"
        type: emission                      # emission (per-line) or aggregate (from vars)
```

## Marketplace Publishing

Processors are organized into **packs** — logical groupings of related processors that users install as a unit. Every marketplace processor should belong to a pack.

### Step 1: Save the processor YAML

Save to `marketplace/processors/{id}.yaml` (filename uses underscores: `wifi_state.yaml`).

### Step 2: Add the processor to `marketplace/marketplace.json`

Add an entry to the `processors` array:

```json
{
  "id": "my-processor",
  "name": "My Processor",
  "version": "1.0.0",
  "description": "What it does",
  "path": "processors/my_processor.yaml",
  "tags": ["domain", "tags"],
  "sha256": "",
  "category": "network",
  "license": null,
  "processor_type": "reporter",
  "source_types": ["logcat"],
  "deprecated": false
}
```

- `processor_type`: one of `reporter`, `state_tracker`, `correlator`
- `sha256`: leave `""` during development (verification is skipped)
- `category`: should match the pack's category

### Step 3: Create or update a pack manifest

If this processor fits an existing pack in `marketplace/packs/`, add its ID to that pack's `processors` list. Otherwise, create a new pack manifest at `marketplace/packs/{pack-id}.pack.yaml`:

```yaml
name: My Pack Name
version: 1.0.0
description: What this collection of processors analyzes
author: LogTapper
tags: [domain, tags, android]
category: network
processors:
  - my-processor
  - my-other-processor
```

Pack fields:
- `name`, `version`, `description`, `author`, `tags`, `category` — pack metadata
- `processors` — list of bare processor IDs (must match IDs in `marketplace.json` processors array)
- `license`, `repository` — optional
- The pack **id** is derived from the filename (stripping `.pack.yaml`), not stored in the YAML

### Step 4: Add or update the pack in `marketplace/marketplace.json`

Add an entry to the `packs` array (or update `processor_ids` if adding to an existing pack):

```json
{
  "id": "my-pack",
  "name": "My Pack Name",
  "version": "1.0.0",
  "description": "What this collection analyzes",
  "path": "packs/my-pack.pack.yaml",
  "tags": ["domain", "tags"],
  "category": "network",
  "processor_ids": ["my-processor", "my-other-processor"],
  "sha256": ""
}
```

- `processor_ids` must list every ID from the pack manifest's `processors` field
- `id` must match the pack manifest filename (minus `.pack.yaml`)

### Step 5: Build or copy

Rebuild (`npx tauri dev` or `cargo build`) — Tauri copies marketplace resources at build time. Or manually copy to `src-tauri/target/debug/marketplace/`.

### Existing packs

| Pack | Category | Domain |
|------|----------|--------|
| `wifi-diagnostics` | network | WiFi state, disconnects, probes |
| `network-connectivity` | network | Connectivity state, DNS |
| `telephony-suite` | telephony | Cellular, radio, SIM, IMS |
| `stability-monitor` | stability | Crashes, exceptions, kill storms |
| `system-health` | memory | GC, FD, heap, battery, lifecycle |
| `error-analysis` | stability | EBADF errors, FD correlation |

**ID conventions:** Use kebab-case (`wifi-state`, `fd-monitor`). Processor IDs must be unique within a source. Marketplace-installed processors get qualified IDs at install time: `{id}@{source_name}`. Pack manifests reference bare IDs only.

## Validation Checklist

Before delivering a processor YAML, verify:

- [ ] Regex patterns are valid (test against sample lines — invalid regex silently produces 0 matches)
- [ ] Filter rules are ordered cheaply (source_type/section/level before tag before message_regex)
- [ ] Rhai scripts use `_emits.push(#{})` not `emit()`
- [ ] Rhai scripts guard field access with `"field" in fields`
- [ ] State tracker transitions are ordered specific-to-general (first match wins)
- [ ] `sections:` is set for bugreport-aware processors
- [ ] `schema.source_types` matches where the processor actually works
- [ ] Variable types match their usage (int fields don't get string assignments)
- [ ] Aggregate type is one of: count, count_by, burst_detector
