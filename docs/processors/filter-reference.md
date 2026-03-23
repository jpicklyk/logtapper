# Processor Filter Reference

## Overview

Filters determine which log lines a processor matches. Filter rules are AND-ed — every rule in the list must pass for a line to be processed. For OR logic, use `message_contains_any` with a list of values, or use regex alternation (`foo|bar`) in a `message_regex` rule.

Filters apply at the processor level (reporters, state trackers, correlators) and at the transition level (state trackers). The engine also builds a pre-filter from tag and message rules across all processors to skip lines that cannot match any processor — so adding at least one filterable rule per processor improves performance across the board.

---

## Filter Rule Types

Rules are listed in order of evaluation cost, cheapest first. Where multiple rules apply, put cheaper rules earlier so expensive ones run only on lines that have already passed.

| Rule Type | YAML Key | Performance | Notes |
|---|---|---|---|
| `source_type_is` | `source_type: "logcat"` | Fastest | Enum comparison. Values: `logcat`, `bugreport`, `kernel` |
| `section_is` | `section: "SYSTEM LOG"` | Fast | Exact, case-sensitive match on bugreport section name |
| `level_min` | `level: W` | Fast | Matches the specified level and above. Order: V < D < I < W < E < F |
| `time_range` | `from: "10:00:00"` / `to: "11:00:00"` | Fast | HH:MM:SS or HH:MM:SS.mmm format. Either bound is optional |
| `tag_match` | `tags: ["Watchdog"]` | Fast | Prefix match — `Watchdog` matches `Watchdog` and `Watchdog/102` |
| `tag_regex` | `pattern: 'Wifi.*'` | Medium | Full regex evaluated against the tag field |
| `message_contains` | `value: "FD:"` | Medium | Substring search — faster and safer than regex for fixed strings |
| `message_contains_any` | `values: ["err1", "err2"]` | Medium | OR-semantics: matches if any value is a substring of the message |
| `message_regex` | `pattern: 'FD:\s*(\d+)'` | Slowest | Full regex on the message field. Supports capture groups for extraction |

---

## Performance Guidance

- Order rules cheapest-first: put `source_type`, `section`, `level`, and `tag_match` before any regex rules.
- Prefer `tag_match` over `tag_regex` when a prefix match is sufficient.
- Prefer `message_contains` over `message_regex` for simple fixed-string checks.
- The engine uses Aho-Corasick and RegexSet as a pre-filter to skip lines before they reach individual processors. This pre-filter is active only when every processor has at least one filterable rule (tag or message). A processor with no filterable rules forces the engine to parse every line.
- Use `sections:` at the processor top level to restrict processing to relevant bugreport sections — both for correctness (avoiding false matches in unrelated sections) and for performance (skipping large irrelevant sections entirely).

---

## Reporter Filter Syntax

Reporters use an explicit `stage: filter` step in the pipeline. Each rule has a `type:` field that selects the rule type.

```yaml
pipeline:
  - stage: filter
    rules:
      - type: source_type_is
        source_type: logcat
      - type: level_min
        level: W
      - type: tag_match
        tags: ["MyService", "MyService/BG"]
      - type: message_contains
        value: "key phrase"
      - type: message_regex
        pattern: 'error code:\s*(\d+)'
```

Rules within a single `filter` stage are AND-ed. To express OR logic across multiple conditions, use `message_contains_any`:

```yaml
      - type: message_contains_any
        values: ["FATAL", "ANR in", "Watchdog killing"]
```

---

## State Tracker Filter Syntax

State tracker transitions use a flat filter format — there is no `type:` field. The keys map directly to filter conditions, and `tag` is a prefix match (same semantics as `tag_match`).

```yaml
transitions:
  - name: Connected
    filter:
      tag: WifiStateMachine
      level: I
      message_contains: "connected"

  - name: Disconnected
    filter:
      tag: WifiStateMachine
      message_regex: 'disconnect reason:\s*(\d+)'
```

The engine fires the **first matching transition only** per line, in YAML order. Put the most specific patterns first.

---

## Correlator Filter Syntax

Correlator sources use the same rule-based syntax as reporters — each rule has a `type:` key. Multiple rules within a source are AND-ed.

```yaml
sources:
  - id: request
    filter:
      - type: tag_match
        tags: [ServiceA]
      - type: message_contains
        value: "request id:"

  - id: response
    filter:
      - type: tag_match
        tags: [ServiceA]
      - type: message_regex
        pattern: 'response for id:\s*(\w+)'
```

---

## Invalid Regex Warning

`validate_for_install()` only checks Rhai script syntax. **Invalid regex patterns pass validation silently** and produce 0 matches at runtime — there is no install-time error. Always test patterns against real log lines before deploying a processor.

The Rust `regex` crate does **not** support look-ahead (`(?!...)`) or look-behind assertions. Use alternatives such as capturing groups or post-match Rhai script logic if you need to exclude patterns.

---

## Common Bugreport Section Names

Use the `section_is` filter rule or the top-level `sections:` list to restrict processing to relevant parts of a bugreport file. Section names are extracted from `------ SECTION NAME (...) ------` headers. Matching is exact and case-sensitive.

| Section | Content |
|---|---|
| `"SYSTEM LOG"` | Main logcat output |
| `"RADIO LOG"` | Telephony and radio process logs |
| `"EVENT LOG"` | System event log |
| `"KERNEL LOG"` | Kernel / dmesg output |
| `"DUMPSYS NORMAL"` | Normal-priority dumpsys output |
| `"MEMORY INFO"` | /proc/meminfo and memory stats |
| `"CPU INFO"` | CPU usage and frequency info |
| `"BUILD INFO"` | Build properties and version info |

Restrict to relevant sections at the processor level to avoid false matches and skip irrelevant content:

```yaml
sections:
  - "SYSTEM LOG"
  - "RADIO LOG"
```

This is evaluated before any per-rule filtering and is the cheapest way to narrow scope in bugreport processors.
