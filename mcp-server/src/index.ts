/**
 * LogTapper MCP Server — process entrypoint.
 *
 * All tool definitions live in `server.ts`; this file only picks a transport
 * and runs the heartbeat. Keeping the two separate lets tests import
 * `server.ts` and drive it over an in-memory transport without spawning a
 * real stdio connection or leaving a dangling `setInterval` behind.
 *
 * Two modes:
 *
 *   (default)          stdio — a harness spawns this process by path
 *                      (Claude Code, Cursor, VS Code, …).
 *   --http [port]      Streamable HTTP on 127.0.0.1:<port>/mcp — LogTapper
 *                      itself spawns this alongside the bridge so every harness
 *                      can connect to one URL and always gets the server that
 *                      shipped with the running app. Stateless: each request
 *                      gets a fresh server instance, so no session bookkeeping.
 */

import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Node's `--experimental-strip-types` ("strip-only" mode) does not remap a
// `.js` specifier to a sibling `.ts` file the way `tsc`'s NodeNext resolution
// does — it needs the real extension. bun and `tsc --noEmit` both accept it.
import { BASE_URL, createServer, server } from "./server.ts";

/** Default port for `--http` when none is given; the app passes it explicitly. */
export const DEFAULT_HTTP_PORT = 40405;
/** Path the Streamable HTTP endpoint is served on. */
export const MCP_PATH = "/mcp";

const log = (message: string): void => {
  process.stderr.write(`logtapper-mcp: ${message}\n`);
};

// ---------------------------------------------------------------------------
// Heartbeat — ping the bridge every 10 s so the Tauri app knows this MCP
// server process is alive, even when no tools are being invoked.
// The frontend uses mcp_last_activity (stamped on every bridge request) to
// distinguish "connected" from "ready (idle)" state.
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 10_000;

// `unref` so the heartbeat never keeps the process alive on its own: once the
// host closes our stdin the transport ends and the event loop should drain.
setInterval(() => {
  fetch(`${BASE_URL}/mcp/status`, { signal: AbortSignal.timeout(4_000) })
    .catch(() => { /* LogTapper not running — silently ignore */ });
}, HEARTBEAT_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

const httpFlag = process.argv.indexOf("--http");
if (httpFlag >= 0) {
  // `--http` alone means the default port; a value that is present but not a
  // port number is a typo the user should hear about, not a silent fallback.
  const raw = process.argv[httpFlag + 1];
  let port = DEFAULT_HTTP_PORT;
  if (raw !== undefined) {
    port = Number(raw);
    if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
      log(`--http expects a port number, got ${JSON.stringify(raw)}`);
      process.exit(2);
    }
  }
  runHttp(port);
} else {
  await runStdio();
}

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Exit promptly on stdin EOF. Hosts normally kill the server process, but
  // some run us behind a launcher, and on Windows a hard-killed launcher does
  // not take its child with it — the closed stdin pipe is the only signal we
  // get, so treat it as the shutdown request it is.
  process.stdin.on("end", () => process.exit(0));
}

function runHttp(port: number): void {
  // Loopback only, and the Host header must name it — the same rule the
  // bridge enforces, so a page in a browser cannot reach us via DNS rebinding.
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];

  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }

    // Stateless Streamable HTTP: one server + transport per request, torn
    // down when the response closes. Registration is cheap (microseconds).
    const mcp = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log(`request failed: ${(e as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      }
    }
  });

  http.on("error", (e) => {
    log(`cannot listen on 127.0.0.1:${port}: ${e.message}`);
    process.exit(1);
  });
  http.listen(port, "127.0.0.1", () => {
    log(`MCP over HTTP at http://127.0.0.1:${port}${MCP_PATH} (pid ${process.pid}, parent ${process.ppid})`);
  });

  // Watchdog: the app that spawned us is our parent. If it goes away without
  // killing us (crash, force-quit), exit rather than linger holding the port.
  const ppid = process.ppid;
  setInterval(() => {
    try {
      process.kill(ppid, 0);
    } catch {
      log(`parent ${ppid} is gone — exiting`);
      process.exit(0);
    }
  }, 5_000);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      http.close();
      process.exit(0);
    });
  }
}
