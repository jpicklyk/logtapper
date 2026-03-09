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
// Bridge client — thin wrappers around fetch with an 8s timeout
// ---------------------------------------------------------------------------

async function bridgeGet(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<unknown> {
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

async function bridgePost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Bridge HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

async function bridgePostLong(path: string, body: unknown, timeoutMs = 120_000): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Bridge HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

async function bridgePut(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Bridge HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

async function bridgeDelete(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Bridge HTTP ${res.status}: ${text}`);
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

// ── 1. logtapper_get_status ─────────────────────────────────────────────

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

// ── 2. logtapper_list_sessions ──────────────────────────────────────────

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

// ── 3. logtapper_get_metadata ───────────────────────────────────────────

server.tool(
  "logtapper_get_metadata",
  "Get lightweight metadata for a log session. Returns source name/type, " +
    "total line count, file size, whether the session is live (ADB), time range, " +
    "and section count. Does NOT include tag stats or full section details — " +
    "use logtapper_get_sections for section name/startLine/endLine mapping. " +
    "Call this as the first query against a session to orient.",
  {
    session_id: z.string().describe("Session ID from logtapper_get_status or logtapper_list_sessions"),
  },
  async ({ session_id }) => {
    try {
      return ok(
        await bridgeGet(`/mcp/sessions/${encodeURIComponent(session_id)}/metadata`)
      );
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── 3b. logtapper_get_sections ──────────────────────────────────────────

server.tool(
  "logtapper_get_sections",
  "Get the named sections of a bugreport or dumpstate log file. Returns an " +
    "array of {name, startLine, endLine} for each section (e.g. 'SYSTEM LOG', " +
    "'DUMPSYS NORMAL', 'KERNEL LOG'). Use startLine/endLine with " +
    "logtapper_query or logtapper_search_with_context's start_line/end_line " +
    "params to target specific sections. Returns an empty array for non-bugreport " +
    "files (logcat, kernel).",
  {
    session_id: z.string().describe("Session ID"),
  },
  async ({ session_id }) => {
    try {
      return ok(
        await bridgeGet(`/mcp/sessions/${encodeURIComponent(session_id)}/sections`)
      );
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── 4. logtapper_query ──────────────────────────────────────────────────

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
        await bridgeGet(`/mcp/sessions/${encodeURIComponent(session_id)}/query`, {
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
      return ok({ error: String(err) });
    }
  }
);

// ── 5. logtapper_search_with_context ────────────────────────────────────

server.tool(
  "logtapper_search_with_context",
  "Search log lines using regex patterns with surrounding context. Returns " +
    "grouped matches where each group includes the matched line plus " +
    "configurable context lines before/after, each marked with an isMatch " +
    "flag. More powerful than logtapper_query's substring matching — use for " +
    "pattern-based investigation like finding all crash signatures or " +
    "specific error sequences. Use offset for pagination through large " +
    "result sets (skip first N matches).",
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
  },
  async ({ session_id, query, max_results, context_lines, case_insensitive, offset, start_line, end_line }) => {
    try {
      return ok(
        await bridgeGet(
          `/mcp/sessions/${encodeURIComponent(session_id)}/search_with_context`,
          {
            query,
            max_results,
            context_lines,
            case_insensitive: case_insensitive !== undefined ? String(case_insensitive) : undefined,
            offset,
            start_line,
            end_line,
          }
        )
      );
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── 6. logtapper_get_lines_around ───────────────────────────────────────

server.tool(
  "logtapper_get_lines_around",
  "Get raw log lines centered on a specific line number. Returns lines with " +
    "level, tag, and raw text, plus an isCenter flag on the target line. Use " +
    "this to examine context around a known line of interest (e.g., a crash " +
    "line, a state transition, or a bookmarked location).",
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
        await bridgeGet(
          `/mcp/sessions/${encodeURIComponent(session_id)}/lines_around`,
          { line, before, after }
        )
      );
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── 7. logtapper_get_pipeline_results ───────────────────────────────────

server.tool(
  "logtapper_get_pipeline_results",
  "Get a compact summary of the last pipeline run. Returns per-processor overviews:\n" +
    "  reporters     — matchedLines count, emission count, top vars (large maps truncated to top 20), 10 recent emissions with extracted fields, 5 sample matched lines with raw text\n" +
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
        await bridgeGet(`/mcp/sessions/${encodeURIComponent(session_id)}/pipeline`, {
          processor_id,
        })
      );
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── 8. logtapper_get_events ─────────────────────────────────────────────

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

// ── 9. logtapper_get_processor_detail ───────────────────────────────────

server.tool(
  "logtapper_get_processor_detail",
  "Drill into a single processor's detailed results. For reporters: full vars, " +
    "optional paginated emissions with extracted fields, matched line numbers. " +
    "For state trackers: full transition list. Use include_emissions=true to see " +
    "emission data. Use include_line_text=true to include raw log line snippets " +
    "(avoids separate logtapper_query calls).",
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

// ── 10. logtapper_get_state_at_line ─────────────────────────────────────

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

// ── 11. logtapper_get_correlations ──────────────────────────────────────

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

// ── 12. logtapper_get_processor_definitions ─────────────────────────────

server.tool(
  "logtapper_get_processor_definitions",
  "Get processor definitions to understand what each processor detects. " +
    "Without processor_id: returns a summary list (id, name, type, description, sections, sourceTypes). " +
    "With processor_id: returns the full definition including filter rules, extract " +
    "patterns, aggregations, state fields, transition names, sections, and sourceTypes. " +
    "sections lists bugreport section names the processor targets; sourceTypes lists " +
    "compatible log source types (logcat, bugreport, dumpstate). Use this to " +
    "understand pipeline results before drilling into specifics.",
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
      return ok(await bridgeGet(path));
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── 13. logtapper_bookmarks ─────────────────────────────────────────────

server.tool(
  "logtapper_bookmarks",
  "Manage bookmarks on log lines within a session. Bookmarks mark lines of " +
    "interest for quick navigation. Use action 'list' to see all bookmarks, " +
    "'create' to add a new bookmark at a line, or 'delete' to remove one.",
  {
    session_id: z.string().describe("Session ID"),
    action: z
      .enum(["list", "create", "delete"])
      .describe("Action to perform: list all bookmarks, create a new one, or delete an existing one"),
    line_number: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Line number to bookmark (required for 'create')"),
    label: z
      .string()
      .optional()
      .describe("Short label for the bookmark (required for 'create')"),
    note: z
      .string()
      .optional()
      .describe("Optional longer note for the bookmark (used with 'create')"),
    bookmark_id: z
      .string()
      .optional()
      .describe("Bookmark ID to delete (required for 'delete')"),
  },
  async ({ session_id, action, line_number, label, note, bookmark_id }) => {
    const sid = encodeURIComponent(session_id);
    try {
      switch (action) {
        case "list":
          return ok(await bridgeGet(`/mcp/sessions/${sid}/bookmarks`));
        case "create":
          if (line_number === undefined || !label) {
            return ok({ error: "line_number and label are required for 'create'" });
          }
          return ok(
            await bridgePost(`/mcp/sessions/${sid}/bookmarks`, {
              lineNumber: line_number,
              label,
              note: note ?? "",
            })
          );
        case "delete":
          if (!bookmark_id) {
            return ok({ error: "bookmark_id is required for 'delete'" });
          }
          return ok(
            await bridgeDelete(
              `/mcp/sessions/${sid}/bookmarks/${encodeURIComponent(bookmark_id)}`
            )
          );
      }
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── 14. logtapper_analyses ──────────────────────────────────────────────

server.tool(
  "logtapper_analyses",
  "Manage analysis artifacts — structured narratives with line references that " +
    "appear in the LogTapper UI. Use 'list' to see all analyses, 'get' for full " +
    "content, 'publish' to create a new analysis, 'update' to revise, or 'delete' " +
    "to remove. Each analysis has a title and sections with headings, body text, " +
    "optional severity, and line references.",
  {
    session_id: z.string().describe("Session ID"),
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
    const sid = encodeURIComponent(session_id);
    try {
      switch (action) {
        case "list":
          return ok(await bridgeGet(`/mcp/sessions/${sid}/analyses`));
        case "get":
          if (!artifact_id) {
            return ok({ error: "artifact_id is required for 'get'" });
          }
          return ok(
            await bridgeGet(
              `/mcp/sessions/${sid}/analyses/${encodeURIComponent(artifact_id)}`
            )
          );
        case "publish":
          if (!title || !sections) {
            return ok({ error: "title and sections are required for 'publish'" });
          }
          return ok(
            await bridgePost(`/mcp/sessions/${sid}/analyses`, { title, sections })
          );
        case "update":
          if (!artifact_id) {
            return ok({ error: "artifact_id is required for 'update'" });
          }
          return ok(
            await bridgePut(
              `/mcp/sessions/${sid}/analyses/${encodeURIComponent(artifact_id)}`,
              { title, sections }
            )
          );
        case "delete":
          if (!artifact_id) {
            return ok({ error: "artifact_id is required for 'delete'" });
          }
          return ok(
            await bridgeDelete(
              `/mcp/sessions/${sid}/analyses/${encodeURIComponent(artifact_id)}`
            )
          );
      }
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── 15. logtapper_watches ───────────────────────────────────────────────

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
          return ok(await bridgeGet(`/mcp/sessions/${sid}/watches`));
        case "create":
          return ok(
            await bridgePost(`/mcp/sessions/${sid}/watches`, {
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
            return ok({ error: "watch_id is required for 'cancel'" });
          }
          return ok(
            await bridgeDelete(
              `/mcp/sessions/${sid}/watches/${encodeURIComponent(watch_id)}`
            )
          );
      }
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── 16. logtapper_run_pipeline ───────────────────────────────────────────

server.tool(
  "logtapper_run_pipeline",
  "Trigger a pipeline run on a session. Executes all installed processors " +
    "(or a specified subset) against the session's log data. Use this to " +
    "generate pipeline results that can then be queried with " +
    "logtapper_get_pipeline_results and logtapper_get_processor_detail. " +
    "This operation may take significant time on large files (1M+ lines).",
  {
    session_id: z.string().describe("Session ID"),
    processor_ids: z
      .array(z.string())
      .optional()
      .describe("Processor IDs to run. If omitted, runs all installed processors."),
  },
  async ({ session_id, processor_ids }) => {
    try {
      return ok(
        await bridgePostLong(
          `/mcp/sessions/${encodeURIComponent(session_id)}/run_pipeline`,
          { processorIds: processor_ids }
        )
      );
    } catch (err) {
      return ok({ error: String(err) });
    }
  }
);

// ── 17. logtapper_get_insights ───────────────────────────────────────────

server.tool(
  "logtapper_get_insights",
  "Get MCP signal insights from pipeline results. For each processor that has " +
    "a schema with MCP exposure configured, returns a rendered summary and a " +
    "list of fired signals (classified as critical/warning/info) with line " +
    "numbers and formatted messages. Processors without MCP schema return " +
    "basic emission counts only. Run logtapper_run_pipeline first to populate " +
    "pipeline results before calling this tool.",
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
        await bridgeGet(
          `/mcp/sessions/${encodeURIComponent(session_id)}/insights`,
          query
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
