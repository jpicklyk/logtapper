/**
 * LogTapper MCP Server — process entrypoint.
 *
 * All tool definitions live in `server.ts`; this file only connects the
 * stdio transport (Claude Code / Claude Desktop spawns this as a subprocess)
 * and runs the heartbeat. Keeping the two separate lets tests import
 * `server.ts` and drive it over an in-memory transport without spawning a
 * real stdio connection or leaving a dangling `setInterval` behind.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Node's `--experimental-strip-types` ("strip-only" mode) does not remap a
// `.js` specifier to a sibling `.ts` file the way `tsc`'s NodeNext resolution
// does — it needs the real extension. bun and `tsc --noEmit` both accept it.
import { BASE_URL, server } from "./server.ts";

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
