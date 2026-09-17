---
name: attach-mcp
description: >-
  Attach or connect the LogTapper MCP server to Claude Code so LogTapper's
  log-analysis tools (list sessions, search log lines, run processors, read
  state-tracker events, manage bookmarks/watches) become available in chat.
  Use whenever the user asks to attach to LogTapper, connect the LogTapper MCP,
  add LogTapper tools, set up the LogTapper integration, or otherwise hook Claude
  up to LogTapper. Registers the HTTP endpoint LogTapper serves at user scope;
  falls back to launching the bundled binary or a dev checkout over stdio.
---

# Attach the LogTapper MCP to Claude

Register LogTapper's MCP server with Claude Code so its log-analysis tools are
available in chat. While its MCP bridge is enabled, LogTapper runs the server
itself and serves it over Streamable HTTP at a fixed local URL:

```
http://127.0.0.1:40405/mcp
```

That URL is the whole configuration. It always reaches the server that shipped
with the running LogTapper, so nothing needs re-registering after an update.

**Definition of done:** a `logtapper` MCP server registered at **user scope**,
the endpoint reachable, and at least one tool call verified.

The tools appear under the `logtapper` namespace (`mcp__logtapper__*`), so always
register the server with the exact name **`logtapper`**.

## Requirements to confirm with the user

Registering works while the app is closed, but the endpoint only exists while
the app is running with the bridge on, so verification needs:

1. **LogTapper is installed and running.**
2. **The MCP Bridge is enabled** — in LogTapper: *Settings → General → MCP
   Integration*, toggle the bridge on. The MCP server starts and stops with it.
3. The `claude` CLI is on PATH (it is, if they are running Claude Code).

## Step 1 — Is it already attached?

```
claude mcp list
```

If a `logtapper` entry already exists and points at the URL above, tell the
user it is already attached and skip to **Step 3**. If it points at a binary
path instead (the pre-0.13 form), re-register: the URL survives app moves and
updates, the path does not.

## Step 2 — Register at user scope

```
claude mcp add --transport http --scope user logtapper http://127.0.0.1:40405/mcp
```

`--scope user` makes LogTapper available in every project. Do not change the
server name from `logtapper`.

### Fallback: launch over stdio

Only if the user's Claude Code cannot use HTTP transport, or they are on a
LogTapper release older than 0.13 (no HTTP endpoint):

- **Installed app:** the `logtapper-mcp` binary sits next to the LogTapper
  executable. The app shows the resolved path under *Settings → General → MCP
  Integration → Launch by path (stdio)* with a **Copy claude mcp add command
  (by path)** button — asking the user to copy it from there is the fastest
  route. Otherwise probe the usual install locations:
  - Windows: `$env:ProgramFiles\LogTapper\logtapper-mcp.exe` (MSI / all users)
    or `$env:LOCALAPPDATA\LogTapper\logtapper-mcp.exe` (just for me)
  - macOS: `/Applications/LogTapper.app/Contents/MacOS/logtapper-mcp`
  - Linux: `/usr/bin/logtapper-mcp`, or alongside the AppImage
  ```
  claude mcp add logtapper --scope user -- "<path-to>/logtapper-mcp"
  ```
- **Dev checkout** (the current directory or an ancestor contains
  `mcp-server/src/index.ts`): `tauri dev` spawns no sidecar, so either run the
  HTTP server by hand —
  `node --experimental-strip-types <abs-path>/mcp-server/src/index.ts --http 40405`
  — and register the URL as in Step 2, or register the stdio form:
  ```
  claude mcp add logtapper --scope user -- node --experimental-strip-types "<abs-path>/mcp-server/src/index.ts"
  ```

Quote any path containing spaces.

## Step 3 — Verify

1. Confirm registration:
   ```
   claude mcp get logtapper
   ```
2. Confirm the endpoint is up (LogTapper running + bridge enabled). Optional
   liveness check on the port:
   - Windows: `Test-NetConnection 127.0.0.1 -Port 40405`
   - macOS/Linux: `nc -z 127.0.0.1 40405 && echo open`
3. The `logtapper` tools connect at session start. If they do not appear
   immediately, the user may need to start a new Claude Code session (or run
   `/mcp` to reconnect). Once connected, verify end-to-end by calling
   `logtapper_list_sessions`.

Report success as: **server registered (scope: user) · endpoint reachable · one
tool verified.**

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Claude Code cannot connect to the server | Bridge off — the MCP server runs only while it is on | Enable *Settings → General → MCP Integration*, then `/mcp` |
| Tools registered but calls return "LogTapper is not running, or the MCP bridge is unavailable" | App closed or bridge off | Start LogTapper, enable the bridge, keep it open |
| No HTTP endpoint on this LogTapper (release older than 0.13) | Pre-HTTP release | Use the stdio fallback, or upgrade LogTapper |
| `node: not found` in dev mode | Node not installed | Install Node ≥ 22 |
| Tools still missing after add | Session hasn't reconnected | Start a new session or run `/mcp` |

## Removing

```
claude mcp remove logtapper --scope user
```
