# Schema and Signals Reference

## Overview

Every processor can include a `schema:` section. This declares the processor's contract: which log types it handles, what data it emits, and how it integrates with the MCP bridge (which exposes processor insights to AI agents like Claude).

The `schema:` block is not enforced at runtime — it is a documentation and integration contract. It tells consumers (the MCP bridge, dashboards, and AI agents) what to expect from a processor without enforcing it during pipeline execution.

---

## The `schema:` Block

```yaml
schema:
  source_types: ["logcat", "bugreport"]
  emissions:
    - name: heap_pct
      type: int
      description: "Heap usage as percentage (0-100)"
    - name: pressure_state
      type: string
      description: "Classified state: normal, stressed, critical"
  mcp:
    summary:
      template: "{{gc_count}} GC events. Peak: {{peak_heap_pct}}%."
      include_vars: [gc_count, peak_heap_pct]
    signals:
      - name: critical_gc_pressure
        severity: critical
        condition: "heap_pct >= 85"
        fields: [heap_pct, heap_used, heap_max]
        format: "Critical GC pressure: {{heap_pct}}%"
        type: emission
```

---

## `source_types`

Declares which log source types this processor is designed for:

- `"logcat"` — standard logcat output
- `"bugreport"` — bugreport/dumpstate files
- `"kernel"` — kernel/dmesg logs

This is metadata — it does not enforce filtering. Use actual filter rules (`source_type_is`) to restrict processing at runtime.

---

## `emissions`

Declares the fields that the processor emits via `_emits.push(#{...})` in its Rhai script:

| Field | Required | Description |
|---|---|---|
| `name` | yes | Field name — must match keys in emitted maps |
| `type` | yes | `int`, `float`, `string`, or `bool` |
| `description` | no | What this field represents |

This schema is informational — it documents the emission contract for consumers (MCP bridge, dashboards) but is not enforced at runtime.

Example:

```yaml
emissions:
  - name: heap_pct
    type: int
    description: "Heap usage as percentage (0-100)"
  - name: heap_used
    type: int
    description: "Used heap in MB"
  - name: heap_max
    type: int
    description: "Max heap in MB"
  - name: pressure_state
    type: string
    description: "Classified state: normal, stressed, critical"
```

---

## MCP Summary

The `mcp.summary` section defines how the processor reports its results to AI agents via the MCP bridge.

```yaml
mcp:
  summary:
    template: "{{gc_count}} GC events. Peak: {{peak_heap_pct}}%."
    include_vars: [gc_count, peak_heap_pct]
```

- `template` — Mustache-style template using `{{var_name}}` placeholders. Rendered with current var values when an AI agent queries processor results.
- `include_vars` — which accumulated `vars` to include in the MCP context response alongside the rendered summary.

When an AI agent queries processor results through the MCP bridge, the summary template is rendered with the current var values and returned as the processor's top-level description.

---

## Signals

Signals define conditions that should be highlighted — they surface critical findings to both the UI and MCP consumers.

```yaml
signals:
  - name: critical_gc_pressure
    severity: critical
    condition: "heap_pct >= 85"
    fields: [heap_pct, heap_used, heap_max]
    format: "Critical GC pressure: {{heap_pct}}% ({{heap_used}}MB/{{heap_max}}MB)"
    type: emission
```

### Signal fields

| Field | Required | Description |
|---|---|---|
| `name` | yes | Signal identifier |
| `description` | no | What this signal indicates |
| `severity` | no | `critical`, `warning`, or `info` (default: `info`) |
| `condition` | no | Filter expression — only emissions matching this produce the signal |
| `fields` | yes | Which emission fields to include in the signal output |
| `format` | no | Mustache template for display |
| `type` | no | `emission` (per-row, default) or `aggregate` (computed from vars) |

### Condition syntax

Conditions are simple filter expressions evaluated against emission fields:

- Comparison operators: `>`, `>=`, `<`, `<=`, `==`, `!=`
- Boolean operators: `&&`, `||` (with parenthesis grouping)
- Right-hand side: numeric literal (`85`, `0.95`) or quoted string (`'FAIL'`, `"DNS"`)
- A missing field causes the condition to evaluate to false

Examples:

```
heap_pct >= 85
result == 'FAIL' && probe_type == 'DNS'
fd_count > 900
(heap_pct >= 80) || (gc_pause_ms > 500)
```

### Signal types

- `emission` — evaluated per emission row. Use for per-event alerts (e.g., each GC event that exceeds a threshold).
- `aggregate` — evaluated once using accumulated vars. Use for summary-level alerts (e.g., total GC count exceeded a limit over the entire log).

---

## Why Signals Matter

When LogTapper's MCP bridge serves data to AI agents, signals highlight the most important findings. A well-defined signal helps an agent prioritize: a `critical` signal about heap pressure at 95% is more actionable than scrolling through thousands of GC events.

Without signals, an agent receives raw emissions and must determine significance on its own. With signals, the processor author — who understands the domain — encodes that judgment directly into the processor definition.

Use `severity: critical` for conditions that require immediate investigation, `warning` for degraded-but-functional states, and `info` for noteworthy observations that are not necessarily problems.
