# Log Analyzer — Project Specification

## Overview

A desktop application for parsing, analyzing, and visualizing Android log files. Users load log files (logcat, kernel, radio, bugreport, etc.), select processors that filter and analyze log lines through a pipeline, and view results with interactive charts, tables, and a unified log viewer. An integrated Claude AI assistant helps with analysis and processor authoring.

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Backend / Core Engine | **Rust** | Memory-mapped file I/O, zero-copy parsing, handles 1GB+ files in ~1s. No GC pauses. |
| Scripting Engine | **Rhai** | Sandboxed, Rust-native, no filesystem/network access. Processors with custom logic. |
| Frontend UI | **React + TypeScript** | Virtualized log viewer, interactive charts, streaming Claude responses. |
| Desktop Shell | **Tauri** | Native executable per platform (~10MB), uses OS webview, IPC bridge between Rust and React. |
| Charts | **Recharts** | React-native charting, supports time series, bar, scatter, histogram, heatmap. |
| Virtual Scrolling | **@tanstack/react-virtual** | Renders millions of log lines with only visible rows in the DOM. |
| Claude Integration | **Anthropic TypeScript SDK** (frontend) or **reqwest** (Rust) | Streaming analysis, processor generation. |

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Single native binary (Tauri)                    │
│                                                  │
│  ┌──────────────────────┐  ┌──────────────────┐  │
│  │    Rust Core          │  │  Native Webview  │  │
│  │                       │  │                  │  │
│  │  • Pipeline engine    │  │  React/TS app    │  │
│  │  • Rhai scripting     │  │  served from     │  │
│  │  • Anonymizer         │◄─┤  embedded        │  │
│  │  • File I/O (mmap)    │─►│  static assets   │  │
│  │  • Claude API client  │  │                  │  │
│  │  • Processor registry │  │  • Log viewer    │  │
│  │  • Cross-source index │  │  • Processor UI  │  │
│  │                       │  │  • Chat panel    │  │
│  │  Runs as native       │  │  • Charts        │  │
│  │  process              │  │  • Settings      │  │
│  └──────────────────────┘  └──────────────────┘  │
│           ▲                        ▲              │
│           └──── Tauri IPC ─────────┘              │
│           (JSON commands, events, streaming)      │
└──────────────────────────────────────────────────┘
```

## Project Structure

```
log-analyzer/
  src/                              # React/TypeScript frontend
    components/
      LogViewer.tsx                  # Virtualized log line display
      LogLine.tsx                    # Single log line with highlights
      HighlightedText.tsx            # Inline highlight span renderer
      SearchBar.tsx                  # Search with regex, case, level filters
      ProcessorPanel.tsx             # Processor selection and config
      ProcessorDashboard.tsx         # Results table + charts + log viewer
      ProcessorMarketplace.tsx       # Browse/install from GitHub registry
      ProcessorChart.tsx             # Chart renderer (Recharts wrapper)
      ChatPanel.tsx                  # Claude analysis chat interface
      VarInspector.tsx               # Live variable state display
      ProgressOverlay.tsx            # File processing progress
      SourceSelector.tsx             # Toggle log sources on/off
      SessionManager.tsx             # Load files, manage sessions
    hooks/
      usePipeline.ts                # IPC wrapper for pipeline commands
      useProcessorVars.ts           # Live var polling/subscription
      useClaude.ts                  # Streaming chat state
      useLogViewer.ts               # Scroll, search, view mode state
      useChartData.ts               # Chart data subscription
    bridge/
      commands.ts                   # Typed Tauri invoke wrappers
      events.ts                     # Typed Tauri event listeners
      types.ts                      # Shared TypeScript types matching Rust serde
    App.tsx
    main.tsx

  src-tauri/                        # Rust backend
    src/
      main.rs                       # Tauri bootstrap and command registration
      commands/
        mod.rs
        pipeline.rs                 # run_pipeline, stop_pipeline
        processors.rs               # list, install, uninstall, get_vars
        claude.rs                   # analyze, generate_processor
        files.rs                    # load_log_file, get_lines, search_logs
        charts.rs                   # get_chart_data, subscribe_chart
        session.rs                  # create_session, add_source
      core/
        mod.rs
        parser.rs                   # LogParser trait + implementations
        logcat_parser.rs            # Logcat format parser
        kernel_parser.rs            # dmesg/kmsg parser
        radio_parser.rs             # Radio logcat parser
        bugreport_parser.rs         # Bugreport container splitter
        pipeline.rs                 # Stream pipeline engine
        line.rs                     # LineContext, LineMeta models
        session.rs                  # AnalysisSession, LogSource
        timeline.rs                 # Unified timeline across sources
        index.rs                    # CrossSourceIndex, CrossQuery
      anonymizer/
        mod.rs
        detectors.rs                # PII pattern matchers (email, IP, MAC, etc.)
        mapping.rs                  # Deterministic pseudonymization
      processors/
        mod.rs
        registry.rs                 # GitHub fetch, cache, install, integrity check
        schema.rs                   # YAML definition parsing and validation
        interpreter.rs              # Declarative stage executor (filter, extract, aggregate)
        vars.rs                     # Variable declaration, initialization, type enforcement
      scripting/
        mod.rs
        engine.rs                   # Rhai engine setup, safety limits, AST caching
        bridge.rs                   # LineContext/vars/emit/session bindings to Rhai scope
        sandbox.rs                  # Script validation, complexity limits
      claude/
        mod.rs
        client.rs                   # Anthropic API client, SSE streaming (reqwest)
        analysis.rs                 # Context building, token budgeting, system prompts
        generator.rs                # Processor generation prompts and YAML parsing
      charts/
        mod.rs
        builder.rs                  # ChartData computation from processor state
        aggregation.rs              # Time bucketing, grouping, statistics
    Cargo.toml
    tauri.conf.json

  package.json
  vite.config.ts
  tsconfig.json
