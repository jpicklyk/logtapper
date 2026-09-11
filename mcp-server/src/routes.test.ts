/**
 * Tool → route coverage for the LogTapper MCP server.
 *
 * Drives the real `server` (from `server.ts`) over an in-memory MCP
 * transport with a fake `fetch`, so every tool call exercises its actual
 * Zod schema, URL-building, and body-shaping logic — the same code path a
 * real agent invocation runs — without a live LogTapper bridge.
 *
 * Two things are asserted:
 *  1. `ROUTE_TABLE` below has one row per `mcp_bridge::ROUTES` entry (parsed
 *     from `src-tauri/src/mcp_bridge/mod.rs` at test time, so this file
 *     cannot silently drift from the authoritative 69-entry table), and
 *     invoking each row's tool call produces a fetch to the expected method
 *     + path (+ a few representative query keys).
 *  2. A non-2xx bridge response becomes `{ isError: true }` with the
 *     `WireError`'s `code` surfaced in the result text — the contract every
 *     tool handler shares via `handleBridgeError`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { server } from "./server.ts";

// ---------------------------------------------------------------------------
// Parse the authoritative route table straight from the Rust source, so this
// test cannot drift from it silently — adding a route to `ROUTES` without a
// matching row here fails `covers every ROUTES entry` below.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const MOD_RS_PATH = resolve(here, "..", "..", "src-tauri", "src", "mcp_bridge", "mod.rs");

function parseBridgeRoutes(): string[] {
  const text = readFileSync(MOD_RS_PATH, "utf8");
  const start = text.indexOf("pub const ROUTES");
  if (start === -1) {
    throw new Error(`Could not find "pub const ROUTES" in ${MOD_RS_PATH} — has it moved or been renamed?`);
  }
  const end = text.indexOf("\n];", start);
  if (end === -1) {
    throw new Error(`Could not find the closing "];" for ROUTES in ${MOD_RS_PATH}`);
  }
  const block = text.slice(start, end);
  const routes: string[] = [];
  const tuplePattern = /\(\s*"([A-Z]+)"\s*,\s*"([^"]+)"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = tuplePattern.exec(block)) !== null) {
    routes.push(`${m[1]} ${m[2]}`);
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Fake fetch — records every call and answers the next queued response (or a
// bare `{}` 200 when nothing was queued).
// ---------------------------------------------------------------------------

type RecordedCall = { method: string; url: string };
type QueuedResponse = { status: number; body: unknown };

let recordedCalls: RecordedCall[] = [];
let queuedResponse: QueuedResponse | null = null;

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    recordedCalls.push({ method: init?.method ?? "GET", url });
    const queued = queuedResponse;
    queuedResponse = null;
    return queued ? fakeResponse(queued.status, queued.body) : fakeResponse(200, {});
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  recordedCalls = [];
  queuedResponse = null;
});

// ---------------------------------------------------------------------------
// Connect `server` to a Client over an in-memory transport, once for the
// whole file.
// ---------------------------------------------------------------------------

let client: Client;

beforeAll(async () => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "routes-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
});

// ---------------------------------------------------------------------------
// The tool → route table. One row per `ROUTES` entry (69 total).
// ---------------------------------------------------------------------------

const S = "s1"; // session id
const F = "f1"; // filter id
const A = "a1"; // analysis artifact id
const B = "b1"; // bookmark id
const W = "w1"; // watch id
const P = "p1"; // processor id
const T = "t1"; // tracker id
const SRC = "src1"; // marketplace source id

interface Row {
  /** "METHOD /path/with/{placeholders}" — must match one `ROUTES` entry exactly. */
  route: string;
  tool: string;
  args: Record<string, unknown>;
  /** Concrete path (placeholders resolved) the fake fetch must have seen. */
  expectPath: string;
  method: string;
  /** A handful of query keys expected on GET requests, spot-checked. */
  queryKeysInclude?: string[];
}

