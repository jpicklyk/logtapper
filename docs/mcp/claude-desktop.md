# Connect LogTapper to Claude Desktop

LogTapper ships an **MCP Bundle** (`.mcpb`) for Claude Desktop. It is a small
relay: Claude Desktop's extensions are stdio-only and its cloud connectors
cannot reach localhost, so the bundle speaks stdio to Claude Desktop and
forwards every tool call to the MCP server LogTapper runs at
`http://127.0.0.1:40405/mcp`. It carries no tools of its own, so you install it
**once** — it does not change when LogTapper updates.

The same extension serves Cowork sessions, which use Claude Desktop's local
extensions.

> **This page is for Claude Desktop.** If you use Claude Code (the CLI or IDE
> extension), follow [claude-code.md](claude-code.md) instead — it connects to
> the URL directly and needs no bundle.

**Before you start:** LogTapper installed, and the MCP bridge enabled under
**Settings → General → MCP Integration**. Right after enabling it the status
reads `Bridge: ready on port 40404`; it only changes to `Bridge: connected`
once a client has actually called a tool, so `ready` is what you should expect
here. See [the setup guide](README.md#step-1--enable-the-mcp-bridge).

## Install

**1. Save the bundle.** In LogTapper, go to **Settings → General → MCP
Integration**. Under **Connect an AI agent**, find the *Claude Desktop* row and
click **Save bundle…**. Save `logtapper.mcpb` somewhere you can find it, such as
your Downloads folder.

**2. Install it in Claude Desktop.** Open **Settings → Extensions → Advanced
settings → Install Extension…** (older builds: **Developer → Extensions →
Install Extension…** from the menu bar), select the `logtapper.mcpb` file you
just saved, and confirm the **Install Extension?** dialog.

The LogTapper tools are available in your next conversation.

### About the "Install extension" button

If LogTapper shows an **Install extension** button next to **Save bundle…**,
your system has an application registered for `.mcpb` files and the button hands
the bundle straight to it, skipping the save step.

The button is hidden when nothing is registered for the file type — notably the
**Microsoft Store build of Claude Desktop on Windows, which does not claim
`.mcpb`**. There, clicking would raise Windows' "How do you want to open this
file?" chooser instead of installing anything, so LogTapper offers only
**Save bundle…** and you install from Claude Desktop's settings as above.

### Managed organizations

Claude Desktop checks extensions against an organization allowlist and blocklist
before installing. If your organization enables the allowlist and LogTapper
isn't on it, the install may be refused — that's an administrator setting, not a
problem with the bundle.

## What gets installed

The bundle is a relay, about half a megabyte, that Claude Desktop runs with its
built-in Node runtime. It has no tool definitions and no knowledge of where
LogTapper is installed; it only knows the URL. That has three consequences:

- **Install once.** A LogTapper update changes the server behind the URL, not
  the relay. You never reinstall the extension for a release.
- **LogTapper must be running with the bridge enabled** for tools to exist. The
  MCP server starts and stops with the bridge.
- **Start order does not matter.** If Claude Desktop starts before LogTapper,
  the extension shows no tools until the bridge is up, then picks them up on
  its own within a few seconds — no toggling, no restart.
- **Changed the port?** If another program owns port 40405 on your machine,
  change LogTapper's MCP port under **Settings → General → MCP Integration**,
  then open the extension's settings in Claude Desktop and set **LogTapper MCP
  URL** to the new address shown there. That is the only setting the relay
  has, and it is the only time you touch it.

## Verify

Open the connector menu in the message composer — `logtapper` should be listed.
Then open a log file in LogTapper and ask Claude:

> What LogTapper sessions are open?

You should get back your session with its source type and line count.

## Manual setup (fallback)

You only need this if you can't use the bundle at all — for example a policy
that blocks extensions. Do not combine it with the extension: Claude Desktop
has been known to break tool routing when the same server is configured both
ways.

<details>
<summary>Configure <code>claude_desktop_config.json</code> by hand</summary>

This route points Claude Desktop at the `logtapper-mcp` binary installed
alongside the app, launched over stdio.

**1. Get the path.** In LogTapper, under **Settings → General → MCP Integration
→ Connect an AI agent**, the *Launch by path (stdio)* row shows the resolved
binary path. Use **Copy JSON config (by path)** there to get a ready-to-paste
block with the path already filled in and backslashes correctly escaped.

**2. Open the config file.** In Claude Desktop's app settings go to the
**Developer** tab and click **Edit Config**. This opens
`claude_desktop_config.json` in your default editor, creating it if needed.

To open it manually instead:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

**3. Add the server.**

```json
{
  "mcpServers": {
    "logtapper": {
      "command": "C:/Users/you/AppData/Local/LogTapper/logtapper-mcp.exe"
    }
  }
}
```

**Backslashes** are escape characters in JSON, so a pasted Windows path breaks
the file — double them (`C:\\Users\\...`) or use forward slashes. If the file
already has other servers, add `logtapper` *inside* the existing `mcpServers`
object rather than replacing the whole file.

**4. Restart Claude Desktop completely.** MCP servers start only at launch, and
on Windows closing the window just minimizes to the system tray — right-click
the tray icon and choose **Quit**. On macOS use **Cmd+Q**.

</details>

## If something isn't working

| Symptom | Fix |
|---|---|
| Double-clicking the saved `.mcpb` does nothing, or Windows asks how to open it | Expected on the Store build — install it from **Settings → Extensions → Advanced settings → Install Extension…** instead |
| No **Install extension** button, only **Save bundle…** | Expected — nothing on your system is registered for `.mcpb`. Save it, then install from Claude Desktop's settings |
| No *Claude Desktop* row in Settings at all | This LogTapper build ships no bundle — use the manual fallback above |
| The install is refused | Your organization's extension allowlist may not include LogTapper — ask your administrator |
| Extension installed but no tools appear | LogTapper is closed or the bridge is off. Enable **Settings → General → MCP Integration**; the tools appear within a few seconds |
| Claude replies "LogTapper is not reachable at http://127.0.0.1:40405/mcp" | Same cause — the MCP server runs only while the bridge is on |
| Still nothing | Check the extension's entry in Claude Desktop's extension list, then its log: `%LOCALAPPDATA%\Claude\Logs\mcp-server-LogTapper.log` on Windows, `~/Library/Logs/Claude/mcp-server-LogTapper.log` on macOS |
| `logtapper_open_file` is denied | The folder isn't allowlisted — add it under **Settings → General → MCP File Access** |

More detail in the [main troubleshooting table](README.md#troubleshooting).
