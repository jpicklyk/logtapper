# Connect LogTapper to Claude Desktop

LogTapper ships an **MCP Bundle** (`.mcpb`) — a self-contained extension for
Claude Desktop. Installing it takes two steps: save the bundle from LogTapper,
then install it from Claude Desktop's **Developer** menu.

> **This page is for Claude Desktop.** If you use Claude Code (the CLI or IDE
> extension), follow [claude-code.md](claude-code.md) instead — it cannot install
> `.mcpb` bundles and is set up differently.

**Before you start:** LogTapper installed, and the MCP bridge enabled under
**Settings → General → MCP Integration**. Right after enabling it the status
reads `Bridge: ready on port 40404`; it only changes to `Bridge: connected`
once a client has actually called a tool, so `ready` is what you should expect
here. See [the setup guide](README.md#step-1--enable-the-mcp-bridge).

## Install

**1. Save the bundle.** In LogTapper, go to **Settings → General → MCP
Integration**. Below the bridge toggle, under **Connect an AI agent**, find the
*Claude Desktop* row and click **Save bundle…**. Save `logtapper.mcpb` somewhere
you can find it, such as your Downloads folder.

**2. Install it in Claude Desktop.** From the menu bar, choose
**Developer → Extensions → Install Extension…**, select the `logtapper.mcpb`
file you just saved, and confirm the **Install Extension?** dialog.

The LogTapper tools are available in your next conversation.

> **Not in Settings.** Extension installation lives in Claude Desktop's
> **Developer** menu — the same menu as *Open MCP Log File…* and *Reload MCP
> Configuration* — not in its Settings window. Looking under Settings is the
> most common reason people can't find it.

### If there's no Developer menu

The Developer menu appears only once developer mode is enabled. Look for an
**Enable Developer Mode…** menu item — it sits with the troubleshooting items
such as *Record Net Log* and *Disable Hardware Acceleration* — and confirm the
warning dialog it shows.

Failing that, enable it by hand: create or edit
`%APPDATA%\Claude\developer_settings.json` (macOS:
`~/Library/Application Support/Claude/developer_settings.json`) so it contains

```json
{ "allowDevTools": true }
```

then restart Claude Desktop completely — on Windows, right-click the system tray
icon and choose **Quit**, since closing the window only minimizes it.

### About the "Install extension" button

If LogTapper shows an **Install extension** button next to **Save bundle…**,
your system has an application registered for `.mcpb` files and the button hands
the bundle straight to it, skipping the save step.

The button is hidden when nothing is registered for the file type — notably the
**Microsoft Store build of Claude Desktop on Windows, which does not claim
`.mcpb`**. There, clicking would raise Windows' "How do you want to open this
file?" chooser instead of installing anything, so LogTapper offers only
**Save bundle…** and you use the Developer menu as above.

### Managed organizations

Claude Desktop checks extensions against an organization allowlist and blocklist
before installing. If your organization enables the allowlist and LogTapper
isn't on it, the install may be refused — that's an administrator setting, not a
problem with the bundle.

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

You only need this if you can't use the bundle at all — an older LogTapper build
that doesn't ship one, or a policy that blocks extensions.

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
| Double-clicking the saved `.mcpb` does nothing, or Windows asks how to open it | Expected on the Store build — install it with **Developer → Extensions → Install Extension…** instead |
| No **Install extension** button, only **Save bundle…** | Expected — nothing on your system is registered for `.mcpb`. Save it, then use **Developer → Extensions → Install Extension…** |
| No *Claude Desktop* row in Settings at all | This LogTapper build ships no bundle — use the manual fallback above |
| No **Developer** menu in Claude Desktop | Developer mode is off — use **Enable Developer Mode…**, or set `allowDevTools` in `developer_settings.json` (see above) |
| The install is refused | Your organization's extension allowlist may not include LogTapper — ask your administrator |
| Extension installed but tools never appear | Check Claude Desktop's extension list; a failed extension reports its error there. Then check `%APPDATA%\Claude\logs\mcp.log` (macOS: `~/Library/Logs/Claude/mcp.log`) — this log is the definitive check |
| Claude replies "LogTapper is not running, or the MCP bridge is unavailable" | LogTapper is closed, or the bridge is off — check **Settings → General → MCP Integration**. Some tools report the same condition as a "fetch failed" error instead |
| `logtapper` doesn't appear under Manage connectors (manual setup) | Almost always the path or the JSON. Open `mcp.log` at the path above — a spawn error naming the path means the file isn't there; a parse error means the JSON is broken |
| Nothing changed after saving the config (manual setup) | The app wasn't fully quit. Use tray → **Quit** on Windows, **Cmd+Q** on macOS |
| Other servers vanished after you edited the file | An entry had an unsupported key or a syntax error and Claude Desktop rewrote the file. Restore it, keep only `command` under `logtapper`, and validate the JSON before saving |
| `logtapper_open_file` is denied | The folder isn't allowlisted — add it under **Settings → General → MCP File Access** |

More detail in the [main troubleshooting table](README.md#troubleshooting).
