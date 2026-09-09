# Connect LogTapper to Claude Desktop

LogTapper ships an **MCP Bundle** (`.mcpb`) — a self-contained extension that
Claude Desktop installs in one click. There are no file paths to look up and no
config file to edit.

> **This page is for Claude Desktop.** If you use Claude Code (the CLI or IDE
> extension), follow [claude-code.md](claude-code.md) instead — it cannot install
> `.mcpb` bundles and is set up differently.

**Before you start:** LogTapper installed, and the MCP bridge enabled under
**Settings → General → MCP Integration**. Right after enabling it the status
reads `Bridge: ready on port 40404`; it only changes to `Bridge: connected`
once a client has actually called a tool, so `ready` is what you should expect
here. See [the setup guide](README.md#step-1--enable-the-mcp-bridge).

## Install

In LogTapper, go to **Settings → General → MCP Integration**. Below the bridge
toggle, under **Connect an AI agent**, find the *Claude Desktop* row and click
**Install extension**.

Claude Desktop opens its install dialog. Confirm it, and you're done — the
LogTapper tools are available in your next conversation.

That's the whole process. You can skip the rest of this page unless something
goes wrong.

### If nothing happens when you click Install

The button hands the bundle to your operating system, which passes it to
whichever app owns `.mcpb` files. If Claude Desktop isn't installed, nothing
owns that extension and the click appears to do nothing.

Click **Save bundle…** instead, put the file somewhere you can find it, and
double-click it once Claude Desktop is installed.

## What gets installed

The bundle carries its own copy of the LogTapper MCP server, and Claude Desktop
supplies the Node runtime to run it. It does **not** reference LogTapper's
install directory, so moving, upgrading, or reinstalling LogTapper won't break
it — and it works on releases that shipped without the `logtapper-mcp` binary.

It reaches LogTapper over the local bridge on `127.0.0.1:40404`, so **LogTapper
must be running with the bridge enabled** for tools to work. The extension
staying installed while LogTapper is closed is normal; the tools just fail until
you open it again.

## Verify

Open the connector menu in the message composer — `logtapper` should be listed.
Then open a log file in LogTapper and ask Claude:

> What LogTapper sessions are open?

You should get back your session with its source type and line count.

## Manual setup (fallback)

You only need this if you can't use the bundle — an older LogTapper build that
doesn't ship one, or a policy that blocks installing extensions.

<details>
<summary>Configure <code>claude_desktop_config.json</code> by hand</summary>

This route points Claude Desktop at the `logtapper-mcp` binary installed
alongside the app, so it requires a LogTapper release **newer than 0.10.0** —
earlier releases did not include that binary. If yours doesn't have it, the
bundle is your only option; upgrade LogTapper.

**1. Get the path.** In LogTapper, under **Settings → General → MCP Integration
→ Connect an AI agent**, the *Claude Code* row shows the resolved binary path.
Use **Copy JSON config** there to get a ready-to-paste block with the path
already filled in and backslashes correctly escaped. Failing that, the
[binary location table](README.md#step-2--find-the-bundled-binary) lists it per
platform.

**2. Open the config file.** Open Claude Desktop's **app settings** — not the
account settings inside the chat window. Use the menu icon at the top-left, then
**File → Settings**, or press **Ctrl+,** (**Cmd+,** on macOS). Go to the
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

Two things that trip people up. **Backslashes** are escape characters in JSON,
so a pasted Windows path breaks the file — double them (`C:\\Users\\...`) or use
forward slashes, which work fine on Windows. And if the file already has other
servers, add `logtapper` *inside* the existing `mcpServers` object rather than
replacing the whole file.

**4. Restart Claude Desktop completely.** MCP servers start only at launch, and
on Windows closing the window just minimizes to the system tray — right-click
the tray icon and choose **Quit**. On macOS use **Cmd+Q**.

</details>

## If something isn't working

| Symptom | Fix |
|---|---|
| **Install extension** does nothing | Claude Desktop isn't installed, or doesn't own `.mcpb` files — use **Save bundle…** and double-click the saved file |
| No *Claude Desktop* row in Settings | This LogTapper build ships no bundle — use the manual fallback above |
| Extension installed but tools never appear | Check Claude Desktop's extension list; a failed extension reports its error there. Then check `%APPDATA%\Claude\logs\mcp.log` (macOS: `~/Library/Logs/Claude/mcp.log`) — this log is the definitive check |
| Claude replies "LogTapper is not running, or the MCP bridge is unavailable" | LogTapper is closed, or the bridge is off — check **Settings → General → MCP Integration**. Some tools report the same condition as a "fetch failed" error instead |
| `logtapper` doesn't appear under Manage connectors (manual setup) | Almost always the path or the JSON. Open `mcp.log` at the path above — a spawn error naming the path means the file isn't there; a parse error means the JSON is broken |
| Nothing changed after saving the config (manual setup) | The app wasn't fully quit. Use tray → **Quit** on Windows, **Cmd+Q** on macOS |
| Other servers vanished after you edited the file | An entry had an unsupported key or a syntax error and Claude Desktop rewrote the file. Restore it, keep only `command` under `logtapper`, and validate the JSON before saving |
| The config file won't save | It may be open in another editor, or you edited the wrong copy — reopen via **Developer → Edit Config** |
| `logtapper_open_file` is denied | The folder isn't allowlisted — add it under **Settings → General → MCP File Access** |

More detail in the [main troubleshooting table](README.md#troubleshooting).
