/**
 * LogTapper MCP Server
 *
 * Exposes LogTapper's live log data as MCP tools that Claude (and other
 * MCP-compatible agents) can call directly.
 *
 * Transport: stdio (Claude Code / Claude Desktop spawns this as a subprocess)
 * Bridge:    HTTP calls to localhost:40404 (Tauri app's internal HTTP bridge)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_PORT = 40404;
const BASE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

// ---------------------------------------------------------------------------
// Bridge client — thin wrapper around fetch with a 5s timeout
// ---------------------------------------------------------------------------

async function bridgeGet(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Bridge HTTP ${res.status}: ${body}`);
  }

  return res.json();
}

function notRunning(): { content: Array<{ type: "text"; text: string }> } {
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

function ok(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "logtapper",
  version: "1.0.0",
  description:
    "Query live Android log sessions loaded in LogTapper. " +
    "Use these tools to inspect log content, state-tracker events, and " +
    "processor results before designing new YAML processors.",
});

// ── logtapper_get_status ───────────────────────────────────────────────────

server.tool(
  "logtapper_get_status",
  "Check whether LogTapper is running and list the IDs of all currently " +
    "loaded log sessions. Call this first to confirm the app is available " +
    "and to discover session IDs for subsequent queries.",
  {},
  async () => {
    try {
      return ok(await bridgeGet("/mcp/status"));
    } catch {
      return notRunning();
    }
  }
);

// ── logtapper_list_sessions ───────────────────────────────────────────────

server.tool(
  "logtapper_list_sessions",
  "List all active log sessions with their source files, line counts, " +
    "source types (Logcat / Bugreport / Kernel), and the installed " +
    "processors that have pipeline results. Use this to understand what " +
    "data is currently loaded before querying lines or events.",
  {},
  async () => {
    try {
      return ok(await bridgeGet("/mcp/sessions"));
    } catch {
      return notRunning();
    }
  }
);

// ── logtapper_query ───────────────────────────────────────────────────────

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
    "  message — substring match against the raw line",
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
  },
  async ({ session_id, n, strategy, around_line, level, tag, message }) => {
    try {
      return ok(
        await bridgeGet(`/mcp/sessions/${encodeURIComponent(session_id)}/query`, {
          n,
          strategy,
          around_line,
          level,
          tag,
          message,
        })
      );
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── logtapper_get_pipeline_results ───────────────────────────────────────

server.tool(
  "logtapper_get_pipeline_results",
  "Get a compact summary of the last pipeline run. Returns per-processor overviews:\n" +
    "  reporters     — matchedLines count, emission count, top vars (large maps truncated to top 20), 10 recent emissions with extracted fields, 5 sample matched lines with raw text\n" +
    "  state_trackers — transitionCount, finalState, 20 most recent transitions with raw line text\n" +
    "\nFor detailed drill-down into a single processor's emissions and matched lines, use logtapper_get_processor_detail.\n" +
    "Returns hasResults:false if the pipeline has not been run yet.",
  {
    session_id: z.string().describe("Session ID"),
    processor_id: z.string().optional().describe("Filter to a single processor ID"),
  },
  async ({ session_id, processor_id }) => {
    try {
      return ok(
        await bridgeGet(`/mcp/sessions/${encodeURIComponent(session_id)}/pipeline`, {
          processor_id,
        })
      );
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── logtapper_get_events ─────────────────────────────────────────────────

server.tool(
  "logtapper_get_events",
  "Get the most recent StateTracker transition events for a session, " +
    "sorted newest-first. StateTrackers fire on meaningful semantic changes " +
    "in the log (e.g. WiFi connected/disconnected, app lifecycle, battery " +
    "state). These events are the pre-digested signal layer — use them to " +
    "understand what happened before diving into raw lines. " +
    "\nNote: events are only available after running the pipeline " +
    "(or during a live ADB stream with trackers active).",
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
        await bridgeGet(`/mcp/sessions/${encodeURIComponent(session_id)}/events`, {
          limit,
        })
      );
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── logtapper_get_processor_detail ────────────────────────────────────────

server.tool(
  "logtapper_get_processor_detail",
  "Drill into a single processor's detailed results. For reporters: full vars, " +
    "optional paginated emissions with extracted fields, matched line numbers. " +
    "For state trackers: full transition list. Use include_emissions=true to see " +
    "emission data. Use include_line_text=true to include raw log line snippets " +
    "(avoids separate logtapper_query calls).",
  {
    session_id: z.string().describe("Session ID"),
    processor_id: z.string().describe("Processor ID to drill into"),
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
        await bridgeGet(
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
      return ok({ error: String(err) });
    }
  }
);

// ── logtapper_get_state_at_line ──────────────────────────────────────────

server.tool(
  "logtapper_get_state_at_line",
  "Reconstruct a state tracker's state at a specific log line. Useful for " +
    "answering questions like 'what was the WiFi state when this crash happened?' " +
    "Returns the state snapshot with all field values at the given line, plus the " +
    "most recent transition before that line.",
  {
    session_id: z.string().describe("Session ID"),
    tracker_id: z.string().describe("State tracker processor ID"),
    line_num: z
      .number()
      .int()
      .min(0)
      .describe("Line number to reconstruct state at"),
  },
  async ({ session_id, tracker_id, line_num }) => {
    try {
      return ok(
        await bridgeGet(
          `/mcp/sessions/${encodeURIComponent(session_id)}/tracker/${encodeURIComponent(tracker_id)}/state_at`,
          { line: line_num }
        )
      );
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── logtapper_get_correlations ───────────────────────────────────────────

server.tool(
  "logtapper_get_correlations",
  "Get correlation events showing cross-signal relationships. Correlators detect " +
    "when events from different log sources co-occur within a time/line window " +
    "(e.g., FD spikes correlated with EBADF errors). Returns trigger line, matched " +
    "sources, and formatted diagnostic message.",
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
        await bridgeGet(
          `/mcp/sessions/${encodeURIComponent(session_id)}/correlations`,
          { correlator_id, limit, offset }
        )
      );
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── logtapper_get_processor_definitions ──────────────────────────────────

server.tool(
  "logtapper_get_processor_definitions",
  "Get processor definitions to understand what each processor detects. " +
    "Without processor_id: returns a summary list (id, name, type, description). " +
    "With processor_id: returns the full definition including filter rules, extract " +
    "patterns, aggregations, state fields, and transition names. Use this to " +
    "understand pipeline results before drilling into specifics.",
  {
    processor_id: z
      .string()
      .optional()
      .describe("Specific processor ID for full definition (omit for summary list)"),
  },
  async ({ processor_id }) => {
    try {
      const path = processor_id
        ? `/mcp/processors/${encodeURIComponent(processor_id)}`
        : "/mcp/processors";
      return ok(await bridgeGet(path));
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── logtapper_search ─────────────────────────────────────────────────────

server.tool(
  "logtapper_search",
  "Search log lines using regex patterns. More powerful than logtapper_query's " +
    "substring matching. Returns matched lines with capture groups and optional " +
    "context lines before/after each match. Use for pattern-based investigation " +
    "like finding all 'FATAL EXCEPTION.*Process: (\\S+)' matches.",
  {
    session_id: z.string().describe("Session ID"),
    pattern: z.string().describe("Regex pattern to search for"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Max results to return (default 50)"),
    case_insensitive: z
      .boolean()
      .optional()
      .describe("Case-insensitive matching (default false)"),
    context: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe("Lines of context before/after each match (default 0)"),
  },
  async ({ session_id, pattern, limit, case_insensitive, context }) => {
    try {
      return ok(
        await bridgeGet(
          `/mcp/sessions/${encodeURIComponent(session_id)}/search`,
          { pattern, limit, case_insensitive: case_insensitive !== undefined ? String(case_insensitive) : undefined, context }
        )
      );
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ---------------------------------------------------------------------------
// Connect and run
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// ---------------------------------------------------------------------------
// Heartbeat — ping the bridge every 10 s so the Tauri app knows this MCP
// server process is alive, even when no tools are being invoked.
// The frontend uses mcp_last_activity (stamped on every bridge request) to
// distinguish "connected" from "ready (idle)" state.
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 10_000;

setInterval(() => {
  fetch(`${BASE_URL}/mcp/status`, { signal: AbortSignal.timeout(4_000) })
    .catch(() => { /* LogTapper not running — silently ignore */ });
}, HEARTBEAT_INTERVAL_MS);
