# State Tracker Processors

State trackers model a state machine over log output. Each processor defines a set of typed state fields and a list of transitions. A transition matches a log line, then updates one or more fields with new values. Over time, this produces a timeline showing how state evolved — when battery charging started, when WiFi connected, when a service was enabled or disabled.

State trackers are a good fit for:

- Battery level and charging status
- WiFi and connectivity state
- Audio routing (speaker, earpiece, Bluetooth)
- System service lifecycle (enabled, running, crashed, stopped)
- Radio/modem state

---

## YAML Structure

```yaml
type: state_tracker
id: my-state-tracker
name: "My State Tracker"
version: "1.0.0"
author: "YourName"
description: "What state this tracks and why."
tags: [domain, tags]

group: CategoryName              # UI grouping label

state:
  - name: enabled
    type: bool                   # bool, int, float, string
  - name: current_value
    type: int
    default: 0                   # defaults to null if omitted

transitions:
  - name: Feature Enabled
    filter:
      tag: MyService             # prefix match
      message_contains: "enabled"
    set:
      enabled: true

  - name: Value Updated
    filter:
      tag: MyService
      message_regex: 'value=(\d+)'
    set:
      current_value: $1          # capture group reference

  - name: Feature Disabled
    filter:
      tag: MyService
      message_contains: "disabled"
    set:
      enabled: false
    clear:
      - current_value            # reset to default

output:
  timeline: true                 # emit timeline events
  annotate: true                 # mark matched lines

schema:
  source_types: ["logcat"]
  emissions: []
  mcp:
    summary:
      template: "Tracks MyService state."
      include_vars: []
    signals: []
```

---

## State Fields

The `state:` block declares the fields your tracker maintains.

| Property | Required | Description |
|---|---|---|
| `name` | yes | Field identifier, used in `set:` and `clear:` |
| `type` | yes | `bool`, `int`, `float`, or `string` |
| `default` | no | Initial value; defaults to null if omitted |

All state fields start at their declared default (or null) before any log line is processed. Transitions update fields incrementally — only the fields named in `set:` or `clear:` change when a transition fires.

---

## Transitions

Each transition has:

- `name` — a human-readable label shown in the timeline
- `filter` — one or more filter conditions (all must match; see below)
- `set` — a map of field names to new values
- `clear` _(optional)_ — a list of field names to reset to their default value

**First matching transition wins.** Only one transition fires per log line. If a line matches both transition A and transition B, only A fires (assuming A comes first in the YAML). This means YAML order is significant: put the most specific transitions before general ones.

---

## Transition Filters

All filter fields are optional and AND-ed together. A line must satisfy every field present in the filter.

| Field | Match Type | Example |
|---|---|---|
| `tag` | Prefix match | `tag: WifiStateMachine` matches "WifiStateMachine" and "WifiStateMachine/102" |
| `tag_regex` | Full regex | `tag_regex: 'Wifi.*Machine'` |
| `message_contains` | Substring | `message_contains: "CMD_ENABLE"` |
| `message_contains_any` | Any substring from list | `message_contains_any: ["connected", "associated"]` |
| `message_regex` | Regex with captures | `message_regex: 'ssid=([^\s,]+)'` |
| `level` | Minimum severity level | `level: W` (matches W, E, F) |
| `source_type` | Source type | `source_type: logcat` |
| `section` | Bugreport section | `section: "RADIO LOG"` |

For OR logic between filter values, use `message_contains_any` or a regex alternation (`message_regex: 'foo|bar'`). Multiple separate filter fields are always AND-ed.

> **Note:** `tag` is a prefix match, not an exact match. `tag: BatteryService` matches any log tag that starts with "BatteryService", including "BatteryService" itself and "BatteryService/HAL". If you need an exact match, use `tag_regex: '^BatteryService$'`.

---

## Capture Groups

When `message_regex` or `tag_regex` contains capture groups, you can reference their values in `set:` using `$1`, `$2`, and so on.

