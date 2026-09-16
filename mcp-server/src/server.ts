/**
 * LogTapper MCP Server — tool definitions.
 *
 * Exposes LogTapper's live log data as MCP tools that Claude (and other
 * MCP-compatible agents) can call directly. This module builds and exports
 * the configured `server` (every `server.tool(...)` call) but does not
 * connect a transport or start the heartbeat — `index.ts` (the process
 * entrypoint) does that. Splitting it out this way lets `routes.test.ts`
 * import `server` and drive it over an in-memory transport without spawning
 * a real stdio connection or a dangling `setInterval`.
 *
 * Transport: stdio (Claude Code / Claude Desktop spawns this as a subprocess)
 * Bridge:    HTTP calls to localhost:40404 (Tauri app's internal HTTP bridge)
 *
 * ## Typing
 *
 * Every response type is imported from `bridge-types` — an alias (see
 * `tsconfig.json`'s `paths`/`rootDirs`) onto the ts-rs-generated bindings at
 * `src-shared/bridge/generated`, the same types the frontend consumes. All such
 * imports are `import type`, so they are erased entirely by both `tsc` and
 * Node's `--experimental-strip-types` — no bundler is needed for `npm start`,
 * and the specifier need not resolve at runtime at all.
 *
 * ## Error contract
 *
 * Every bridge route now answers a real HTTP status with a
 * `{ "error": { "code", "message" } }` envelope on failure (WP-13). `bridgeGet`
 * / `bridgePost` / `bridgePut` / `bridgeDelete` / `bridgePostLong` parse that
 * envelope on any non-2xx response and throw a `BridgeError` carrying
 * `code` / `message` / `status`. Every tool handler catches that (via
 * `handleBridgeError`) and returns MCP's `{ isError: true, content }` shape —
 * a 404 is a real answer to a wrong question, not ordinary content. A
 * connection failure (LogTapper not running, or the bridge unreachable) is a
 * different kind of problem and keeps the pre-existing `notRunning()` shape.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type {
  Ack,
  ActivityEntry,
  AdbDeviceList,
  AnonymizerConfig,
  AnonymizerTestResult,
  AnalysisArtifact,
  Bookmark,
  BridgeSessionList,
  BridgeSessionMetadata,
  BridgeStatusInfo,
  ChainState,
  ChartData,
  ExportAllSessionsInfo,
  FilterCreateResult,
  FilterInfo,
  FilteredLinesResult,
  FocusContext,
  Insights,
  LinePage,
  MarketplaceFetchResult,
  McpAgentAccess,
  McpOpenAllowlist,
  NavRequest,
  OpenedSession,
  Page,
  PackSummary,
  PipelineRunResult,
  ProcessorDetail,
  ProcessorSummary,
  SearchHits,
  SectionInfo,
  SectionLocation,
  SessionCorrelations,
  SessionPipelineResults,
  Source,
  StartStreamRequest,
  StateSnapshot,
  StreamEventsPage,
  StreamSaved,
  StreamStarted,
  StreamStatus,
  ThemeSummary,
  TimelineSeriesData,
  TrackerEventEntry,
  UpdateCheckResult,
  UpdateResult,
  UserTheme,
  WatchInfo,
  WireError,
  WorkspaceEntry,
  WorkspaceList,
  WorkspaceLoadOutcome,
  WorkspaceSaved,
  WorkspaceSummary,
} from "bridge-types";

const BRIDGE_PORT = 40404;
export const BASE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

// ---------------------------------------------------------------------------
// Bridge client — typed fetch wrappers with an 8s timeout (120s for
// run_pipeline) and one error contract.
// ---------------------------------------------------------------------------

/**
 * One non-2xx bridge response. `code` is stable and matched by callers
 * (never localize or reword it); `message` is human-readable and
 * deliberately uninformative for gate refusals (a denied and a nonexistent
 * path both say "path is not allowed" — see `logtapper_open_file`).
 */
export class BridgeError extends Error {
  // Plain field declarations, not constructor parameter properties — the
  // latter is TypeScript syntax that requires a type-directed transform and
  // is rejected by Node's `--experimental-strip-types` ("strip-only" mode;
  // see `npm start`/`dev`), which only erases type annotations, not lowers
  // TS-only runtime sugar.
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
  }
}

async function bridgeFetch<T>(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.ok) {
    return (await res.json()) as T;
  }

  const body = (await res.json().catch(() => null)) as WireError | null;
  throw new BridgeError(
    body?.error?.code ?? `HTTP_${res.status}`,
    body?.error?.message ?? `Bridge HTTP ${res.status}`,
    res.status
  );
}

async function bridgeGet<T>(
  path: string,
  query?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return bridgeFetch<T>(url.toString());
}

async function bridgePost<T>(path: string, body: unknown): Promise<T> {
  return bridgeFetch<T>(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bridgePostLong<T>(path: string, body: unknown, timeoutMs = 120_000): Promise<T> {
  return bridgeFetch<T>(
    `${BASE_URL}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
}

async function bridgePut<T>(path: string, body: unknown): Promise<T> {
  return bridgeFetch<T>(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bridgePatch<T>(path: string, body: unknown): Promise<T> {
  return bridgeFetch<T>(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bridgeDelete<T>(
  path: string,
  query?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return bridgeFetch<T>(url.toString(), { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

function notRunning(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            running: false,
            error:
              "LogTapper is not running, or the MCP bridge is unavailable. " +
              `Start LogTapper and ensure it is listening on port ${BRIDGE_PORT}.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/** A bridge call failed with a real HTTP status — surface code/message/status. */
function bridgeErrorResult(err: BridgeError): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ code: err.code, message: err.message, status: err.status }, null, 2),
      },
    ],
  };
}

/**
 * The one catch-block handler every tool uses: a `BridgeError` (the bridge
 * answered, but with a non-2xx status) becomes `isError: true` with its
 * code/message/status; anything else (connection refused, DNS failure, the
 * 8s/120s timeout firing) is treated as "LogTapper isn't running" rather than
 * a tool failure to retry.
 */
function handleBridgeError(err: unknown): ToolResult {
  if (err instanceof BridgeError) return bridgeErrorResult(err);
  return notRunning();
}

/** Client-side argument validation failure — one failure shape with bridge errors. */
function argError(message: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ message }, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

export const server = new McpServer({
  name: "logtapper",
  version: "1.3.0",
  description:
    "Query live Android log sessions loaded in LogTapper. " +
    "Use these tools to inspect log content, state-tracker events, and " +
    "processor results before designing new YAML processors.",
});

// ── 1. logtapper_get_status ─────────────────────────────────────────────

