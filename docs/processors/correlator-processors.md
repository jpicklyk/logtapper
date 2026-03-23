# Correlator Processors

Correlators detect when event A is followed by (or preceded by) event B within a window. They are designed for causal analysis — for example, "did this FD spike cause that EBADF error?" or "did this network disconnect precede that app crash?"

Unlike reporters, correlators link events across different tags and sources. They define named sources, each with their own filter and extraction rules, and a trigger-based correlation rule that fires when one source event is seen within a configurable window of another.

## YAML Structure

```yaml
type: correlator
id: my-correlator
name: "Event A -> Event B Correlator"
version: "1.0.0"
author: "YourName"
description: "Detects when event A precedes event B."
tags: [domain, tags]

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
      template: "Correlates event A with event B."
      include_vars: []
    signals: []
```

## Sources

Each source defines how to recognize and capture one class of event.

**`id`** — A unique name for this source. Used in the `trigger` field and in emit templates to reference extracted values.

**`filter`** — One or more filter rules that a log line must satisfy to be considered a candidate event for this source. Multiple rules are AND-ed. Uses the same rule-based filter syntax as reporters. See [Filter Reference](filter-reference.md) for the full rule list.

**`extract`** — Optional list of named regex extractions. Each extraction has:
- `name` — the field name, referenced in templates as `{{source_id.field_name}}`
- `pattern` — a regex with one capture group
- `cast` — optional type coercion: `int` or `float`

**`condition`** — An optional Rhai boolean expression evaluated after extraction. Only events where the condition evaluates to `true` participate in correlation. Examples:
- `"count > 100"` — only consider events where the extracted count exceeds 100
- `"result == 'FAIL'"` — only match events with a specific string value

If any extraction referenced in the condition failed to match (field is absent), the expression will throw a runtime error and the event will be skipped. Guard with `if "field" in fields` when extraction may be absent.

## The `correlate` Block

**`trigger`** — The source ID that triggers the correlation check. When a line matches this source, the engine looks back through recent history for matching events from the other sources. The trigger is typically the "effect" event (the error or crash), while the other sources capture the "cause" events.

**`within_lines`** — Lookback window measured in log lines. When the trigger fires, the engine searches back this many lines for matching non-trigger source events. Use for file analysis where line proximity is a reliable proxy for time proximity.

**`within_ms`** — Lookback window measured in milliseconds, using parsed log timestamps. Use for time-based correlation when precise timing matters. Specify only one of `within_lines` or `within_ms`.

**`emit`** — A template string that produces the correlation event message. Uses double-brace syntax: `{{source_id.field_name}}`. All extracted fields from all matched sources are available. See the Template Syntax section below.

**`guidance`** — A human-readable explanation of what this correlation means and how to investigate it. Shown alongside correlation events in the UI and in MCP output. Write this for the developer who will read it during an incident — explain the mechanism, not just the observation.

## Template Syntax

The `emit` field uses double-brace templates:

```
{{source_id.field_name}}   — extracted field from a named source
{{source_id}}              — the source ID itself, rendered as a label
```

Examples:
- `{{event_a.count}}` — the value of the `count` field extracted from `event_a`
- `{{fd_spike.fd_count}}` — the `fd_count` field from the `fd_spike` source
- `{{ebadf_error.operation}}` — the `operation` field from `ebadf_error`

If a field was not extracted (the regex did not match), it renders as an empty string. All fields from all matched sources are available in the template regardless of which source is the trigger.

## Window Sizing

Choosing the right window affects both recall (catching real correlations) and precision (avoiding false positives):

| Setting | When to use |
|---|---|
| `within_lines: 50000` | Typical logcat files with moderate activity (~50k lines/hour) |
| `within_lines: 150000` | High-volume devices or when cause and effect may be far apart |
| `within_ms: 30000` | 30-second window when logs have reliable timestamps |
| `within_ms: 5000` | Tight window when the cause-effect chain is nearly instantaneous |

Larger windows catch more true correlations but also produce more false positives where two unrelated events happen to be near each other. Start conservatively and widen only if real correlations are being missed.

## Complete Example: FD Exhaustion -> EBADF Correlator

The `fd-ebadf-correlator` marketplace processor detects a known Android stability pattern: when `system_server` accumulates too many open file descriptors, the kernel reuses FD numbers, causing other processes' reads and writes to fail with `EBADF`.