```yaml
transitions:
  - name: Value Updated
    filter:
      tag: MyService
      message_regex: 'level=(\d+).*status=(\w+)'
    set:
      level: "$1"
      status: "$2"
```

The captured string is cast to the declared field type. If the field is `type: int`, the value `"$1"` is parsed as an integer. If parsing fails (e.g., the captured text is not a valid number), the field is left unchanged.

---

## The `clear` Directive

Use `clear:` to reset fields back to their declared default (or null if no default was set):

```yaml
transitions:
  - name: Feature Disabled
    filter:
      tag: MyService
      message_contains: "disabled"
    set:
      enabled: false
    clear:
      - current_value
      - last_ssid
```

This is useful when a state field is only meaningful while a condition is active — clearing it on exit makes it obvious in the timeline that the value is no longer valid.

---

## Output Options

```yaml
output:
  timeline: true    # emit a timeline event each time a transition fires
  annotate: true    # mark matched lines in the log viewer
```

Both options default to false if omitted. For most state trackers you want both enabled.

---

## The `group` Field

```yaml
group: Network
```

`group:` is a UI label that groups related state trackers together in the processor panel. Use a broad category like `Network`, `System`, `Radio`, `Audio`, or `Power`. Trackers with the same group value appear together.

---

## Complete Example: Battery State Tracker

The `battery-state` marketplace processor tracks battery level, charging status, and plug source from `BatteryService` log output. It is a good reference for several state tracker patterns: multi-format support, atomic multi-field updates, and transition ordering.

```yaml
type: state_tracker
id: battery-state
name: Battery State
version: 3.1.2
author: LogTapper
description: "Tracks battery level, charging status, and plug source from BatteryService. Each transition captures all fields at once so level + status + plugged are set atomically. Supports Samsung (level:N, status:N, ac:true/false) and AOSP (level=N, status=N, plugged=N) formats."
tags: [battery, power, android]
category: battery
builtin: false

group: System

state:
  - name: level
    type: int
  - name: charging
    type: bool
  - name: plugged
    type: string
  - name: status
    type: string

transitions:
  # ── Samsung format: status=2 + named plug boolean ─────────────────────────
  # Captures level ($1) and sets charging/status/plugged atomically.

  - name: Charging via AC
    filter:
      tag: BatteryService
      message_regex: 'level[=:](\d+).*?status[=:]2[,\s].*?ac:true'
    set:
      level: "$1"
      charging: true
      status: charging
      plugged: ac

  - name: Charging via USB
    filter:
      tag: BatteryService
      message_regex: 'level[=:](\d+).*?status[=:]2[,\s].*?usb:true'
    set:
      level: "$1"
      charging: true
      status: charging
      plugged: usb

  - name: Charging via Wireless
    filter:
      tag: BatteryService
      message_regex: 'level[=:](\d+).*?status[=:]2[,\s].*?wireless:true'
    set:
      level: "$1"
      charging: true
      status: charging
      plugged: wireless

  - name: Charging via Pogo
    filter:
      tag: BatteryService
      message_regex: 'level[=:](\d+).*?status[=:]2[,\s].*?pogo:true'
    set:
      level: "$1"
      charging: true
      status: charging
      plugged: pogo

  # ── AOSP format: status=2 + numeric plugged code ──────────────────────────

  - name: AC Plugged (AOSP)
    filter:
      tag: BatteryService
      message_regex: 'level=(\d+).*?status=2.*?plugged=1[\s,]'
    set:
      level: "$1"
      charging: true
      status: charging
      plugged: ac

  - name: USB Plugged (AOSP)
    filter:
      tag: BatteryService
      message_regex: 'level=(\d+).*?status=2.*?plugged=2[\s,]'
    set:
      level: "$1"
      charging: true
      status: charging
      plugged: usb

  - name: Wireless Charging (AOSP)
    filter:
      tag: BatteryService
      message_regex: 'level=(\d+).*?status=2.*?plugged=4[\s,]'
    set:
      level: "$1"
      charging: true
      status: charging
      plugged: wireless

  # ── Status 3 — Discharging (both formats) ─────────────────────────────────

  - name: Discharging
    filter:
      tag: BatteryService
      message_regex: 'level[=:](\d+).*?status[=:]3[,\s]'
    set:
      level: "$1"
      charging: false
      status: discharging
      plugged: none

  # ── Status 4 — Not Charging (plugged but not charging) ────────────────────

  - name: Not Charging
    filter:
      tag: BatteryService
      message_regex: 'level[=:](\d+).*?status[=:]4[,\s]'
    set:
      level: "$1"
      charging: false
      status: not_charging
      plugged: none

  # ── Status 5 — Full ───────────────────────────────────────────────────────

  - name: Battery Full
    filter:
      tag: BatteryService
      message_regex: 'level[=:](\d+).*?status[=:]5[,\s]'
    set:
      level: "$1"
      charging: false
      status: full

  # ── Level-only fallback (level present but no recognized status) ──────────

  - name: Battery Level
    filter:
      tag: BatteryService
      message_regex: 'level[=:](\d+)'
    set:
      level: "$1"

output:
  timeline: true
  annotate: true

schema:
  source_types: ["logcat", "bugreport"]
  emissions: []
  mcp:
    summary:
      template: "Battery state tracker: monitors level, charging status, and plug source from BatteryService across Samsung and AOSP formats."
      include_vars: []
    signals: []
```

