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

### What shipped in Phase 1, and why it wasn't enough

Phase 1 replaced the single global flag with `AppState::mcp_anonymize:
Mutex<HashMap<String, bool>>` — one flag per session, fail-closed when absent. That
covered the window before the frontend signalled anything, but the frontend *did*
signal: `usePipelineWiring` mirrored `chain.includes('__pii_anonymizer')` into
`set_mcp_anonymize` on every chain edit and on pane focus. With the default chain (no
anonymizer) the mirror wrote `false` the moment the UI opened a tab, so the fail-closed
default only held until the user looked at the session. Observed live on 2026-09-11: raw
email addresses and IMEIs in `lines_around` results and in a 74 MB agent-written export.

### What actually resolves it

Agent anonymization is now one global, persisted, UI-only setting and nothing else:

- `AppState::agent_raw_access: Mutex<bool>`, default `false`, persisted to
  `{app_data_dir}/mcp_agent_access.json` and reloaded in `lib.rs::setup` alongside the
  open-file allowlist.
- `policy::should_anonymize(ctx, _session)` = `Ui` → `false`; `Agent` →
  `!agent_raw_access`. The session id is accepted and ignored, so no session state — above
  all no pipeline chain — can widen what an agent sees.
- `services::settings::set_agent_raw_access` is the only writer. It runs
  `policy::deny_agent_gate_mutation` first (`Agent` → `Forbidden`/`NOT_ALLOWED`), persists,
  and journals `settings.agent_raw_access`. The bridge exposes `GET
  /mcp/settings/agent_access` so an agent can see whether it is redacted, and deliberately
  no write route.
- The UI surface is one checkbox: Settings → General → MCP Integration, "Allow agents to
  read raw (un-anonymized) log text", off by default, with an inline warning when on.
- The per-session `mcp_anonymize` map, the `set_mcp_anonymize` command and the frontend
  chain mirror are deleted. `Ui` reads are still never redacted (the human is looking at
  their own machine).

See `services::policy` doc comments and `src-tauri/src/services/CLAUDE.md`.

---

## Issue 2: MCP anonymization is coupled to the pipeline chain — RESOLVED

### The original problem

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

### How it was resolved

The coupling was not merely confusing, it was the delivery mechanism for Issue 1's leak
(see above), so both were fixed in one change: the chain mirror in
`src-next/hooks/usePipelineWiring.ts` is gone, along with the `set_mcp_anonymize` command
and the per-session flag it wrote. Chain composition now decides only what the pipeline
computes; `agent_raw_access` decides only what an agent may read. The two cannot be
confused because there is no code path from one to the other — `should_anonymize` never
looks at a session.

Note the one remaining, deliberate direction of influence, which runs the *safe* way:
`services::pipeline::resolve_effective_chain` force-includes `__pii_anonymizer` in an
agent's effective chain when `should_anonymize` says yes. Access control constrains the
chain; the chain never widens access control.

---

## Issue 3: `h_query` serves pre-transform data — Claude sees different lines than the user

### The problem

`h_query` reads from `source.raw_line(i)` — the original bytes from the mmap or the raw `Vec<String>` stored in `LogSourceData::Stream`. This is always pre-transformation data: no transformers have touched it.

However, the user's own view of the log is post-transformer:

- **ADB streaming**: `flush_batch` applies Layer 1 transformers before emitting `adb-batch` events. The frontend display cache (`lineCacheRef`) holds the already-transformed `ViewLine[]`. What the user sees in the log viewer is post-transform.
- **File mode**: When a pipeline is run, the viewer can be switched to Processor mode, which shows lines as the pipeline processed them. The raw viewer tab shows unprocessed lines, but the user's primary analytical view is the processed one.

If a user has a transformer that, say, normalises timestamps, strips noisy prefixes, or rewrites tag names — Claude's `logtapper_query` results will look different from what the user sees in the UI. This makes it harder to refer to specific lines ("line 4,291 shows...") and creates a confusing mismatch when Claude and the user are discussing the same log.

The PII case used to be the most severe version of this — the user seeing `<IPv4-1>` in the UI while Claude saw `192.168.1.1` — and is now closed from the other end: an agent's raw-line reads are redacted regardless of the chain unless the user opted out (Issue 1).

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
| 1 | PII anonymization defaults to off | **Resolved** — anonymized by default, one persisted UI-only `agent_raw_access` opt-out (`services::policy::should_anonymize`) | was Medium | done |
| 2 | MCP anonymization coupled to pipeline chain | **Resolved** — chain mirror, `set_mcp_anonymize` and the per-session map deleted | was Medium (it disabled Issue 1's default) | done |
| 3 | Query path reads pre-transform data | **Open** (view mismatch); PII half resolved via Issue 1's fix | Low (was Low–Medium) | Moderate–Large for the view-mismatch half |

Issue 1's first attempt shipped with the Phase 1 service-layer migration and was completed
(together with Issue 2) by the `agent_raw_access` change. Issue 3's view-mismatch half
remains a design improvement for a later phase.

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
  change the anonymizer config, grant itself raw log access, or add/remove a marketplace
  source. This wasn't a
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
