# Connect LogTapper to Claude Code

Claude Code connects to the MCP server LogTapper runs over HTTP. One command,
no binary path, and nothing to redo after a LogTapper update.

> **This page is for Claude Code** (the CLI, desktop app, or IDE extension). If
> you use Claude Desktop, follow [claude-desktop.md](claude-desktop.md) instead —
> plugins and the `claude mcp` command are not available there.

**Before you start:** LogTapper installed, and the MCP bridge enabled under
**Settings → General → MCP Integration**. The MCP server starts and stops with
the bridge. See [the setup guide](README.md#step-1--enable-the-mcp-bridge).

## Register the server

```
claude mcp add --transport http --scope user logtapper http://127.0.0.1:40405/mcp
```

The same command is one click away in LogTapper: **Settings → General → MCP
Integration → Connect an AI agent → Copy claude mcp add command**.

Notes:

- `--scope user` makes LogTapper available in every project. Use
  `--scope project` instead if you only want it in the current repository.
- Keep the name `logtapper` exactly as written — the tools are namespaced from
  it (`mcp__logtapper__*`).

> **Do not add `mcpServers` to `~/.claude/settings.json`.** That key belongs to
> Claude Desktop's config format; Claude Code ignores it, and the server will
> silently never load. Use `claude mcp add`, which writes the correct file.

### Or let the plugin do it

```
/plugin marketplace add jpicklyk/logtapper
/plugin install logtapper@logtapper-plugins
```

Then ask Claude:

> attach the LogTapper MCP

The `attach-mcp` skill registers the URL at user scope and runs a test tool
call. The plugin also installs a `log-analysis` skill for working with sessions
conversationally — searching for crashes, tracing state transitions, and running
processor pipelines by chat.

## Verify

```
claude mcp get logtapper
```

Then start a new session (or run `/mcp` to reconnect — servers are attached at
session start), open a log file in LogTapper, and ask:

> What LogTapper sessions are open?

## Launching by path instead

If you need the stdio form — for a tool that wraps Claude Code and cannot use
HTTP, say — the `logtapper-mcp` binary is installed next to the LogTapper
executable, and the **Launch by path (stdio)** row in Settings shows its path:

```
claude mcp add logtapper --scope user -- "/path/to/logtapper-mcp"
```

From a source checkout, use Node as the command:

```
claude mcp add logtapper --scope user -- node --experimental-strip-types "/path/to/repo/mcp-server/src/index.ts"
```

The path changes if LogTapper moves between per-user and all-users installs,
which is why the URL is the default.

## Removing or updating

```
claude mcp remove logtapper --scope user
```

With the URL route there is nothing to update after a LogTapper release. Only a
path-based registration needs re-adding when the app moves.

## If something isn't working

| Symptom | Fix |
|---|---|
| Tools don't appear after adding | Start a new session, or run `/mcp` to reconnect |
| The connection fails outright | The bridge is off — the MCP server runs only while it is on. Enable it, then `/mcp` |
| Tools appear but every call fails | LogTapper isn't running, or the bridge is off |
| `claude: command not found` | Claude Code's CLI isn't on your PATH — reinstall it, or use the plugin route from inside Claude Code |
| Wrong or stale path registered (stdio route) | `claude mcp remove logtapper --scope user`, then add the URL instead |

More detail in the [main troubleshooting table](README.md#troubleshooting).
