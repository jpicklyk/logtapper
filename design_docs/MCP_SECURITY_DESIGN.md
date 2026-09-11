# MCP Security Design: Open Issues

> **Status:** Partially resolved by the Phase 1 service-layer migration (see "Service-layer
> era" at the end). Issue 1 is fixed. Issues 2 and 3 are re-verified against the current
> code below — 2 is unchanged, 3's security-critical half (PII) is now fixed and its
> general half is unchanged. This file is otherwise historical: it documents the reasoning
> that led to the current design, not just a list of remaining bugs.

---

## Background

The MCP bridge (`src-tauri/src/mcp_bridge/`, module split in Phase 1 — was a single
4,353-line `mcp_bridge.rs`) exposes two classes of data to Claude:

| Endpoint | Data source | What it returns |
|---|---|---|
| `/mcp/sessions/:id/query` | `AppState::sessions` (Tier 1 — raw log store), via `services::lines` | Sampled raw log lines, filtered/searched |
| `/mcp/sessions/:id/pipeline` | `AppState::pipeline_results` (Tier 2 — pipeline results), via `services::pipeline` | Reporter vars, emissions, match counts |
| `/mcp/sessions/:id/events` | `AppState::state_tracker_results` (Tier 2), via `services::tracker` | StateTracker transition records |

The three issues below all stem from the fact that the query path reads directly from
Tier 1 (raw log data) rather than from post-pipeline transformed data.

---

## Issue 1: PII anonymization defaults to off — RESOLVED

### The original problem

`AppState::mcp_anonymize` was a `Mutex<bool>` that defaulted to `false`, set to `true`
only when the frontend called `set_mcp_anonymize(true)` — which happened when the user
added `__pii_anonymizer` to their pipeline chain. A user who loaded a log file and had not
yet done that got raw, unredacted lines served to Claude with no visible signal.

### What actually shipped (Phase 1)

The single global flag was replaced with `AppState::mcp_anonymize: Mutex<HashMap<String,
bool>>` — one flag per session — and the read side, `services::policy::should_anonymize`,
**fails closed**: a session with no explicit entry (just opened, or the frontend's signal
hasn't landed yet) resolves to `true` (redact), not `false`. This is a stronger fix than
the originally-proposed single-line default flip — it also closes the race where an agent
queries a session in the window before the frontend's `setMcpAnonymize` call lands, which
a plain `Mutex<bool>` default of `true` would not have covered (a *global* default only
helps before the flag is ever set for *any* session; a per-session fail-closed default
helps for every individual session, including ones opened after the app has been running
for a while with other sessions already toggled).

`Ui`-caller reads are additionally never redacted regardless of the flag (the human is
looking at their own machine) — `should_anonymize` returns `false` unconditionally for
`Caller::Ui` and only applies the fail-closed per-session resolution for `Caller::Agent`.
See `services::policy` doc comments and `src-tauri/src/services/CLAUDE.md`.

---

## Issue 2: MCP anonymization is coupled to the pipeline chain — they are separate concerns

### The problem

Whether MCP queries are anonymized is currently determined by whether `__pii_anonymizer` is present in the user's pipeline chain. The frontend syncs the two via a `useEffect` in `usePipeline.ts`:

```typescript
useEffect(() => {
  setMcpAnonymize(pipelineChain.includes('__pii_anonymizer')).catch(() => {});
}, [pipelineChain]);
```

This conflates two unrelated decisions:

1. **Pipeline chain composition** — which processors to run when analysing a log file
2. **MCP access control** — what data Claude is allowed to see

A user may legitimately want to analyse logs with the anonymizer disabled (e.g., they need the real IP addresses for a network debugging session) while still wanting MCP queries to be protected. Under the current design, they cannot have both.

Conversely, a user might include the anonymizer in their chain purely to protect pipeline results that get written to Tier 2 — unaware that this is also the toggle controlling MCP raw-line access.

### Re-verified against the Phase 1 code: still open

`src-next/hooks/usePipelineWiring.ts` still ties the per-session `mcp_anonymize` flag
directly to whether `__pii_anonymizer` is in that session's chain
(`setMcpAnonymize(sessionId, own.chain.includes('__pii_anonymizer')))`, fired both on the
debounced chain-sync path and on pane-focus change. The flag became per-session (Issue 1),
which narrows the blast radius of the coupling — a user can no longer accidentally toggle
MCP redaction for every open session by editing one chain — but the conflation itself
(chain composition vs. access control) is unchanged. `services::policy::set_anonymize`
(via `commands::session::set_mcp_anonymize`) is a plain per-session setter with no
knowledge of *why* it was called, so an independent UI control (the lock/unlock icon
originally proposed) can still be layered on without a backend change — the backend
already accepts "set this session's flag" as a standalone action, it's only the frontend
wiring that currently always derives it from the chain.

### Proposed fix (unchanged)

Introduce an independent `mcp_anonymize_override: Mutex<Option<bool>>` in `AppState`, or
expose a separate UI control (a toggle in the MCP Bridge status widget in
`ProcessorPanel`) that sets `mcp_anonymize` directly. The pipeline chain presence of
`__pii_anonymizer` becomes a default/suggestion, not the authoritative control.

A simple UX approach: add a lock/unlock icon to the MCP Bridge widget in the ProcessorPanel that explicitly shows and controls whether MCP queries are anonymized, independent of the pipeline chain.

---

## Issue 3: `h_query` serves pre-transform data — Claude sees different lines than the user

### The problem

`h_query` reads from `source.raw_line(i)` — the original bytes from the mmap or the raw `Vec<String>` stored in `LogSourceData::Stream`. This is always pre-transformation data: no transformers have touched it.

However, the user's own view of the log is post-transformer:

- **ADB streaming**: `flush_batch` applies Layer 1 transformers before emitting `adb-batch` events. The frontend display cache (`lineCacheRef`) holds the already-transformed `ViewLine[]`. What the user sees in the log viewer is post-transform.
- **File mode**: When a pipeline is run, the viewer can be switched to Processor mode, which shows lines as the pipeline processed them. The raw viewer tab shows unprocessed lines, but the user's primary analytical view is the processed one.

If a user has a transformer that, say, normalises timestamps, strips noisy prefixes, or rewrites tag names — Claude's `logtapper_query` results will look different from what the user sees in the UI. This makes it harder to refer to specific lines ("line 4,291 shows...") and creates a confusing mismatch when Claude and the user are discussing the same log.

The PII case is the most severe version of this: if the user has the anonymizer in their chain, they see `<IPv4-1>` in the UI while Claude sees `192.168.1.1` in its MCP query results (unless `mcp_anonymize` happens to also be set).

### Proposed fix

`h_query` should read from the same view the user sees. For ADB streaming, this means reading from the transformed `ViewLine` data rather than `source.raw_line(i)`.

This is architecturally more involved than Issues 1 and 2 because the transformed view currently only exists in the frontend display cache — it is not persisted back to the backend session store after transformation. The fix would require one of:

**Option A** — Store the last-transformed line for each raw line in `AppState` alongside the session. Memory cost: roughly doubles the per-line storage for sessions with active transformers.

**Option B** — Re-apply transformers on-the-fly inside `h_query`. This keeps no extra state but adds latency and requires the MCP query path to replicate the transformer execution logic.

**Option C** — Accept the mismatch for now, but at minimum ensure PII is consistent (i.e., fix Issues 1 and 2 first). The view mismatch is a UX inconvenience; the PII mismatch is a security concern.

Option C is the pragmatic near-term path. Options A or B can be revisited when transformer usage is more common and the perf/memory trade-offs are better understood.

### Re-verified against the Phase 1 code

Option C's precondition — "fix Issues 1 and 2 first" for the PII half — is now half true.
`services::lines`/`services::search`/every other raw-line service still read
`source.raw_line(i)` (pre-transform Tier 1 bytes, same as before); the general
view-mismatch half of Issue 3 is **unchanged**. But every one of those services routes its
output through `services::policy::redact_line` before returning it to an `Agent` caller,
and that redaction now uses the fail-closed per-session resolution from Issue 1 — so the
**security-critical** half of Issue 3 ("if a user has the anonymizer in their chain, they
see `<IPv4-1>` while Claude sees the raw IP") is fixed for the *unset* case: an agent
querying a session with no explicit signal yet gets redacted output, not raw. The
still-open half is purely a *view* mismatch (timestamp normalization, tag rewriting, other
non-PII transformer output) and remains Option C as originally scoped: accepted for now,
revisit A/B later.

---

## Summary

| # | Issue | Status | Risk level | Effort to fix |
|---|---|---|---|---|
| 1 | PII anonymization defaults to off | **Resolved** — per-session fail-closed map (`services::policy::should_anonymize`) | was Medium | done |
| 2 | MCP anonymization coupled to pipeline chain | **Open**, narrowed to per-session | Low — confusing but not dangerous | Small (add independent UI toggle; backend already supports it) |
| 3 | Query path reads pre-transform data | **Open** (view mismatch); PII half resolved via Issue 1's fix | Low (was Low–Medium) | Moderate–Large for the view-mismatch half |

Issue 1 shipped with the Phase 1 service-layer migration. Issues 2 and 3's general half
remain design improvements for a later phase.

---

## Service-layer era: the caller model

Phase 1 (`plans/service-layer-phase1.md`) rebuilt every capability — UI and MCP alike — on
top of `src-tauri/src/services/`, with a `services::Caller` (`Ui` or `Agent { client }`)
threaded through every call instead of the transport (Tauri command vs. HTTP route)
implicitly deciding what's allowed. This directly supersedes the framing this document was
originally written under ("the MCP bridge" as a separate, less-trusted code path with its
own copy of the logic) — there is now one implementation, and the security question moved
from "which endpoint is this" to "which `Caller` is this".

What changed as a result, relevant to the issues above:

- **Every raw-line-returning service, not just `h_query`,** is now subject to the same
  `should_anonymize`/`redact_line` gate — `services::insights`, `services::sections`,
  `services::filters`, `services::export`, `services::stream` all redact for `Agent`
  callers the same way `services::lines`/`services::search` do. Before Phase 1, several of
  these paths didn't exist for agents at all (workspaces, filters, ADB streaming,
  timeline, export, marketplace, settings were previously UI-only).
- **`policy::authorize_open` / `policy::authorize_write_dest`** generalize the
  "allowlist, indistinguishable denied/nonexistent" pattern this document implicitly
  assumed only applied to `open_file` — it now also gates workspace save, export
  destination, and ADB stream save-to-file for an `Agent` caller.
- **`policy::deny_agent_gate_mutation`** is new: an agent cannot widen the allowlist,
  change the anonymizer config, or add/remove a marketplace source. This wasn't a
  documented concern before Phase 1 because agents couldn't reach those mutations at all;
  now that the service layer gives agents parity with the UI for almost everything, this
  gate is what keeps "parity" from including "can change what an agent itself is allowed
  to do."
- **Real HTTP status codes.** Every bridge failure prior to Phase 1 was `200 + {"error":
  ...}` — indistinguishable from success to a client that checks status codes rather than
  parsing the body. This is now `IntoResponse for ServiceError` (see
  `src-tauri/src/mcp_bridge/CLAUDE.md`), a real status per `ServiceError` variant.

See root `CLAUDE.md`'s "Security model" section for the current-state summary, and
`src-tauri/src/services/CLAUDE.md` for the policy gates themselves.
