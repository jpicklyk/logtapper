---
name: log-analysis
description: >-
  Systematic log investigation using the LogTapper MCP tools (mcp__logtapper__*).
  Use this skill whenever the user asks to analyze, investigate, root-cause, or
  compare logs that are loaded in LogTapper — dumpstates, bugreports, logcat, or
  kernel logs — even if they just say "check the logs", "why is X failing on this
  device", "compare these two captures", or name a symptom (crash, disconnect,
  enumeration failure, config not applied). Also use it when asked to publish or
  write analysis findings back into LogTapper. It encodes the investigation
  ladder (pipeline results before raw lines), comparative working-vs-failing
  methodology, multi-boot timeline discipline for dumpstates, and the
  line-anchored analysis publishing workflow.
---

# LogTapper Log Analysis

A methodology for investigating logs through LogTapper's MCP tools. The tools
are powerful but the log files are huge (500k–1M lines); an undisciplined
investigation burns context on raw-line fishing and produces conclusions that
don't survive scrutiny. This workflow gets to defensible root causes cheaply.

## Ground rules

- **Verify the app first.** `logtapper_get_status` / `logtapper_list_sessions`.
  If unreachable, the app isn't running or the bridge is off (Settings →
  General → MCP Integration) — see the `attach-mcp` skill.
- **Identify sessions by content, never by filename.** Multiple sessions are
  often all named `dumpstate.txt`. Read the header (lines 0–10: `Build:`,
  `Build fingerprint:`) to map session IDs to devices before any analysis.
  State the mapping explicitly in your first response.
- **Batch independent queries.** When comparing two sessions, issue the same
  query against both in one parallel tool-call block.
- **Mind the source type.** Sessions can be `Dumpstate`, `Logcat`, `Kernel`,
  or live ADB streams (`sourceType` in `list_sessions`; `isLive` in metadata).
  The multi-boot timeline rules and section map below apply to dumpstates;
  logcat/kernel files have no named sections, and live streams grow while you
  query them (`recent` sampling, events arriving continuously).

## The investigation ladder

Work top-down. Each rung is dramatically cheaper than the one below it, and
each rung tells you where to look on the next.

1. **Orient** — `logtapper_get_status`, `logtapper_list_sessions`,
   `logtapper_get_metadata`. What's loaded, how big, what time range.
2. **Pipeline results** — `logtapper_get_pipeline_results` (optionally
   per-processor), `logtapper_get_insights`, `logtapper_get_events`. This is
   the pre-digested signal layer: matched-line counts, emissions with extracted
   fields, state transitions, accumulated vars. A zero where you expected a
   signal (e.g., `registrations: 0` from a lifetime tracker) is often the
   finding itself. Two calls here can localize an anomaly that would take
   dozens of raw searches.

   The pipeline only sees what processors cover — distinguish three cases
   before trusting this rung: (a) a relevant processor **has results with
   signal** — follow its line numbers down the ladder; (b) a relevant
   processor **ran and shows zero** — that absence is itself evidence, cite
   it; (c) **no installed processor covers the subsystem at all** (compare
   the issue domain against `installedProcessors` / `processorsWithResults`
   from `list_sessions`) — this is evidence of *nothing*; say so and work
   rungs 3–5 directly. For a domain you expect to analyze repeatedly, mention
   that the `create-processor` skill can close the coverage gap.
3. **Sections** — `logtapper_get_sections` with a `query` filter to find the
   dumpsys/service section you need, then range-scope everything below to it.
4. **Targeted search** — `logtapper_search_with_context` with a regex, range
   restricted (`start_line`/`end_line`) wherever possible.
5. **Raw context** — `logtapper_get_lines_around` on specific line numbers
   (max 100 lines before/after per call) to read the full event anatomy.

Skip rungs only when the user hands you a specific line number or the pipeline
hasn't been run (`hasResults: false` — suggest `logtapper_run_pipeline`).

## Comparative analysis (working vs failing capture)

When the user has a good/bad pair, the goal is to find the **divergence step**:
the first point in a shared sequence where the two captures behave differently.

1. Map both sessions to devices from their headers.
2. Pull the same pipeline results from both, in parallel pairs.
3. Reconstruct the operation as an ordered step sequence appropriate to the
   domain (a peripheral: attach → negotiate → init → handshake → identify →
   configure; an app flow: launch → bind → request → response → render; a
   network: associate → authenticate → DHCP → validate), and fill in each
   device's behavior per step from evidence.
4. Report it as a side-by-side table: `# | Step | Working device | Failing
   device | Verdict`. Everything before the divergence step "works on both" —
   that's what exonerates whole subsystems at once.
5. Mind asymmetric evidence: the failing capture often *cannot* contain the
   identification the working one has (a device that never enumerates has no
   VID/PID). Say what cannot be proven, don't paper over it.

## Timeline discipline (dumpstates are multi-boot)

