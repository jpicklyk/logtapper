# Connect LogTapper to Claude Code

Claude Code can set this up for you. The LogTapper plugin ships a skill that
locates the bundled binary, registers the MCP server at user scope, and verifies
the connection.

> **This page is for Claude Code** (the CLI, desktop app, or IDE extension). If
> you use Claude Desktop, follow [claude-desktop.md](claude-desktop.md) instead —
> plugins and the `claude mcp` command are not available there.

**Before you start:** LogTapper installed, and the MCP bridge enabled under
**Settings → General → MCP Integration**. See
[the setup guide](README.md#step-1--enable-the-mcp-bridge).

## Recommended — install the plugin

```
/plugin marketplace add jpicklyk/logtapper
/plugin install logtapper@logtapper-plugins
```

Then ask Claude:

> attach the LogTapper MCP

The `attach-mcp` skill finds the binary, registers it at user scope, and runs a
test tool call. You never have to look up a path.

The plugin also installs a `log-analysis` skill for working with sessions
conversationally — searching for crashes, tracing state transitions, and running
processor pipelines by chat.

## Manual setup

If you'd rather not install the plugin, register the server yourself. Get the
binary path from the
[binary location table](README.md#step-2--find-the-bundled-binary), then:

```
claude mcp add logtapper --scope user -- "/path/to/logtapper-mcp"
```

Windows:

```
claude mcp add logtapper --scope user -- "C:\Users\you\AppData\Local\LogTapper\logtapper-mcp.exe"
```

Running from a source checkout instead of an installed release:

```
claude mcp add logtapper --scope user -- node --experimental-strip-types "/path/to/repo/mcp-server/src/index.ts"
```

Notes:

- `--scope user` makes LogTapper available in every project. Use
  `--scope project` instead if you only want it in the current repository.
- Everything after `--` is the launch command, passed through untouched. Quote
  any path containing spaces.
- Keep the name `logtapper` exactly as written — the tools are namespaced from
  it (`mcp__logtapper__*`).

> **Do not add `mcpServers` to `~/.claude/settings.json`.** That key belongs to
> Claude Desktop's config format; Claude Code ignores it, and the server will
> silently never load. Use `claude mcp add`, which writes the correct file.

## Verify

```
claude mcp get logtapper
```

Then start a new session (or run `/mcp` to reconnect — servers are attached at
session start), open a log file in LogTapper, and ask:

> What LogTapper sessions are open?

## Removing or updating

```
claude mcp remove logtapper --scope user
```

Re-run the add command with the new path. Do this if you move LogTapper or
switch between a per-user and all-users install.

## If something isn't working

| Symptom | Fix |
|---|---|
| Tools don't appear after adding | Start a new session, or run `/mcp` to reconnect |
| Tools appear but every call fails | LogTapper isn't running, or the bridge is off |
| `claude: command not found` | Claude Code's CLI isn't on your PATH — reinstall it, or use the plugin route from inside Claude Code |
| Wrong or stale path registered | `claude mcp remove logtapper --scope user`, then re-add |

More detail in the [main troubleshooting table](README.md#troubleshooting).
