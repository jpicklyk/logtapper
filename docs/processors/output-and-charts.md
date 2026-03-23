# Output Views and Charts Reference

This document covers the `output` stage for reporter processors — how results are displayed in the LogTapper dashboard as views (tables and summaries) and charts (visual data).

## Overview

The `output` stage is the final stage in a reporter processor. It has two sections:

- **`views`** — tabular or summary text display of emissions or vars
- **`charts`** — visual charts rendered in the processor dashboard

Both sections are optional. A processor with no `output` stage still runs and accumulates results; it just does not render anything in the dashboard.

---

## Views

Views render processor results as human-readable panels in the dashboard.

### Table View

Displays emissions as a grid of rows and columns.

```yaml
- stage: output
  views:
    - type: table
      source: emissions
      columns: ["heap_used", "heap_max", "heap_pct", "pressure_state"]
      sort: "heap_pct"        # optional: sort rows by this column
```

| Field | Required | Description |
|---|---|---|
| `type` | yes | `table` |
| `source` | yes | Data source — typically `emissions` |
| `columns` | yes | Ordered list of emission fields to display as columns |
| `sort` | no | Column name to sort rows by (ascending) |

Each row in the table corresponds to one emission. Only fields listed in `columns` are shown; other emission fields are ignored in the display.

### Summary View

Renders a single-line template string interpolated with emission or var values.

```yaml
  views:
    - type: summary
      source: emissions
      template: "Peak heap: {{peak_pct}}%, Total GCs: {{gc_count}}"
```

| Field | Required | Description |
|---|---|---|
| `type` | yes | `summary` |
| `source` | yes | Data source — typically `emissions` |
| `template` | yes | Template string; `{{field_name}}` tokens are replaced with values |

Template tokens reference field names from the last emission (or from vars if `source: vars` is used). Missing fields render as empty string.

---

## Charts

Charts are defined in the `charts` array under the `output` stage. Each chart requires a common set of fields plus type-specific options.

### Common Fields

| Field | Required | Type | Description |
|---|---|---|---|
| `id` | yes | string | Unique identifier for this chart |
| `type` | yes | string | Chart type: `time_series`, `bar`, `histogram` |
| `title` | yes | string | Display title shown above the chart |
| `source` | yes | string | Data source, typically `emissions` |
| `description` | no | string | Tooltip description shown on hover |
| `group_by` | no | string | Group data points by this field |
| `color_by` | no | string | Color data points by this field |
| `stacked` | no | bool | Stack bars or areas (default: `false`) |
| `interactive` | no | bool | Enable hover interactions (default: `false`) |
| `color_scale` | no | string | Named color scale for the chart |

### Time Series

Plots an emission field value against time or line number.

```yaml
charts:
  - id: heap_timeline
    type: time_series
    title: "GC Heap Pressure Over Time"
    source: emissions
    x: { field: timestamp, label: "Time" }
    y: { field: heap_pct, label: "Heap %" }
    timeline: { field: heap_pct, color: "#d29922", label: "GC Heap %" }
```

| Field | Required | Description |
|---|---|---|
| `x` | yes | X-axis configuration: `field` (emission field) and `label` (axis label) |
| `y` | yes | Y-axis configuration: `field` and `label` |
| `timeline` | no | Adds an overlay band to the main session timeline view |

The `timeline` sub-field renders a colored overlay on the session-level timeline at the top of the LogTapper UI. Use it to mark periods of elevated activity (e.g., high heap pressure) so they are visible without opening the processor panel.

### Bar Chart

Displays categorical or grouped counts.

```yaml
charts:
  - id: pressure_distribution
    type: bar
    title: "Pressure State Distribution"
    source: emissions
    x: { field: pressure_state, label: "State" }
    y: { field: pressure_state, label: "Count", aggregation: count }
```

| Field | Required | Description |
|---|---|---|
| `x` | yes | X-axis: `field` and `label` |
| `y` | yes | Y-axis: `field`, `label`, and optional `aggregation` |

The `aggregation` field on the y-axis enables in-chart aggregation before rendering. Supported values:

| Aggregation | Description |
|---|---|
| `count` | Count occurrences of each x value |
| `sum` | Sum the y field values per x group |
| `avg` | Average the y field values per x group |
| `min` | Minimum y value per x group |
| `max` | Maximum y value per x group |

When `aggregation` is omitted, each emission produces one bar segment. Combine with `stacked: true` to stack segments by a `group_by` field.

### Histogram

Bins a continuous emission field into a frequency distribution.

```yaml
charts:
  - id: gc_pause_dist
    type: histogram
    title: "GC Pause Duration Distribution"
    source: emissions
    x: { field: pause_ms, label: "Pause (ms)" }
    bins: 20
    range: [0.0, 500.0]
```

| Field | Required | Description |
|---|---|---|
| `x` | yes | Field to bin and axis label |
| `bins` | no | Number of bins (default determined by renderer) |
| `range` | no | `[min, max]` float pair clamping the histogram range |

---

## Annotations

Add reference lines or shaded regions to any chart to mark thresholds or zones of interest.

```yaml
charts:
  - id: my_chart
    type: time_series
    title: "Heap Pressure"
    source: emissions
    x: { field: timestamp, label: "Time" }
    y: { field: heap_pct, label: "Heap %" }
    annotations:
      - type: line
        value: 85.0
        label: "Critical threshold"
        color: "#e53e3e"
      - type: region
        from: 70.0
        to: 85.0
        label: "Stressed zone"
        color: "#d29922"
        style: "dashed"
```

### Line Annotation

Draws a horizontal reference line at a fixed y-value.

| Field | Required | Description |
|---|---|---|
| `type` | yes | `line` |
| `value` | yes | Y-axis value where the line is drawn |
| `label` | no | Text label displayed alongside the line |
| `color` | no | Hex color string (default: theme foreground) |

### Region Annotation

Shades a horizontal band between two y-values.

| Field | Required | Description |
|---|---|---|
| `type` | yes | `region` |
| `from` | yes | Lower y-axis bound of the shaded region |
| `to` | yes | Upper y-axis bound of the shaded region |
| `label` | no | Text label for the region |
| `color` | no | Hex color string for the shading |
| `style` | no | Border style: `solid` or `dashed` (default: `solid`) |

---

## Variable Display Options

Variables declared in `vars:` can be surfaced directly in the processor dashboard panel without needing a view or chart.

```yaml
vars:
  - name: gc_count
    type: int
    default: 0
    display: true              # show in dashboard
    label: "GC Events"         # display label (auto-generated if omitted)

  - name: pressure_distribution
    type: map
    default: {}
    display: true
    display_as: table          # render map as a two-column table
    columns: ["pressure_state", "count"]
```

| Field | Required | Description |
|---|---|---|
| `display` | no | `true` to show this var in the dashboard panel (default: `false`) |
| `label` | no | Human-readable label. If omitted, the name is auto-converted from `snake_case` to Title Case |
| `display_as` | no | Render mode for complex types. `table` renders a map var as a two-column table |
| `columns` | no | Column headers when `display_as: table` is set |

Scalar vars (`int`, `float`, `string`, `bool`) render as a labeled value. Map vars with `display_as: table` render each key-value pair as a row, with `columns` providing the header labels.

Variable display is evaluated after the pipeline run completes, so the dashboard shows final accumulated values, not per-line intermediates.