A Samsung dumpstate contains **several kernel log copies from different
boots**: `KERNEL LOG (dmesg)` and `KERNEL AP_KLOG` (current boot), `LAST KMSG`
(previous boot), plus a separate `dumpstate_board.txt` (current boot). Getting
the boot attribution wrong produces a false timeline.

- **Same-boot check:** identical events carry identical microsecond kernel
  timestamps across copies. Different uptimes = different boots.
- **Uptime → wall clock anchors**, in order of reliability: the dumpstate
  header timestamp (line ~1), the `USB LOG (/proc/usblog)` `time sync:
  [MM-DD HH:MM:SS][uptime]` line, and log lines that embed both an uptime and
  a wall clock (e.g., wifi driver lines like `qca6490: [...][12:38:20.309...]`).
- **Suspend pauses the kernel clock.** CLOCK_MONOTONIC stops during suspend, so
  uptime deltas undershoot wall-clock deltas. Reconcile with two anchors; look
  for `Freezing remaining freezable tasks` (suspend entry) to place the gap.
- If a capture window matters, state the reconstructed timeline as a table with
  wall clock, uptime, and event — and say which anchor you used.

## Tool mechanics that bite

- **500k-line scan cap** per search request. A "0 matches" result is only a
  negative finding if `truncated: false`; otherwise page with `start_line`
  until the whole file is covered. Check `scannedLines` and `matchCount`
  (true total) in every response.
- **Wide dumpsys lines get cut at 500 chars.** Raise `max_line_chars` (up to
  8000) when the value you need may sit past the cut.
- **`get_lines_around` caps `before`/`after` at 100.**
- **`get_sections` can miss sections.** If a section you expect isn't listed,
  fall back to searching for the header pattern `^------ ` (or `^========`)
  in the suspected range — dumpstate section headers are greppable.
- Filtered `logtapper_query` switches to full-scan mode; prefer
  `search_with_context` with ranges for anything targeted.

## High-value dumpstate sections

| Section | Why it matters |
|---|---|
| Header (lines 0–15) | Build, fingerprint, capture wall-clock, kernel version |
| `USB LOG (/proc/usblog)` | CCIC/Type-C event history for the whole boot, `PORT: count` = devices that actually enumerated, and the uptime↔wall-clock `time sync` anchor |
| `DUMP OF SERVICE <name>` (ethernet, connectivity, usb, …) | Stored configuration vs live state — e.g., IP config store vs "Tracking interfaces" |
| `LAST KMSG` | The previous boot — check it before claiming "first occurrence" |
| `Package [<name>]` in the package service dump | `versionName`/`versionCode` of the apps under test (often past line 500k — page there directly) |
| Charger/battery telemetry (kernel log) | Periodic health lines rule power in or out during a failure window |

## Evidence standards

- **Independent witnesses.** Before declaring a root cause, corroborate with a
  second subsystem that observes the same layer through a different path
  (e.g., USB reset failure + BC1.2 data-contact-detect timeout both implicate
  D+/D−). One log line is a lead; two independent ones are a finding.
- **Negative claims need full coverage.** "This never happened" requires scans
  whose `truncated` flags you checked, across the whole file.
- **Quote exactly, cite line numbers.** Findings reference `lineNum` so they're
  clickable/verifiable in the viewer and reusable as analysis anchors.
- **Evaluate the user's hypotheses against evidence** rather than adopting or
  dismissing them — if the logs can't decide, say what measurement would.

## Publishing findings back into LogTapper

When an investigation concludes (or the user asks to save/submit the analysis),
publish it as an analysis artifact so it lives with the session:

- `logtapper_analyses` `action: "publish"` with `session_id`, `title`, and
  `sections` — each section has `heading`, markdown `body`, optional
  `severity` (`Info`/`Warning`/`Error`/`Critical`), and `references` with
  `lineNumber` (+ optional `endLine`) and a `label`.
- Use `highlightType: "Anchor"` for the smoking-gun lines (the divergence
  step, the failure line, the empty-state line) and `"Annotation"` for
  supporting context. Anchors are what a reviewer clicks first.
- References must point into the artifact's own `session_id`. Evidence from a
  different session (e.g., the board log) goes in the body text with the file
  and approximate line named.
- `action: "update"` replaces the **entire** `sections` array — resend all
  sections, not just the changed one.
- Typical section shape: TL;DR (severity reflecting the outcome) → timeline →
  root cause (Critical, anchored) → alternatives evaluated/excluded →
  recommended actions (Warning).

## Report structure

For a full investigation report (chat or document), use:

```
TL;DR (one paragraph: verdict + mechanism + what was ruled out)
Test setup identity (devices, builds, software versions, peripheral identity)
Verified timeline (wall clock | event, with the anchor named)
Side-by-side step table (comparative cases)
Key evidence sections (short, one claim each, quotes + line numbers)
Conclusion (numbered findings, then recommended actions)
```

Keep log snippets to one-liners except the single decisive block. State what
each piece of evidence *rules out*, not just what it shows — exoneration is
usually the most valuable output for the stakeholder.
