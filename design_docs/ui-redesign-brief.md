# LogTapper UI Redesign — Design Brief (phase 2)

Status: draft for the Claude Design canvas and for the phase-2 plan. Companion to
`plans/service-layer-phase1.md` (the backend contract this UI is built on).

## 1. Thesis

LogTapper is a workbench for Android log analysis with **two first-class operators**: the
human doing manual investigation, and an AI agent working as a peer on the same
workspaces through MCP. It is not an editor with an AI hook. The agent's presence,
actions, findings and requests are visible in the UI at all times, and anything the human
can do, the agent can do — and vice versa.

The backend already guarantees parity: one service layer, one typed contract, caller
identity on every action, an activity journal, and typed MCP routes for every capability.
The UI has to make that parity *felt*.

**Processors are shared analyzers.** The deterministic processors (reporters, state
trackers, transformers, correlators) are presented as *capabilities* that both operators
apply to a session — the agent's deterministic toolkit and the human's one-click
analysis are the same thing. They stay fully usable with no agent connected. The UI word
is "analyzer" (never "skill", which collides with Claude Code skills); a "pack" is a set
of analyzers for a subsystem.

## 2. Two modes, one workspace

A **workspace** is the unit of work (an investigation, a device, a bug). It holds sessions
of either kind. The session's source type decides which surfaces exist — there is no
fixed panel layout.

| | Post-mortem analysis | Live development |
|---|---|---|
| Sources | dumpstate, bugreport, saved logcat, kernel, `.lts` | ADB logcat stream from a connected device |
| Goal | root cause, comparison across captures, defensible findings | fast signal-to-noise while iterating on a build |
| Tempo | slow, deep | fast, shallow, continuous |
| Agent role | co-analyst: runs processors, reads results, publishes line-anchored analyses | watcher: subscribes to watch matches, explains events as they happen |

## 3. What is wrong today (user's complaints → design direction)

| Complaint | Direction |
|---|---|
| Dashboard feels disconnected from the pipeline | The **Analyzers** surface replaces chain, dashboard and library as separate destinations: one list of the analyzers active for this session, in plain language ("finds USB enumeration failures"), each card carrying its own run state, skips (source-type mismatch), counts and results. Enable → run → read is one flow; agent runs show the same cards plus a feed entry saying why it chose them. |
| Marketplace and processors are too complex for an average user | Ship a **Packs** view: curated capability packs by subsystem (USB, Wi-Fi, battery, memory…), one-click enable per workspace, plain-language description of what each pack's analyzers find; enabling a pack gives both operators those analyzers. Library, YAML authoring, sources, updates and uninstall move under an **Advanced** disclosure. Installing from the marketplace becomes "add pack". |
| The agent does not feel first class | An always-present **agent presence** (see §5): status, activity feed, consent prompts, focus handoff. Agent-created artifacts (bookmarks, watches, analyses, runs) carry a caller badge. Analyses are a home surface, not a side tab. |
| Workspaces are not prominent | Workspace is the top-level navigation: a workspace switcher/home with its sessions, packs enabled, recent analyses, and agent activity. Session tabs live inside the workspace. |
| Correlations are seldom used and disconnected | Demote. Correlator output becomes an analyzer card like any other; no dedicated pane, no bottom tab. (Confirmed.) |
| Device state from trackers is hidden and hard to understand | Promote **Device state** as a named surface — the analyzers' current understanding of the device — tied to the cursor line: current tracked fields, plain-language field descriptions taken from the processor definition, "what changed here" at the selected line, jump to previous/next transition. Snapshot trackers show the dump, time-series trackers show the value at the cursor. |
| Timeline looks good but is underused | Demote to an on-demand strip inside the viewer (scrub-to-line) rather than a standing pane. The agent explains sequences in text and analyses; the strip supports that, it is not a destination. (Confirmed.) |
| Panes are not tied to mode | The mode-to-surface map in §4 is the rule. Watches, stream controls and live device state exist only in live mode; sections, analyses and comparison exist only in post-mortem mode. |

## 4. Surface map

