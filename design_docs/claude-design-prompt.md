# Prompt for claude.ai/design — LogTapper phase-2 exploration

Attach before sending: `design_docs/ui-redesign-brief.md`, PNG exports of the
"LogTapper Redesign" canvas (all boards, dark), and two or three screenshots of the
current app (workspace with a dumpstate open, live ADB mode, the marketplace).

---

I'm redesigning LogTapper, a Windows/Tauri desktop workbench for Android log analysis
(dumpstate, bugreport, logcat, live ADB streams). The attached brief is the source of
truth: read sections 1–6 first. The attached canvas PNGs are my own first pass at the
eight artboards the brief asks for; the app screenshots show what exists today. Treat
the first pass as a starting point to push against, not a spec to reproduce.

**Thesis to hold onto.** Two first-class operators share one workspace: a human doing
manual investigation, and an AI agent working through MCP from Claude Code or Claude
Desktop. It must never feel like an editor with an AI hook. The deterministic processors
are "analyzers" (never "skills"); a "pack" is a curated set of analyzers for a subsystem.
Everything stays fully usable with no agent connected.

**Two modes, one workspace.** Post-mortem analysis (slow, deep, saved files) and live
development (fast, shallow, ADB stream). Panes belong to a mode; the surface map in
section 4 of the brief says which. Workspaces are the top-level navigation.

**Demotions already agreed.** Correlations become an analyzer card, no dedicated pane.
The timeline becomes an on-demand scrub strip inside the viewer. Comparison mode is
deferred; leave room for it on the ultra-wide board but do not design it.

**What I want you to explore, in priority order.**

1. The agent presence. A quiet, state-driven companion (orb or avatar) whose motion
   reflects real state from the activity journal: detached, idle, reading, running,
   wrote, needs-you, raw-access-on. Give me three distinct directions for the orb and
   its expanded panel (feed with human and agent entries, a pending consent prompt, the
   shared-focus indicator). One direction should be minimal, one expressive, one in
   between. Show the "needs you" state on each.
2. The analyzers surface. It replaces today's pipeline chain builder, dashboard and
   processor library with one list of active analyzers whose results live on the cards
   themselves. Show it in post-mortem (results at rest) and live (continuous counters).
   Explore whether it docks beside the viewer or below it at 1920×1080.
3. Workspace home. Switcher, sessions of both kinds, enabled packs, recent analyses,
   agent activity, and the open/attach actions. Two directions: card grid versus a
   dense list-first layout.
4. Packs. Curated packs by subsystem with one-click enable and an Advanced disclosure
   that reveals individual analyzers and marketplace sources. This must feel simpler
   than the current marketplace screenshot.
5. First run: attaching an agent is the onboarding flow, not a settings subsection.

**Constraints.** Desktop density, keyboard-first, virtualized viewer that stays smooth at
a million lines. Reference size is 1920×1080 at 100% scaling; sketch the post-mortem and
live boards once at 1440×900 to prove the collapse behaviour described in section 6.2,
and once at 3440×1440. Light and dark on every board, using the token names from
section 6.1 and the attached token sheet. The log-level palette and agent-state palette
are fixed; propose changes to them only as a separate note. Fonts: Geist for UI,
JetBrains Mono for log text. Every colour must be a token, never a literal.

**Deliverables.** One canvas, one artboard per screen and variant, dark first with the
light version alongside. For each exploration above, a short annotation stating the
trade-off you made and what you would need from the backend to make it real. The
backend already exposes: session list and metadata, an activity journal with caller
identity, pipeline results per analyzer, tracker device state at a line, watches with
match counts, bookmarks and analyses with caller badges, bridge status including
whether raw log access is on. Do not invent data the UI cannot get.

Ask me before designing if anything in the brief conflicts with the screenshots.
