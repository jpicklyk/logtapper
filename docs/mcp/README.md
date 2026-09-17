# MCP Setup Guide

LogTapper ships a bundled MCP ([Model Context Protocol](https://modelcontextprotocol.io/))
server that gives AI agents direct tool access to your live log sessions — search
lines, run analysis pipelines, read state-tracker events, manage bookmarks and
watches. No Node.js and no separate install required.

## How it works

While the MCP bridge is enabled, LogTapper runs its own MCP server and serves it
over HTTP at a fixed local address:

```
http://127.0.0.1:40405/mcp
```

Any client that speaks MCP's Streamable HTTP transport — Claude Code, Cursor,
VS Code, Windsurf, Gemini CLI and most others — connects to that URL. There is
no binary to locate and nothing to reinstall after a LogTapper update: the
server you reach is always the one that shipped with the running app.

```
AI client  ──HTTP──▶  127.0.0.1:40405/mcp  (server LogTapper runs)  ──▶  LogTapper sessions
```

Claude Desktop is the one exception: its extensions are stdio-only and its
cloud connectors cannot reach localhost, so it gets a small **relay extension**
that forwards to the same URL. See [claude-desktop.md](claude-desktop.md).

Three consequences worth knowing up front:

- **LogTapper must be running with the bridge enabled.** The MCP server starts
  and stops with the bridge. A client configured while the app is closed is
  fine — it just has no tools until you open the app.
- Both ports (40404 for the bridge, 40405 for MCP) are bound to loopback only
  and reject requests whose `Host` header is not `127.0.0.1` or `localhost`.
  Nothing is exposed to your network, and DNS-rebinding attempts are refused.
- **The client has to run on the same machine as LogTapper.** An agent running
  in a container, in WSL, or over a remote SSH session cannot reach a LogTapper
  running on your desktop.

## Step 1 — Enable the MCP Bridge

In LogTapper, go to **Settings → General → MCP Integration** and toggle the
bridge on. A status dot appears reading `Bridge: ready on port 40404`. It
changes to `Bridge: connected` only after a client has actually called a tool,
so `ready` is the expected state until you finish connecting one.

The bridge stays off until you enable it, and the setting persists across
restarts.

## Step 2 — Connect your client

The same **MCP Integration** section shows the URL under **Connect an AI
agent**, with buttons that copy the URL, a ready-made `claude mcp add` command,
or a ready-made JSON block.

- **[Claude Code](claude-code.md)** — one command with the URL, or let the
  LogTapper plugin do it.
- **[Claude Desktop](claude-desktop.md)** — install the relay extension once
  from the same Settings section.
- **[Any other MCP client](#any-other-mcp-client)** — the contract below.

### Any other MCP client

| Property | Value |
|---|---|
| Transport | **Streamable HTTP** |
| URL | `http://127.0.0.1:40405/mcp` |
| Authentication | none (loopback only) |
| Server name | `logtapper` — tools are namespaced from it, so a different name renames every tool |

Most clients express this as a JSON object keyed by server name with a `url`:

```json
{
  "mcpServers": {
    "logtapper": {
      "url": "http://127.0.0.1:40405/mcp"
    }
  }
}
```

Where that object goes, and what the surrounding key is called, differs by
client (VS Code, for example, uses `servers` and adds `"type": "http"`) — check
your client's own MCP documentation. Most clients only start MCP servers at
launch, so restart the client after adding one.

#### Clients that only support stdio

The same server can be launched as a process. The `logtapper-mcp` binary is
installed next to the LogTapper executable, and the **Launch by path (stdio)**
row in Settings shows the resolved path with copy buttons for it. The contract:

| Property | Value |
|---|---|
| Transport | **stdio** |
| Command | the full path to `logtapper-mcp` |
| Arguments | none |

The path changes if LogTapper is moved or reinstalled between per-user and
all-users locations, which is why the URL is the recommended route. On Windows
a path in JSON needs its backslashes doubled or replaced with forward slashes.

## Changing the MCP port

The MCP server listens on 40405 by default. If another program on your machine
owns that port, LogTapper says so in **Settings → General → MCP Integration**
("The MCP server did not start: …address in use…") and offers a **Port** field
right there. Choose a port between 1024 and 65535 other than 40404, click
**Apply port**, and the URL and every copy button in that section update to the
new address. The choice is saved and applied on every launch.

Every client then needs the new URL once:

| Client | What to update |
|---|---|
| Claude Code | `claude mcp remove logtapper --scope user`, then the **Copy claude mcp add command** button gives you the add command with the new URL |
| Claude Desktop | Nothing to reinstall. Open the LogTapper extension's settings in Claude Desktop and set **LogTapper MCP URL** to the new address — [details and both orderings](claude-desktop.md#changing-the-mcp-port) |
| Any other HTTP client | Edit the `url` in its config to the new address and restart the client |
| stdio-by-path clients | Unaffected — they launch the binary and never use the port |

The bundle file LogTapper ships is not rewritten when the port changes; the
Claude Desktop extension's own setting is where the address lives after
install.

## Capabilities

The server exposes tools in these groups:

- **Session discovery** — list active sessions, get metadata (source type, line
  count, time range, tag distribution), browse bugreport/dumpstate sections
- **Log querying** — sample lines, regex search with context, persistent filter
  scans, get lines around a point of interest
- **Pipeline & processors** — view processor definitions, edit a session's
  processor chain, trigger pipeline runs, get results (reporter emissions, state
  tracker transitions, correlator events), get rendered insight summaries,
  charts and timelines
- **State reconstruction** — get a tracker's state at any line number (e.g.
  "what was the WiFi state when this crash happened?")
- **Annotations** — manage bookmarks and analysis artifacts with line references
- **Live monitoring** — start and stop ADB streams, create watches with filter
  criteria
- **Workspace and settings** — list, load and save workspaces; read settings
  and the shared activity journal; export sessions
- **File access** — open log files directly, subject to the allowlist in
  **Settings → General → MCP File Access**

Log text reaching an agent is PII-redacted unless you opt out in Settings.
Agents cannot change the anonymizer, the open-file allowlist or their own raw
access — those switches are UI-only by design.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tools are listed, but Claude reports "LogTapper is not running, or the MCP bridge is unavailable" | Bridge off, or LogTapper not running | Enable **Settings → General → MCP Integration**, and keep LogTapper open |
| The client cannot connect to the URL at all | Bridge off (the MCP server runs only while it is on), or the client was started first | Enable the bridge, then reconnect or restart the client |
| Settings says the MCP server did not start, naming an address-in-use error | Another program owns port 40405 | Change the port in the same Settings section; the URL and copy buttons follow it. Re-register clients with the new URL, and set the Claude Desktop extension's **LogTapper MCP URL** setting to match |
| No `logtapper` tools appear at all | Wrong URL, or client not restarted | Copy the URL from Settings again, then fully restart your client |
| `logtapper_open_file` is denied | Directory not allowlisted | Add the folder under **Settings → General → MCP File Access** |
| Worked before, broken after moving the app (stdio route only) | The registered path no longer exists | Switch to the URL, or re-register with the new path |

## Running from source

If you cloned the repository instead of installing a release, `tauri dev` has no
compiled sidecar to spawn, so run the TypeScript server yourself with Node 22+:

```
node --experimental-strip-types <repo>/mcp-server/src/index.ts --http 40405
```

and connect to `http://127.0.0.1:40405/mcp` as above. Without `--http` the same
command is the stdio server, for clients that launch a process.
