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

**New in 0.3.0** (backend service-layer migration): full agent parity with the
desktop UI, not just read access. New tool families —
`logtapper_workspace` (list/load/save/autosave), `logtapper_filters`
(create/info/lines/cancel/close), `logtapper_stream` (start/status/events/stop
for ADB streaming), `logtapper_processors` and `logtapper_marketplace`
(install/uninstall/packs/sources/updates), `logtapper_chain`
(get/set/add/remove — read or edit a session's configured processor chain),
`logtapper_chart` / `logtapper_timeline`, `logtapper_export`,
`logtapper_settings` (read-only —
agents cannot change the anonymizer config, open-file allowlist or their own
raw-log access, by design; log text reaching an agent is PII-redacted unless
the user opted out in Settings),
and `logtapper_activity` (the shared UI+agent action feed). A watch or
pipeline run created via chat now shows up live in the desktop UI.

This is a breaking change for anything calling the bridge's HTTP API directly:
response fields are camelCase and some were renamed (e.g. a search tool's
`matchCount` is now `total`), and failures are real HTTP status codes
(404/400/403/etc.) instead of `200` with an error in the body. Tools invoked
through this plugin are unaffected — the field renames and status handling
are internal to the bundled MCP server.

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