const ROUTE_TABLE: Row[] = [
  { route: "GET /mcp/status", tool: "logtapper_get_status", args: {}, method: "GET", expectPath: "/mcp/status" },
  { route: "POST /mcp/open_file", tool: "logtapper_open_file", args: { path: "C:\\logs\\device.log" }, method: "POST", expectPath: "/mcp/open_file" },
  { route: "GET /mcp/sessions", tool: "logtapper_list_sessions", args: {}, method: "GET", expectPath: "/mcp/sessions" },
  { route: "POST /mcp/sessions/{session_id}/close", tool: "logtapper_close_session", args: { session_id: S }, method: "POST", expectPath: `/mcp/sessions/${S}/close` },
  { route: "GET /mcp/sessions/{session_id}/query", tool: "logtapper_query", args: { session_id: S, strategy: "recent" }, method: "GET", expectPath: `/mcp/sessions/${S}/query`, queryKeysInclude: ["strategy"] },
  { route: "GET /mcp/sessions/{session_id}/pipeline", tool: "logtapper_get_pipeline_results", args: { session_id: S }, method: "GET", expectPath: `/mcp/sessions/${S}/pipeline` },
  { route: "GET /mcp/sessions/{session_id}/events", tool: "logtapper_get_events", args: { session_id: S }, method: "GET", expectPath: `/mcp/sessions/${S}/events` },
  { route: "GET /mcp/sessions/{session_id}/correlations", tool: "logtapper_get_correlations", args: { session_id: S }, method: "GET", expectPath: `/mcp/sessions/${S}/correlations` },
  { route: "GET /mcp/sessions/{session_id}/processor/{processor_id}", tool: "logtapper_get_processor_detail", args: { session_id: S, processor_id: P }, method: "GET", expectPath: `/mcp/sessions/${S}/processor/${P}` },
  { route: "GET /mcp/sessions/{session_id}/tracker/{tracker_id}/state_at", tool: "logtapper_get_state_at_line", args: { session_id: S, tracker_id: T, line_num: 5 }, method: "GET", expectPath: `/mcp/sessions/${S}/tracker/${T}/state_at`, queryKeysInclude: ["line"] },
  { route: "GET /mcp/sessions/{session_id}/search", tool: "logtapper_search", args: { session_id: S, pattern: "foo" }, method: "GET", expectPath: `/mcp/sessions/${S}/search`, queryKeysInclude: ["pattern"] },
  { route: "GET /mcp/sessions/{session_id}/metadata", tool: "logtapper_get_metadata", args: { session_id: S }, method: "GET", expectPath: `/mcp/sessions/${S}/metadata` },
  { route: "GET /mcp/sessions/{session_id}/sections", tool: "logtapper_get_sections", args: { session_id: S }, method: "GET", expectPath: `/mcp/sessions/${S}/sections` },
  { route: "GET /mcp/sessions/{session_id}/section_at", tool: "logtapper_section_at", args: { session_id: S, line: 0 }, method: "GET", expectPath: `/mcp/sessions/${S}/section_at`, queryKeysInclude: ["line"] },
  { route: "GET /mcp/sessions/{session_id}/lines_around", tool: "logtapper_get_lines_around", args: { session_id: S, line: 10 }, method: "GET", expectPath: `/mcp/sessions/${S}/lines_around`, queryKeysInclude: ["line"] },
  { route: "GET /mcp/sessions/{session_id}/search_with_context", tool: "logtapper_search_with_context", args: { session_id: S, query: "foo" }, method: "GET", expectPath: `/mcp/sessions/${S}/search_with_context`, queryKeysInclude: ["query"] },
  { route: "GET /mcp/processors", tool: "logtapper_get_processor_definitions", args: {}, method: "GET", expectPath: "/mcp/processors" },
  { route: "GET /mcp/processors/{processor_id}", tool: "logtapper_get_processor_definitions", args: { processor_id: P }, method: "GET", expectPath: `/mcp/processors/${P}` },
  { route: "GET /mcp/sessions/{session_id}/bookmarks", tool: "logtapper_bookmarks", args: { session_id: S, action: "list" }, method: "GET", expectPath: `/mcp/sessions/${S}/bookmarks` },
  { route: "POST /mcp/sessions/{session_id}/bookmarks", tool: "logtapper_bookmarks", args: { session_id: S, action: "create", line_number: 1, label: "L" }, method: "POST", expectPath: `/mcp/sessions/${S}/bookmarks` },
  { route: "DELETE /mcp/sessions/{session_id}/bookmarks/{bookmark_id}", tool: "logtapper_bookmarks", args: { session_id: S, action: "delete", bookmark_id: B }, method: "DELETE", expectPath: `/mcp/sessions/${S}/bookmarks/${B}` },
  { route: "PUT /mcp/sessions/{session_id}/bookmarks/{bookmark_id}", tool: "logtapper_bookmarks", args: { session_id: S, action: "update", bookmark_id: B, label: "L2" }, method: "PUT", expectPath: `/mcp/sessions/${S}/bookmarks/${B}` },
  { route: "GET /mcp/analyses", tool: "logtapper_analyses", args: { action: "list" }, method: "GET", expectPath: "/mcp/analyses" },
  { route: "POST /mcp/analyses", tool: "logtapper_analyses", args: { action: "publish", title: "T", sections: [{ heading: "H", body: "B" }] }, method: "POST", expectPath: "/mcp/analyses" },
  { route: "GET /mcp/analyses/{artifact_id}", tool: "logtapper_analyses", args: { action: "get", artifact_id: A }, method: "GET", expectPath: `/mcp/analyses/${A}` },
  { route: "PUT /mcp/analyses/{artifact_id}", tool: "logtapper_analyses", args: { action: "update", artifact_id: A, title: "T2" }, method: "PUT", expectPath: `/mcp/analyses/${A}` },
  { route: "DELETE /mcp/analyses/{artifact_id}", tool: "logtapper_analyses", args: { action: "delete", artifact_id: A }, method: "DELETE", expectPath: `/mcp/analyses/${A}` },
  { route: "GET /mcp/sessions/{session_id}/analyses", tool: "logtapper_analyses", args: { session_id: S, action: "list" }, method: "GET", expectPath: `/mcp/sessions/${S}/analyses` },
  { route: "POST /mcp/sessions/{session_id}/analyses", tool: "logtapper_analyses", args: { session_id: S, action: "publish", title: "T", sections: [{ heading: "H", body: "B" }] }, method: "POST", expectPath: `/mcp/sessions/${S}/analyses` },
  { route: "GET /mcp/sessions/{session_id}/analyses/{artifact_id}", tool: "logtapper_analyses", args: { session_id: S, action: "get", artifact_id: A }, method: "GET", expectPath: `/mcp/sessions/${S}/analyses/${A}` },
  { route: "PUT /mcp/sessions/{session_id}/analyses/{artifact_id}", tool: "logtapper_analyses", args: { session_id: S, action: "update", artifact_id: A, title: "T2" }, method: "PUT", expectPath: `/mcp/sessions/${S}/analyses/${A}` },
  { route: "DELETE /mcp/sessions/{session_id}/analyses/{artifact_id}", tool: "logtapper_analyses", args: { session_id: S, action: "delete", artifact_id: A }, method: "DELETE", expectPath: `/mcp/sessions/${S}/analyses/${A}` },
  { route: "GET /mcp/sessions/{session_id}/insights", tool: "logtapper_get_insights", args: { session_id: S }, method: "GET", expectPath: `/mcp/sessions/${S}/insights` },
  { route: "POST /mcp/sessions/{session_id}/run_pipeline", tool: "logtapper_run_pipeline", args: { session_id: S }, method: "POST", expectPath: `/mcp/sessions/${S}/run_pipeline` },
  { route: "GET /mcp/sessions/{session_id}/watches", tool: "logtapper_watches", args: { session_id: S, action: "list" }, method: "GET", expectPath: `/mcp/sessions/${S}/watches` },
  { route: "POST /mcp/sessions/{session_id}/watches", tool: "logtapper_watches", args: { session_id: S, action: "create", text_search: "x" }, method: "POST", expectPath: `/mcp/sessions/${S}/watches` },
  { route: "DELETE /mcp/sessions/{session_id}/watches/{watch_id}", tool: "logtapper_watches", args: { session_id: S, action: "cancel", watch_id: W }, method: "DELETE", expectPath: `/mcp/sessions/${S}/watches/${W}` },
  { route: "GET /mcp/activity", tool: "logtapper_activity", args: {}, method: "GET", expectPath: "/mcp/activity" },
  { route: "GET /mcp/settings/anonymizer", tool: "logtapper_settings", args: { action: "anonymizer" }, method: "GET", expectPath: "/mcp/settings/anonymizer" },
  { route: "GET /mcp/settings/open_allowlist", tool: "logtapper_settings", args: { action: "open_allowlist" }, method: "GET", expectPath: "/mcp/settings/open_allowlist" },
  { route: "POST /mcp/settings/anonymizer/test", tool: "logtapper_settings", args: { action: "test", text: "hi" }, method: "POST", expectPath: "/mcp/settings/anonymizer/test" },
  { route: "GET /mcp/settings/agent_access", tool: "logtapper_settings", args: { action: "agent_access" }, method: "GET", expectPath: "/mcp/settings/agent_access" },
  { route: "POST /mcp/sessions/{session_id}/filters", tool: "logtapper_filters", args: { session_id: S, action: "create" }, method: "POST", expectPath: `/mcp/sessions/${S}/filters` },
  { route: "GET /mcp/filters/{filter_id}", tool: "logtapper_filters", args: { filter_id: F, action: "info" }, method: "GET", expectPath: `/mcp/filters/${F}` },
  { route: "GET /mcp/filters/{filter_id}/lines", tool: "logtapper_filters", args: { filter_id: F, action: "lines" }, method: "GET", expectPath: `/mcp/filters/${F}/lines` },
  { route: "POST /mcp/filters/{filter_id}/cancel", tool: "logtapper_filters", args: { filter_id: F, action: "cancel" }, method: "POST", expectPath: `/mcp/filters/${F}/cancel` },
  { route: "DELETE /mcp/filters/{filter_id}", tool: "logtapper_filters", args: { filter_id: F, action: "close" }, method: "DELETE", expectPath: `/mcp/filters/${F}` },
  { route: "GET /mcp/sessions/{session_id}/chart", tool: "logtapper_chart", args: { session_id: S, processor_id: P }, method: "GET", expectPath: `/mcp/sessions/${S}/chart`, queryKeysInclude: ["processor_id"] },
  { route: "GET /mcp/sessions/{session_id}/timeline", tool: "logtapper_timeline", args: { session_id: S, processor_ids: [P] }, method: "GET", expectPath: `/mcp/sessions/${S}/timeline`, queryKeysInclude: ["processor_ids"] },
  { route: "GET /mcp/export/info", tool: "logtapper_export", args: { action: "info" }, method: "GET", expectPath: "/mcp/export/info" },
  { route: "POST /mcp/export", tool: "logtapper_export", args: { action: "run", dest_path: "C:\\out\\all.lts" }, method: "POST", expectPath: "/mcp/export" },
  { route: "POST /mcp/processors/install", tool: "logtapper_processors", args: { action: "install", yaml: "id: x\nname: X\n" }, method: "POST", expectPath: "/mcp/processors/install" },
  { route: "DELETE /mcp/processors/{processor_id}", tool: "logtapper_processors", args: { action: "uninstall", processor_id: P }, method: "DELETE", expectPath: `/mcp/processors/${P}` },
  { route: "GET /mcp/packs", tool: "logtapper_processors", args: { action: "packs" }, method: "GET", expectPath: "/mcp/packs" },
  { route: "GET /mcp/marketplace/sources", tool: "logtapper_marketplace", args: { action: "sources" }, method: "GET", expectPath: "/mcp/marketplace/sources" },
  { route: "GET /mcp/marketplace/sources/{source_id}/fetch", tool: "logtapper_marketplace", args: { action: "fetch", source_id: SRC }, method: "GET", expectPath: `/mcp/marketplace/sources/${SRC}/fetch` },
  { route: "GET /mcp/marketplace/updates", tool: "logtapper_marketplace", args: { action: "updates" }, method: "GET", expectPath: "/mcp/marketplace/updates" },
  { route: "POST /mcp/marketplace/install", tool: "logtapper_marketplace", args: { action: "install", source_name: SRC, entry: { id: "e1", name: "E", path: "e.yaml", version: "1.0.0" } }, method: "POST", expectPath: "/mcp/marketplace/install" },
  { route: "POST /mcp/marketplace/update_all/{source_id}", tool: "logtapper_marketplace", args: { action: "update_all", source_id: SRC }, method: "POST", expectPath: `/mcp/marketplace/update_all/${SRC}` },
  { route: "GET /mcp/workspaces", tool: "logtapper_workspace", args: { action: "list" }, method: "GET", expectPath: "/mcp/workspaces" },
  { route: "GET /mcp/workspace", tool: "logtapper_workspace", args: { action: "current" }, method: "GET", expectPath: "/mcp/workspace" },
  { route: "POST /mcp/workspace/load", tool: "logtapper_workspace", args: { action: "load", path: "C:\\ws\\x.ltw" }, method: "POST", expectPath: "/mcp/workspace/load" },
  { route: "POST /mcp/workspace/save", tool: "logtapper_workspace", args: { action: "save", workspace_id: "ws1", workspace_name: "WS", dest_path: "C:\\ws\\x.ltw" }, method: "POST", expectPath: "/mcp/workspace/save" },
  { route: "POST /mcp/workspace/autosave", tool: "logtapper_workspace", args: { action: "autosave", workspace_id: "ws1", workspace_name: "WS" }, method: "POST", expectPath: "/mcp/workspace/autosave" },
  { route: "GET /mcp/adb/devices", tool: "logtapper_stream", args: { action: "devices" }, method: "GET", expectPath: "/mcp/adb/devices" },
  { route: "POST /mcp/adb/stream", tool: "logtapper_stream", args: { action: "start", device_id: "dev1" }, method: "POST", expectPath: "/mcp/adb/stream" },
  { route: "GET /mcp/sessions/{session_id}/stream/status", tool: "logtapper_stream", args: { action: "status", session_id: S }, method: "GET", expectPath: `/mcp/sessions/${S}/stream/status` },
  { route: "GET /mcp/sessions/{session_id}/stream/events", tool: "logtapper_stream", args: { action: "events", session_id: S, since: 5 }, method: "GET", expectPath: `/mcp/sessions/${S}/stream/events`, queryKeysInclude: ["since"] },
  { route: "POST /mcp/sessions/{session_id}/stream/stop", tool: "logtapper_stream", args: { action: "stop", session_id: S }, method: "POST", expectPath: `/mcp/sessions/${S}/stream/stop` },
  { route: "POST /mcp/sessions/{session_id}/stream/save", tool: "logtapper_stream", args: { action: "save", session_id: S, dest_path: "C:\\out\\cap.txt" }, method: "POST", expectPath: `/mcp/sessions/${S}/stream/save` },
];

