---
name: spec-framework
description: Specification and design framework for LogTapper feature implementation. Defines quality bars, section templates, and anti-patterns for each planning phase. Referenced by the feature-implementation schema guidance fields.
user-invocable: false
---

# Specification Framework for LogTapper Features

This skill defines how to write strong specifications and implementation plans for LogTapper.
It is the reference document behind the `feature-implementation` schema gates. When filling
schema notes, consult the relevant section here for quality bars, examples, and anti-patterns.

---

## Core Principles

These four principles separate useful specs from busywork:

1. **Trade-off driven, not description driven.** A spec that describes what will be built
   without explaining *why this approach over alternatives* is a task list, not a design document.

2. **Appropriately scoped detail.** Include details where stakeholders might change their
   mind if the detail changed. Implementation minutiae belong in code comments, not the spec.

3. **Self-contained for future readers.** Assume readers lack your Slack threads, meeting
   context, and prior conversation history. A spec written for people who were in the room
   is worthless six months later.

4. **"Do nothing" is always an alternative.** Every spec should honestly evaluate whether
   not building the thing is the best option.

---

## Section Guide: Requirements

**Schema note:** `requirements` (queue phase, required)

### What to capture

- **Problem statement** with quantified impact. Not "we want feature X" but "users
  experience Y pain because of Z limitation."
- **Who benefits** and how their workflow changes.
- **2-5 acceptance criteria** that concretely define "done." Each criterion should be
  testable — if you can't write a test or manual verification step for it, it's too vague.
- **Non-goals** — things someone might reasonably expect this feature to include but that
  are deliberately excluded. These prevent scope creep better than any process.

### Quality bar

A good requirements note lets someone who has never seen the codebase understand:
(a) what problem exists, (b) what success looks like, and (c) what is explicitly out of scope.

### Anti-patterns

- "Add X to the app" with no problem statement — *why* does X matter?
- Acceptance criteria that restate the title: "Feature works correctly" is not a criterion.
- Missing non-goals — if you can't name a single non-goal, you haven't scoped tightly enough.

### Example (good)

> **Problem:** When a log file spans multiple days, the StateTimeline ruler shows only
> HH:MM:SS timestamps. Users cannot tell which day a transition occurred on, making it
> impossible to correlate events across days in bugreport files.
>
> **Who benefits:** Engineers analyzing multi-day bugreports (primary use case for LogTapper).
>
> **Acceptance criteria:**
> 1. Timeline ruler shows MM-DD HH:MM:SS when log spans > 24 hours
> 2. Transition tooltips include the date
> 3. Single-day logs remain unchanged (no visual regression)
>
> **Non-goals:**
> - Year display (logcat strips the year; adding it would require heuristics)
> - Timezone conversion (all timestamps are device-local)

---

## Section Guide: Design

**Schema note:** `design` (queue phase, required)

### What to capture

- **Proposed approach** — what changes, where, and how the pieces connect. For LogTapper
  this means identifying which layers are affected:
  - Rust backend: parsers, commands, pipeline, processors
  - Frontend: bridge types, context/hooks, components, cache/viewport
  - Cross-cutting: MCP bridge, Tauri events, IPC types

- **Alternatives considered** — minimum two real alternatives (not strawmen). For each:
  - What was the approach?
  - What were its advantages?
  - Why was it rejected? (specific trade-off, not "it seemed worse")

- **Affected modules** — list the specific files/modules that will change. This forces you
  to understand the blast radius before writing code.

- **Cross-cutting concerns checklist:**
  - Does this touch `AppState` concurrency? (lock ordering, no locks across `.await`)
  - Does this affect the pre-filter? (new tags, transformer interaction)
  - Does this introduce new Tauri events? (StrictMode double-mount pattern required)
  - Does this add new context state? (frontend isolation principles apply)
  - Does this expose data via MCP bridge? (security tier implications)

### Quality bar

A reader should be able to implement the feature from the design note alone, understanding
not just *what* to build but *why this approach was chosen over the alternatives*.

### Anti-patterns

- **No alternatives section.** If you only have one approach, you haven't explored the
  solution space. Even "do nothing" counts as an alternative.
- **Strawman alternatives.** "Alternative: rewrite everything in Go. Rejected: too much work."
  This doesn't help anyone.
- **Missing blast radius.** "Change the parser" without identifying which downstream consumers
  (pipeline, MCP bridge, frontend cache) are affected.
- **Copy-pasted code.** Verbose type definitions that will be immediately outdated. Focus on
  design-relevant interfaces, not implementation details.

### LogTapper-specific considerations

