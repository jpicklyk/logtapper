---
name: attach-mcp
description: >-
  Attach or connect the LogTapper MCP server to Claude Code so LogTapper's
  log-analysis tools (list sessions, search log lines, run processors, read
  state-tracker events, manage bookmarks/watches) become available in chat.
  Use whenever the user asks to attach to LogTapper, connect the LogTapper MCP,
  add LogTapper tools, set up the LogTapper integration, or otherwise hook Claude
  up to LogTapper. Auto-detects the bundled logtapper-mcp binary (installed app)
  or the node/TypeScript server (dev checkout) and registers it at user scope.
---

# Attach the LogTapper MCP to Claude

Register LogTapper's MCP server with Claude Code so its log-analysis tools are
available in chat. LogTapper exposes its live log sessions over a local HTTP
bridge (`127.0.0.1:40404`); the MCP server is a thin **stdio** process that
relays tool calls to that bridge.

**Definition of done:** a `logtapper` MCP server registered at **user scope**,
the bridge reachable, and at least one tool call verified.

The tools appear under the `logtapper` namespace (`mcp__logtapper__*`), so always
register the server with the exact name **`logtapper`**.

## Requirements to confirm with the user

Tool *calls* only work when the app is up and the bridge is on, but you can
register first and verify last. Make sure the user knows:

1. **LogTapper is installed and running.**
2. **The MCP Bridge is enabled** — in LogTapper: *Settings → General → MCP
   Integration*, toggle the bridge on. It then listens on `127.0.0.1:40404`.
3. The `claude` CLI is on PATH (it is, if they are running Claude Code).

## Step 1 — Is it already attached?

```
claude mcp list
```

If a `logtapper` entry already exists, tell the user it is already attached and
skip to **Step 4**. Only re-register if it points at a stale or wrong path.

## Step 2 — Locate the MCP server

Determine the launch command using the **first** case that matches.

### (a) Dev checkout
If the current directory (or an ancestor) contains `mcp-server/src/index.ts`,
this is a LogTapper source checkout. Launch via Node with TypeScript stripping:

- command: `node`
- args: `--experimental-strip-types <abs-path>/mcp-server/src/index.ts`

Resolve the absolute path from the repo root before building the command.

### (b) Installed app — bundled binary
Releases **newer than 0.10.0** ship a compiled sidecar named `logtapper-mcp`
(`logtapper-mcp.exe` on Windows) **next to the main executable**. Earlier
releases did not include it — if the user is on 0.10.0 or older, they must
upgrade or use a dev checkout.

The app itself knows the path: **Settings → General → MCP Integration →
Connect an AI agent** shows it, with a **Copy Claude Code command** button that
produces the exact `claude mcp add` line from Step 3. If LogTapper is open,
asking the user to read or copy it from there is the fastest route.

Otherwise, find it through the running app process, then its sibling:

**Windows (PowerShell):**
```powershell
$p = Get-Process log-tapper, LogTapper -ErrorAction SilentlyContinue | Select-Object -First 1
if ($p) { Get-ChildItem (Split-Path $p.Path) -Filter 'logtapper-mcp*.exe' | Select-Object -First 1 -ExpandProperty FullName }
```
If the app is not running, probe the two install locations the installers use:
- `$env:ProgramFiles\LogTapper\logtapper-mcp.exe` — `.msi`, or `.exe` installer
  with "for all users"
- `$env:LOCALAPPDATA\LogTapper\logtapper-mcp.exe` — `.exe` installer with
  "just for me"

**macOS:**
```bash
ls "/Applications/LogTapper.app/Contents/MacOS/logtapper-mcp" 2>/dev/null
```

**Linux:**
```bash
command -v logtapper-mcp 2>/dev/null || ls /usr/bin/logtapper-mcp 2>/dev/null
```
The `.deb` and `.rpm` install it to `/usr/bin`. For an AppImage build, the
binary sits alongside the AppImage — ask the user for that folder if it is not
found automatically.

### (c) Ask the user
If neither is found, ask for the full path to the `logtapper-mcp` binary (or the
LogTapper install folder). Point them to the
[MCP Setup Guide](https://github.com/jpicklyk/logtapper/blob/main/docs/mcp/README.md#step-2--find-the-bundled-binary),
which lists the install location for every platform.

## Step 3 — Register at user scope

Use `claude mcp add` with `--scope user` so LogTapper is available in every
project. Everything after `--` is the launch command, passed through untouched.

**Installed binary:**
```
claude mcp add logtapper --scope user -- "<path-to>/logtapper-mcp"
```
Windows example (MSI / all-users install):
```
claude mcp add logtapper --scope user -- "C:\Program Files\LogTapper\logtapper-mcp.exe"
```

**Dev checkout:**
```
claude mcp add logtapper --scope user -- node --experimental-strip-types "<abs-path>/mcp-server/src/index.ts"
```

Quote any path containing spaces. Do not change the server name from `logtapper`.

## Step 4 — Verify

1. Confirm registration:
   ```
   claude mcp get logtapper
   ```
2. Confirm the bridge is reachable (LogTapper running + bridge enabled). Optional
   liveness check on the port:
   - Windows: `Test-NetConnection 127.0.0.1 -Port 40404`
   - macOS/Linux: `nc -z 127.0.0.1 40404 && echo open`
3. The `logtapper` tools connect when the stdio server starts. If they do not
   appear immediately, the user may need to start a new Claude Code session (or
   run `/mcp` to reconnect). Once connected, verify end-to-end by calling
   `logtapper_list_sessions`.

Report success as: **server registered (scope: user) · bridge reachable · one
tool verified.**

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Tools registered but calls return "LogTapper is not running, or the MCP bridge is unavailable" (or "fetch failed") | Bridge off or app not running | Enable *Settings → General → MCP Integration*; keep LogTapper open |
| `logtapper-mcp` binary not found next to the app | Release 0.10.0 or older — the sidecar was not shipped | Upgrade LogTapper, or in a dev checkout use the Node command instead |
| `logtapper-mcp` binary not found, install location unknown | Path unknown | Have the user read it from *Settings → General → MCP Integration*, or ask for the install folder |
| `node: not found` in dev mode | Node not installed | Use the bundled binary, or install Node ≥ 22 |
| Wrong/old path registered | App moved or reinstalled | `claude mcp remove logtapper`, then redo Step 3 |
| Tools still missing after add | Session hasn't reconnected | Start a new session or run `/mcp` |

## Removing

```
claude mcp remove logtapper
```
