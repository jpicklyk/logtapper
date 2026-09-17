/**
 * LogTapper MCP relay — the process inside the Claude Desktop bundle.
 *
 * Claude Desktop extensions are stdio-only and its cloud connectors cannot
 * reach localhost, so this relay speaks stdio to Claude Desktop and forwards
 * `tools/list` and `tools/call` to the HTTP endpoint LogTapper serves itself
 * (`logtapper-mcp --http`, spawned by the app next to the bridge). It carries
 * no tool definitions, so it never goes stale: the tools are whatever the
 * running app's server offers.
 *
 * Any other stdio-only harness can use the same relay unchanged.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Bumped only when the relay itself changes — not with LogTapper releases. */
const RELAY_VERSION = "1.0.0";

/** Where the app serves MCP over HTTP. Overridable for experiments only. */
const UPSTREAM_URL = process.env.LOGTAPPER_MCP_URL ?? "http://127.0.0.1:40405/mcp";

const NOT_REACHABLE =
  `LogTapper is not reachable at ${UPSTREAM_URL}. Start LogTapper and enable the MCP bridge ` +
  "(Settings > General > MCP Integration), then try again.";

const log = (message: string): void => {
  process.stderr.write(`logtapper relay: ${message}\n`);
};

// ---------------------------------------------------------------------------
// Upstream client — connected lazily, dropped on any failure so the next
// request reconnects (the upstream is stateless, so nothing is lost).
// ---------------------------------------------------------------------------

let upstream: Client | null = null;
/** The connect in flight, so overlapping requests share one client instead of leaking the loser. */
let connecting: Promise<Client> | null = null;

function connectUpstream(): Promise<Client> {
  if (upstream) return Promise.resolve(upstream);
  if (connecting) return connecting;
  const client = new Client({ name: "logtapper-relay", version: RELAY_VERSION });
  client.onclose = () => {
    if (upstream === client) upstream = null;
  };
  connecting = client
    .connect(new StreamableHTTPClientTransport(new URL(UPSTREAM_URL)))
    .then(() => {
      upstream = client;
      log(`connected to ${UPSTREAM_URL}`);
      return client;
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

function dropUpstream(): void {
  const c = upstream;
  upstream = null;
  c?.close().catch(() => {});
}

/** `fetch failed` on its own says nothing — surface the cause (ECONNREFUSED, …). */
function describe(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const cause = err.cause?.code ?? err.cause?.message;
  return cause ? `${err.message}: ${cause}` : err.message;
}

// ---------------------------------------------------------------------------
// Reconnect poller — while the app is unreachable, keep trying quietly and
// tell the host the tool list changed once it appears, so a host that started
// us before LogTapper was up refetches on its own instead of giving up.
// ---------------------------------------------------------------------------

const RECONNECT_INTERVAL_MS = 5_000;
let poller: NodeJS.Timeout | null = null;

function startPolling(): void {
  if (poller) return;
  poller = setInterval(async () => {
    try {
      await connectUpstream();
    } catch {
      return; // still down — try again next tick
    }
    clearInterval(poller!);
    poller = null;
    log("upstream is back — notifying host that the tool list changed");
    server.sendToolListChanged().catch((e) => log(`list_changed notification failed: ${describe(e)}`));
  }, RECONNECT_INTERVAL_MS);
  poller.unref();
}

// ---------------------------------------------------------------------------
// Stdio-facing server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "logtapper", version: RELAY_VERSION },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    const client = await connectUpstream();
    return await client.listTools();
  } catch (e) {
    dropUpstream();
    log(`tools/list: upstream unreachable (${describe(e)}) — reporting no tools and polling`);
    startPolling();
    return { tools: [] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const client = await connectUpstream();
    return (await client.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} })) as CallToolResult;
  } catch (e) {
    dropUpstream();
    log(`tools/call ${req.params.name} failed: ${describe(e)}`);
    startPolling();
    return {
      isError: true,
      content: [{ type: "text", text: `${NOT_REACHABLE}\n(${describe(e)})` }],
    } satisfies CallToolResult;
  }
});

log(`starting (pid ${process.pid}, node ${process.version}), upstream ${UPSTREAM_URL}`);
await server.connect(new StdioServerTransport());

// Exit on stdin EOF — the host closing our pipe is the shutdown request.
process.stdin.on("end", () => {
  dropUpstream();
  process.exit(0);
});