When designing features, check these project-specific constraints:

- **Frontend isolation (CLAUDE.md rules 1-8):** New context state must go in the narrowest
  possible context. New components must be `React.memo`. New callbacks must be `useCallback`
  with stable deps.
- **Rust concurrency model:** All `AppState` fields use `std::sync::Mutex`. Never hold locks
  across `.await`. Never hold `sessions` while acquiring `pipeline_results`.
- **Pipeline layer model:** Understand which layer your change affects (pre-filter,
  Layer 1 transformers, Layer 2a/2b/2c parallel processors). Transformers must NOT be
  included in pre-filter tag collection.
- **LineContext string fields** are `Arc<str>`, not `String`.
- **Rhai scripting:** `_emits.push(#{...})` not `emit()`. `key in map` not `contains_key`.

### Example (good)

> **Approach:** Extend the logcat parser regex to accept non-numeric UID names in group 3
> (`\S+` instead of `\d+`). The PID/TID extraction logic already handles the 3-field case
> via `caps.get(5).is_some()` — named UIDs naturally fall into this branch since they produce
> a 3-field match. No changes needed to `parse_threadtime`'s PID extraction.
>
> **Alternatives considered:**
> 1. *Add a separate regex for named-UID format.* Advantage: no risk of breaking existing
>    parsing. Rejected: the formats are identical except for group 3's content — a second
>    regex duplicates 90% of the logic and doubles maintenance burden.
> 2. *Pre-process lines to replace named UIDs with numeric 0.* Advantage: no regex change.
>    Rejected: loses the UID name information, and the string manipulation adds overhead
>    to every line parsed.
>
> **Affected modules:**
> - `src-tauri/src/core/logcat_parser.rs` — regex change + new tests
> - `src-tauri/src/commands/processors.rs` — sort matched lines (related fix)
> - `src-next/components/StateTimeline/StateTimeline.tsx` — date display (related fix)

---

## Section Guide: Implementation Notes

**Schema note:** `implementation-notes` (work phase, required)

### What to capture

- **Key decisions made** during implementation that weren't in the design.
- **Deviations from the plan** — what changed and why.
- **Surprises and wrong turns** — what was harder than expected, what assumption was wrong.
- **Patterns discovered** — reusable patterns that should be applied elsewhere or documented.

### Quality bar

A future developer reading this note should understand what happened during implementation
that the design didn't predict. This is where institutional knowledge gets captured.

### Anti-patterns

- Empty note or "implemented as designed" — even clean implementations involve micro-decisions
  worth recording (e.g., "chose to sort in the backend rather than frontend because the
  matched lines API is also used by the MCP bridge").
- Git log summary — listing commits is not an implementation note. Explain the *why* behind
  decisions, not the *what*.

---

## Section Guide: Test Results

**Schema note:** `test-results` (work phase, required)

### What to capture

- **Rust tests:** `cargo test` output — total count, pass/fail, any new tests added.
- **Clippy:** `cargo clippy -- -D warnings` — clean or issues found.
- **TypeScript:** `npm run build` — clean or pre-existing errors (distinguish from new ones).
- **New tests added:** List test names and what they verify.
- **Manual verification:** If applicable, describe what was tested manually and the outcome.

### Quality bar

Someone reviewing the work should be able to see at a glance: (a) nothing is broken,
(b) new behavior is covered by tests, (c) pre-existing issues are acknowledged but not
introduced by this change.

### Anti-patterns

- "All tests pass" with no specifics — how many tests? Were new ones added?
- Ignoring pre-existing failures — acknowledge them explicitly so reviewers know they're
  not new regressions.
- No manual verification for UI changes — automated tests can't catch visual regressions
  or UX issues.

---

## Section Guide: Verification

**Schema note:** `verification` (review phase, optional)

### What to capture

- **Rebuild confirmed:** Was `npx tauri dev` run successfully with the changes?
- **Feature verified:** Does the feature work end-to-end in the running app?
- **Edge cases tested:** Any boundary conditions checked manually.
- **MCP reconnect needed:** If changes affect the MCP bridge, was `/mcp` reconnect tested?

---

## Decision Checklist

Before finalizing a design, verify:

- [ ] Problem statement is quantified (not just "it would be nice")
- [ ] At least 2 real alternatives considered (including "do nothing")
- [ ] Non-goals explicitly named
- [ ] Affected modules identified with blast radius understood
- [ ] Cross-cutting concerns checked (concurrency, StrictMode, isolation, pre-filter)
- [ ] Success criteria are testable
- [ ] No over-engineering — minimum complexity for the current requirement