const covered = new Set<string>();

describe("mcp-server tool → route coverage", () => {
  it.each(ROUTE_TABLE)("$tool ($route) calls $method $route", async (row) => {
    const result = await client.callTool({ name: row.tool, arguments: row.args });
    expect(result.isError, `${row.tool} returned isError for ${JSON.stringify(row.args)}: ${JSON.stringify(result.content)}`).not.toBe(true);

    expect(recordedCalls, `${row.tool} did not call fetch at all`).toHaveLength(1);
    const call = recordedCalls[0];
    expect(call.method).toBe(row.method);

    const url = new URL(call.url);
    expect(url.origin).toBe("http://127.0.0.1:40404");
    expect(url.pathname).toBe(row.expectPath);

    for (const key of row.queryKeysInclude ?? []) {
      expect(url.searchParams.has(key), `expected query key '${key}' on ${call.url}`).toBe(true);
    }

    covered.add(row.route);
  });

  it("ROUTE_TABLE covers every entry in mcp_bridge::ROUTES", () => {
    const bridgeRoutes = parseBridgeRoutes();
    expect(bridgeRoutes.length).toBe(70);

    const missing = bridgeRoutes.filter((r) => !covered.has(r));
    expect(missing, `ROUTE_TABLE is missing rows for: ${missing.join(", ")}`).toEqual([]);

    // Every row also corresponds to a route that actually exists — catches a
    // typo'd `route` field in ROUTE_TABLE itself.
    const bridgeRouteSet = new Set(bridgeRoutes);
    const unknown = ROUTE_TABLE.map((r) => r.route).filter((r) => !bridgeRouteSet.has(r));
    expect(unknown, `ROUTE_TABLE has rows for routes not in mcp_bridge::ROUTES: ${unknown.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error contract: any non-2xx bridge response becomes `isError: true` with
// the WireError's `code` surfaced in the result text.
// ---------------------------------------------------------------------------

describe("bridge error envelope", () => {
  it("a 404 WireError becomes isError:true with the code and message in the text", async () => {
    queuedResponse = {
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "Session 's1' not found" } },
    };

    const result = await client.callTool({ name: "logtapper_get_metadata", arguments: { session_id: S } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as { code: string; message: string; status: number };
    expect(parsed.code).toBe("NOT_FOUND");
    expect(parsed.message).toBe("Session 's1' not found");
    expect(parsed.status).toBe(404);
  });

  it("a 403 NOT_ALLOWED (open_file gate) becomes isError:true, not a thrown exception", async () => {
    queuedResponse = {
      status: 403,
      body: { error: { code: "NOT_ALLOWED", message: "path is not allowed" } },
    };

    const result = await client.callTool({
      name: "logtapper_open_file",
      arguments: { path: "C:\\outside\\device.log" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("NOT_ALLOWED");
  });

  it("client-side argument validation failures use the same isError shape", async () => {
    const result = await client.callTool({
      name: "logtapper_bookmarks",
      arguments: { session_id: S, action: "create" }, // missing line_number/label
    });

    expect(result.isError).toBe(true);
    expect(recordedCalls).toHaveLength(0); // never reached the bridge
  });
});
