# LogTapper — Claude Code Plugin

Companion tools for the [LogTapper](https://github.com/jpicklyk/logtapper)
desktop log-analysis app. This plugin helps you connect Claude Code to a running
LogTapper instance and work with live log sessions by chat.

## Skills

| Skill | Invoke | What it does |
|---|---|---|
| `attach-mcp` | `/logtapper:attach-mcp` — or just *"attach to the LogTapper MCP"* | Registers the MCP endpoint LogTapper serves (`http://127.0.0.1:40405/mcp`) with Claude Code at **user scope**, falling back to the bundled binary or a dev checkout over stdio. |
| `log-analysis` | `/logtapper:log-analysis` — or just ask about the logs (*"why is X failing on this device"*, *"compare these two captures"*) | Systematic investigation of the sessions open in LogTapper: pipeline results before raw lines, working-vs-failing comparison, multi-boot timeline discipline for dumpstates, and publishing line-anchored analyses back into the app. |

Once attached, LogTapper's tools appear under the `logtapper` namespace
(`mcp__logtapper__*`): list sessions, search log lines with context, run
processors, read state-tracker/correlator events, and manage bookmarks and
watches.

**New in 0.4.0:** LogTapper 0.13 serves MCP over HTTP itself, so `attach-mcp`
registers a URL instead of a per-install binary path. Nothing to re-register
after moving or updating LogTapper.

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
  *Settings → General → MCP Integration*. While the bridge is on, LogTapper
  serves its MCP server at `http://127.0.0.1:40405/mcp`.
- Claude Code with the `claude` CLI on PATH.

## Install

The plugin is distributed through the marketplace in the LogTapper repo. Inside
a Claude Code session:

```
/plugin marketplace add jpicklyk/logtapper
/plugin install logtapper@logtapper-plugins
```

Or from a terminal:

```bash
claude plugin marketplace add jpicklyk/logtapper
claude plugin install logtapper@logtapper-plugins
```

Then, in any project:

```
attach to the LogTapper MCP
```

## How the MCP connection works

LogTapper runs its MCP server **itself** while the bridge is enabled and serves
it over Streamable HTTP at a fixed local URL. That URL is the whole
configuration: `attach-mcp` registers it at user scope, so it always reaches the
server that shipped with the running LogTapper and nothing needs re-registering
after an update. The plugin does **not** hard-code an MCP config — registration
happens through `claude mcp add`, which writes the correct file for your Claude
Code install.

If HTTP is not an option (a tool that wraps Claude Code and only supports
stdio, say), the skill falls back to launching the `logtapper-mcp` binary
installed next to the app executable, or
`node --experimental-strip-types mcp-server/src/index.ts` from a source checkout.
Those paths are machine-specific, which is why the URL is the default. See
[Connect LogTapper to Claude Code](../../docs/mcp/claude-code.md) for the
manual commands, verification, and troubleshooting.

## License

GPL-3.0-or-later, matching the LogTapper project.