```

---

## Core Data Models (Rust)

### Log Line

```rust
/// What the script sees for each log line
#[derive(Clone, serde::Serialize)]
pub struct LineContext {
    pub raw: String,
    pub timestamp: i64,          // Nanos since epoch
    pub level: LogLevel,
    pub tag: String,
    pub pid: i32,
    pub tid: i32,
    pub message: String,
    pub source_id: String,       // Which log source this came from
    pub source_line_num: usize,
    /// Fields extracted by upstream pipeline stages
    pub fields: BTreeMap<String, Dynamic>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
pub enum LogLevel {
    Verbose,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}
```

### Analysis Session (Multi-Source)

```rust
pub struct AnalysisSession {
    pub id: String,
    pub sources: Vec<LogSource>,
    pub timeline: Timeline,
    pub index: CrossSourceIndex,
}

pub struct LogSource {
    pub id: String,
    pub name: String,
    pub source_type: SourceType,
    pub mmap: Mmap,
    pub line_index: Vec<LineOffset>,
    pub line_meta: Vec<LineMeta>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub enum SourceType {
    Logcat,
    Kernel,        // dmesg / kmsg
    Radio,         // radio logcat
    Events,        // event log
    Bugreport,     // Container — splits into sub-sources
    Tombstone,
    ANRTrace,
    Custom { parser_id: String },
}
```

### Unified Timeline

All lines from all sources sorted by timestamp. Processors and the viewer operate against this.

```rust
pub struct Timeline {
    entries: Vec<TimelineEntry>,
    source_to_timeline: HashMap<(String, usize), usize>,
}

#[derive(Clone)]
pub struct TimelineEntry {
    pub source_id: String,
    pub source_line_num: usize,
    pub timestamp: i64,
    pub level: LogLevel,
    pub tag: String,
}
```

### Cross-Source Index

Enables fast cross-source queries from scripts via `session.query(...)`.

```rust
pub struct CrossSourceIndex {
    by_tag: HashMap<String, Vec<usize>>,
    by_pid: HashMap<i32, Vec<usize>>,
    by_source: HashMap<SourceType, Vec<usize>>,
    time_buckets: BTreeMap<i64, Vec<usize>>,
}

pub struct CrossQuery {
    pub from: i64,
    pub to: i64,
    pub sources: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub min_level: Option<LogLevel>,
}
```

---

## PII Anonymizer

Sits early in the pipeline — right after parsing, before any processors. Downstream processors and Claude API calls only ever see anonymized data.

### Design

- **Deterministic pseudonymization**: Same PII value maps to same token within a session (e.g., `user@email.com` → `<EMAIL-1>` everywhere).
- **Session-scoped mappings**: Never persisted to disk. Fresh mappings each session.
- **Reversible mode**: Mapping held in memory only; user can optionally reveal a specific token during analysis.
- **Redact mode**: One-way, mapping discarded immediately.
- **Configurable detectors**: Users toggle which PII categories are active.

### PII Categories

| Category | Prefix | Detection |
|----------|--------|-----------|
| Email | `EMAIL` | `[\w.+-]+@[\w-]+\.[\w.-]+` |
| IPv4 | `IPv4` | `\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b` |
| IPv6 | `IPv6` | Standard IPv6 patterns |
| Phone | `PHONE` | Various phone formats |
| IMEI | `IMEI` | 15-digit patterns |
| Serial Number | `SERIAL` | Device serial patterns |
| MAC Address | `MAC` | `([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}` |
| Android ID | `AID` | 16-char hex patterns |
| Custom | `PII` | User-supplied regex |

### Pipeline Position

```
File → Reader/mmap → Parser → Anonymizer → [Processor 1] → [Processor 2] → ...
```

### Implementation Pattern

```rust
pub struct LogAnonymizer {
    detectors: Vec<Box<dyn PiiDetector>>,
    mappings: ConcurrentHashMap<String, String>,
    counters: ConcurrentHashMap<PiiCategory, AtomicInteger>,
}

pub trait PiiDetector: Send + Sync {
    fn category(&self) -> PiiCategory;
    fn find_all(&self, text: &str) -> Vec<PiiMatch>;
}

pub struct PiiMatch {
    pub range: Range<usize>,
    pub category: PiiCategory,
    pub raw_value: String,
}
```

- Process matches longest-first to avoid partial replacements.
- Deduplicate overlapping matches.
- Pre-screen with fast checks (e.g., skip EmailDetector if line has no `@`).

---

## Processor System

### Two Layers

**Layer 1: Declarative YAML** (~80% of processors) — Rust engine interprets directly. No dynamic code.

**Layer 2: Rhai Scripts** (~20%) — For conditional logic, state machines, custom calculations.

### YAML Schema

```yaml
meta:
  id: "processor-id"               # Unique identifier
  name: "Human Readable Name"
  version: "1.0.0"                 # Semver
  author: "author-name"
  description: "What this processor does"
  tags: ["wifi", "connectivity"]

# Declare which log sources this processor needs
sources:
  required:
    - type: Logcat
      alias: logcat
  optional:
    - type: Kernel
      alias: kernel

# Declare variables the script will use
vars:
  - name: variable_name
    type: int | bool | string | float | map | list
    default: <value>
    display: true|false            # Show in UI dashboard
    label: "UI Label"
    display_as: table|value        # How to render in UI
    columns: [col1, col2]          # For table display
    configurable: true|false       # User can change at runtime
    min: <number>                  # For configurable numeric vars
    max: <number>

pipeline:
  - stage: filter
    source: <alias>                # Optional: only run against this source
    rules:
      - type: tag_match
        tags: ["Tag1", "Tag2"]
      - type: message_contains
        value: "text"
      - type: message_contains_any
        values: ["text1", "text2"]
      - type: message_regex
        pattern: "regex"
      - type: level_min
        level: WARN
      - type: time_range
        from: "HH:MM:SS"
        to: "HH:MM:SS"

  - stage: extract
    fields:
      - name: field_name
        pattern: "regex with (capture group)"
        cast: int | float | string  # Optional type cast

  - stage: correlate
    trigger:
      message_contains: "text"
    lookback:
      max_lines: 50
      extract_from_match:
        tag: "TagName"
        message_contains: "text"
        field: field_name

  - stage: script
    runtime: rhai
    src: |
      // Inline Rhai script
      // Available bindings:
      //   line     — current LineContext (read-only)
      //   fields   — extracted fields from upstream stages (read-only)
      //   vars     — declared variables (read/write, persists across lines)
      //   history  — lookback buffer of recent LineContexts (read-only)
      //   session  — cross-source query API (read-only)
      //   emit(map) — push a result to the output stage
      //   emit_chart("chart_id", map) — push data point to a specific chart

  - stage: aggregate
    groups:
      - type: count | count_by | min | max | avg | percentile | time_bucket
        field: field_name
        group_by: field_name       # Optional
        interval: "5m"             # For time_bucket
        label: "Description"

  - stage: output
    views:
      - type: table
        source: emissions | vars   # What data feeds the table
        columns: [col1, col2, col3]
        sort: column_name
      - type: summary
        source: vars
        template: |
          Template with {{var_name}} interpolation.

    charts:
      - id: chart_id
        type: time_series | bar | scatter | histogram | heatmap | pie | area
        title: "Chart Title"
        description: "Optional description"
        source: emissions | vars.var_name | script  # Where data comes from
        x:
          field: field_name
          label: "X Axis Label"
          bucket: "5m"             # For time_series
        y:
          field: field_name
          aggregation: count       # Alternative to field
          label: "Y Axis Label"
        group_by: field_name
        color_by: field_name       # For scatter
        stacked: true|false        # For bar/area
        bins: 20                   # For histogram
        range: [-100, -30]         # For histogram
        color_scale: "name"        # For heatmap
        interactive: true          # Click-to-jump to log region
        annotations:
          - type: horizontal_line | vertical_line | horizontal_band | vertical_band | point_marker
            value: <number>        # For line types
            from: <number>         # For band types
            to: <number>
            label: "Label"
            style: dashed|solid
            color: "rgba(...)"
```

### Script API — What the Script Author Sees

| Name | Type | Access | Description |
|------|------|--------|-------------|
| `line` | object | read | Current log line: `.tag`, `.message`, `.level`, `.timestamp`, `.pid`, `.tid`, `.source_id` |
| `fields` | map | read | Upstream extracted fields: `fields.ssid`, `fields.rssi`, etc. |
| `vars` | map | read/write | Declared variables — persist across all lines in the processor run |
| `history` | list | read | Recent lines lookback buffer |
| `session` | object | read | Cross-source query: `session.query(#{ from: ts, to: ts, sources: [...], tags: [...] })` |
| `emit(map)` | function | call | Push a result to the output stage |
| `emit_chart(id, map)` | function | call | Push a data point to a specific chart |

### Script Engine Safety (Rhai)

```rust
engine.set_max_operations(1_000_000);   // Prevent infinite loops
engine.set_max_string_size(50_000);     // Prevent memory bombs
engine.set_max_array_size(100_000);
engine.set_max_map_size(10_000);
// Rhai has no filesystem, network, or system access by default
```

### Script Execution Flow

For each log line that passes the filter stage:

1. Rust builds a `Scope` with `line`, `fields`, `history`, `session` as constants and `vars` as mutable.
2. Rhai AST (compiled once, cached) is executed against the scope.
3. Rust reads back mutated `vars` from the scope.
4. Rust collects any `emit()` and `emit_chart()` calls.
5. Line is added to the lookback buffer (capped at configured limit).

---

## Processor Distribution — GitHub Registry

### Repository Structure

```
android-log-processors/
  registry.json
  processors/
    wifi-disconnect-tracker/
      processor.yaml
      README.md
      icon.svg
    anr-root-cause/
      processor.yaml
      README.md
      icon.svg
```

### Registry Index

```json
{
  "version": 2,
  "processors": [
    {
      "id": "wifi-disconnect-tracker",
      "name": "WiFi Disconnect Tracker",
      "version": "1.2.0",
      "path": "processors/wifi-disconnect-tracker/processor.yaml",
      "tags": ["wifi", "connectivity"],
      "sha256": "a1b2c3..."
    }
  ]
}
```

### Security

- **YAML-only processors**: Inherently safe. Validate regex complexity at install time.
- **Rhai scripts**: Sandboxed. Validate at install time with `engine.compile()`. Set execution limits.
- **SHA-256 checksum verification** on every load (not just install).
- **Local cache** at a platform-appropriate location. Re-verify integrity on load.

---

## Claude AI Integration

### Two Use Cases

**1. Analysis** — Feed filtered/anonymized results to Claude for natural language insights.

**2. Processor Generation** — User describes what to find; Claude generates a processor YAML.

### Key Design Points

- All data sent to Claude goes through the anonymizer first (enforced by pipeline position).
- **Context window management**: Use a `ContextBudget` to select representative lines (head + tail + sampled middle), flagged-first, or most recent.
- **Streaming**: Use SSE streaming so the UI shows tokens as they arrive.
- **API key management**: System keychain, not config files.
- **Cost awareness**: Show estimated token count before sending; user confirms.
- **Model**: `claude-sonnet-4-5-20250929` for analysis, adjustable in settings.

### System Prompts

**Analysis prompt**: Explains the tool context, that PII is anonymized with deterministic tokens, and to identify patterns/anomalies/correlations.

**Processor generation prompt**: Explains the YAML schema, available filter/extraction/aggregation types, and instructs Claude to respond with valid YAML only.

---

## Log Viewer

### View Modes

| Mode | Description |
|------|-------------|
| **Full** | Every line, scrollable, searchable |
| **Processor** | Collapsed to only matched lines + configurable context lines. Gap markers show hidden line counts. |
| **Focus** | Centered on a specific line/time with a configurable radius. Triggered by clicking chart points or result rows. |

### Windowed Loading

The Rust backend owns the full dataset. The frontend requests windows via:

```rust
pub struct LineRequest {
    pub mode: ViewMode,
    pub offset: usize,          // Line offset (Full) or match index offset (Processor)
    pub count: usize,           // Viewport capacity
    pub context: usize,         // Context lines above/below matches (Processor mode)
    pub processor_id: Option<String>,
    pub search: Option<SearchQuery>,
}
```

Returns `LineWindow` with:
- `total_lines` — for scrollbar sizing
- `lines: Vec<ViewLine>` — actual lines to render, each with:
  - Line number, text, level, tag, timestamp
  - `matched_by: Vec<String>` — which processors matched
  - `highlights: Vec<HighlightSpan>` — inline highlight spans
  - `is_context: bool` — context line (dimmed) vs direct match

### Highlight Types

| Kind | Visual | Purpose |
|------|--------|---------|
| `Search` | Yellow background | Active search matches |
| `SearchActive` | Orange background | Currently focused search match |
| `ProcessorMatch { id }` | Colored bottom border | Processor's assigned color |
| `ExtractedField { name }` | Underline | Fields that were captured by extract stage |
| `PiiReplaced` | Red-ish background | Anonymized PII tokens |

### Highlight Rendering

Multiple highlights can overlap. The renderer:
1. Collects all boundary points from all highlights.
2. Splits text into non-overlapping segments at boundaries.
3. Tags each segment with which highlights apply.
4. Renders with stacked CSS classes.

### Search

```rust
pub struct SearchQuery {
    pub text: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    pub within_processor: Option<String>,
    pub min_level: Option<LogLevel>,
    pub tags: Option<Vec<String>>,
}
```

Returns `SearchSummary` with total matches, match line numbers (for jump-to navigation), and breakdowns by level and tag for filter chips.

### Processor View — Collapsed with Gap Markers

Adjacent match groups are coalesced when their context lines would overlap. Gap markers between groups show hidden line count and are clickable to expand.

### Multi-Source Display

In timeline mode, lines from different sources interleave by timestamp. Each source gets a color-coded gutter label (e.g., `LC` for logcat, `KN` for kernel, `RD` for radio). Sources can be toggled on/off.

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+F` | Focus search bar |
| `Enter` / `Shift+Enter` | Next / previous search match |
| `Escape` | Clear search, return to full view |
| `Ctrl+G` | Go to line number |
| `F` | Toggle full view |
| `1-9` | Switch to processor N's view |
| `C` | Cycle context lines (0 → 3 → 10 → 25) |
| `[` / `]` | Expand/collapse context around current line |

---

## Charts

### Declarative Charts (from YAML)

Processors declare charts in the `output.charts` section. The Rust `ChartBuilder` computes `ChartData` from processor state (vars, emissions, or script chart emissions).

### Script-Driven Charts

Scripts use `emit_chart("chart_id", #{ ... })` to push data points. Charts with `source: script` consume these.

### Chart Data Model

```rust
pub struct ChartData {
    pub id: String,
    pub chart_type: ChartType,
    pub title: String,
    pub description: Option<String>,
    pub series: Vec<DataSeries>,
    pub annotations: Vec<Annotation>,
    pub x_axis: AxisConfig,
    pub y_axis: AxisConfig,
    pub line_refs: Vec<LineReference>,  // Click-to-jump support
}

pub struct DataSeries {
    pub label: String,
    pub color: Option<String>,
    pub points: Vec<DataPoint>,
}

pub struct DataPoint {
    pub x: f64,
    pub y: f64,
    pub label: Option<String>,
    pub timeline_pos: Option<usize>,  // Links back to log viewer
}
```

### Supported Chart Types

`TimeSeries`, `Bar { stacked }`, `Scatter`, `Histogram { bins }`, `Heatmap`, `Pie`, `Area { stacked }`

### Annotation Types

`HorizontalLine`, `VerticalLine`, `HorizontalBand`, `VerticalBand`, `PointMarker`

### Interactive Feature

Charts with `interactive: true` support click-to-jump. Clicking a data point switches the log viewer to Focus mode centered on that timeline position.

### Live Updates

During processing, charts update in real-time via Tauri events (`chart-update-{processor_id}-{chart_id}`).

---

## Tauri IPC Commands

### File / Session

| Command | Direction | Description |
|---------|-----------|-------------|
| `load_log_file(path)` | FE → BE | Load a file, detect type, create source |
| `create_session(sources)` | FE → BE | Create analysis session with multiple sources |
| `get_lines(LineRequest)` | FE → BE | Get a window of lines for the viewer |
| `search_logs(SearchQuery)` | FE → BE | Execute search, return summary |

### Pipeline

| Command | Direction | Description |
|---------|-----------|-------------|
| `run_pipeline(file_path, processor_ids)` | FE → BE | Start processing |
| `stop_pipeline()` | FE → BE | Cancel processing |
| `pipeline-results` | BE → FE (event) | Streaming result batches |
| `pipeline-progress` | BE → FE (event) | Progress updates |

### Processors

| Command | Direction | Description |
|---------|-----------|-------------|
| `list_processors()` | FE → BE | List installed processors |
| `fetch_registry()` | FE → BE | Fetch GitHub registry index |
| `install_processor(id)` | FE → BE | Download and install from registry |
| `get_processor_vars(id)` | FE → BE | Get current variable state |

### Charts

| Command | Direction | Description |
|---------|-----------|-------------|
| `get_chart_data(processor_id, chart_id)` | FE → BE | Get computed chart data |
| `subscribe_chart(processor_id, chart_id)` | FE → BE | Subscribe to live updates |
| `chart-update-{pid}-{cid}` | BE → FE (event) | Streaming chart updates |

### Claude

| Command | Direction | Description |
|---------|-----------|-------------|
| `claude_analyze(AnalysisRequest)` | FE → BE | Send filtered data for analysis |
| `claude_generate_processor(description, sample_lines)` | FE → BE | Generate processor YAML |
| `claude-stream` | BE → FE (event) | Streaming response tokens |

---

## Build & Distribution

### Development

```bash
cargo tauri dev    # Hot-reloads both Rust and React
```

### Production Builds

```bash
cargo tauri build                                    # Current platform
cargo tauri build --target x86_64-pc-windows-msvc    # Windows
cargo tauri build --target aarch64-apple-darwin       # macOS Apple Silicon
cargo tauri build --target x86_64-apple-darwin        # macOS Intel
cargo tauri build --target x86_64-unknown-linux-gnu   # Linux
```

### Output

| Platform | Format | Size |
|----------|--------|------|
| Windows | `.msi` / `.exe` | ~8-15MB |
| macOS | `.dmg` / `.app` | ~8-12MB |
| Linux | `.deb` / `.AppImage` / `.rpm` | ~8-12MB |

### Auto-Updates

Tauri built-in updater with a JSON manifest alongside GitHub releases.

### CI/CD

GitHub Actions matrix build across Windows, macOS (Intel + ARM), and Linux. Uploads artifacts per target.

---

## Performance Targets

| Metric | Target |
|--------|--------|
| 1GB file load + index | < 2s |
| 1GB file through 12 processors | < 5s |
| UI frame rate during processing | 60fps (no jank) |
| Peak memory (1GB file) | < 400MB (mmap + indexes) |
| Search across 5M lines | < 500ms |
| GC pauses | None (Rust) |

---

## Implementation Priority

### Phase 1: Foundation
1. Tauri project scaffold with Rust backend + React frontend
2. Logcat parser (most common format)
3. Memory-mapped file reader with line indexing
4. Basic pipeline engine (filter + extract stages, no scripting yet)
5. Virtualized log viewer (Full mode)
6. Search functionality

### Phase 2: Core Features
7. Rhai scripting engine integration
8. Variable system (declaration, binding, persistence)
9. Processor YAML schema parser and validator
10. Processor view mode (collapsed with gap markers)
11. PII anonymizer with configurable detectors
12. Highlight system (search, processor, extracted fields, PII)

### Phase 3: Multi-Source & Charts
13. Additional parsers (kernel, radio, bugreport splitter)
14. Unified timeline and cross-source index
15. Session management (multiple sources)
16. `session.query()` bridge to Rhai
17. Chart system (declarative + script-driven)
18. Click-to-jump from charts to log viewer

### Phase 4: Intelligence & Distribution
19. Claude analysis integration (streaming)
20. Claude processor generation
21. GitHub processor registry (fetch, install, verify)
22. Processor marketplace UI
23. Auto-updater
24. CI/CD pipeline for multi-platform builds

---

## Example Processor: WiFi Disconnect + Kernel Correlator

This example demonstrates cross-source querying, variable management, script logic, and chart output:

```yaml
meta:
  id: "wifi-kernel-correlator"
  name: "WiFi Disconnect + Kernel Correlator"
  version: "1.0.0"
  description: "Correlates WiFi disconnects with kernel driver errors"
  tags: ["wifi", "connectivity", "kernel"]

sources:
  required:
    - type: Logcat
      alias: logcat
  optional:
    - type: Kernel
      alias: kernel
    - type: Radio
      alias: radio

vars:
  - name: correlations
    type: list
    default: []
    display: true
    label: "Correlated Events"
    display_as: table
    columns: [timestamp, wifi_event, kernel_event, radio_state, severity]

  - name: orphaned_disconnects
    type: int
    default: 0
    display: true
    label: "Disconnects with no kernel correlation"

pipeline:
  - stage: filter
    source: logcat
    rules:
      - type: tag_match
        tags: ["WifiStateMachine"]
      - type: message_contains
        value: "NETWORK_DISCONNECTION_EVENT"

  - stage: extract
    fields:
      - name: ssid
        pattern: 'SSID:\s*"?([^",]+)"?'
      - name: reason
        pattern: 'reason=(\d+)'
        cast: int

  - stage: script
    runtime: rhai
    src: |
      let disconnect_time = line.timestamp;

      let kernel_events = session.query(#{
          from: disconnect_time - 2000,
          to: disconnect_time + 500,
          sources: ["kernel"],
          tags: ["wlan", "cfg80211", "ieee80211", "brcmfmac", "dhd"]
      });

      let radio_events = session.query(#{
          from: disconnect_time - 5000,
          to: disconnect_time + 1000,
          sources: ["radio"]
      });

      let kernel_error = ();
      let severity = "low";

      for event in kernel_events {
          if event.message.contains("firmware crash") {
              kernel_error = event;
              severity = "critical";
              break;
          }
          if event.message.contains("beacon loss") {
              kernel_error = event;
              severity = "high";
              break;
          }
          if event.message.contains("deauth") || event.message.contains("disassoc") {
              kernel_error = event;
              severity = "medium";
              break;
          }
      }

      let radio_state = "unknown";
      for event in radio_events {
          if event.message.contains("RADIO_STATE") {
              radio_state = event.message;
              break;
          }
      }

      if kernel_error != () {
          emit(#{
              timestamp: line.timestamp,
              wifi_event: line.message,
              kernel_event: kernel_error.message,
              ssid: fields.ssid,
              reason: fields.reason,
              severity: severity,
              time_delta_ms: kernel_error.timestamp - disconnect_time
          });

          vars.correlations.push(#{
              timestamp: line.timestamp,
              wifi_event: "Disconnect reason=" + fields.reason,
              kernel_event: kernel_error.message,
              radio_state: radio_state,
              severity: severity
          });
      } else {
          vars.orphaned_disconnects += 1;
      }

  - stage: output
    views:
      - type: table
        source: emissions
        columns: [timestamp, ssid, severity, wifi_event, kernel_event, time_delta_ms]
        sort: timestamp

    charts:
      - id: severity_breakdown
        type: bar
        title: "Disconnect Severity"
        source: emissions
        x: { field: severity }
        y: { aggregation: count, label: "Count" }
        stacked: false
        interactive: true

      - id: correlation_timeline
        type: time_series
        title: "Correlated Disconnects Over Time"
        source: emissions
        x: { field: timestamp, bucket: "10m" }
        y: { aggregation: count, label: "Events" }
        group_by: severity
        interactive: true
```