| Surface | Post-mortem | Live | Notes |
|---|---|---|---|
| Workspace home | ✓ | ✓ | sessions, packs, recent analyses, agent activity, open/attach actions |
| Viewer (virtualized, one query bar) | ✓ | ✓ | the single query bar merges today's search bar and filter bar; level/tag/time/regex chips; results as an in-viewer filter |
| Sections navigator | ✓ | — | bugreport/dumpstate only |
| Analyzers (active set + results) | ✓ | ✓ | replaces chain builder, dashboard and library; live mode shows continuous counters per card |
| Device state | ✓ | ✓ | cursor-tied in post-mortem; "now" in live |
| Analyses (reader + list) | ✓ | — | line-anchored; agent- or human-authored; home surface for findings |
| Bookmarks | ✓ | ✓ | shared artifacts with caller badge |
| Watches | — | ✓ | match badges, pause/resume, agent subscriptions visible |
| Stream controls | — | ✓ | device picker, package filter, start/stop, save capture |
| Timeline strip | ✓ (on demand) | — | scrub inside the viewer |
| Agent presence | ✓ | ✓ | always visible, collapsible |
| Export / share | ✓ | ✓ | anonymize option is explicit |
| Settings | ✓ | ✓ | MCP integration and agent access first; packs advanced; PII detectors |

Gone as standalone destinations: processor dashboard, correlations view, timeline pane,
processor library vs marketplace split, free-standing editor tab, the second search bar.

## 5. Agent presence

The agent runs in Claude Code or Claude Desktop, not inside LogTapper. The UI shows its
presence from the activity journal and bridge status, and offers the human ways to steer
it. The animated companion the user wants is welcome **if it is state-driven and quiet**:
an orb/avatar whose motion reflects real state, never decorative.

States (derived from the journal and the bridge):

| State | Signal | Visual |
|---|---|---|
| Detached | bridge on, no client activity | dim, still |
| Idle | connected, no recent action | soft breathing |
| Reading | query/search/lines activity | scanning motion |
| Running | pipeline run in progress | pulsing with progress |
| Wrote | published analysis / created watch or bookmark | brief flare, then a card in the feed |
| Needs you | consent prompt (open file outside allowlist, export destination) | attention pulse + inline prompt |
| Raw access on | `agentRawAccess` true | persistent warning tint |

Feed: chronological, grouped by session, each entry clickable to jump to the line,
processor, analysis or watch it concerns. Caller badges distinguish human and agent.

Handoff, both directions:
- **Human → agent**: "Ask about this" on a selection or line sets the agent's focus
  context (session, line, section) which the agent reads on its next call; the UI shows
  what focus is currently shared.
- **Agent → human**: the agent can request navigation (show session X line N, open
  analysis Y); the UI shows the request in the feed and applies it, with a toggle to
  require confirmation.

Consent: inline prompts in the presence panel instead of a settings page; approvals are
per request and journaled.

First run: attaching an agent (Claude Code or Claude Desktop) is the onboarding flow, not
a settings subsection.

Open question: an in-app chat with the agent would require an embedded model client (the
backend has a Claude API client used for one-shot analysis). Out of scope for this phase;
the presence panel must not depend on it.

## 6. Non-negotiables

- Virtualized viewer that stays smooth at 1M lines and under 50 ms streaming batches.
- Keyboard-first navigation for the viewer and sections.
- Desktop density; light and dark themes; long-session legibility.
- Workspaces, watches, live ADB streaming, the analyzers surface and manual bookmarking
  stay fully usable without any agent connected.
- Every visual decision lives in stylesheets; dynamic values through custom properties.

### 6.1 Theming

Full theming is a design input, not a later coat of paint. The canvas should be built on
a token system so that a theme is a set of values, not a set of components.

- **Token layers.** Primitive palette → semantic tokens (surface, surface-raised, text,
  text-muted, border, accent, selection, focus ring) → domain tokens (log levels V/D/I/W/E/F,
  watch match, bookmark categories, processor kinds, agent states, PII token highlight,
  diff added/removed for comparisons). Components consume semantic and domain tokens only.
- **Built-in themes.** Light, dark, and a high-contrast variant of each; follow-system by
  default. Dark is the primary design target because sessions are long.
- **User themes.** A theme is a JSON file of token overrides the user can create, edit in
  Settings, import and export; partial overrides fall back to the base theme. Log-level
  colours and the agent orb palette are the first things people will want to change.
- **Density.** Compact and comfortable density modes for the viewer and lists, independent
  of theme; the viewer's row height and font are user-set, not theme-set.
- **Contrast rules.** Every log-level and status colour must keep AA contrast on both
  surface tokens; the design shows the level palette against both surfaces.