```yaml
type: correlator
id: fd-ebadf-correlator
name: "FD Exhaustion → EBADF Correlator"
version: 1.0.1
author: LogTapper
description: >
  Detects when a system_server FD spike (>900 FDs per Watchdog telemetry)
  precedes EBADF errors in other processes — indicating FD recycling as the
  root cause of use-after-close failures. Fires when an EBADF error is seen
  within 150,000 lines of a Watchdog FD spike.
tags: [ebadf, fd, correlator, android, stability]
category: stability

sources:
  - id: fd_spike
    filter:
      - type: tag_match
        tags: [Watchdog]
      - type: message_contains
        value: "FD:"
    extract:
      - name: fd_count
        pattern: 'FD:\s*(\d+)'
        cast: int
      - name: pid
        pattern: 'PID:\s*(\d+)'
        cast: int
    condition: "fd_count > 900"

  - id: ebadf_error
    filter:
      - type: message_contains_any
        values: ["EBADF", "Bad file descriptor"]
      - type: level_min
        level: W
    extract:
      - name: operation
        pattern: '(read|write|close|ioctl|poll|select)\s+(?:failed|error)'
      - name: erring_pid
        pattern: '^\S+\s+(\d+)'
        cast: int

correlate:
  trigger: ebadf_error
  within_lines: 150000
  emit: "FD exhaustion ({{fd_spike.fd_count}} FDs in PID {{fd_spike.pid}}) preceded EBADF {{ebadf_error.operation}} in PID {{ebadf_error.erring_pid}}"
  guidance: >
    system_server's FD count exceeded 900 shortly before an EBADF error appeared
    in another process. This indicates FD recycling: when the FD table fills up,
    the kernel reuses file descriptor numbers that other processes still hold open,
    causing their subsequent reads/writes to fail with EBADF.

    To investigate: look at the fd_spike source line to confirm the FD count at
    the time of the spike, then check the Watchdog FD timeline for which component
    drove the count up. The EBADF site is a symptom — fix the FD leak in
    system_server, not the error handler in the affected process.

output:
  annotate: true

schema:
  source_types: ["logcat"]
  emissions: []
  mcp:
    summary:
      template: "FD-EBADF correlator: detects when system_server FD spikes (>900 FDs) precede EBADF errors, indicating FD recycling as root cause."
      include_vars: []
    signals: []
```

### Walkthrough

**`fd_spike` source** — Filters for lines from the `Watchdog` tag that contain `"FD:"`. Watchdog periodically logs system_server's file descriptor count in a structured format. The extractor pulls out `fd_count` and `pid` as integers. The `condition: "fd_count > 900"` narrows participation to genuine spikes — routine FD counts below this threshold are ignored, reducing false positives.

**`ebadf_error` source** — Matches any line containing `"EBADF"` or `"Bad file descriptor"` at warning level or above. This is intentionally broad: EBADF can surface in many tags and processes. The extractor captures the failing `operation` (read, write, close, etc.) and the `erring_pid` of the affected process.

**Trigger is `ebadf_error`** — The correlation check fires when an EBADF error is seen, not when the FD spike occurs. This is intentional: you want to ask "was there a preceding spike?" at the moment the symptom appears. The engine looks back up to 150,000 lines for a matching `fd_spike` event.

**150,000-line window** — FD exhaustion may accumulate gradually. The spike visible in Watchdog output could precede the resulting errors by a large number of log lines on a busy device. This wide window ensures the causal chain is captured even if other components log heavily between the two events.

**Emit template** — `"FD exhaustion ({{fd_spike.fd_count}} FDs in PID {{fd_spike.pid}}) preceded EBADF {{ebadf_error.operation}} in PID {{ebadf_error.erring_pid}}"` combines fields from both sources into a single actionable message. A developer reading this immediately knows the FD count at the time of the spike, the system_server PID, which operation failed, and which process was affected.

**Guidance** — Explains the FD recycling mechanism and redirects the developer to the correct fix location (the FD leak in system_server) rather than the symptom site (the error handler in the affected process). Good guidance prevents wasted time patching the wrong component.

## When to Use Correlators vs Reporters

**Use a correlator when:**
- You need to link events from different tags or processes
- You are looking for a cause-effect relationship between two distinct event types
- The events you care about are spread across unrelated parts of the log

**Use a reporter when:**
- You are analyzing a single event stream (one tag, one pattern)
- You need Rhai scripting, accumulated variables, or complex aggregation logic
- The signal you want can be detected from a single log line or a sequence in one tag

**Key differences:**

| Capability | Correlator | Reporter |
|---|---|---|
| Links events across tags | Yes | No |
| Rhai scripting | No | Yes |
| Accumulated vars | No | Yes |
| Lookback window | Built-in | Via `history_get()` |
| Multiple sources | Yes | One filter chain |

Correlators are pattern-matching only — filter, extract, condition, and a window check. If you need logic beyond that (counting occurrences, tracking state across lines, emitting computed values), use a reporter. For cases where a reporter needs cross-tag awareness, the `history_get()` scripting function provides a limited form of lookback within a single processor's execution context.
