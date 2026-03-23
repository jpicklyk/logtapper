# Processor Authoring Guide

Processors are YAML definitions that analyze Android log data in LogTapper. Each processor describes a filter, an extraction or tracking strategy, and an output format. Three processor types exist, each suited to a different analysis pattern: `reporter` processors count, extract, and aggregate matched lines; `state_tracker` processors follow state machines through log transitions; and `correlator` processors match pairs of events across one or more log sources.

## Processor Types

| Type | Use when... | Example |
|------|-------------|---------|
| `reporter` (default) | Count occurrences, extract metrics, detect bursts | GC pressure monitor, exception storm detector |
| `state_tracker` | Track state over time, monitor transitions | Battery state, WiFi state |
| `correlator` | Correlate event A with event B across sources | FD exhaustion causing EBADF errors |

## Quick-Start Example

The following is a minimal, complete reporter that you can paste directly into LogTapper. It counts `AndroidRuntime` crash lines and records the most recent exception class.

```yaml
meta:
  id: "crash-counter"
  name: "Crash Counter"
  version: "1.0.0"
  author: "MyName"
  description: "Counts AndroidRuntime crashes and tracks the most recent exception."
  tags: [crash, stability]

vars:
  - name: crash_count
    type: int
    default: 0
    display: true
    label: "Total Crashes"
  - name: last_exception
    type: string
    default: ""
    display: true
    label: "Last Exception"

pipeline:
  - stage: filter
    rules:
      - type: tag_match
        tags: ["AndroidRuntime"]
      - type: level_min
        level: E

  - stage: extract
    fields:
      - name: exception_class
        pattern: ':\s+([\w.]+Exception)'

  - stage: script
    runtime: rhai
    src: |
      vars.crash_count += 1;
      if "exception_class" in fields {
        vars.last_exception = fields.exception_class;
        _emits.push(#{ exception: fields.exception_class });
      }

  - stage: output
    views:
      - type: table
        source: emissions
        columns: ["exception"]

schema:
  source_types: ["logcat"]
  emissions:
    - name: exception
      type: string
      description: "The exception class name"
  mcp:
    summary:
      template: "{{crash_count}} crashes. Last: {{last_exception}}"
      include_vars: [crash_count, last_exception]
    signals: []
```

## How to Install a Processor

**Paste YAML**
Open the Processors panel, click "+", paste your YAML into the editor, then click Install.

**Load from file**
Open the Processors panel, click Import, and select a `.yaml` file from disk.

**Marketplace**
Open the Processors panel, go to the Marketplace tab, browse available packs, and click Install next to any processor or pack.

## Guide Map

- [Reporter Processors](reporter-processors.md) — filter/extract/script/aggregate pipeline
- [State Tracker Processors](state-tracker-processors.md) — state machines and transitions
- [Correlator Processors](correlator-processors.md) — cross-event correlation
- [Rhai Scripting Reference](rhai-scripting.md) — scope variables, patterns, and gotchas
- [Filter Reference](filter-reference.md) — all filter rule types and performance guidance
- [Output and Charts](output-and-charts.md) — views, charts, and variable display
- [Schema and Signals](schema-and-signals.md) — MCP integration and signal definitions
- [Contributing to the Marketplace](marketplace.md) — publishing processors and packs

## Key Concepts

**Processors run against parsed log lines.** LogTapper parses logcat, bugreport, and kernel log formats into structured `LineContext` objects (tag, level, message, fields). Processors operate on these parsed representations, not raw text.

**Filter rules are AND-ed.** All rules in a `filter` stage must match for a line to proceed. To match any of several patterns, use `message_contains_any: [...]` or regex alternation in a single `message_regex` rule — for example `message_regex: "foo|bar"`.

**Reporter scripts use Rhai, not JavaScript.** The scripting runtime is [Rhai](https://rhai.rs/book/). To emit a data record, push a map onto `_emits`: `_emits.push(#{ key: value })`. Calling `emit(...)` as a function compiles but throws at runtime, aborting the entire script for that line. Check for key existence with `"key" in fields`, not `fields.contains_key("key")`.

**Transformers are built-in only.** The `transformer` processor type (used for PII anonymization and similar pre-processing) is built into LogTapper and cannot be authored in YAML. Only `reporter`, `state_tracker`, and `correlator` are user-authorable types.

**Invalid regex silently produces zero matches.** If a `message_regex` or similar filter pattern contains an invalid regular expression, LogTapper will accept the processor at install time but the filter will never match any line. Always test patterns against known log samples before deploying. Note that look-ahead assertions (`(?!...)`) are not supported — use `message_contains_any` or restructure the pattern if you need exclusion logic.