- **Agent presence** honours the theme: the orb takes its colours from the agent-state
  tokens so a theme can make it calmer or more prominent.

### 6.2 Screen sizes and layout

Target desktop monitors from Full HD to ultra-wide, at 100–150 % OS scaling.

| Tier | Effective width | Layout behaviour |
|---|---|---|
| Compact | 1280–1599 px (FHD at 125–150 % scaling, laptops) | Single centre column; navigator and agent presence collapse to rails; one session visible; pipeline flow as an overlay drawer. |
| Standard | 1600–2559 px (FHD/QHD at 100 %) | Three columns: navigator · viewer · agent/details; pipeline flow docked beside the viewer or below it; one session plus one details surface. |
| Wide | 2560–3439 px (QHD+, 4K at 150 %) | Four regions: navigator · viewer · analysis or device state · agent presence, all persistent. |
| Ultra-wide | ≥ 3440 px (21:9 and 32:9) | Viewer plus analysis, device state and agent presence all persistent with generous widths; workspace home as a grid. (Two-session comparison is a later phase — the layout must leave room for it.) |

Rules:
- Panes are resizable columns with persisted widths **per workspace**, so an
  investigation opened on the ultra-wide comes back the same way.
- The viewer never scrolls horizontally on any tier; long lines wrap or truncate by a
  user setting.
- Nothing is hidden below a tier — every surface is reachable from a rail or drawer on
  Compact; larger tiers only promote surfaces to persistent regions.
- Minimum supported viewport is 1280 × 720; below that the app still works with a
  single column and drawers but is not designed for.
- Comparison mode (two sessions synchronized by time or by analyzer event) is **deferred
  to a later phase**; the ultra-wide layout reserves the space but this phase ships one
  session per viewer.
- Live mode on ultra-wide: watches and device state get their own persistent column
  next to the tailing viewer.

## 7. Data the UI can draw on

Everything below is typed and generated in `src-next/bridge/generated/` (ts-rs) and
served by the service layer to both the UI and agents:

- Sessions, metadata, sections, `LinePage`/`Sampled` lines, `SearchHits`
- Pipeline: chain per session, `PipelineRunResult`, processor detail, `StateSnapshot`
  with `sourceSections`, transitions, `Insights`
- Artifacts: bookmarks, analyses (line-anchored sections), watches with `watch-update`
- Live: `AdbStreamEvent` batches, `StreamStatus`, watch matches
- Workspaces: list, load/save/switch, `WorkspaceRestoredEvent`
- Agent: `ActivityEntry` with `Caller`, `McpStatus` incl. `agentRawAccess`, allowlist,
  anonymizer config
- Events: `bookmark-update`, `analysis-update`, `watch-update`, `activity`,
  `session-opened/closed`, progress events

## 8. Artboards requested from Claude Design

1. **Workspace home** — switcher, sessions of both kinds, enabled packs, recent analyses,
   agent presence collapsed.
2. **Post-mortem mode** — viewer with the unified query bar, sections navigator, pipeline
   flow with results on the nodes, device state at the cursor, an analysis open with a
   line-anchored link highlighted.
3. **Live mode** — stream controls, viewer tailing, watches with match badges, live device
   state, agent presence in "watching" state.
4. **Agent presence, expanded** — feed with human and agent entries, a consent prompt
   pending, a shared-focus indicator, a "needs you" state of the orb.
5. **Packs** — curated packs with one-click enable and the Advanced disclosure.
6. **First run / attach an agent** — onboarding for Claude Code and Claude Desktop.

7. **Theme and tokens** — the semantic and domain token sheet with the log-level palette
   shown against light, dark and high-contrast surfaces, plus the agent-state palette.
8. **Ultra-wide post-mortem** — artboard 2 at 3440×1440 showing how the persistent regions
   use the width (comparison mode itself is deferred; leave the room).

Sizes: 1920×1080 at 100 % as the reference for artboards 1–6 (Standard tier), the same
boards sketched once at 1440×900 (Compact tier) to prove the collapse behaviour, and
3440×1440 for artboard 8. Every board in light and dark.

## 9. Engineering note (decided after the design)

The framework choice (SolidJS port vs React with the compiler) is made once the artboards
show how much of the current component inventory survives. Either way the new UI is built
against the generated contract, as a separate frontend that reaches parity per mode before
it replaces the current one, so manual analysis never breaks during the transition.
