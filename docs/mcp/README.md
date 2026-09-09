# MCP Setup Guide

LogTapper ships a bundled MCP ([Model Context Protocol](https://modelcontextprotocol.io/))
server that gives AI agents direct tool access to your live log sessions — search
lines, run analysis pipelines, read state-tracker events, manage bookmarks and
watches. No Node.js and no separate install required.

## How it works

LogTapper exposes its open sessions over a local HTTP bridge on
`127.0.0.1:40404`. The MCP server is a small **stdio** process that your AI
client launches and that relays tool calls to that bridge. Any client that can
start a local MCP server can use it.

```
AI client  ──stdio──▶  logtapper-mcp  ──HTTP──▶  LogTapper (127.0.0.1:40404)
```

Three consequences worth knowing up front:

- **LogTapper must be running** with the bridge enabled for any tool call to
  succeed. Registering the server while the app is closed is fine — the calls
  just fail until you open it.
- The bridge is bound to loopback only. Nothing is exposed to your network.
- **The MCP server has to run on the same machine as LogTapper.** The bridge
  address is compiled in and the bridge rejects requests that do not arrive as
  `127.0.0.1:40404` or `localhost:40404`, which blocks DNS-rebinding attacks but
  also means there is no way to point the server at a different host. An agent
  running in a container, in WSL, or over a remote SSH session cannot reach a
  LogTapper running on your desktop.

## Step 1 — Enable the MCP Bridge

In LogTapper, go to **Settings → General → MCP Integration** and toggle the
bridge on. A status dot appears reading `Bridge: ready on port 40404`. It
changes to `Bridge: connected` only after a client has actually called a tool,
so `ready` is the expected state until you finish connecting one.

The bridge stays off until you enable it, and the setting persists across
restarts.

## Step 2 — Find the bundled binary

> **Claude Desktop users can skip this step.** LogTapper ships an MCP Bundle
> and installs it for you — see [claude-desktop.md](claude-desktop.md). The path
> below only matters for Claude Code, which launches the server by absolute path.

Releases newer than 0.10.0 install a compiled `logtapper-mcp` binary next to
the main LogTapper executable (earlier releases did not include it). Your
client needs its full path.

**The easy way:** the same **Settings → General → MCP Integration** section
shows the resolved path under **Connect an AI agent**, with buttons that copy
the path, a ready-made `claude mcp add` command, or a ready-made Claude Desktop
config block. If that panel says no bundled binary was found, you are on a
pre-sidecar release or a source checkout — see
[Running from source](#running-from-source).

If you'd rather locate it by hand:

| Platform | Path |
|---|---|
| **Windows** (installed "just for me") | `%LOCALAPPDATA%\LogTapper\logtapper-mcp.exe` |
| **Windows** (installed "for all users", or `.msi`) | `C:\Program Files\LogTapper\logtapper-mcp.exe` |
| **macOS** | `/Applications/LogTapper.app/Contents/MacOS/logtapper-mcp` |
| **Linux** (`.deb`) | `/usr/bin/logtapper-mcp`, or alongside the `log-tapper` binary |
| **Linux** (AppImage) | Next to the AppImage after extraction |

On Windows, try the first path; if the folder doesn't exist, use the second.

**Copying the path without a terminal:** paste `%LOCALAPPDATA%\LogTapper` into
the File Explorer address bar and press Enter. Then hold **Shift**, right-click
`logtapper-mcp.exe`, and choose **Copy as path**. That puts the full quoted path
on your clipboard.

> If you don't find a `logtapper-mcp` binary at all, check whether the filename
> carries a platform suffix (e.g. `logtapper-mcp-x86_64-pc-windows-msvc.exe`) and
> use that full name instead. If there's nothing matching `logtapper-mcp*`,
> you're likely running a locally-built bundle rather than an official release —
> see [Running from source](#running-from-source) below.

## Step 3 — Connect your client

Setup differs by client, because they consume the server differently:

- **[Claude Desktop](claude-desktop.md)** — install a bundled `.mcpb` extension
  saved from **Settings → General → MCP Integration**. The bundle carries its own
  copy of the server, so no path is involved and Step 2 does not apply.
- **[Claude Code](claude-code.md)** — registers the `logtapper-mcp` binary by
  absolute path, via the LogTapper plugin or `claude mcp add`. Claude Code
  cannot install `.mcpb` bundles, so this path stays manual.
- **[Any other MCP client](#any-other-mcp-client)** — launch the binary over
  stdio. See the contract below.

### Any other MCP client

Most MCP clients are not Claude Desktop and cannot install a `.mcpb`. They launch
a local process and speak MCP over its stdin/stdout, which is exactly what the
bundled binary does — so any of them can use LogTapper. Rather than describe each
client's configuration format, here is the contract to map onto whatever your
client asks for:

| Property | Value |
|---|---|
| Transport | **stdio** (the client launches the process; there is no URL to connect to) |
| Command | the full path to `logtapper-mcp` — see [Step 2](#step-2--find-the-bundled-binary) |
| Arguments | none |
| Environment | none |
| Server name | `logtapper` — tools are namespaced from it, so a different name renames every tool |

Most clients express this as a JSON object keyed by server name, with a
`command` and optional `args`:

```json
{
  "logtapper": {
    "command": "/full/path/to/logtapper-mcp"
  }
}
```

Where that object goes, and what the surrounding key is called, differs by
client — check your client's own MCP documentation for the file it reads and the
schema it expects. Two details are worth carrying over regardless: on Windows a
path in JSON needs its backslashes doubled or replaced with forward slashes, and
most clients only start MCP servers at launch, so restart the client after
adding one.

Running from a source checkout instead of an installed release? Use `node` as the
command and the server entry point as the argument — see
[Running from source](#running-from-source).

## Capabilities

The server exposes 21 tools:

- **Session discovery** — list active sessions, get metadata (source type, line
  count, time range, tag distribution), browse bugreport/dumpstate sections
- **Log querying** — sample lines (uniform/recent/around strategies), regex
  search with context, get lines around a point of interest
- **Pipeline & processors** — view processor definitions, trigger pipeline runs,
  get results (reporter emissions, state tracker transitions, correlator
  events), get rendered insight summaries
- **State reconstruction** — get a tracker's state at any line number (e.g.
  "what was the WiFi state when this crash happened?")
- **Annotations** — manage bookmarks and analysis artifacts with line references
- **Live monitoring** — create watches with filter criteria for real-time ADB
  streaming
- **File access** — open log files directly, subject to the allowlist in
  **Settings → General → MCP File Access**

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tools are listed, but Claude reports "LogTapper is not running, or the MCP bridge is unavailable" (or a "fetch failed" error) | Bridge off, or LogTapper not running | Enable **Settings → General → MCP Integration**, and keep LogTapper open |
| No `logtapper` tools appear at all | Wrong binary path, or client not restarted | Verify the path from Step 2, then fully restart your client |
| `logtapper_open_file` is denied | Directory not allowlisted | Add the folder under **Settings → General → MCP File Access** |
| Worked before, broken after reinstall | App moved between per-user and all-users install | Re-check the path in Step 2 and re-register |
| Saved `.mcpb` won't open, or only **Save bundle...** is offered | Nothing on the system is registered for `.mcpb` — the Microsoft Store build of Claude Desktop does not claim it | Install it in Claude Desktop with **Developer -> Extensions -> Install Extension...** |

## Running from source

If you cloned the repository instead of installing a release, there is no
compiled binary — run the TypeScript server directly with Node 22+:

```
node --experimental-strip-types <repo>/mcp-server/src/index.ts
```

Use that as the launch command wherever a client doc says "the binary path".
