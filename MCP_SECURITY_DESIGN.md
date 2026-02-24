# MCP Security Design: Open Issues

> **Status:** Deferred — early development. These are known design concerns, not bugs.
> Captured here so the trade-offs are understood before the tool ships to users.

---

## Background

The MCP bridge (`src-tauri/src/mcp_bridge.rs`) exposes two classes of data to Claude:

| Endpoint | Data source | What it returns |
|---|---|---|
| `/mcp/sessions/:id/query` | `AppState::sessions` (Tier 1 — raw log store) | Sampled raw log lines, filtered/searched |
| `/mcp/sessions/:id/pipeline` | `AppState::pipeline_results` (Tier 2 — pipeline results) | Reporter vars, emissions, match counts |
| `/mcp/sessions/:id/events` | `AppState::state_tracker_results` (Tier 2) | StateTracker transition records |

The three issues below all stem from the fact that `h_query` reads directly from Tier 1 (raw log data) rather than from post-pipeline transformed data.

---

## Issue 1: PII anonymization defaults to off — should default to on

### The problem

`AppState::mcp_anonymize` is a `Mutex<bool>` that defaults to `false`. It is only set to `true` when the frontend calls `set_mcp_anonymize(true)`, which happens when the user adds `__pii_anonymizer` to their pipeline chain.

This means:

- User loads a log file that contains email addresses, OAuth tokens, device IDs, or IP addresses
- They have not yet added the PII Anonymizer to their pipeline chain
- `h_query` serves those raw lines unredacted to Claude

The user has no visible signal that this is happening. The MCP tool activity isn't shown in the UI, and there is no opt-in prompt. The sensitive data flows silently.

### Why it matters

The PII Anonymizer ships pre-configured with 14 detectors enabled by default (`AnonymizerConfig::with_defaults()`). The system already has an opinion about what constitutes PII — it's just not applying it to MCP queries by default.

### Proposed fix

Flip the default: `mcp_anonymize` should initialise to `true`. Users who want Claude to see raw unredacted lines can explicitly turn it off. This is a single-line change in `commands/mod.rs`:

```rust
// Before
mcp_anonymize: Mutex::new(false),

// After
mcp_anonymize: Mutex::new(true),
```

The corresponding `setMcpAnonymize` call in `usePipeline.ts` already fires on chain changes — no frontend changes needed. The behaviour becomes: anonymized by default, raw when the user explicitly removes the anonymizer from their chain.

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

### Proposed fix

Introduce an independent `mcp_anonymize_override: Mutex<Option<bool>>` in `AppState`, or expose a separate UI control (a toggle in the MCP Bridge status widget in `ProcessorPanel`) that sets `mcp_anonymize` directly. The pipeline chain presence of `__pii_anonymizer` becomes a default/suggestion, not the authoritative control.

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

---

## Summary

| # | Issue | Risk level | Effort to fix |
|---|---|---|---|
| 1 | PII anonymization defaults to off | **Medium** — silent PII exposure to Claude | Trivial (one-line default change) |
| 2 | MCP anonymization coupled to pipeline chain | Low — confusing but not dangerous | Small (add independent UI toggle) |
| 3 | `h_query` reads pre-transform data | Low–Medium — view mismatch; PII mismatch if Issue 1 fixed | Moderate–Large (requires backend arch decision) |

Issue 1 should be fixed before any public release. Issues 2 and 3 are design improvements that can wait for a more stable architecture.
