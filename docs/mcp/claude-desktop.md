# Connect LogTapper to Claude Desktop

Claude Desktop connects to LogTapper by launching the bundled MCP server as a
local process. Setup is a one-time edit to a JSON config file.

Claude Desktop cannot talk to LogTapper's HTTP bridge directly — its config file
only accepts servers it launches itself, and its Custom Connectors feature only
reaches servers on the public internet. The bundled `logtapper-mcp` server
exists to close that gap: Claude Desktop launches it, and it relays tool calls
to the bridge on `127.0.0.1:40404`.

> **This page is for Claude Desktop.** If you use Claude Code (the CLI or IDE
> extension), follow [claude-code.md](claude-code.md) instead — it has a
> two-command setup. Claude Desktop does not support plugins or the `claude mcp`
> command, so the steps below are the way to do it there.

**Before you start:**

- LogTapper installed from a release **newer than 0.10.0**. Earlier releases did
  not include the `logtapper-mcp` binary.
- The MCP bridge enabled under **Settings → General → MCP Integration**. Right
  after you enable it the status reads `Bridge: ready on port 40404`. It only
  changes to `Bridge: connected` once a client has actually called a tool, so
  `ready` is the expected state at this point. See
  [the setup guide](README.md#step-1--enable-the-mcp-bridge).

## Step 1 — Copy the config from LogTapper

In LogTapper, open **Settings → General → MCP Integration**. Below the bridge
toggle, the **Connect an AI agent** panel shows the full path of the bundled
binary. Click **Copy Claude Desktop config**.

That puts a complete, ready-to-paste JSON block on your clipboard with the path
already escaped for JSON. You do not need to find the file yourself.

<details>
<summary>If you can't open LogTapper right now — find the path by hand</summary>

| Platform | Path |
|---|---|
| **Windows**, installed with the `.msi` or "for all users" | `C:\Program Files\LogTapper\logtapper-mcp.exe` |
| **Windows**, installed "just for me" (`.exe` installer) | `%LOCALAPPDATA%\LogTapper\logtapper-mcp.exe` |
| **macOS** | `/Applications/LogTapper.app/Contents/MacOS/logtapper-mcp` |

On Windows, paste the folder into the File Explorer address bar, then
**Shift+right-click** `logtapper-mcp.exe` and choose **Copy as path**. You will
have to escape the backslashes yourself when you paste it into JSON — see
Step 3.

</details>

## Step 2 — Open the config file

Open Claude Desktop's **app settings** — not the account settings inside the
chat window. Use the menu icon at the top-left, then **File → Settings**, or
press **Ctrl+,** (**Cmd+,** on macOS). Go to the **Developer** tab and click
**Edit Config**. This opens `claude_desktop_config.json` in your default editor,
creating it if needed.

To open it manually instead:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

## Step 3 — Add the server

Paste the block you copied in Step 1. For an MSI install on Windows it looks
like this:

```json
{
  "mcpServers": {
    "logtapper": {
      "command": "C:\Program Files\LogTapper\logtapper-mcp.exe"
    }
  }
}
```

That's the whole entry. The server takes no arguments and reads no environment
variables — the bridge address is fixed at `127.0.0.1:40404`.

**Do not add any other keys** such as `url`, `type`, or `transport`. Claude
Desktop's config only understands launched processes, and an entry with
unrecognized keys can make it silently drop the whole `mcpServers` block.

Keep the name `logtapper`. It is the name used throughout these docs and by the
Claude Code plugin, so troubleshooting steps line up. (Renaming it only changes
the label Claude Desktop shows — the tools themselves are always named
`logtapper_*`.)

**Two things that trip people up:**

1. **Backslashes** — only if you typed the path by hand. JSON treats `\` as an
   escape character, so a Windows path pasted as-is breaks the file. Either
   double them (`C:\Program Files\...`) or use forward slashes
   (`C:/Program Files/...`), which work fine on Windows. The in-app copy button
   already does this for you.

2. **Existing servers.** If the file already has other entries, add `logtapper`
   *inside* the existing `mcpServers` object rather than pasting over the whole
   file:

   ```json
   {
     "mcpServers": {
       "some-other-server": { "command": "..." },
       "logtapper": {
         "command": "C:\Program Files\LogTapper\logtapper-mcp.exe"
       }
     }
   }
   ```

Save the file when you're done.

## Step 4 — Restart Claude Desktop completely

MCP servers are only started when Claude Desktop launches, so a restart is
required — and on Windows, closing the window only minimizes the app to the
system tray.

- **Windows:** right-click the Claude icon in the system tray (bottom-right, you
  may need to click the `^` arrow to see it) and choose **Quit**. Then reopen
  Claude Desktop.
- **macOS:** **Cmd+Q**, or **Claude → Quit Claude**. Closing the window is not
  enough.

## Step 5 — Verify

Click the **+** button at the bottom-left of the message box, hover
**Connectors**, and choose **Manage connectors**. `logtapper` should be listed
with 21 tools.

Then start LogTapper, open a log file, and ask Claude:

> What LogTapper sessions are open?

You should get back your session with its source type and line count. Back in
LogTapper, the MCP Integration status flips to `Bridge: connected` within a few
seconds of that call — a second confirmation that the two are talking.

## Running from a source checkout

If you cloned the repository instead of installing a release there is no
compiled binary, and the in-app panel says so. Launch the TypeScript server
with Node 22+ instead:

```json
{
  "mcpServers": {
    "logtapper": {
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "C:/path/to/repo/mcp-server/src/index.ts"
      ]
    }
  }
}
```

## If something isn't working

| Symptom | Fix |
|---|---|
| `logtapper` doesn't appear under Manage connectors | Almost always the path or the JSON. Open `%APPDATA%\Claude\logs\mcp.log` (macOS: `~/Library/Logs/Claude/mcp.log`) — a spawn error naming the path means the file isn't there; a parse error means the JSON is broken. This log is the definitive check. |
| Claude replies "LogTapper is not running, or the MCP bridge is unavailable" | LogTapper is closed, or the bridge is off — check **Settings → General → MCP Integration**. Some tools report the same condition as a "fetch failed" error instead. |
| Nothing changed after saving the config | The app wasn't fully quit. Use tray → **Quit** on Windows, **Cmd+Q** on macOS. |
| Other servers vanished after you edited the file | An entry had an unsupported key or a syntax error and Claude Desktop rewrote the file. Restore it, keep only `command` under `logtapper`, and validate the JSON before saving. |
| The config file won't save | It may be open in another editor, or you edited the wrong copy — reopen via **Developer → Edit Config**. |
| `logtapper_open_file` is denied | The folder isn't allowlisted — add it under **Settings → General → MCP File Access**. |

More detail in the [main troubleshooting table](README.md#troubleshooting).
