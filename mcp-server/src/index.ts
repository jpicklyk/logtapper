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
  "Get the results of the last pipeline run for a session. Returns per-processor " +
    "summaries for all processor types:\n" +
    "  reporters     — matchedLines count, emission count, accumulated vars\n" +
    "  state_trackers — transitionCount, finalState snapshot, 5 most recent transitions\n" +
    "\nUse this to verify the pipeline ran correctly and to understand what each " +
    "processor found before querying raw lines or events. " +
    "Returns hasResults:false if the pipeline has not been run yet.",
  {
    session_id: z.string().describe("Session ID"),
  },
  async ({ session_id }) => {
    try {
      return ok(
        await bridgeGet(`/mcp/sessions/${encodeURIComponent(session_id)}/pipeline`)
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

// ---------------------------------------------------------------------------
// Connect and run
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
