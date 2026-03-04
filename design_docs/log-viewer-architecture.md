# Log Viewer System Architecture

## Specification Document

**Project**: LogTapper — Log Viewer Component
**Stack**: Rust (backend) + Web (frontend, React)
**Status**: Design Specification

---

## 1. Core Design Philosophy

The system is built around one fundamental principle: **the line number is the universal key**. Every component — backend indexing, API contracts, frontend cache, virtual scroll, MCP agent tools, and analysis artifacts — references lines by their assigned line number. For file-based sources, this corresponds to the physical line position in the source file. For live sources (ADB logcat streams), line numbers are assigned sequentially as lines arrive and are permanently stable once assigned.

This ensures:

- Filtered views never lose their connection to the original source
- Cache entries remain valid across filter transitions
- Copy/paste output always includes traceable line references
- Agent analysis references are navigable in the UI
- The system is predictable and debuggable at every layer
- File sources and live sources are interchangeable from the consumer's perspective

The log viewer is **read-only** for file sources and **append-only** for live sources. In neither case is existing data modified, which dramatically simplifies concurrency and caching — there are no writes to coordinate against reads, no dirty reads, and no cache invalidation from mutation.

The system has two primary consumers of the backend: the **frontend UI** (human interaction via viewport, scroll, and selection) and the **MCP server** (agent interaction via programmatic queries and analysis). Both are peer consumers of the same backend API and session infrastructure.

---

## 2. Backend Architecture (Rust)

### 2.1 Log Source Abstraction

The backend operates on a `LogSource` trait rather than directly on files. This abstraction allows file-based and live streaming sources to share the same read infrastructure.

```rust
pub trait LogSource: Send + Sync {
    fn total_lines(&self) -> u32;
    fn get_lines(&self, start: u32, count: u32) -> Vec<LogLine>;
    fn get_lines_by_numbers(&self, lines: Vec<u32>) -> Vec<LogLine>;
    fn is_live(&self) -> bool;
    fn subscribe_updates(&self) -> Receiver<SourceEvent>;
}

pub enum SourceEvent {
    LinesAppended { new_total: u32 },
    StreamEnded,
    StreamError(String),
}
```

Two implementations exist: `FileLogSource` for static files and `LiveLogSource` for ADB logcat streams. All downstream components — the Line Provider, Search/Filter Engine, API layer, frontend, and MCP server — operate against the trait and are unaware of which source type backs a given session.

For `FileLogSource`, `total_lines` is fixed after indexing and `subscribe_updates` immediately yields no events. For `LiveLogSource`, `total_lines` grows over time and `subscribe_updates` emits `LinesAppended` events as new data arrives.

### 2.2 File Indexing Layer (FileLogSource)

When a log file is opened, the backend performs a single sequential scan to build a **line index** — a compact data structure that maps every line number to its byte offset and length in the file.

```
LineIndex:
  line_number (u32) → { byte_offset (u64), byte_length (u32) }
```

This index is approximately 12–16 bytes per line. For a 10 million line file, that's roughly 120–160 MB — acceptable for a desktop application. The index remains in memory for the lifetime of the file session and is **immutable after construction**.

The indexing pass also captures lightweight metadata:

- Total line count
- File size
- Optionally, a sparse timestamp index (every Nth line's parsed timestamp) for time-based navigation

### 2.3 Live Ingestion Layer (LiveLogSource)

For live ADB logcat streams, the backend builds the line index **incrementally** as lines arrive. An ingestion thread reads from the ADB connection, parses line boundaries, assigns sequential line numbers starting at 1, and appends to an internal buffer.

```rust
pub struct LiveLogSource {
    buffer: Arc<RwLock<AppendBuffer>>,
    update_channel: broadcast::Sender<SourceEvent>,
}

struct AppendBuffer {
    lines: Vec<StoredLine>,          // append-only, never modified
    total_lines: AtomicU32,          // readers can check without lock
    spill_file: Option<SpillFile>,   // overflow to disk when buffer is large
}
```

Because the buffer is append-only, the `RwLock` has minimal contention — the writer holds a brief write lock to append a batch, readers hold read locks to fetch ranges, and readers never block each other.

#### Line Number Assignment

Line numbers for a live stream start at 1 and increment with each received line. Once line 5,000 is assigned, it is always line 5,000. This preserves the universal-key contract. The only difference from file sources is that `total_lines` increases over time.

#### Memory Management: Spill-to-Disk

A live logcat session can run for hours and produce millions of lines. The `AppendBuffer` holds recent lines in memory (configurable, perhaps the most recent 100K lines). When the in-memory buffer exceeds its limit, older lines are flushed to a temporary spill file on disk. The spill file uses the same byte-offset indexing as `FileLogSource`, enabling identical O(1) random access.

```
┌─────────────────────────────────────────────┐
│  LiveLogSource                              │
│                                             │
│  Spill File (disk)         Memory Buffer    │
│  ┌──────────────────┐    ┌──────────────┐  │
│  │ Lines 1–900,000  │    │ Lines        │  │
│  │ (indexed, random  │    │ 900,001–     │  │
│  │  access via       │    │ 1,000,000    │  │
│  │  byte offsets)    │    │ (hot, fast)  │  │
│  └──────────────────┘    └──────────────┘  │
│                                             │
│  ← older lines             newer lines →   │
└─────────────────────────────────────────────┘
```

From the reader's perspective, this is invisible. `get_lines(950_000, 100)` hits the memory buffer. `get_lines(5_000, 100)` reads from the spill file. The `LogSource` trait hides the distinction.

#### Capture Finalization

When the user stops a live capture, the `LiveLogSource` finalizes the spill file into a proper log file and transparently swaps the session to a `FileLogSource`. The session ID stays the same, line numbers stay the same, and the frontend cache remains valid. The user sees the "live" indicator disappear and can save the file as a static artifact.

### 2.4 Line Provider Service

The core read service satisfies requests like "give me lines 50,000 through 50,200" by delegating to the active `LogSource`:

1. For `FileLogSource`: looks up byte offsets in the line index (two array lookups, O(1)), performs a single `seek + read` on the file or memory-mapped region
2. For `LiveLogSource`: reads from the in-memory buffer or spill file depending on line number range

Both return lines with their assigned line numbers attached. The backend **never renumbers lines**. A filtered result set is always a sparse list of `(line_number, content)` pairs.

### 2.5 File Access Strategy

For file-based sources using memory-mapped files (`mmap`), the OS handles paging. Multiple threads can read concurrently from the same mapped region with no synchronization. For buffered I/O (preferable for very large files or specific access patterns), each consumer gets its own file handle with an independent seek cursor.

The choice between `mmap` and per-handle reads can be made at construction time based on file size and hidden behind a trait so consumers don't need to know which strategy is in use.

### 2.6 Search & Filter Engine

Search and filtering operate as **index-producing operations**. They don't return full line content — they produce a `FilteredLineSet`: an ordered collection of line numbers that match the criteria.

```
FilteredLineSet:
  matched_lines: Vec<u32>       // line numbers, sorted
  total_matches: u32
  filter_id: Uuid               // stable reference for this result set
```

This separation is critical. The frontend or MCP agent can request "give me items 100–200 from FilteredLineSet X" and the backend translates that to the corresponding line numbers, fetches those lines from the source, and returns them with original numbering intact.

#### Progressive Search Results

For large files, search results are emitted progressively so consumers can begin working with matches before the full scan completes. The backend publishes increasingly complete snapshots using a lock-free pattern:

```rust
pub struct ProgressiveFilterSession {
    current_results: Arc<ArcSwap<FilteredLineSet>>,
    status: Arc<AtomicU8>,  // Searching | Complete | Cancelled
}
```

Consumers read the latest snapshot without blocking the search thread.

#### Compound Filters

Multiple filters (log level, tag, time range, text search) produce their own FilteredLineSets, which are intersected to produce the active view set.

#### Incremental Filtering on Live Sources

When a filter is active on a live source, new lines are evaluated against the filter criteria as they arrive. Matching line numbers are appended to the existing `FilteredLineSet`. This reuses the same `ArcSwap` snapshot pattern — the ingestion thread publishes updated snapshots, and readers always see a consistent view. Only new lines are evaluated; the full history is never rescanned.

---

## 3. Backend API Contract

The interface between backend and its consumers (frontend and MCP server) is a clean set of operations. This contract applies whether implemented as Tauri commands, MCP tools, a local HTTP API, or direct FFI.

### 3.1 Data Types

```
LogLine {
  line_number: u32       // assigned line number — THE key
  content: String
  byte_offset: u64       // optional, useful for debugging
}

FilterCriteria {
  text_search: Option<String>
  regex: Option<String>
  log_levels: Option<Vec<LogLevel>>
  tags: Option<Vec<String>>
  time_range: Option<(DateTime, DateTime)>
  combine: AND | OR
}

SourceSession {
  session_id: Uuid
  total_lines: u32
  source_type: File | Live
  file_size: Option<u64>    // present for file sources
}

FilterSession {
  filter_id: Uuid
  total_matches: u32
}

SourceEvent {
  LinesAppended { new_total: u32 }
  StreamEnded
  StreamError(String)
}

AdbConfig {
  device_serial: Option<String>
  logcat_args: Vec<String>        // e.g., ["-v", "threadtime", "*:W"]
  buffer: Option<LogcatBuffer>    // main, system, crash, etc.
}

SessionMetadata {
  total_lines: u32
  source_type: File | Live
  time_range: Option<(DateTime, DateTime)>
  log_level_distribution: Map<LogLevel, u32>
  top_tags: Vec<(String, u32)>
  file_size: Option<u64>
}

Bookmark {
  id: Uuid
  session_id: Uuid
  line_number: u32              // the universal key
  label: String                 // short, e.g. "Memory leak start"
  note: Option<String>
  created_by: Agent | User
  created_at: DateTime
}

AnalysisArtifact {
  id: Uuid
  session_id: Uuid
  title: String                 // "Crash Root Cause Analysis"
  created_at: DateTime
  sections: Vec<AnalysisSection>
}

AnalysisSection {
  heading: String               // "Memory pressure leading to OOM"
  body: String                  // markdown narrative from the agent
  references: Vec<SourceReference>
  severity: Option<Severity>    // info, warning, critical
}

SourceReference {
  line_number: u32              // the universal key
  end_line: Option<u32>         // for ranges
  label: String                 // "GC thrashing begins here"
  highlight_type: Annotation | Anchor
}

WatchEvent {
  watch_id: Uuid
  new_matches: Vec<LogLine>
  total_matches: u32
}
```

Every response that includes lines **always** includes the assigned `line_number`. There is no API that returns lines without this reference.

### 3.2 Core Operations

These operations are shared by both the frontend and MCP consumers.

```
// Source lifecycle — file
open_file(path) → SourceSession
close_session(session_id)

// Source lifecycle — live capture
start_live_capture(adb_config: AdbConfig) → SourceSession
stop_live_capture(session_id)
save_live_capture(session_id, output_path) → saved file path

// Session discovery
list_sessions() → Vec<SourceSession>

// Line fetching — the workhorse (works identically for file and live sources)
get_lines(session_id, start_line: u32, count: u32) → Vec<LogLine>
get_lines_by_numbers(session_id, line_numbers: Vec<u32>) → Vec<LogLine>

// Search & filter (works identically for file and live sources)
create_filter(session_id, criteria: FilterCriteria) → FilterSession
get_filtered_lines(filter_id, offset: u32, count: u32) → Vec<LogLine>
cancel_filter(filter_id)

// Subscriptions
subscribe_source_updates(session_id) → Stream<SourceEvent>
subscribe_progress(operation_id) → Stream<ProgressEvent>

// Bookmarks (shared between UI and MCP)
create_bookmark(session_id, line_number, label, note) → bookmark_id
list_bookmarks(session_id) → Vec<Bookmark>
delete_bookmark(bookmark_id)
subscribe_bookmark_updates(session_id) → Stream<BookmarkEvent>
```

### 3.3 MCP-Oriented Operations

These operations are primarily used by MCP agents but are available to any consumer. They provide context-efficient access patterns suited to programmatic exploration within token budgets.

```
// Metadata — cheap overview for agent orientation
get_session_metadata(session_id) → SessionMetadata

// Context-window-friendly fetching
get_lines_around(session_id, line_number, context_before, context_after) → Vec<LogLine>
search_with_context(session_id, query, max_results, context_lines) → Vec<SearchMatch>

// Live monitoring — push-based filter notifications
create_watch(session_id, criteria) → watch_id
cancel_watch(watch_id)
subscribe_watch(watch_id) → Stream<WatchEvent>

// Analysis artifacts — agent publishes structured findings
publish_analysis(session_id, artifact: AnalysisArtifact) → artifact_id
update_analysis(artifact_id, artifact: AnalysisArtifact)
list_analyses(session_id) → Vec<AnalysisArtifact>
get_analysis(artifact_id) → AnalysisArtifact
delete_analysis(artifact_id)
subscribe_analysis_updates(session_id) → Stream<AnalysisEvent>
```

The `get_session_metadata` call gives the agent a cheap overview to orient before making targeted queries. An agent's typical first call on any session would be this endpoint.

The `search_with_context` operation returns matches with surrounding lines — exactly what an agent needs to understand a crash or pattern without fetching the entire file.

The `create_watch` operation builds on incremental filter evaluation for live sources. A watch is a filter with a push notification channel, enabling the agent to monitor a live stream for specific conditions ("alert when ANR detected") without polling.

The `update_analysis` call supports live source scenarios where the agent publishes a preliminary analysis while monitoring, then refines it as more data arrives.

---

## 4. Backend Concurrency Model

### 4.1 Thread Safety Principles

For file sources, the read-only nature eliminates write coordination concerns. For live sources, the append-only pattern minimizes it. Thread safety is achieved through Rust's ownership model with minimal synchronization.

### 4.2 Shared State Layers

**Line Index (File Sources)** — Immutable after construction. Shared freely via `Arc<LineIndex>` with zero synchronization. Any thread can look up byte offsets concurrently with no locks and no contention.

**Append Buffer (Live Sources)** — Append-only with `RwLock`. The writer (ingestion thread) holds a brief write lock to append batches. Readers hold read locks to fetch ranges. Readers never block each other. The `total_lines` field uses `AtomicU32` so readers can check the current count without acquiring any lock.

**File Access** — For `mmap`, multiple threads read from the same mapped region concurrently. For buffered I/O, each consumer opens its own read-only file handle with an independent seek cursor. Both approaches require no locking on the read path.

**Filter Sessions** — Built once by the search engine, then shared immutably via `Arc` (file sources) or published as append-only snapshots via `ArcSwap` (live sources). The collection of active filters uses a concurrent map (`DashMap`) for safe creation/removal while other threads read existing filters.

**Bookmarks and Analyses** — Stored in concurrent maps (`DashMap`) on the session. Both the frontend and MCP server can read and write concurrently. Bookmarks and analyses are small metadata objects, so contention is negligible even under concurrent access.

### 4.3 Session Architecture

```rust
pub struct LogSession {
    id: Uuid,
    source: Arc<dyn LogSource>,                           // file or live, polymorphic
    active_filters: DashMap<Uuid, Arc<FilterSession>>,    // concurrent map
    bookmarks: DashMap<Uuid, Bookmark>,                   // shared between UI and MCP
    analyses: DashMap<Uuid, AnalysisArtifact>,            // agent-published findings
    active_watches: DashMap<Uuid, WatchSession>,          // live source monitors
}

pub struct SessionHandle {
    session: Arc<LogSession>,
}
```

Creating a `SessionHandle` is just cloning an `Arc`. Multiple components — frontend viewport, prefetch, search, MCP agent queries — hold handles to the same session with negligible overhead. The data fetching path through `FileLogSource` is fully lock-free. The path through `LiveLogSource` acquires a brief read lock on the append buffer, which does not contend with other readers.

### 4.4 Concurrent Scenario Support

| Scenario | How It Works |
|---|---|
| Viewport + prefetch + search simultaneously | All hold SessionHandles. Viewport and prefetch read different line ranges through the LogSource. Search scans via its own access path. No contention. |
| Two tabs viewing same file with different filters | Share the same LogSession and LogSource. Each has its own FilterSession. Completely independent reads. |
| Search cancelled while viewport fetches | Cancellation sets an AtomicBool on the filter session. Viewport fetch uses the LogSource directly — completely unaffected by filter lifecycle. |
| Live ingestion while viewport reads and search runs | Ingestion thread appends with a brief write lock. Viewport and search hold read locks (non-contending). Filter receives incremental updates via ArcSwap snapshots. |
| MCP agent querying while frontend scrolls | Both hold SessionHandles to the same session. Agent's `search_with_context` and frontend's `get_lines` are independent concurrent reads through the LogSource. |
| Agent publishes analysis while user is viewing | Agent writes to the analyses DashMap. Frontend receives notification via subscription and renders references in the gutter. No impact on viewport fetching. |
| Agent watch active during live capture | Watch evaluates new lines using the same incremental filter path. Push notifications to the agent are independent of frontend update batching. |

### 4.5 I/O Bandwidth Consideration

The main risk is not data races (Rust prevents those) but I/O bandwidth saturation on spinning disks. If many consumers issue random reads to different file regions, disk seek thrashing can occur. On SSD this is a non-issue. For HDD support, a request coalescing layer can batch concurrent reads, sort by byte offset, and issue them sequentially. This sits between the SessionHandle and actual file I/O, invisible to consumers.

---

## 5. Frontend Architecture

### 5.1 Core Concepts

The frontend maintains a clear separation between three concepts:

**Active Line Set** — The ordered list of line numbers currently "in scope." When unfiltered on a file source, this is implicitly `[0..total_lines]` (never materialized). When unfiltered on a live source, this is `[0..current_total]` and grows over time. When filtered, this is the FilteredLineSet from the backend. The Active Line Set defines what the scrollbar represents.

**Viewport** — The visible window of 50–100 lines depending on screen size. This is what the user actually sees.

**Cache** — A bounded structure holding recently fetched `LogLine` objects, keyed by line number. Managed by the global CacheManager.

### 5.2 Global Cache Manager

#### The Problem with Per-File Caches

If each file view owns an independent cache sized to the user's configured maximum, opening three files triples actual memory usage — breaking the user's expectation that the configured value is a total memory budget.

#### Shared Budget Architecture

A single **CacheManager** owns the total memory budget and allocates slices to active views (both file-based and live):

```
┌─────────────────────────────────────────────┐
│  CacheManager                               │
│  Total budget: 500 MB (user-configured)     │
│                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ File A   │ │ Live     │ │ File C   │   │
│  │ View     │ │ Logcat   │ │ View     │   │
│  └──────────┘ └──────────┘ └──────────┘   │
└─────────────────────────────────────────────┘
```

Note: The MCP server does not participate in the frontend cache. It reads directly from the backend and manages its own token-budget-oriented access patterns.

#### Priority-Based Allocation

The CacheManager tracks each view's priority based on observable signals:

| Priority | Budget Share | Description |
|---|---|---|
| Focused | Up to 60% | The tab/pane the user is actively interacting with |
| Visible | Up to 30% | On screen but not focused (split pane) |
| Background | Remaining ~10% | Open tab but not visible |

A **guaranteed minimum floor** (enough for viewport plus modest prefetch, ~2–5 MB) prevents background tabs from full eviction, keeping tab switching snappy.

#### Eviction Strategy

When total memory usage approaches the budget, eviction considers the global picture:

1. First evict from background views (least recently accessed lines first)
2. Then from visible-but-not-focused views
3. Only evict from the focused view as a last resort, and only lines far from the viewport

#### Transition Behavior

When the user switches tabs, the CacheManager **does not immediately evict** from the old tab. It adjusts ceilings: the backgrounded view stops prefetching and allows gradual eviction under pressure. The newly focused view grows into its allocation. This makes transitions smooth.

#### File Size Disparity Handling

When a source's total size is smaller than its allocation, the surplus is redistributed. A 10 KB file gets fully cached and the remaining budget goes to larger sources. This falls out naturally when allocation is based on actual requests rather than pre-partitioning.

#### CacheManager Interface

```
CacheManager
  total_budget: configured by user
  allocate_view(session_id) → ViewCacheHandle
  release_view(session_id)
  on_focus_change(session_id)

ViewCacheHandle
  get(line_number) → Option<LogLine>      // cache hit or miss
  put(lines: Vec<LogLine>)                // offer lines to cache
  prefetch_allowed() → bool               // budget check before prefetching
```

The `put` operation is an **offer**, not a guarantee. The CacheManager can decline to cache lines if the view is over its allocation. The `prefetch_allowed` check lets the fetch layer skip prefetch requests when a background view has no remaining budget.

### 5.3 Cache Configuration

```
CacheConfig {
  max_total_bytes: u64        // user-configurable global budget
  prefetch_ahead: u32         // lines to fetch ahead of viewport, e.g. 500
  prefetch_behind: u32        // lines to keep behind viewport, e.g. 200
  chunk_size: u32             // fetch granularity, e.g. 200 lines per request
}
```

**Small cache (default)**: Holds a sliding window around the current viewport per source. As the user scrolls, distant lines are evicted. Prefetch runs ahead of scroll direction.

**Large cache / full source mode**: If a view's allocation exceeds the source's total size, the frontend issues a background load of the entire content. Once complete, all operations hit local memory with zero backend latency. This applies to file sources where the total size is known upfront; live sources are not candidates for full-source mode since their size is unbounded.

**Cache keying**: Because the key is always the line number, the cache works identically whether the view is filtered or unfiltered, and whether the source is a file or live stream. Filter transitions don't thrash the cache.

### 5.4 Full-Source-In-Memory Decision

The decision accounts for the global budget and source type:

```
Can fully cache source?
  = source is NOT live
  AND source_line_count × avg_line_size < this_view's_current_allocation
```

If other views close and free budget, the CacheManager can promote a progressively-loaded view to full-source mode in the background.

---

## 6. Virtual Scrolling & Scroll Handling

### 6.1 Virtual Scroll Mechanics

The virtual scroll component renders only the visible viewport rows plus a small overscan buffer. The scroll container's total height is derived from the Active Line Set size.

```
Scroll position → index into Active Line Set
                → line number
                → cache lookup (hit → render, miss → fetch + placeholder)
```

When the view is filtered, the scrollbar represents the filtered result set. Row 0 in the scroll view might be original line 47,832. The gutter always displays the assigned line number.

### 6.2 Fast Scroll / Large Jump Handling

When a user drags the scrollbar from line 0 to line 750,000, naive implementations either freeze the UI or show placeholder flicker. The solution has three cooperating layers.

#### Layer 1: Immediate Visual Response (No I/O)

The scrollbar position, total height, and gutter line numbers are all computable locally from the Active Line Set. As the user drags, they see line numbers updating in real time. Content area behavior depends on cache state:

- **Cache hit**: Render actual content immediately
- **Cache miss**: Render a skeleton row — correct line number in the gutter, muted placeholder bar for content

#### Layer 2: Debounced Fetching

Fetch requests are debounced. The frontend does not request data until scroll velocity drops below a threshold or the user pauses for ~50–150ms. A fast drag from 0 to 750,000 results in 2–3 fetch requests total, not thousands:

```
Scroll event stream:
  line 0 → 12,000 → 89,000 → 340,000 → 680,000 → 750,000 → (pause)
  │         │          │          │          │          │
  skip      skip       skip       skip       skip       FETCH
```

#### Layer 3: Directional Prefetch After Settling

Once the viewport is populated, prefetch loads chunks in the scroll direction:

```
Viewport:    749,800 – 750,000  (visible)
Prefetch 1:  750,000 – 750,200  (immediate, high priority)
Prefetch 2:  750,200 – 750,400  (background, lower priority)
Prefetch 3:  749,600 – 749,800  (small upward buffer)
```

#### User Experience Timeline

| Phase | Duration | What the User Sees |
|---|---|---|
| Drag begins | Instant | Scrollbar moves, gutter line numbers update in real time |
| Mid-drag | Continuous | Skeleton rows with correct line numbers, smooth scroll |
| Drag stops | 0–150ms | Debounce settles, fetch fires |
| Content loads | 1–10ms | Skeletons replaced with real content, no layout shift |
| Continued scroll | Instant | Prefetched content renders immediately |

The UI **never blocks and never waits**. Scroll is driven by local math, skeletons provide visual continuity, and data fills in after the user commits to a position.

#### Fast Scroll in Filtered View

Same behavior. The frontend maps scroll position to the FilteredLineSet index. The gutter shows original (sparse/non-sequential) line numbers, reinforcing that the user is in a filtered view.

---

## 7. Live Source Frontend Behavior

### 7.1 Update Handling

The frontend subscribes to `SourceEvent` updates from the backend. When the backend emits `LinesAppended { new_total }`, the frontend's behavior depends on the user's scroll position.

### 7.2 Tail-Follow Mode

If the user is scrolled to the bottom (or has explicitly enabled "follow" mode), the viewport auto-advances to show new lines. The scrollbar's total height grows and the viewport stays pinned to the end.

The update cadence is batched to animation frame timing (~16ms). Logcat can produce thousands of lines per second; the frontend does not re-render on every single line. Instead, on each frame it checks for new lines, extends the Active Line Set, and renders the latest batch if in follow mode. This gives smooth 60fps scrolling through live data.

### 7.3 Scrolled-Back Mode

If the user has scrolled up to investigate something, new lines arrive but the viewport **does not move**. The scrollbar thumb shrinks slightly as the total grows, and a "new lines below" indicator appears. The user's reading position is undisturbed.

When the user clicks the indicator or scrolls back to the bottom, follow mode re-engages.

### 7.4 Filtered View on Live Data

When a filter is active on a live source, new lines that match the filter appear in the filtered view as they arrive. The backend evaluates new lines against active filter criteria and appends matching line numbers to the `FilteredLineSet` (see Section 2.6). The frontend receives an updated match count and, if in follow mode on the filtered view, displays new matches.

### 7.5 Live Source Cache Interaction

Live source views participate in the same CacheManager budget as file views. The cache keys are the same — stable line numbers. The only difference is that new lines are continuously being offered to the cache. In follow mode, the cache naturally holds the most recent lines. When the user scrolls back into history, the cache loads older lines from the backend (memory buffer or spill file) using the same fetch path as file sources.

---

## 8. MCP Server Integration

### 8.1 Architecture Position

The MCP server sits alongside the frontend as a peer consumer of the backend API layer. It holds `SessionHandle`s to the same `LogSession` instances the frontend uses. The concurrency model handles this naturally — an MCP tool call fetching lines while the frontend prefetches is just another concurrent reader.

```
┌────────────┐    ┌────────────┐
│  Frontend   │    │  MCP       │
│  (Tauri     │    │  Server    │
│   WebView)  │    │  (Agent)   │
└──────┬──────┘    └──────┬─────┘
       │                  │
       │   Tauri IPC      │   MCP Protocol
       │                  │
┌──────┴──────────────────┴──────┐
│  Backend API Layer             │
│  (shared command handlers)     │
└────────────────────────────────┘
```

### 8.2 Agent Access Patterns

The MCP agent has different access patterns from the frontend:

**Session discovery** — The agent needs to enumerate available sessions via `list_sessions()`. The frontend knows this implicitly (it opened the sessions), but an MCP client connecting externally does not.

**Context-efficient fetching** — An agent working within a token budget requests precisely what it needs. `get_lines_around` centers on a line of interest with configurable context. `search_with_context` returns matches with surrounding lines — ideal for understanding a crash without fetching the entire file.

**Metadata orientation** — `get_session_metadata` gives the agent a cheap overview (line count, time range, log level distribution, top tags) to orient before making targeted queries. An agent's typical first call on any session would be this endpoint.

**Live monitoring** — For live sources, the agent can create **watches** — filters with push notification channels. A watch enables the agent to monitor a stream for specific conditions ("alert when ANR detected") without polling. Watches build on the incremental filter evaluation already designed for live sources.

### 8.3 Agent-to-UI Feedback

The MCP integration supports two feedback mechanisms that bridge agent analysis and human investigation:

#### Bookmarks

Bookmarks are lightweight pins — an agent marks a single line with a label and optional note. The frontend subscribes to bookmark changes and can render them in the gutter or as a navigable list.

Bookmarks are keyed by line number, consistent with the rest of the architecture. The human can also create bookmarks manually in the UI, and the agent can read user-created bookmarks to understand what the human is focusing on. The `created_by` field distinguishes agent-created from user-created bookmarks.

#### Analysis Artifacts

Analysis artifacts are the heavyweight feedback mechanism — a structured document that ties narrative analysis to source evidence. Unlike bookmarks (individual pins), an artifact is a **narrative with citations**: the agent explains what it found, with each claim anchored to specific lines in the log.

```
AnalysisArtifact
  └── AnalysisSection (heading, markdown body, severity)
        └── SourceReference (line_number, optional range, label, highlight_type)
```

The agent publishes an artifact in a single call. The frontend subscribes to analysis events on the session. When a new artifact arrives, the UI can notify the user and make the references available for navigation.

The `SourceReference` entries within an artifact implicitly serve as navigable anchors — the UI can extract all references from active analyses and render them in the gutter without requiring separate bookmarks. This makes bookmarks the "pin a single line" tool and analyses the "explain what happened" tool.

The `highlight_type` field on each `SourceReference` indicates how the UI should treat the reference:

- **Anchor**: A navigation target — clicking jumps to this line
- **Annotation**: A contextual marker — displayed in the gutter when the line is visible

How the UI renders these signals — sidebar panel, gutter marks, highlight colors, toast notifications — is entirely a presentation decision that can evolve independently. The data contract is stable because it's line-number-keyed.

For live sources, the agent can publish a preliminary analysis while monitoring and refine it via `update_analysis` as more data arrives.

---

## 9. Selection Model

Multi-line selection tracks line numbers, not viewport positions:

```
Selection {
  ranges: Vec<(u32, u32)>     // (start_line, end_line) in assigned numbering
  anchor: Option<u32>          // for shift-click extension
}
```

Copy operations collect content for all selected line numbers (from cache or backend) and produce output with line numbers preserved:

```
[47832] 2024-01-15 10:23:44.123 E/MyApp: NullPointerException
[47833] 2024-01-15 10:23:44.123 E/MyApp:   at com.example.foo(Foo.kt:42)
[47834] 2024-01-15 10:23:44.124 E/MyApp:   at com.example.bar(Bar.kt:17)
```

This works identically for file and live sources.

---

## 10. Data Flow Examples

### 10.1 Opening a Large File

```
User opens file
  → Backend: open_file(path)
  → Backend creates FileLogSource, scans file, builds LineIndex
    (progress streamed to UI)
  → Returns SourceSession { total_lines: 8,400,000, source_type: File }
  → Frontend: CacheManager.allocate_view(session_id) → ViewCacheHandle
  → Frontend sets Active Line Set to implicit [0..8,400,000]
  → Frontend requests get_lines(session_id, 0, 200)
  → Cache populated via ViewCacheHandle.put()
  → Viewport renders
  → Background prefetch begins in scroll direction
```

### 10.2 Starting a Live Capture

```
User starts ADB logcat capture
  → Backend: start_live_capture(adb_config)
  → Backend creates LiveLogSource, starts ingestion thread
  → Returns SourceSession { total_lines: 0, source_type: Live }
  → Frontend: CacheManager.allocate_view(session_id) → ViewCacheHandle
  → Frontend subscribes to source updates
  → Frontend enables follow mode by default
  → Ingestion thread receives lines, appends to buffer
  → Backend emits LinesAppended { new_total: 150 }
  → Frontend batches at frame rate, renders new lines
  → User scrolls up to investigate → follow mode disengages
  → "New lines below" indicator appears
  → User clicks indicator → follow mode re-engages, viewport jumps to end
```

### 10.3 Stopping and Saving a Live Capture

```
User clicks stop
  → Backend: stop_live_capture(session_id)
  → Ingestion thread stops, LiveLogSource finalizes spill file
  → Session transparently swaps to FileLogSource
  → SourceSession.source_type changes to File
  → Frontend: "live" indicator disappears, follow mode disabled
  → All cached lines remain valid (same line numbers)
  → User: save_live_capture(session_id, "/path/to/output.log")
  → Backend writes finalized file to output path
```

### 10.4 Applying a Filter

```
User filters to "ERROR" level
  → Frontend: create_filter(session_id, { log_levels: [ERROR] })
  → Backend streams through source, builds FilteredLineSet
     (partial results emitted as progress events)
  → Returns FilterSession { filter_id, total_matches: 12,345 }
  → Frontend sets Active Line Set to FilteredLineSet (12,345 entries)
  → Scrollbar adjusts to represent 12,345 items
  → Frontend requests get_filtered_lines(filter_id, 0, 200)
  → Backend maps offset [0..200] → line numbers from FilteredLineSet
  → Fetches those lines from source, returns with line numbers
  → Cache stores by line number
  → Viewport renders: gutter shows 103, 287, 512, 1044...
```

### 10.5 Filtering on a Live Source

```
User applies "ERROR" filter while live capture is running
  → create_filter works the same as file sources for existing lines
  → As new lines arrive, backend evaluates against filter criteria
  → Matching lines are appended to FilteredLineSet
  → Frontend receives updated match count
  → If in follow mode: new matching lines appear at bottom of filtered view
  → If scrolled back: "new matches below" indicator appears
```

### 10.6 Clearing a Filter

```
User clears filter
  → Active Line Set reverts to implicit [0..total_lines]
  → Viewport lines likely already in cache (fetched during filtered view)
  → Scroll position can jump to the line that was centered in filtered view
  → Cache entries remain valid — no invalidation needed
```

### 10.7 Opening Multiple Sources

```
User opens File A (2 GB), starts Live Logcat, opens File C (500 MB)
  → CacheManager allocates views for each
  → User focuses Live Logcat → gets up to 60% of budget
  → File C (visible in split pane) → gets up to 30%
  → File A (background tab) → holds at minimum floor
  → User switches to File A → allocations shift, no immediate eviction
  → Live Logcat in background continues receiving lines
    but stops aggressive caching (minimum floor only)
```

### 10.8 Agent Explores a Log File via MCP

```
Agent connects to MCP server
  → list_sessions() → sees File A is open
  → get_session_metadata(session_id) → learns: 8.4M lines, time range,
    log level distribution shows 12K errors, top tags
  → search_with_context(session_id, "OutOfMemoryError", max_results: 10,
    context_lines: 5) → gets 10 matches with surrounding context
  → Agent identifies crash pattern starting at line 2,340,100
  → get_lines_around(session_id, 2_340_100, context_before: 50,
    context_after: 20) → detailed view of the crash site
  → Agent creates bookmarks at key lines during investigation
  → Frontend receives bookmark notifications, renders in gutter
```

### 10.9 Agent Publishes Analysis

```
Agent completes investigation
  → publish_analysis(session_id, {
      title: "OOM Crash Root Cause",
      sections: [
        { heading: "GC Pressure Buildup",
          body: "Starting at line 2,339,800, GC frequency increases...",
          severity: Warning,
          references: [
            { line: 2_339_800, label: "GC frequency increase begins" },
            { line: 2_339_950, end_line: 2_340_010, label: "Allocation failures" }
          ] },
        { heading: "OOM Kill",
          body: "The system runs out of memory at line 2,340,100...",
          severity: Critical,
          references: [
            { line: 2_340_100, label: "OutOfMemoryError thrown" }
          ] }
      ]
    })
  → Frontend receives analysis notification
  → UI renders references as gutter annotations on lines 2,339,800+
  → User clicks a reference → viewport jumps to that line
  → User opens analysis panel → sees full narrative with clickable citations
```

### 10.10 Agent Monitors Live Stream

```
Agent sets up watch on live logcat session
  → create_watch(session_id, { text_search: "ANR" }) → watch_id
  → Agent subscribes to watch events
  → Live capture continues, ingestion thread evaluates new lines
  → Line 450,230 contains "ANR in com.example.app"
  → Agent receives WatchEvent { new_matches: [LogLine(450230, ...)],
    total_matches: 1 }
  → Agent fetches context: get_lines_around(session_id, 450_230, 20, 10)
  → Agent publishes preliminary analysis
  → Frontend shows analysis references while stream continues
  → More ANRs detected → agent updates analysis with new findings
```

---

## 11. Performance Considerations

**Backend file access**: Memory-mapping gives the OS responsibility for paging. Combined with the line index, random access to any line is O(1). For files smaller than available RAM, the OS naturally caches the entire file in the page cache.

**Live ingestion throughput**: The append-only buffer with batched write locks handles logcat rates (typically hundreds to low thousands of lines per second) with negligible contention. The frontend batches UI updates to frame rate, preventing render thrashing during high-throughput streams.

**Fetch coalescing**: When the frontend needs lines [100, 103, 107, 108, 109, 205], the backend coalesces nearby requests into range reads rather than individual seeks. Heuristic: if lines are within N of each other, read the full range.

**Search cancellation**: Long-running searches are cancellable. The backend checks a cancellation token between chunks. The frontend debounces search input and cancels in-flight searches when criteria change.

**Frontend rendering**: Each visible row is a lightweight component. Syntax highlighting and log-level coloring are computed lazily on render, not on fetch. The cache stores raw content; presentation is a view concern.

**Live source memory**: The spill-to-disk strategy bounds memory usage for long-running captures. The in-memory buffer size is configurable and independent of the frontend cache budget.

**MCP query efficiency**: The `search_with_context` and `get_lines_around` operations are designed for token-budget-aware access. The agent avoids fetching bulk data by using metadata for orientation and context-windowed results for investigation.

**Concurrent consumer load**: The MCP server and frontend operating simultaneously on the same session adds negligible overhead. Both are readers; the only shared mutable state (bookmarks, analyses) is low-frequency metadata writes in concurrent maps.

---

## 12. Module Boundaries

```
┌────────────────────────────────────────────────────────────────────┐
│  Frontend                                                          │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  CacheManager (global, owns memory budget)                   │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐                    │ │
│  │  │ View     │ │ View     │ │ View     │                    │ │
│  │  │ Cache    │ │ Cache    │ │ Cache    │                    │ │
│  │  │ Handle   │ │ Handle   │ │ Handle   │                    │ │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘                    │ │
│  └───────┼─────────────┼───────────┼───────────────────────────┘ │
│          │             │           │                              │
│  ┌───────┴──┐   ┌──────┴───┐  ┌───┴────────┐  ┌─────────────┐  │
│  │ Virtual  │   │ Virtual  │  │ Virtual    │  │ Analysis    │  │
│  │ Scroll   │   │ Scroll   │  │ Scroll     │  │ Panel /     │  │
│  │ + Follow │   │ View     │  │ View       │  │ Bookmark    │  │
│  │ Mode     │   │          │  │            │  │ Gutter      │  │
│  └───────┬──┘   └──────┬───┘  └───┬────────┘  └──────┬──────┘  │
│          │             │           │                   │          │
│  ┌───────┴─────────────┴───────────┴───────────────────┴──────┐  │
│  │  Backend Client / API Adapter                              │  │
│  │  (translates viewport needs → API calls)                   │  │
│  │  (subscribes to SourceEvent, BookmarkEvent, AnalysisEvent) │  │
│  └───────────────────────────┬────────────────────────────────┘  │
└──────────────────────────────┼───────────────────────────────────┘
                               │  (Tauri IPC)
┌──────────────────────────────┼───────────────────────────────────┐
│  Backend                     │                                    │
│  ┌───────────────────────────┴────────────────────────────────┐  │
│  │  API Layer (shared command handlers)                       │  │
│  └──────────┬─────────────────────────────────┬──────────────┘  │
│             │  (Tauri commands)                │  (MCP protocol) │
│             │                                  │                  │
│  ┌──────────┴──────────────────────────────────┴──────────────┐  │
│  │  LogSession                                                │  │
│  │  (Arc<dyn LogSource>, filters, bookmarks, analyses,        │  │
│  │   watches)                                                 │  │
│  └──────┬────────────────────────────┬────────────────────────┘  │
│         │                            │                            │
│  ┌──────┴──────────┐  ┌─────────────┴────────────┐              │
│  │  FileLogSource  │  │  LiveLogSource           │              │
│  │  (index + mmap/ │  │  (append buffer +        │              │
│  │   buffered I/O) │  │   spill file + ADB       │              │
│  │                 │  │   ingestion thread)       │              │
│  └──────┬──────────┘  └─────────────┬────────────┘              │
│         │                            │                            │
│  ┌──────┴────────────────────────────┴───────────┐              │
│  │  Search / Filter Engine                        │              │
│  │  (static scan for files,                       │              │
│  │   incremental eval for live sources,           │              │
│  │   watch notifications)                         │              │
│  └───────────────────────────────────────────────┘              │
│                                                                  │
│  ┌───────────────────────────────────────────────┐              │
│  │  MCP Server                                    │              │
│  │  (exposes LogSession via MCP protocol,         │              │
│  │   context-efficient tools, watch management)   │              │
│  └───────────────────────────────────────────────┘              │
└──────────────────────────────────────────────────────────────────┘
```

---

## 13. Key Design Decisions Summary

| Decision | Rationale |
|---|---|
| Line number as universal key | Guarantees traceability back to source in every context — UI, MCP, bookmarks, and analysis references |
| LogSource trait abstraction | File and live sources share the same read infrastructure; all consumers are source-agnostic |
| Index-first approach | One upfront scan (file) or incremental build (live) enables O(1) random access |
| Filters produce line sets, not content | Decouples "what matches" from "fetch content," enabling lazy loading of filtered views |
| Incremental filter eval for live sources | New lines evaluated against active filters and watches without rescanning history |
| Cache keyed by line number | Cache entries valid across filter transitions and source type — no invalidation on filter change |
| Global shared cache budget | User configures one number; system respects it regardless of sources open |
| Priority-based cache allocation | Focused views get most memory; background tabs hold minimum floor |
| Debounced fetch with skeleton rows | Fast scroll never blocks UI; data fills in after user settles |
| Backend never renumbers | Single source of truth for line identity, no mapping tables to maintain |
| Immutable/append-only shared data | Lock-free read path for files; minimal-contention append path for live sources |
| Spill-to-disk for live sources | Bounds memory for long-running captures while preserving random access to full history |
| Capture finalization | Stopping a live capture transparently transitions to a file source; session ID and cache remain valid |
| Frame-rate batched UI updates | Prevents render thrashing during high-throughput live streams |
| MCP as peer consumer | Agent uses same backend sessions and concurrency model as frontend — no separate data path |
| Context-efficient MCP operations | Metadata, search-with-context, and lines-around operations respect agent token budgets |
| Bookmarks as shared state | Lightweight line-keyed pins created by either agent or user, visible to both |
| Analysis artifacts with source references | Agent publishes structured narrative with line-number-keyed citations; UI renders contextually |
| Watches for live monitoring | Push-based filter notifications for agents, built on existing incremental filter infrastructure |