### What this example demonstrates

**Multi-format support.** Samsung devices log battery state using colons (`level:85, status:2, ac:true`) while AOSP uses equals signs and numeric plug codes (`level=85 status=2 plugged=1`). The regex `level[=:](\d+)` handles both separators in a single pattern. The plug source is then detected by checking either a named boolean (`ac:true`) for Samsung or a numeric code (`plugged=1`) for AOSP.

**Atomic multi-field updates.** Each charging transition sets `level`, `charging`, `status`, and `plugged` in a single `set:` block. This means every timeline event reflects a consistent state snapshot — you never see a moment where `charging: true` but `plugged` is still `none` from a previous line.

**Transition ordering from specific to general.** The transitions are arranged in order of decreasing specificity:

1. Samsung AC/USB/Wireless/Pogo charging (status=2 + named boolean) — most specific
2. AOSP AC/USB/Wireless charging (status=2 + numeric plugged code)
3. Discharging (status=3)
4. Not charging (status=4)
5. Full (status=5)
6. Level-only fallback — least specific, catches any remaining BatteryService line with a level value

A line that matches transition 1 never reaches transition 6. This ordering is deliberate.

**The fallback transition.** The final "Battery Level" transition has a minimal filter — just the tag and a level capture. Its purpose is to track level changes reported by lines that don't include a recognized status code. Without it, those lines would be silently ignored. Because it is last, it only fires when no more-specific transition matched.

---

## Ordering Gotcha

The first matching transition wins. If you place a general transition before a specific one, the specific one will never fire.

Consider this incorrect ordering:

```yaml
transitions:
  # WRONG — this fires for ALL BatteryService lines with a level value,
  # including charging lines. The transitions below never fire.
  - name: Battery Level
    filter:
      tag: BatteryService
      message_regex: 'level[=:](\d+)'
    set:
      level: "$1"

  - name: Charging via AC
    filter:
      tag: BatteryService
      message_regex: 'level[=:](\d+).*?status[=:]2[,\s].*?ac:true'
    set:
      level: "$1"
      charging: true
      status: charging
      plugged: ac
```

A line like `level:85, status:2, ac:true` matches both transitions. Because "Battery Level" is listed first, it fires — and the engine moves on to the next log line. "Charging via AC" never fires, so `charging`, `status`, and `plugged` are never updated.

The fix is to put "Battery Level" last, as a catch-all fallback. Specific patterns always belong above general ones.

---

## See Also

- [Filter Reference](filter-reference.md) — complete documentation for all filter fields
- [Reporter Processors](reporter-processors.md) — for counting, extracting, and scripting against log lines
- [Rhai Scripting](rhai-scripting.md) — for reporters that need computed logic beyond simple field matching
