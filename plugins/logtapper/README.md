# LogTapper — Claude Code Plugin

Companion tools for the [LogTapper](https://github.com/jpicklyk/logtapper)
desktop log-analysis app. This plugin helps you connect Claude Code to a running
LogTapper instance and work with live log sessions by chat.

## Skills

| Skill | Invoke | What it does |
|---|---|---|
| `attach-mcp` | `/logtapper:attach-mcp` — or just *"attach to the LogTapper MCP"* | Detects the LogTapper MCP server (bundled binary in an installed app, or the node/TypeScript server in a dev checkout) and registers it with Claude Code at **user scope**. |

Once attached, LogTapper's tools appear under the `logtapper` namespace
(`mcp__logtapper__*`): list sessions, search log lines with context, run
processors, read state-tracker/correlator events, and manage bookmarks and
watches.

## Requirements

- **LogTapper installed and running**, with the MCP Bridge enabled in
  *Settings → General → MCP Integration* (listens on `127.0.0.1:40404`).
- Claude Code with the `claude` CLI on PATH.

## Install

The plugin is distributed through the marketplace in the LogTapper repo:

```bash
claude plugin marketplace add jpicklyk/logtapper
claude plugin install logtapper@logtapper-plugins
```

Then, in any project:

```
attach to the LogTapper MCP
```

## How the MCP connection works

LogTapper ships its MCP server **with the desktop app** — a compiled `logtapper-mcp`
binary next to the app executable in released builds, or the
`node --experimental-strip-types mcp-server/src/index.ts` server in a source
checkout. Because that path is machine-specific, the plugin does **not** hard-code
an MCP config; the `attach-mcp` skill detects the right launcher and registers it
for you.

## License

GPL-3.0-or-later, matching the LogTapper project.
