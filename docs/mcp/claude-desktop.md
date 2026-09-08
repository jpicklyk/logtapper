# Connect LogTapper to Claude Desktop

Claude Desktop connects to LogTapper by launching the bundled MCP server. Setup
is a one-time edit to a JSON config file.

> **This page is for Claude Desktop.** If you use Claude Code (the CLI or IDE
> extension), follow [claude-code.md](claude-code.md) instead — it has a
> two-command setup. Claude Desktop does not support plugins or the `claude mcp`
> command, so the steps below are the way to do it there.

**Before you start:** LogTapper installed, and the MCP bridge enabled under
**Settings → General → MCP Integration**. See
[the setup guide](README.md#step-1--enable-the-mcp-bridge).

## Step 1 — Copy the binary path

You need the full path to `logtapper-mcp`. The
[binary location table](README.md#step-2--find-the-bundled-binary) lists it per
platform — on Windows it is usually:

```
%LOCALAPPDATA%\LogTapper\logtapper-mcp.exe
```

Paste that folder into the File Explorer address bar, then **Shift+right-click**
the file and choose **Copy as path**.

## Step 2 — Open the config file

In Claude Desktop, go to **Settings → Developer → Edit Config**. This opens
`claude_desktop_config.json` in your default editor — no need to go looking for
it.

To open it manually instead:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

If the file doesn't exist yet, create it with the contents shown below.

## Step 3 — Add the server

```json
{
  "mcpServers": {
    "logtapper": {
      "command": "C:/Users/you/AppData/Local/LogTapper/logtapper-mcp.exe"
    }
  }
}
```

That's the whole entry — the server takes no arguments and needs no environment
variables.

Keep the name `logtapper` exactly as written. The tools are namespaced from it,
so renaming the server renames every tool.

**Two things that trip people up:**

1. **Backslashes.** JSON treats `\` as an escape character, so a Windows path
   pasted as-is will break the file. Either double them
   (`C:\Users\you\...`) or use forward slashes (`C:/Users/you/...`), which
   work fine on Windows. "Copy as path" gives you single backslashes, so this
   applies to almost everyone.

2. **Existing servers.** If the file already has other entries, add `logtapper`
   *inside* the existing `mcpServers` object rather than pasting over the whole
   file:

   ```json
   {
     "mcpServers": {
       "some-other-server": { "command": "..." },
       "logtapper": {
         "command": "C:/Users/you/AppData/Local/LogTapper/logtapper-mcp.exe"
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

Open the tools/connector menu in the message composer. `logtapper` should be
listed with its tools available.

Then start LogTapper, open a log file, and ask Claude:

> What LogTapper sessions are open?

You should get back your session with its source type and line count.

## If something isn't working

| Symptom | Fix |
|---|---|
| `logtapper` doesn't appear in the tools menu | Almost always the path. Check backslash escaping first, then confirm the file exists at that path. |
| It appears, but every call fails | LogTapper isn't running, or the bridge is off — check **Settings → General → MCP Integration**. |
| Nothing changed after saving the config | The app wasn't fully quit. Use tray → **Quit** on Windows, **Cmd+Q** on macOS. |
| The config file won't save | It may be open in another editor, or you edited the wrong copy — reopen via **Settings → Developer → Edit Config**. |
| JSON error on startup | A stray comma or unescaped backslash. Paste the file into a JSON validator to find it. |

More detail in the [main troubleshooting table](README.md#troubleshooting).