server.tool(
  "logtapper_get_status",
  "Check whether LogTapper is running and list the IDs of all currently " +
    "loaded log sessions. Call this first to confirm the app is available " +
    "and to discover session IDs for subsequent queries.",
  {},
  async () => {
    try {
      return ok(await bridgeGet<BridgeStatusInfo>("/mcp/status"));
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 2. logtapper_list_sessions ──────────────────────────────────────────

server.tool(
  "logtapper_list_sessions",
  "List all active log sessions with their source files, line counts, " +
    "source types (Logcat / Bugreport / Kernel), and the installed " +
    "processors that have pipeline results. Each session's source includes " +
    "its absolute source file `path` (null for ADB streams) — use it to " +
    "tell apart two open sessions that share the same display name (e.g. " +
    "'dumpstate.txt' loaded from two different devices). Each session also " +
    "reports `focused: true/false` — the session the user currently has " +
    "the log viewer focused on; prefer publishing analyses to the focused " +
    "session when the target is ambiguous. Use this to understand what " +
    "data is currently loaded before querying lines or events.",
  {},
  async () => {
    try {
      return ok(await bridgeGet<BridgeSessionList>("/mcp/sessions"));
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 3. logtapper_get_metadata ───────────────────────────────────────────

server.tool(
  "logtapper_get_metadata",
  "Get lightweight metadata for a log session. Returns source name/type, " +
    "total line count, file size, whether the session is live (ADB), time range, " +
    "and section count. Does NOT include tag stats or full section details — " +
    "use logtapper_get_sections for section name/startLine/endLine mapping, or " +
    "logtapper_query (which returns tag/level histograms over the sample it reads). " +
    "Call this as the first query against a session to orient.",
  {
    session_id: z.string().describe("Session ID from logtapper_get_status or logtapper_list_sessions"),
  },
  async ({ session_id }) => {
    try {
      return ok(
        await bridgeGet<BridgeSessionMetadata>(`/mcp/sessions/${encodeURIComponent(session_id)}/metadata`)
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 4. logtapper_get_sections ────────────────────────────────────────────

server.tool(
  "logtapper_get_sections",
  "Get the named sections of a bugreport or dumpstate log file. Returns " +
    "paginated {name, startLine, endLine, parentIndex?} for each section. " +
    "DUMPSYS sections (CRITICAL, HIGH, NORMAL) include subsections for each " +
    "dumpsys service (e.g. 'activity', 'wifi', 'battery') — subsections have " +
    "a parentIndex pointing to their parent DUMPSYS section's array index. " +
    "Use startLine/endLine with logtapper_query or logtapper_search_with_context " +
    "to target specific sections or subsections. The query param filters both " +
    "parent and subsection names. Returns an empty array for non-bugreport files. " +
    "Large dumpstate files may have 1000+ sections — use query to filter or " +
    "paginate with limit/offset.",
  {
    session_id: z.string().describe("Session ID"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max sections to return (default 50, max 200)"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Number of sections to skip for pagination (default 0)"),
    query: z
      .string()
      .optional()
      .describe("Case-insensitive substring filter on section name (e.g. 'DUMPSYS', 'WIFI', 'SYSTEM LOG')"),
  },
  async ({ session_id, limit, offset, query }) => {
    try {
      return ok(
        await bridgeGet<Page<SectionInfo>>(`/mcp/sessions/${encodeURIComponent(session_id)}/sections`, {
          limit,
          offset,
          query,
        })
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 5. logtapper_section_at ─────────────────────────────────────────────

server.tool(
  "logtapper_section_at",
  "Resolve which section of a bugreport/dumpstate contains a given line. " +
    "Answers the question 'what section is line N in?' directly, instead of " +
    "paging through logtapper_get_sections and cross-referencing parentIndex " +
    "against line ranges by hand.\n\n" +
    "Returns two distinct things, and the difference matters:\n" +
    "• `containingSections` — every section whose line range covers the line, " +
    "outermost first. This is where the line actually sits.\n" +
    "• `matchesFilterSection` — the ONE name a processor's `filter.section` " +
    "must use to match this line, or null if no rule can target it by section.\n\n" +
    "These disagree more often than you would expect. Section resolution takes " +
    "the last section STARTING at or before the line and stops if the line is " +
    "past that section's end — it does not walk outward to an enclosing parent. " +
    "So a line inside DUMPSYS NORMAL but after the `wifi` subsection ended " +
    "matches no section at all. Use this before writing any `section:` filter.",
  {
    session_id: z.string().describe("Session ID"),
    line: z
      .number()
      .int()
      .min(0)
      .describe("0-based line number to resolve"),
  },
  async ({ session_id, line }) => {
    try {
      return ok(
        await bridgeGet<SectionLocation>(`/mcp/sessions/${encodeURIComponent(session_id)}/section_at`, {
          line,
        })
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 6. logtapper_query ──────────────────────────────────────────────────

server.tool(
  "logtapper_query",
  "Sample log lines from a session. Returns the raw line text plus level " +
    "and tag metadata. Use this to understand the structure and content of " +
    "the log before writing a processor YAML. " +
    "\n\nStrategies:\n" +
    "  uniform  — evenly spread across the entire log (good for first look)\n" +
    "  recent   — latest N lines (default; good for live ADB streams)\n" +
    "  around   — N lines centred on around_line (good for context after finding an anomaly)\n" +
    "\nFilters (all optional, all AND-ed):\n" +
    "  level   — minimum level: V D I W E F\n" +
    "  tag     — exact tag string\n" +
    "  message — substring match against the raw line\n" +
    "\nWhen any filter is active, the tool switches to full-scan mode (up to " +
    "500k lines) to avoid missing rare events. The chosen strategy still " +
    "controls scan ordering. `strategy` in the response is an object " +
    "(`{\"kind\":\"recent\"}`, `{\"kind\":\"around\",\"line\":N}`, …) describing what was " +
    "actually resolved — not an echo of the query string, so a typo in `strategy` " +
    "is visible rather than silently reflected back. `strategyNote` explains the " +
    "sample or scan in words; `scannedLines` reports how many lines were actually " +
    "scanned (present only when a filter forced a scan), and 'truncated' is true " +
    "if the 500k cap (or the session ending mid-scan) cut the scan short of the " +
    "full requested range.\n" +
    "\nRange restriction:\n" +
    "  start_line / end_line — restrict sampling/scanning to a line range\n" +
    "  time_start / time_end — restrict to a timestamp range (ISO 8601)",
  {
    session_id: z.string().describe("Session ID from logtapper_get_status or logtapper_list_sessions"),
    n: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Lines to return (default 50, max 200)"),
    strategy: z
      .enum(["uniform", "recent", "around"])
      .optional()
      .describe("Sampling strategy (default 'recent')"),
    around_line: z
      .number()
      .int()
      .optional()
      .describe("Centre line for 'around' strategy"),
    level: z
      .string()
      .optional()
      .describe("Minimum log level: V, D, I, W, E, or F"),
    tag: z.string().optional().describe("Exact tag filter (e.g. 'ActivityManager')"),
    message: z
      .string()
      .optional()
      .describe("Substring that must appear in the raw line"),
    start_line: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Restrict to lines >= start_line (0-based, inclusive)"),
    end_line: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Restrict to lines < end_line (0-based, exclusive)"),
    time_start: z
      .string()
      .optional()
      .describe("Filter to lines with timestamp >= this value (ISO 8601, e.g. '2024-01-15T10:30:00')"),
    time_end: z
      .string()
      .optional()
      .describe("Filter to lines with timestamp <= this value (ISO 8601, e.g. '2024-01-15T11:00:00')"),
  },
  async ({ session_id, n, strategy, around_line, level, tag, message, start_line, end_line, time_start, time_end }) => {
    try {
      return ok(
        await bridgeGet<LinePage>(`/mcp/sessions/${encodeURIComponent(session_id)}/query`, {
          n,
          strategy,
          around_line,
          level,
          tag,
          message,
          start_line,
          end_line,
          time_start,
          time_end,
        })
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 7. logtapper_search ─────────────────────────────────────────────────

server.tool(
  "logtapper_search",
  "Search log lines with a regex pattern and return the first `limit` matches " +
    "(stops scanning once the page is full — `total` in the response therefore " +
    "always equals `returned`; use logtapper_search_with_context if you need an " +
    "exact match count across the whole range, or offset-based pagination). Each " +
    "hit's `contextBefore`/`contextAfter` arrays hold the surrounding lines when " +
    "`context` > 0. Lines are truncated to 500 characters.",
  {
    session_id: z.string().describe("Session ID"),
    pattern: z.string().describe("Regex pattern to search for"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max results (default 50, max 200)"),
    case_insensitive: z.boolean().optional().describe("Case-insensitive matching (default false)"),
    context: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe("Context lines before and after each match (default 0, max 5)"),
    start_line: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Restrict search to lines >= start_line (0-based, inclusive)"),
    end_line: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Restrict search to lines < end_line (0-based, exclusive)"),
  },
  async ({ session_id, pattern, limit, case_insensitive, context, start_line, end_line }) => {
    try {
      return ok(
        await bridgeGet<SearchHits>(`/mcp/sessions/${encodeURIComponent(session_id)}/search`, {
          pattern,
          limit,
          case_insensitive,
          context,
          start_line,
          end_line,
        })
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 8. logtapper_search_with_context ────────────────────────────────────

server.tool(
  "logtapper_search_with_context",
  "Search log lines using regex patterns with surrounding context. Returns " +
    "`hits[]`, each carrying the matched `line` (a full line object) plus " +
    "`contextBefore`/`contextAfter` arrays (always present, possibly empty) and " +
    "`captures` (regex capture groups, always present, possibly empty). More " +
    "powerful than logtapper_query's substring matching — use for pattern-based " +
    "investigation like finding all crash signatures or specific error " +
    "sequences. Use offset for pagination through large result sets (skip " +
    "first N matches).\n\n" +
    "Response fields: `total` is the TRUE total number of matches across the " +
    "whole search range, independent of max_results and offset — use it to " +
    "decide whether to paginate. `returned` is how many are in this page " +
    "(== hits.length). Lines are truncated to `maxLineChars` (default 500) with " +
    "a trailing '...'; wide dumpsys status lines exceed that and lose their " +
    "trailing fields, so raise max_line_chars when a value you need may sit " +
    "past the cut. The search range itself is capped at 500k lines per " +
    "request; `scannedLines` reports how many lines were actually scanned, and " +
    "`truncated` is true if that cap (or the session ending mid-scan) cut the " +
    "scan short — page forward with start_line to cover the rest.",
  {
    session_id: z.string().describe("Session ID"),
    query: z.string().describe("Regex pattern to search for"),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max match groups to return (default 10, max 50)"),
    context_lines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe("Lines of context before/after each match (default 3, max 10)"),
    case_insensitive: z
      .boolean()
      .optional()
      .describe("Case-insensitive matching (default false)"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Number of matches to skip before collecting results (default 0). Use for pagination."),
    start_line: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Restrict search to lines >= start_line (0-based, inclusive)"),
    end_line: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Restrict search to lines < end_line (0-based, exclusive)"),
    max_line_chars: z
      .number()
      .int()
      .min(1)
      .max(8000)
      .optional()
      .describe(
        "Max characters per returned line before truncation (default 500, max 8000). " +
          "Raise this when the field you need may sit past the default cut — wide " +
          "dumpsys status lines routinely exceed 500 characters."
      ),
  },
  async ({ session_id, query, max_results, context_lines, case_insensitive, offset, start_line, end_line, max_line_chars }) => {
    try {
      return ok(
        await bridgeGet<SearchHits>(
          `/mcp/sessions/${encodeURIComponent(session_id)}/search_with_context`,
          {
            query,
            max_results,
            context_lines,
            case_insensitive: case_insensitive !== undefined ? String(case_insensitive) : undefined,
            offset,
            start_line,
            end_line,
            max_line_chars,
          }
        )
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 9. logtapper_get_lines_around ───────────────────────────────────────

server.tool(
  "logtapper_get_lines_around",
  "Get raw log lines centered on a specific line number. Returns lines with " +
    "level, tag, and raw text; each line's `isContext` flag is false for the " +
    "centre line and true for every line around it (the response's `strategy` " +
    "object also carries the centre as `strategy.line`). Use this to examine " +
    "context around a known line of interest (e.g., a crash line, a state " +
    "transition, or a bookmarked location).",
  {
    session_id: z.string().describe("Session ID"),
    line: z
      .number()
      .int()
      .min(0)
      .describe("Target line number to center on"),
    before: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("Lines before the target (default 20, max 100)"),
    after: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe("Lines after the target (default 20, max 100)"),
  },
  async ({ session_id, line, before, after }) => {
    try {
      return ok(
        await bridgeGet<LinePage>(`/mcp/sessions/${encodeURIComponent(session_id)}/lines_around`, {
          line,
          before,
          after,
        })
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 10. logtapper_get_pipeline_results ──────────────────────────────────

server.tool(
  "logtapper_get_pipeline_results",
  "Get a compact summary of the last pipeline run. Returns per-processor overviews:\n" +
    "  reporters     — matchedLineCount, emission count, top vars (large maps truncated to top 20), 10 recent emissions with extracted fields, 5 sample matched lines with raw text\n" +
    "  state_trackers — transitionCount, finalState, 20 most recent transitions with raw line text\n" +
    "\nFor detailed drill-down into a single processor's emissions and matched lines, use logtapper_get_processor_detail.\n" +
    "Returns hasResults:false if the pipeline has not been run yet.",
  {
    session_id: z.string().describe("Session ID"),
    processor_id: z.string().optional().describe("Filter to a single processor ID (qualified form like 'wifi-state@official' or bare like 'wifi-state')"),
  },
  async ({ session_id, processor_id }) => {
    try {
      return ok(
        await bridgeGet<SessionPipelineResults>(`/mcp/sessions/${encodeURIComponent(session_id)}/pipeline`, {
          processor_id,
        })
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 11. logtapper_get_events ────────────────────────────────────────────

server.tool(
  "logtapper_get_events",
  "Get the most recent StateTracker transition events for a session, " +
    "sorted newest-first. StateTrackers fire on meaningful semantic changes " +
    "in the log (e.g. WiFi connected/disconnected, app lifecycle, battery " +
    "state). These events are the pre-digested signal layer — use them to " +
    "understand what happened before diving into raw lines. Returned as a " +
    "page (`items`, `total`) — `total` here is just the page's own size " +
    "(the backend caps and does not report what it walked past); raise " +
    "`limit` for more." +
    "\nNote: events are only available after running the pipeline " +
    "(or during a live ADB stream with trackers active)." +
    "\nNote: `timestamp` is 0 for events from non-logcat bugreport sections " +
    "(e.g. DUMPSYS content) where no per-line timestamp exists. Use `lineNum` " +
    "for relative ordering of zero-timestamp events.",
  {
    session_id: z.string().describe("Session ID"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max events to return, newest first (default 50)"),
  },
  async ({ session_id, limit }) => {
    try {
      return ok(
        await bridgeGet<Page<TrackerEventEntry>>(`/mcp/sessions/${encodeURIComponent(session_id)}/events`, {
          limit,
        })
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 12. logtapper_get_processor_detail ──────────────────────────────────

server.tool(
  "logtapper_get_processor_detail",
  "Drill into a single processor's detailed results. For reporters: full vars, " +
    "optional paginated emissions with extracted fields, matched line numbers. " +
    "For state trackers: full transition list, paginated. Use include_emissions=true " +
    "to see emission data. Use include_line_text=true to include raw log line " +
    "snippets (avoids separate logtapper_query calls). The response is untagged — " +
    "switch on `processorType` ('reporter' | 'state_tracker'); a reporter's " +
    "`emissions` is null when include_emissions was not requested, otherwise a page " +
    "({items, offset, limit, total})." +
    "\nNote: state tracker transitions from non-logcat bugreport sections " +
    "(e.g. DUMPSYS content) have `timestamp: 0` — no per-line timestamp exists. " +
    "Use `lineNum` for relative ordering.",
  {
    session_id: z.string().describe("Session ID"),
    processor_id: z.string().describe("Processor ID to drill into (qualified or bare — bare IDs are resolved automatically)"),
    include_emissions: z
      .boolean()
      .optional()
      .describe("Include emission data (default false)"),
    emission_limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max emissions to return (default 50, max 200)"),
    emission_offset: z
      .number()
      .int()
      .optional()
      .describe("Offset for emission pagination (default 0)"),
    include_line_text: z
      .boolean()
      .optional()
      .describe("Include raw log line text for matched lines (default false)"),
  },
  async ({ session_id, processor_id, include_emissions, emission_limit, emission_offset, include_line_text }) => {
    try {
      return ok(
        await bridgeGet<ProcessorDetail>(
          `/mcp/sessions/${encodeURIComponent(session_id)}/processor/${encodeURIComponent(processor_id)}`,
          {
            include_emissions: include_emissions !== undefined ? String(include_emissions) : undefined,
            emission_limit,
            emission_offset,
            include_line_text: include_line_text !== undefined ? String(include_line_text) : undefined,
          }
        )
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 13. logtapper_get_state_at_line ─────────────────────────────────────

server.tool(
  "logtapper_get_state_at_line",
  "Reconstruct a state tracker's state at a specific log line. Useful for " +
    "answering questions like 'what was the WiFi state when this crash happened?' " +
    "Returns the state snapshot with all field values at the given line, plus the " +
    "most recent transition before that line.",
  {
    session_id: z.string().describe("Session ID"),
    tracker_id: z.string().describe("State tracker processor ID (qualified or bare — bare IDs are resolved automatically)"),
    line_num: z
      .number()
      .int()
      .min(0)
      .describe("Line number to reconstruct state at"),
  },
  async ({ session_id, tracker_id, line_num }) => {
    try {
      return ok(
        await bridgeGet<StateSnapshot>(
          `/mcp/sessions/${encodeURIComponent(session_id)}/tracker/${encodeURIComponent(tracker_id)}/state_at`,
          { line: line_num }
        )
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 14. logtapper_get_correlations ──────────────────────────────────────

server.tool(
  "logtapper_get_correlations",
  "Get correlation events showing cross-signal relationships. Correlators detect " +
    "when events from different log sources co-occur within a time/line window " +
    "(e.g., FD spikes correlated with EBADF errors). Returns, per correlator, a " +
    "`guidance` string plus a page of events (trigger line, matched source IDs, " +
    "and a formatted diagnostic message). Raw matched-line text is deliberately " +
    "not included — only the structured trigger fields.",
  {
    session_id: z.string().describe("Session ID"),
    correlator_id: z
      .string()
      .optional()
      .describe("Filter to a specific correlator ID"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max events to return (default 50)"),
    offset: z.number().int().optional().describe("Pagination offset (default 0)"),
  },
  async ({ session_id, correlator_id, limit, offset }) => {
    try {
      return ok(
        await bridgeGet<SessionCorrelations>(
          `/mcp/sessions/${encodeURIComponent(session_id)}/correlations`,
          { correlator_id, limit, offset }
        )
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 15. logtapper_get_processor_definitions ─────────────────────────────

server.tool(
  "logtapper_get_processor_definitions",
  "Get processor definitions to understand what each processor detects. " +
    "Without processor_id: returns a summary list (id, name, type, description, sections, sourceTypes). " +
    "With processor_id: returns the full definition including filter rules, extract " +
    "patterns, aggregations, state fields, transition names, sections, and sourceTypes. " +
    "sections lists bugreport section names the processor targets; sourceTypes lists " +
    "compatible log source types (logcat, bugreport, dumpstate). Use this to " +
    "understand pipeline results before drilling into specifics. Both shapes are " +
    "assembled from the processor's YAML-derived schema, which is heterogeneous " +
    "across processor types, so this is the one tool whose response is not typed " +
    "against a generated interface — treat it as free-form JSON.",
  {
    processor_id: z
      .string()
      .optional()
      .describe("Specific processor ID for full definition (qualified or bare — omit for summary list)"),
  },
  async ({ processor_id }) => {
    try {
      const path = processor_id
        ? `/mcp/processors/${encodeURIComponent(processor_id)}`
        : "/mcp/processors";
      return ok(await bridgeGet<unknown>(path));
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 16. logtapper_bookmarks ──────────────────────────────────────────────

server.tool(
  "logtapper_bookmarks",
  "Manage bookmarks on log lines within a session. Bookmarks mark lines of " +
    "interest for quick navigation. Use action 'list' to see all bookmarks " +
    "(optionally filtered by category or tag), 'create' to add a new bookmark " +
    "at a line (supports line ranges, snippets, categories, and tags), 'update' " +
    "to modify an existing bookmark's label, note, category, or tags, or " +
    "'delete' to remove one.",
  {
    session_id: z.string().describe("Session ID"),
    action: z
      .enum(["list", "create", "update", "delete"])
      .describe("Action to perform: list all bookmarks, create a new one, update an existing one, or delete an existing one"),
    line_number: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Line number to bookmark (required for 'create')"),
    label: z
      .string()
      .optional()
      .describe("Short label for the bookmark (required for 'create', optional for 'update')"),
    note: z
      .string()
      .optional()
      .describe("Optional longer note for the bookmark (used with 'create' and 'update')"),
    bookmark_id: z
      .string()
      .optional()
      .describe("Bookmark ID (required for 'update' and 'delete')"),
    line_number_end: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("End line number for range/snippet bookmarks (creates a bookmark spanning line_number to line_number_end)"),
    snippet: z
      .array(z.string())
      .optional()
      .describe("Captured raw line text for the bookmark range"),
    category: z
      .enum(["error", "warning", "state-change", "timing", "observation", "custom"])
      .optional()
      .describe("Category for visual grouping"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Free-form tags for filtering and grouping"),
    filter_category: z
      .string()
      .optional()
      .describe("Filter bookmarks by category (exact match, used with 'list')"),
    filter_tag: z
      .string()
      .optional()
      .describe("Filter bookmarks by tag (matches if bookmark has this tag, used with 'list')"),
  },
  async ({ session_id, action, line_number, label, note, bookmark_id, line_number_end, snippet, category, tags, filter_category, filter_tag }) => {
    const sid = encodeURIComponent(session_id);
    try {
      switch (action) {
        case "list":
          return ok(
            await bridgeGet<Bookmark[]>(`/mcp/sessions/${sid}/bookmarks`, {
              category: filter_category,
              tag: filter_tag,
            })
          );
        case "create": {
          if (line_number === undefined || !label) {
            return argError("line_number and label are required for 'create'");
          }
          const body: Record<string, unknown> = {
            lineNumber: line_number,
            label,
            note: note ?? "",
          };
          if (line_number_end !== undefined) body.lineNumberEnd = line_number_end;
          if (snippet !== undefined) body.snippet = snippet;
          if (category !== undefined) body.category = category;
          if (tags !== undefined) body.tags = tags;
          return ok(await bridgePost<Bookmark>(`/mcp/sessions/${sid}/bookmarks`, body));
        }
        case "update": {
          if (!bookmark_id) {
            return argError("bookmark_id is required for 'update'");
          }
          const updateBody: Record<string, unknown> = {};
          if (label !== undefined) updateBody.label = label;
          if (note !== undefined) updateBody.note = note;
          if (category !== undefined) updateBody.category = category;
          if (tags !== undefined) updateBody.tags = tags;
          return ok(
            await bridgePut<Bookmark>(
              `/mcp/sessions/${sid}/bookmarks/${encodeURIComponent(bookmark_id)}`,
              updateBody
            )
          );
        }
        case "delete":
          if (!bookmark_id) {
            return argError("bookmark_id is required for 'delete'");
          }
          return ok(
            await bridgeDelete<Ack>(`/mcp/sessions/${sid}/bookmarks/${encodeURIComponent(bookmark_id)}`)
          );
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 17. logtapper_analyses ───────────────────────────────────────────────

server.tool(
  "logtapper_analyses",
  "Manage analysis artifacts — structured narratives with line references that " +
    "appear in the LogTapper UI. Analyses are workspace-owned, not session-owned: a " +
    "single analysis may reference lines across multiple sessions (or none at " +
    "all) via a per-reference sessionId. Use 'list' to see analyses, 'get' for " +
    "full content, 'publish' to create a new analysis, 'update' to revise, or " +
    "'delete' to remove. Each analysis has a title and sections with headings, " +
    "body text, optional severity, and line references. Omit session_id to " +
    "operate workspace-wide ('list' returns every analysis, 'publish' creates one " +
    "with no session verification and unattributed references stay unattributed). " +
    "Pass session_id to scope 'list' to analyses referencing that session, or to " +
    "have 'publish' verify the session exists and stamp any reference lacking its " +
    "own sessionId with it. Artifact IDs are workspace-unique, so 'get'/'update'/" +
    "'delete' always resolve the SAME artifact whether or not session_id is passed " +
    "alongside artifact_id — passing session_id there only changes one thing: on " +
    "'update', it becomes the fallback attribution for any replaced reference that " +
    "doesn't carry its own sessionId (so a client that PUTs bare references doesn't " +
    "silently de-attribute the artifact from every session). A reference left " +
    "unresolved (no sessionId, and none inferred) still displays in the UI but " +
    "cannot be attributed to a specific session's log lines.",
  {
    session_id: z
      .string()
      .optional()
      .describe(
        "Session ID. Optional: scopes 'list'/'publish' to a session; for " +
          "'update' it is the fallback attribution for a reference with no " +
          "sessionId of its own. Omit for workspace-wide list/publish, or when " +
          "'get'/'update'/'delete' need no session context."
      ),
    action: z
      .enum(["list", "get", "publish", "update", "delete"])
      .describe("Action: list, get, publish, update, or delete"),
    artifact_id: z
      .string()
      .optional()
      .describe("Analysis artifact ID (required for get, update, delete)"),
    title: z
      .string()
      .optional()
      .describe("Analysis title (required for publish, optional for update)"),
    sections: z
      .array(
        z.object({
          heading: z.string().describe("Section heading"),
          body: z.string().describe("Section body text (markdown supported)"),
          severity: z
            .enum(["Info", "Warning", "Error", "Critical"])
            .optional()
            .describe("Optional severity level for this section"),
          references: z
            .array(
              z.object({
                lineNumber: z.number().int().describe("Start line number"),
                endLine: z.number().int().optional().describe("End line number for ranges"),
                label: z.string().describe("Reference label shown in UI"),
                highlightType: z
                  .enum(["Annotation", "Anchor"])
                  .optional()
                  .describe("Highlight style: 'Annotation' (subtle) or 'Anchor' (prominent). Default 'Annotation'."),
                sessionId: z
                  .string()
                  .optional()
                  .describe(
                    "Session this reference's line numbers belong to. Omit to " +
                      "attribute it to the tool call's session_id (session-scoped " +
                      "publish), or leave it unattributed (workspace publish with " +
                      "no session_id)."
                  ),
              })
            )
            .optional()
            .describe("Line references within this section"),
        })
      )
      .optional()
      .describe("Analysis sections (required for publish, optional for update)"),
  },
  async ({ session_id, action, artifact_id, title, sections }) => {
    const sid = session_id ? encodeURIComponent(session_id) : undefined;
    try {
      switch (action) {
        case "list":
          return ok(
            await bridgeGet<AnalysisArtifact[]>(sid ? `/mcp/sessions/${sid}/analyses` : "/mcp/analyses")
          );
        case "get": {
          if (!artifact_id) {
            return argError("artifact_id is required for 'get'");
          }
          // Session-scoped or workspace-scoped lookup resolve to the same
          // artifact (ids are workspace-unique) — prefer the scoped route
          // when session_id was given, purely for full route coverage /
          // symmetry with 'update'.
          const path = sid
            ? `/mcp/sessions/${sid}/analyses/${encodeURIComponent(artifact_id)}`
            : `/mcp/analyses/${encodeURIComponent(artifact_id)}`;
          return ok(await bridgeGet<AnalysisArtifact>(path));
        }
        case "publish": {
          if (!title || !sections) {
            return argError("title and sections are required for 'publish'");
          }
          return ok(
            await bridgePost<AnalysisArtifact>(sid ? `/mcp/sessions/${sid}/analyses` : "/mcp/analyses", {
              title,
              sections,
            })
          );
        }
        case "update": {
          if (!artifact_id) {
            return argError("artifact_id is required for 'update'");
          }
          // Passing session_id here (scoped route) supplies the fallback
          // attribution for a replaced reference with no sessionId of its
          // own — see the tool description.
          const path = sid
            ? `/mcp/sessions/${sid}/analyses/${encodeURIComponent(artifact_id)}`
            : `/mcp/analyses/${encodeURIComponent(artifact_id)}`;
          return ok(await bridgePut<AnalysisArtifact>(path, { title, sections }));
        }
        case "delete": {
          if (!artifact_id) {
            return argError("artifact_id is required for 'delete'");
          }
          const path = sid
            ? `/mcp/sessions/${sid}/analyses/${encodeURIComponent(artifact_id)}`
            : `/mcp/analyses/${encodeURIComponent(artifact_id)}`;
          return ok(await bridgeDelete<Ack>(path));
        }
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 18. logtapper_watches ────────────────────────────────────────────────

server.tool(
  "logtapper_watches",
  "Manage watches — push-based filter notifications during live ADB streaming. " +
    "A watch evaluates filter criteria against every new batch of lines and fires " +
    "when matches are found. Use 'list' to see active watches, 'create' to set up " +
    "a new watch with filter criteria, or 'cancel' to stop one.",
  {
    session_id: z.string().describe("Session ID"),
    action: z
      .enum(["list", "create", "cancel"])
      .describe("Action: list active watches, create a new watch, or cancel an existing one"),
    watch_id: z
      .string()
      .optional()
      .describe("Watch ID to cancel (required for 'cancel')"),
    text_search: z
      .string()
      .optional()
      .describe("Substring to match in log lines (used with 'create')"),
    regex: z
      .string()
      .optional()
      .describe("Regex pattern to match (used with 'create')"),
    log_levels: z
      .array(z.string())
      .optional()
      .describe("Log levels to match — use PascalCase: 'Verbose', 'Debug', 'Info', 'Warn', 'Error', 'Fatal' (used with 'create')"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags to match (used with 'create')"),
    pids: z
      .array(z.number().int())
      .optional()
      .describe("Process IDs to match (used with 'create')"),
    combine: z
      .enum(["and", "or"])
      .optional()
      .describe("How to combine criteria: 'and' (all must match) or 'or' (any match) (default 'and')"),
  },
  async ({ session_id, action, watch_id, text_search, regex, log_levels, tags, pids, combine }) => {
    const sid = encodeURIComponent(session_id);
    try {
      switch (action) {
        case "list":
          return ok(await bridgeGet<WatchInfo[]>(`/mcp/sessions/${sid}/watches`));
        case "create":
          return ok(
            await bridgePost<WatchInfo>(`/mcp/sessions/${sid}/watches`, {
              textSearch: text_search,
              regex,
              logLevels: log_levels,
              tags,
              pids,
              combine: combine ?? "and",
            })
          );
        case "cancel":
          if (!watch_id) {
            return argError("watch_id is required for 'cancel'");
          }
          return ok(await bridgeDelete<Ack>(`/mcp/sessions/${sid}/watches/${encodeURIComponent(watch_id)}`));
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 19. logtapper_chain ──────────────────────────────────────────────────

server.tool(
  "logtapper_chain",
  "Read or edit a session's processor chain — the same configured analyzer " +
    "list shown in the app's Analyzers panel, and what a chain-only " +
    "logtapper_run_pipeline call (no explicit processor_ids) executes. " +
    "`activeProcessorIds` is the FULL ordered chain, including members that " +
    "are currently disabled; `disabledProcessorIds` is the subset of those " +
    "switched off. Use action 'get' to read the current chain, 'set' to " +
    "replace it outright (activeProcessorIds/disabledProcessorIds default to " +
    "empty, so calling 'set' with neither field clears the chain), 'add' to " +
    "append processor IDs to the chain (re-enabling them if they were " +
    "disabled members), or 'remove' to drop processor IDs from the chain " +
    "entirely. 'add' is strict: every ID must resolve to an installed " +
    "processor. Every change this tool makes is journaled under the calling " +
    "agent's client name, and the user can see and revert it from the app.",
  {
    session_id: z.string().describe("Session ID"),
    action: z
      .enum(["get", "set", "add", "remove"])
      .describe("Action: read the chain, replace it wholesale, append processor IDs, or drop processor IDs"),
    active_processor_ids: z
      .array(z.string())
      .optional()
      .describe("Full ordered chain, disabled members included (used with 'set'; omitted means empty)"),
    disabled_processor_ids: z
      .array(z.string())
      .optional()
      .describe("Subset of active_processor_ids that should be disabled (used with 'set'; omitted means empty)"),
    processor_ids: z
      .array(z.string())
      .optional()
      .describe("Processor IDs to append or drop (required for 'add' and 'remove')"),
  },
  async ({ session_id, action, active_processor_ids, disabled_processor_ids, processor_ids }) => {
    const sid = encodeURIComponent(session_id);
    try {
      switch (action) {
        case "get":
          return ok(await bridgeGet<ChainState>(`/mcp/sessions/${sid}/chain`));
        case "set":
          return ok(
            await bridgePut<ChainState>(`/mcp/sessions/${sid}/chain`, {
              activeProcessorIds: active_processor_ids,
              disabledProcessorIds: disabled_processor_ids,
            })
          );
        case "add":
          if (!processor_ids || processor_ids.length === 0) {
            return argError("processor_ids is required for 'add'");
          }
          return ok(await bridgePatch<ChainState>(`/mcp/sessions/${sid}/chain`, { add: processor_ids }));
        case "remove":
          if (!processor_ids || processor_ids.length === 0) {
            return argError("processor_ids is required for 'remove'");
          }
          return ok(await bridgePatch<ChainState>(`/mcp/sessions/${sid}/chain`, { remove: processor_ids }));
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 20. logtapper_run_pipeline ───────────────────────────────────────────

server.tool(
  "logtapper_run_pipeline",
  "Trigger a pipeline run on a session. Executes the session's configured " +
    "processor chain (or a specified subset). Use this to generate pipeline " +
    "results that can then be queried with logtapper_get_pipeline_results and " +
    "logtapper_get_processor_detail. This operation may take significant time " +
    "on large files (1M+ lines).\n\n" +
    "IMPORTANT semantics: omitting processor_ids no longer means 'run every " +
    "installed processor' — it means 'run this session's own configured chain' " +
    "(resolved from the session's active/disabled processor sets). A session " +
    "with no chain configured errors rather than running everything. Passing " +
    "processor_ids does NOT run them in isolation: they are ADDED to the " +
    "session's chain — visible in the app's Analyzers panel and persisted " +
    "with the workspace — before the run executes. To configure the chain " +
    "without triggering a run, use logtapper_chain instead. The response's " +
    "`effectiveProcessorIds` reports exactly which processors ran, so a " +
    "caller that passed no ids can see what was actually used.",
  {
    session_id: z.string().describe("Session ID"),
    processor_ids: z
      .array(z.string())
      .optional()
      .describe(
        "Processor IDs to add to the session's chain and run. If omitted, runs the session's own " +
          "configured chain — see the semantics note above."
      ),
  },
  async ({ session_id, processor_ids }) => {
    try {
      return ok(
        await bridgePostLong<PipelineRunResult>(
          `/mcp/sessions/${encodeURIComponent(session_id)}/run_pipeline`,
          { processorIds: processor_ids }
        )
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 21. logtapper_get_insights ───────────────────────────────────────────

server.tool(
  "logtapper_get_insights",
  "Get MCP signal insights from pipeline results. For each processor that has " +
    "a schema with MCP exposure configured, returns a rendered summary and a " +
    "list of fired signals (classified as critical/warning/info) with line " +
    "numbers and formatted messages. Processors without MCP schema return " +
    "basic emission counts only. Every signal carries `lastLine` (null for a " +
    "per-emission signal, set for an aggregate one) alongside `isAggregate`. " +
    "Run logtapper_run_pipeline first to populate pipeline results before " +
    "calling this tool.",
  {
    session_id: z.string().describe("Session ID"),
    max_signals: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max total signal events to return across all processors (default 20)"),
    processor_ids: z
      .array(z.string())
      .optional()
      .describe("Filter to specific processor IDs. If omitted, all processors are included."),
  },
  async ({ session_id, max_signals, processor_ids }) => {
    try {
      const query: Record<string, string | number | boolean | undefined> = {
        max_signals,
      };
      if (processor_ids && processor_ids.length > 0) {
        query.processor_ids = processor_ids.join(",");
      }
      return ok(
        await bridgeGet<Insights>(`/mcp/sessions/${encodeURIComponent(session_id)}/insights`, query)
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 22. logtapper_open_file ───────────────────────────────────────────────

server.tool(
  "logtapper_open_file",
  "Open a log file in LogTapper as a new session, then query it with the other " +
    "tools. Use this to load a file the user has pointed you at without them " +
    "having to open it in the UI first.\n\n" +
    "Access is gated by an allowlist the user configures in LogTapper (see " +
    "logtapper_settings action 'open_allowlist' to inspect it). The `path` " +
    "MUST be:\n" +
    "  • absolute and a local drive path (e.g. 'C:\\\\logs\\\\device.log') — relative, " +
    "UNC (\\\\\\\\server\\\\share), verbatim (\\\\\\\\?\\\\), device (\\\\\\\\.\\\\), and NTFS " +
    "alternate-data-stream paths are rejected; and\n" +
    "  • inside one of the configured allowlisted directories, OR the path of a " +
    "session that is already open (reopening is always permitted and is " +
    "idempotent — it returns the SAME sessionId).\n\n" +
    "Errors return an HTTP error whose body carries a `code`:\n" +
    "  • INVALID_PATH — the path is malformed (not absolute, UNC/verbatim/device/ADS). " +
    "The message says what was wrong; fix the path and retry.\n" +
    "  • NOT_ALLOWED — the path is not permitted. This response is DELIBERATELY " +
    "identical whether the file is outside the allowlist or does not exist, so you " +
    "cannot use it to probe for files. Do NOT retry variations to discover what " +
    "exists; if the user expects this path to work, ask them to add its directory " +
    "to LogTapper's open-file allowlist.\n\n" +
    "On success returns { sessionId, sourceType, totalLines, isIndexing }. " +
    "If `isIndexing` is true, the file is large and still being indexed in the " +
    "background: `totalLines` will keep growing. Poll logtapper_get_metadata (its " +
    "`isIndexing` flag) or logtapper_get_status until indexing settles before " +
    "relying on line counts or querying the tail of the file.\n\n" +
    "SOURCE TYPE. LogTapper normally detects the type from the file's leading " +
    "bytes, and that type decides two things: which parser reads the lines, and " +
    "which processors are eligible to run (a processor declaring " +
    "source_types: [kernel] is skipped on a Logcat session and vice versa). " +
    "Detection is a content heuristic and it can be wrong — most often on vendor " +
    "dumps whose head is a long preamble of boot tables or banners rather than " +
    "log lines, where the real format only starts thousands of lines in. Pass " +
    "`sourceType` when you know the file's provenance better than its first bytes " +
    "do: the user told you what it is, the filename or the directory it came from " +
    "identifies it, or you opened it once and the returned `sourceType` disagrees " +
    "with what the content plainly shows. Reopening the same path with a corrected " +
    "`sourceType` is the supported way to fix a misdetection — it re-indexes with " +
    "the right parser. Omit it whenever detection is right; an override is not a " +
    "default to set routinely.",
  {
    path: z
      .string()
      .describe(
        "Absolute local drive path to the log file (e.g. 'C:\\\\logs\\\\device.log'). " +
          "Must be inside the configured allowlist or already open as a session."
      ),
    sourceType: z
      .enum([
        "Logcat",
        "Kernel",
        "Radio",
        "Events",
        "Bugreport",
        "Dumpstate",
        "Tombstone",
        "ANRTrace",
      ])
      .optional()
      .describe(
        "Override content detection for this session. Omit to let LogTapper " +
          "detect the type. Use when detection is wrong or when you already know " +
          "the format — e.g. 'Kernel' for a dmesg or Samsung dumpstate_board.txt " +
          "whose head is boot-stat preamble, 'Dumpstate' for a Samsung dump, " +
          "'Bugreport' for a standard ADB bugreport. Rejected with " +
          "INVALID_SOURCE_TYPE if the value is not one of these. Not supported " +
          "for .lts session bundles, which carry their own recorded type."
      ),
  },
  async ({ path, sourceType }) => {
    try {
      return ok(
        await bridgePost<OpenedSession>("/mcp/open_file", {
          path,
          ...(sourceType ? { sourceType } : {}),
        })
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 23. logtapper_close_session ───────────────────────────────────────────

server.tool(
  "logtapper_close_session",
  "Close a log session in LogTapper and release the resources it holds. This " +
    "purges the session's pipeline/tracker/correlator results, cancels any active " +
    "ADB stream or background indexing, and — for file-backed sessions — DROPS the " +
    "underlying memory map so the file handle is released (on Windows the file is " +
    "no longer locked and can be moved or deleted).\n\n" +
    "The session ALWAYS closes, even if the user currently has it open in a tab: " +
    "LogTapper closes that tab in response. After a successful call the id no longer " +
    "appears in logtapper_list_sessions or logtapper_get_status.\n\n" +
    "Returns { ok: true } on success. If the id is not a currently loaded session, " +
    "returns an HTTP 404 error whose body carries code NOT_FOUND — call " +
    "logtapper_list_sessions to see the valid ids. Closing is idempotent from the " +
    "caller's view: once closed, re-closing the same id returns NOT_FOUND.",
  {
    session_id: z
      .string()
      .describe("Session ID from logtapper_list_sessions or logtapper_get_status"),
  },
  async ({ session_id }) => {
    try {
      return ok(
        await bridgePost<Ack>(`/mcp/sessions/${encodeURIComponent(session_id)}/close`, {})
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 24. logtapper_filters ─────────────────────────────────────────────────

server.tool(
  "logtapper_filters",
  "Run a persistent, server-side filter scan over a session and page through its " +
    "matches. Unlike logtapper_query/logtapper_search (which scan on every call), " +
    "a filter scans ONCE in the background and its matches can then be paged " +
    "cheaply. Use 'create' to start a scan, 'info' to poll its status " +
    "('scanning' | 'complete' | 'cancelled') and match count, 'lines' to page " +
    "through matched lines, 'cancel' to stop an in-progress scan early, and " +
    "'close' to discard it.\n\n" +
    "SNAPSHOT SEMANTICS — the one thing to get right: a filter's `totalLines` is " +
    "captured once, at 'create' time. It only ever scans `[0, totalLines)`. Lines " +
    "a live ADB stream receives AFTER creation are never covered, even while the " +
    "filter is still scanning, and even after it reports 'complete'. To cover " +
    "new data, create a fresh filter — or use logtapper_watches for a live, " +
    "push-based subscription instead. 'cancel' stops the scan early; 'close' " +
    "additionally discards the filter's id and matched-line bookkeeping. Neither " +
    "touches the session's own history or any other filter's results.",
  {
    session_id: z.string().optional().describe("Session ID (required for 'create')"),
    filter_id: z.string().optional().describe("Filter ID from 'create' (required for 'info', 'lines', 'cancel', 'close')"),
    action: z
      .enum(["create", "info", "lines", "cancel", "close"])
      .describe("Action to perform"),
    text_search: z.string().optional().describe("Substring search, case-insensitive (used with 'create')"),
    regex: z.string().optional().describe("Regex pattern against message content (used with 'create')"),
    log_levels: z
      .array(z.enum(["Verbose", "Debug", "Info", "Warn", "Error", "Fatal"]))
      .optional()
      .describe("Include only lines at these levels (used with 'create')"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Include only lines whose tag contains any of these substrings, case-insensitive (used with 'create')"),
    time_start: z
      .number()
      .int()
      .optional()
      .describe("Minimum timestamp, ns since 2000-01-01 UTC, inclusive (used with 'create')"),
    time_end: z
      .number()
      .int()
      .optional()
      .describe("Maximum timestamp, ns since 2000-01-01 UTC, inclusive (used with 'create')"),
    pids: z.array(z.number().int()).optional().describe("Include only lines from these PIDs (used with 'create')"),
    combine: z
      .enum(["and", "or"])
      .optional()
      .describe("How to combine the above criteria (default 'and', used with 'create')"),
    offset: z.number().int().min(0).optional().describe("0-based start into the matched-line list (used with 'lines', default 0)"),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Page size (used with 'lines', default 200, capped at 1000 regardless of what is requested)"),
  },
  async ({ session_id, filter_id, action, text_search, regex, log_levels, tags, time_start, time_end, pids, combine, offset, limit }) => {
    try {
      switch (action) {
        case "create": {
          if (!session_id) {
            return argError("session_id is required for 'create'");
          }
          const criteria = {
            textSearch: text_search ?? null,
            regex: regex ?? null,
            logLevels: log_levels ?? null,
            tags: tags ?? null,
            timeStart: time_start ?? null,
            timeEnd: time_end ?? null,
            pids: pids ?? null,
            combine: combine ?? "and",
          };
          return ok(
            await bridgePost<FilterCreateResult>(
              `/mcp/sessions/${encodeURIComponent(session_id)}/filters`,
              criteria
            )
          );
        }
        case "info": {
          if (!filter_id) return argError("filter_id is required for 'info'");
          return ok(await bridgeGet<FilterInfo>(`/mcp/filters/${encodeURIComponent(filter_id)}`));
        }
        case "lines": {
          if (!filter_id) return argError("filter_id is required for 'lines'");
          return ok(
            await bridgeGet<FilteredLinesResult>(`/mcp/filters/${encodeURIComponent(filter_id)}/lines`, {
              offset,
              limit,
            })
          );
        }
        case "cancel": {
          if (!filter_id) return argError("filter_id is required for 'cancel'");
          return ok(await bridgePost<Ack>(`/mcp/filters/${encodeURIComponent(filter_id)}/cancel`, {}));
        }
        case "close": {
          if (!filter_id) return argError("filter_id is required for 'close'");
          return ok(await bridgeDelete<Ack>(`/mcp/filters/${encodeURIComponent(filter_id)}`));
        }
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 25. logtapper_workspace ───────────────────────────────────────────────

server.tool(
  "logtapper_workspace",
  "Manage LogTapper workspaces (`.ltw` files) — the saved set of open sessions, " +
    "pipeline chain, and editor layout. Use 'list' to see every known workspace, " +
    "'current' for what the backend currently believes the active workspace is, " +
    "'load' to open a `.ltw` end-to-end (opens and restores every session it " +
    "names), 'save' to write a `.ltw` to a caller-chosen path, 'autosave' to " +
    "write to the app-owned per-workspace autosave slot (no destination to choose), " +
    "'rename' to change a workspace's app-state display name, and 'delete' to " +
    "remove a workspace from the app-state list (optionally also deleting its " +
    "`.ltw` file).\n\n" +
    "GATES: 'load' resolves `path` the same way logtapper_open_file resolves a log " +
    "path — outside the open allowlist and nonexistent both fail identically with " +
    "NOT_ALLOWED — and then opens every session the manifest names through that " +
    "SAME allowlist check again (a `.ltw` is a list of file paths; honouring one " +
    "blindly would be an allowlist bypass). One entry failing does not abort the " +
    "rest — check `sessions[i].error` in the response for a partial result. 'save' " +
    "requires dest_path's PARENT DIRECTORY to already exist inside the open " +
    "allowlist; the `.ltw` file itself need not exist yet. 'autosave' has no " +
    "destination to gate — only workspace_id, constrained to a single path segment. " +
    "'delete' with delete_file=true requires the entry's saved `.ltw` path's PARENT " +
    "DIRECTORY to already be inside the open allowlist (same rule as 'save'), and " +
    "refuses to delete the currently active workspace unless force=true, which " +
    "closes its open sessions first instead of failing outright.",
  {
    action: z.enum(["list", "current", "load", "save", "autosave", "rename", "delete"]).describe("Action to perform"),
    path: z.string().optional().describe("`.ltw` path to open (required for 'load')"),
    workspace_id: z
      .string()
      .optional()
      .describe("Stable workspace identifier (required for 'save', 'autosave', 'rename', and 'delete')"),
    workspace_name: z.string().optional().describe("Display name (required for 'save' and 'autosave')"),
    new_name: z.string().optional().describe("New display name, 1-128 chars, no path separators (required for 'rename')"),
    delete_file: z
      .boolean()
      .optional()
      .describe("Also delete the entry's saved `.ltw` from disk (used with 'delete', default false)"),
    force: z
      .boolean()
      .optional()
      .describe("Close the active workspace's open sessions and delete it anyway (used with 'delete', default false)"),
    dest_path: z
      .string()
      .optional()
      .describe("Destination `.ltw` path (required for 'save' — its parent directory must be inside the open allowlist)"),
    pipeline_chain: z
      .array(z.string())
      .optional()
      .describe("Processor IDs in the active pipeline chain (used with 'save'/'autosave', default [])"),
    disabled_chain_ids: z
      .array(z.string())
      .optional()
      .describe("Processor IDs in the chain but currently disabled (used with 'save'/'autosave', default [])"),
    editor_tabs: z
      .array(z.unknown())
      .optional()
      .describe("Editor tab state, opaque to the backend (used with 'save'/'autosave', default [])"),
    layout: z
      .unknown()
      .optional()
      .describe("UI layout tree, opaque to the backend — never inspected server-side (used with 'save'/'autosave')"),
  },
  async ({
    action,
    path,
    workspace_id,
    workspace_name,
    new_name,
    delete_file,
    force,
    dest_path,
    pipeline_chain,
    disabled_chain_ids,
    editor_tabs,
    layout,
  }) => {
    try {
      switch (action) {
        case "list":
          return ok(await bridgeGet<WorkspaceList>("/mcp/workspaces"));
        case "current":
          return ok(await bridgeGet<WorkspaceSummary>("/mcp/workspace"));
        case "load": {
          if (!path) return argError("path is required for 'load'");
          return ok(await bridgePost<WorkspaceLoadOutcome>("/mcp/workspace/load", { path }));
        }
        case "save": {
          if (!workspace_id || !workspace_name || !dest_path) {
            return argError("workspace_id, workspace_name, and dest_path are required for 'save'");
          }
          return ok(
            await bridgePost<WorkspaceSaved>("/mcp/workspace/save", {
              workspaceId: workspace_id,
              destPath: dest_path,
              workspaceName: workspace_name,
              editorTabs: editor_tabs ?? [],
              layout: layout ?? null,
              pipelineChain: pipeline_chain ?? [],
              disabledChainIds: disabled_chain_ids ?? [],
            })
          );
        }
        case "autosave": {
          if (!workspace_id || !workspace_name) {
            return argError("workspace_id and workspace_name are required for 'autosave'");
          }
          return ok(
            await bridgePost<WorkspaceSaved>("/mcp/workspace/autosave", {
              workspaceId: workspace_id,
              workspaceName: workspace_name,
              editorTabs: editor_tabs ?? [],
              layout: layout ?? null,
              pipelineChain: pipeline_chain ?? [],
              disabledChainIds: disabled_chain_ids ?? [],
            })
          );
        }
        case "rename": {
          if (!workspace_id || !new_name) return argError("workspace_id and new_name are required for 'rename'");
          return ok(
            await bridgePatch<WorkspaceEntry>(`/mcp/workspaces/${encodeURIComponent(workspace_id)}`, {
              newName: new_name,
            })
          );
        }
        case "delete": {
          if (!workspace_id) return argError("workspace_id is required for 'delete'");
          return ok(
            await bridgeDelete<Ack>(`/mcp/workspaces/${encodeURIComponent(workspace_id)}`, {
              deleteFile: delete_file ?? false,
              force: force ?? false,
            })
          );
        }
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 26. logtapper_chart ───────────────────────────────────────────────────

server.tool(
  "logtapper_chart",
  "Compute a single processor's `output.charts` data for a session. Requires a " +
    "pipeline run first (logtapper_run_pipeline). Reads only structured " +
    "emission data — never raw log-line text.",
  {
    session_id: z.string().describe("Session ID"),
    processor_id: z.string().describe("The processor whose output.charts to compute"),
  },
  async ({ session_id, processor_id }) => {
    try {
      return ok(
        await bridgeGet<ChartData[]>(`/mcp/sessions/${encodeURIComponent(session_id)}/chart`, {
          processor_id,
        })
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 27. logtapper_timeline ────────────────────────────────────────────────

server.tool(
  "logtapper_timeline",
  "Compute one downsampled (line_num, value) series per `timeline`-annotated " +
    "chart spec, across a SET of processors (unlike logtapper_chart, which " +
    "takes one processor and returns every chart it declares). Requires a " +
    "pipeline run first (logtapper_run_pipeline).",
  {
    session_id: z.string().describe("Session ID"),
    processor_ids: z
      .array(z.string())
      .min(1)
      .describe("Processor IDs to search for timeline-annotated chart specs"),
  },
  async ({ session_id, processor_ids }) => {
    try {
      return ok(
        await bridgeGet<TimelineSeriesData[]>(`/mcp/sessions/${encodeURIComponent(session_id)}/timeline`, {
          processor_ids: processor_ids.join(","),
        })
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 28. logtapper_export ──────────────────────────────────────────────────

server.tool(
  "logtapper_export",
  "Export every open session (as a multi-session `.lts` bundle). Use 'info' to " +
    "see what would be exported (session count, processor counts) without " +
    "writing anything, and 'run' to actually write the bundle.\n\n" +
    "GATE: dest_path's PARENT DIRECTORY must already exist inside the MCP open " +
    "allowlist (see logtapper_settings action 'open_allowlist'); the file itself " +
    "need not exist yet. A denied destination is HTTP 403 NOT_ALLOWED — " +
    "identical whether the parent is outside the allowlist or does not exist, " +
    "by the same anti-probing design as logtapper_open_file. Raw log-line text " +
    "in the bundle is PII-redacted the same way every other raw-line tool " +
    "is — unless the user allowed raw agent access in Settings (see " +
    "logtapper_settings action 'agent_access'). `anonymize` is a Ui-only " +
    "option (the desktop app's Export dialog checkbox) and is SILENTLY " +
    "IGNORED for an agent caller — an agent's export redaction is governed " +
    "solely by 'agent_access', never by this flag.",
  {
    action: z.enum(["info", "run"]).describe("Action to perform"),
    dest_path: z.string().optional().describe("Destination `.lts` path (required for 'run')"),
    include_bookmarks: z.boolean().optional().describe("Include bookmarks in the bundle (used with 'run', default true)"),
    include_analyses: z.boolean().optional().describe("Include analysis artifacts in the bundle (used with 'run', default true)"),
    include_processors: z.boolean().optional().describe("Include installed processor definitions in the bundle (used with 'run', default true)"),
    anonymize: z.boolean().optional().describe("Ui-only; ignored for an agent caller (see the tool description)"),
  },
  async ({ action, dest_path, include_bookmarks, include_analyses, include_processors, anonymize }) => {
    try {
      switch (action) {
        case "info":
          return ok(await bridgeGet<ExportAllSessionsInfo>("/mcp/export/info"));
        case "run": {
          if (!dest_path) return argError("dest_path is required for 'run'");
          return ok(
            await bridgePostLong<Ack>("/mcp/export", {
              destPath: dest_path,
              includeBookmarks: include_bookmarks ?? true,
              includeAnalyses: include_analyses ?? true,
              includeProcessors: include_processors ?? true,
              editorTabs: [],
              anonymize: anonymize ?? false,
            })
          );
        }
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 29. logtapper_processors ──────────────────────────────────────────────

server.tool(
  "logtapper_processors",
  "Install, uninstall, or list installed processor packs. Use 'install' to " +
    "install a single processor from a raw YAML string, 'uninstall' to remove " +
    "an installed processor by id, and 'packs' to list every installed " +
    "processor pack. To browse or install FROM a configured marketplace " +
    "source, use logtapper_marketplace instead — this tool is for a YAML the " +
    "caller already has in hand.",
  {
    action: z.enum(["install", "uninstall", "packs"]).describe("Action to perform"),
    yaml: z.string().optional().describe("Raw processor YAML (required for 'install')"),
    processor_id: z.string().optional().describe("Processor ID to uninstall (required for 'uninstall')"),
  },
  async ({ action, yaml, processor_id }) => {
    try {
      switch (action) {
        case "install": {
          if (!yaml) return argError("yaml is required for 'install'");
          return ok(await bridgePost<ProcessorSummary>("/mcp/processors/install", { yaml }));
        }
        case "uninstall": {
          if (!processor_id) return argError("processor_id is required for 'uninstall'");
          return ok(await bridgeDelete<Ack>(`/mcp/processors/${encodeURIComponent(processor_id)}`));
        }
        case "packs":
          return ok(await bridgeGet<PackSummary[]>("/mcp/packs"));
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 30. logtapper_marketplace ─────────────────────────────────────────────

server.tool(
  "logtapper_marketplace",
  "Browse and install from LogTapper's configured marketplace sources. Use " +
    "'sources' to list configured sources, 'fetch' to pull one source's index " +
    "(available processors and packs), 'updates' to check every enabled source " +
    "for newer versions of already-installed processors, 'install' to install a " +
    "processor or pack by naming exactly one of entry/pack from a fetched index, " +
    "and 'update_all' to update every outdated processor installed from one " +
    "source.\n\n" +
    "GATE: there is deliberately no action to add or remove a marketplace " +
    "source — a source is where every future processor install's CODE comes " +
    "from, so that stays a human-only decision made in the LogTapper UI. " +
    "Installing FROM an already-configured source is unrestricted, the same as " +
    "any other tool use.",
  {
    action: z.enum(["sources", "fetch", "updates", "install", "update_all"]).describe("Action to perform"),
    source_id: z
      .string()
      .optional()
      .describe("Source name (required for 'fetch' and 'update_all')"),
    source_name: z.string().optional().describe("Source name to install from (required for 'install')"),
    entry: z
      .object({
        id: z.string(),
        name: z.string(),
        path: z.string(),
        version: z.string(),
        sha256: z.string().optional(),
      })
      .optional()
      .describe("A processor entry from a 'fetch' result's `processors[]` — pass this XOR `pack` for 'install'"),
    pack: z
      .object({
        id: z.string(),
        name: z.string(),
        version: z.string(),
        description: z.string().nullable().optional(),
        path: z.string(),
        tags: z.array(z.string()).default([]),
        sha256: z.string(),
        category: z.string().nullable().optional(),
        processor_ids: z.array(z.string()).default([]),
      })
      .optional()
      .describe("A pack entry from a 'fetch' result's `packs[]` — pass this XOR `entry` for 'install'"),
  },
  async ({ action, source_id, source_name, entry, pack }) => {
    try {
      switch (action) {
        case "sources":
          return ok(await bridgeGet<Source[]>("/mcp/marketplace/sources"));
        case "fetch": {
          if (!source_id) return argError("source_id is required for 'fetch'");
          return ok(
            await bridgeGet<MarketplaceFetchResult>(
              `/mcp/marketplace/sources/${encodeURIComponent(source_id)}/fetch`
            )
          );
        }
        case "updates":
          return ok(await bridgeGet<UpdateCheckResult>("/mcp/marketplace/updates"));
        case "install": {
          if (!source_name) return argError("source_name is required for 'install'");
          if ((!entry && !pack) || (entry && pack)) {
            return argError("exactly one of 'entry' or 'pack' is required for 'install'");
          }
          return ok(
            // Response is an untagged union (bare ProcessorSummary or bare
            // PackSummary, no discriminant) — the caller already knows which
            // it sent. No generated type exists for this union (it is a
            // route-local Rust enum, not a `services::wire` type), so it is
            // typed here as the local `MarketplaceInstallResult` alias.
            await bridgePost<MarketplaceInstallResult>("/mcp/marketplace/install", {
              sourceName: source_name,
              entry: entry ?? undefined,
              pack: pack ?? undefined,
            })
          );
        }
        case "update_all": {
          if (!source_id) return argError("source_id is required for 'update_all'");
          return ok(
            await bridgePost<UpdateResult[]>(
              `/mcp/marketplace/update_all/${encodeURIComponent(source_id)}`,
              {}
            )
          );
        }
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 31. logtapper_stream ──────────────────────────────────────────────────

server.tool(
  "logtapper_stream",
  "Start and monitor a live ADB logcat capture. Use 'devices' to list attached " +
    "devices, 'start' to begin capturing from one, 'status' to check a stream's " +
    "line/byte counts and active processors, 'events' to poll the agent event " +
    "feed, 'stop' to end the capture, and 'save' to write everything captured " +
    "so far to a file.\n\n" +
    "POLLING CONTRACT for 'events': an agent has no persistent socket, so after " +
    "'start' you poll 'events' on a loop, passing back each response's " +
    "`nextSince` as the next call's `since` — 0 (the default) means 'everything " +
    "still retained'. `latestSeq - nextSince` tells you how far behind you are; " +
    "`gap: true` means you fell more than the ring's capacity behind and the " +
    "missing events are gone for good (poll faster, or raise `limit`). Sequence " +
    "numbers start at 1 and are per-session.\n\n" +
    "GATE for 'save': dest_path's PARENT DIRECTORY must already exist inside the " +
    "MCP open allowlist; the file itself need not exist. Denied and " +
    "nonexistent both fail identically as NOT_ALLOWED, by the same design as " +
    "logtapper_open_file.",
  {
    action: z.enum(["devices", "start", "status", "events", "stop", "save"]).describe("Action to perform"),
    session_id: z
      .string()
      .optional()
      .describe("Session ID from 'start' (required for 'status', 'events', 'stop', 'save')"),
    device_id: z
      .string()
      .optional()
      .describe("Device serial (used with 'start'; omit to auto-pick the single connected device — errors if zero or more than one is attached)"),
    package_filter: z
      .string()
      .optional()
      .describe("Package name to resolve to a --pid filter (used with 'start'; omit to stream unfiltered)"),
    processor_ids: z
      .array(z.string())
      .optional()
      .describe("Processors to run continuously over the stream (used with 'start'; omit for no chain)"),
    max_raw_lines: z
      .number()
      .int()
      .optional()
      .describe("Raw lines kept in the backend buffer before the oldest are evicted (used with 'start', default 500000)"),
    since: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Cursor from the previous poll's nextSince (used with 'events', default 0 — 'everything still retained')"),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Page size (used with 'events', default 200, capped at the ring's capacity)"),
    dest_path: z.string().optional().describe("Destination file path (required for 'save')"),
  },
  async ({ action, session_id, device_id, package_filter, processor_ids, max_raw_lines, since, limit, dest_path }) => {
    try {
      switch (action) {
        case "devices":
          return ok(await bridgeGet<AdbDeviceList>("/mcp/adb/devices"));
        case "start": {
          const body: StartStreamRequest = {
            deviceId: device_id ?? null,
            packageFilter: package_filter ?? null,
            processorIds: processor_ids ?? null,
            maxRawLines: max_raw_lines ?? null,
          };
          return ok(await bridgePost<StreamStarted>("/mcp/adb/stream", body));
        }
        case "status": {
          if (!session_id) return argError("session_id is required for 'status'");
          return ok(
            await bridgeGet<StreamStatus>(`/mcp/sessions/${encodeURIComponent(session_id)}/stream/status`)
          );
        }
        case "events": {
          if (!session_id) return argError("session_id is required for 'events'");
          return ok(
            await bridgeGet<StreamEventsPage>(
              `/mcp/sessions/${encodeURIComponent(session_id)}/stream/events`,
              { since, limit }
            )
          );
        }
        case "stop": {
          if (!session_id) return argError("session_id is required for 'stop'");
          return ok(
            await bridgePost<Ack>(`/mcp/sessions/${encodeURIComponent(session_id)}/stream/stop`, {})
          );
        }
        case "save": {
          if (!session_id) return argError("session_id is required for 'save'");
          if (!dest_path) return argError("dest_path is required for 'save'");
          return ok(
            await bridgePost<StreamSaved>(`/mcp/sessions/${encodeURIComponent(session_id)}/stream/save`, {
              destPath: dest_path,
            })
          );
        }
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 32. logtapper_settings ────────────────────────────────────────────────

server.tool(
  "logtapper_settings",
  "Read LogTapper's anonymizer configuration, MCP open-file allowlist and " +
    "agent raw-log-access setting, and preview what the anonymizer would " +
    "redact in arbitrary text. Use 'anonymizer' to see the configured PII " +
    "detectors, 'open_allowlist' to see which directories " +
    "logtapper_open_file/logtapper_export/logtapper_stream ('save') will " +
    "accept, 'agent_access' to see whether the log text you receive is " +
    "redacted, and 'test' to preview redaction on text you supply (nothing " +
    "is persisted or changed — safe to call freely).\n\n" +
    "ANONYMIZATION IS ON UNLESS THE USER TURNED IT OFF: every raw log line " +
    "you read through any tool — query, search, lines_around, processor " +
    "detail, insights, filter lines, stream events, export — is " +
    "PII-redacted (<EMAIL-1>, <IPv4-2>, ...) unless the user ticked 'Allow " +
    "agents to read raw (un-anonymized) log text' in LogTapper's Settings " +
    "→ General → MCP Integration. 'agent_access' returns { agentRawAccess } " +
    "so you can say which one you are seeing. Redaction tokens are stable " +
    "within a session, so you can still correlate on them; never ask the " +
    "user to paste an un-redacted value unless they raise it themselves.\n\n" +
    "READ-ONLY BY DESIGN: there are no actions to change any of these. An " +
    "agent widening its own anonymizer config, open-file allowlist or " +
    "raw-log access would be an agent granting itself more access — that " +
    "stays a human-only decision made in the LogTapper UI. If a path you " +
    "need isn't covered, tell the user and ask them to add it, the same " +
    "guidance logtapper_open_file gives.",
  {
    action: z.enum(["anonymizer", "open_allowlist", "agent_access", "test"]).describe("Action to perform"),
    text: z.string().optional().describe("Text to preview redaction on (required for 'test')"),
  },
  async ({ action, text }) => {
    try {
      switch (action) {
        case "anonymizer":
          return ok(await bridgeGet<AnonymizerConfig>("/mcp/settings/anonymizer"));
        case "open_allowlist":
          return ok(await bridgeGet<McpOpenAllowlist>("/mcp/settings/open_allowlist"));
        case "agent_access":
          return ok(await bridgeGet<McpAgentAccess>("/mcp/settings/agent_access"));
        case "test": {
          if (text === undefined) return argError("text is required for 'test'");
          return ok(
            await bridgePost<AnonymizerTestResult>("/mcp/settings/anonymizer/test", { text })
          );
        }
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 33. logtapper_activity ────────────────────────────────────────────────

server.tool(
  "logtapper_activity",
  "Read the shared activity journal — every state-changing action taken " +
    "either by the user in the UI or by an agent through this MCP server, in " +
    "one feed (so an agent and the UI never disagree about what happened). " +
    "Use `since` (an entry id from a previous call) to page forward and see " +
    "only what's new; omit it to see the most recent entries up to `limit`. " +
    "Reads are never journaled, so polling this tool does not add to its own " +
    "feed.",
  {
    since: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Return only entries with id > since. Omit for everything retained."),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Cap the result at the newest `limit` entries."),
  },
  async ({ since, limit }) => {
    try {
      return ok(await bridgeGet<ActivityEntry[]>("/mcp/activity", { since, limit }));
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 34. logtapper_focus ─────────────────────────────────────────────────────

server.tool(
  "logtapper_focus",
  "Manage the shared focus context — an explicit \"ask about this\" handoff " +
    "between the UI and an agent (distinct from which pane the UI happens to " +
    "have open). Use 'get' to read it, 'set' to point at a session/line/section " +
    "(and optionally a selection range or note), and 'clear' to remove it. " +
    "Whoever calls 'set' is recorded as `setBy` — you cannot claim another " +
    "caller's identity or backdate `ts`.",
  {
    action: z.enum(["get", "set", "clear"]).describe("Action to perform"),
    session_id: z.string().optional().describe("Session ID to focus (required for 'set')"),
    line: z.number().int().min(0).optional().describe("Line number to focus (used with 'set')"),
    section: z.string().optional().describe("Section name to focus (used with 'set')"),
    selection_start: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Selection range start line, inclusive (used with 'set'; requires selection_end)"),
    selection_end: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Selection range end line, inclusive (used with 'set'; requires selection_start)"),
    note: z.string().optional().describe("Free-text note describing why this is focused (used with 'set')"),
  },
  async ({ action, session_id, line, section, selection_start, selection_end, note }) => {
    try {
      switch (action) {
        case "get":
          return ok(await bridgeGet<FocusContext | null>("/mcp/focus"));
        case "set": {
          if (!session_id) return argError("session_id is required for 'set'");
          const selection =
            selection_start !== undefined && selection_end !== undefined
              ? { start: selection_start, end: selection_end }
              : null;
          return ok(
            await bridgePut<FocusContext>("/mcp/focus", {
              sessionId: session_id,
              line: line ?? null,
              section: section ?? null,
              selection,
              note: note ?? null,
            })
          );
        }
        case "clear":
          return ok(await bridgeDelete<Ack>("/mcp/focus"));
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 35. logtapper_navigate ───────────────────────────────────────────────────

server.tool(
  "logtapper_navigate",
  "Ask the UI to jump to a specific line or analysis in a session. This never " +
    "applies the jump itself — it journals the request and emits it as an " +
    "event; the UI decides whether to navigate immediately or hold for the " +
    "user's confirmation. `reason` is required and shows up in the activity " +
    "feed, so make it something the user can act on.",
  {
    session_id: z.string().describe("Session ID to navigate within"),
    line: z.number().int().min(0).optional().describe("Line number to jump to"),
    analysis_id: z.string().optional().describe("Analysis artifact ID to open instead of (or alongside) a line"),
    reason: z.string().describe("Why the UI should navigate here — shown to the user"),
  },
  async ({ session_id, line, analysis_id, reason }) => {
    try {
      return ok(
        await bridgePost<NavRequest>("/mcp/navigate", {
          sessionId: session_id,
          line: line ?? null,
          analysisId: analysis_id ?? null,
          reason,
        })
      );
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ── 36. logtapper_themes ─────────────────────────────────────────────────────

server.tool(
  "logtapper_themes",
  "Read LogTapper's stored user themes (custom colour/token overrides on top " +
    "of one of the four built-in themes: dark, light, dark-hc, light-hc). " +
    "Use 'list' to see every stored theme's slug/name/base, and 'read' to get " +
    "one theme's full token map. READ-ONLY BY DESIGN: there is no write or " +
    "delete action here — creating, replacing, or deleting a theme is a " +
    "human-only decision made in LogTapper's Settings UI, the same reasoning " +
    "as logtapper_settings for the anonymizer config and open-file allowlist.",
  {
    action: z.enum(["list", "read"]).describe("Action to perform"),
    slug: z.string().optional().describe("Theme slug to read (required for 'read')"),
  },
  async ({ action, slug }) => {
    try {
      switch (action) {
        case "list":
          return ok(await bridgeGet<ThemeSummary[]>("/mcp/themes"));
        case "read":
          if (!slug) return argError("slug is required for 'read'");
          return ok(await bridgeGet<UserTheme>(`/mcp/themes/${encodeURIComponent(slug)}`));
      }
    } catch (err) {
      return handleBridgeError(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Types with no generated twin
// ---------------------------------------------------------------------------

/**
 * `POST /mcp/marketplace/install`'s response is an untagged Rust enum defined
 * locally in `mcp_bridge::routes::processors` (`MarketplaceInstallResult`),
 * not a `services::wire` type — so it has no ts-rs binding. The wire shape is
 * exactly a bare `ProcessorSummary` or a bare `PackSummary`; this alias
 * documents that rather than falling back to `unknown`.
 */
type MarketplaceInstallResult = ProcessorSummary | PackSummary;
