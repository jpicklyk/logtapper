/**
 * Monotonic epoch bumped once at the top of every workspace teardown
 * (`doClearPanes` in `useWorkspace.ts`) — covers all three transitions that
 * tear panes down: new / open / switch.
 *
 * `useFileSession.loadFile` captures the epoch before awaiting its backend
 * `load_log_file` IPC call. If the epoch has advanced by the time that IPC
 * resolves, the workspace the load was aimed at has already been torn down
 * (the user switched/opened/new'd away while the load was in flight) — the
 * load discards itself (closes the just-opened backend session(s), clears
 * any pre-seed) instead of registering into whatever workspace happens to be
 * active by then. See queue note `root-cause` on item
 * `6b9d644c-eff7-486c-982f-9034b3e7f84f` for the full mechanism.
 *
 * Module-scope rather than a ref: `useWorkspace` (owns `doClearPanes`, the
 * writer) and `useFileSession` (owns `loadFile`, the reader) are sibling
 * hooks mounted independently in `HookWiring` — there is no shared ref to
 * thread between them, and both are effectively singletons (mounted once),
 * so a module-level counter is equivalent to a ref owned by a common
 * ancestor without needing to invent one.
 *
 * IMPORTANT: this is read/written from imperative code (event handlers,
 * promise continuations, callback bodies) — never from a React render body
 * or `useMemo` factory. Reading external mutable state during render would
 * violate the "no reading external mutable state in useMemo/render" rule
 * (src-next/CLAUDE.md) because React wouldn't know to re-run when it
 * changes; this module is never read for that purpose, only as an
 * imperative staleness check, the same pattern as the existing
 * per-pane/tab `loadGenRef` guard in `useFileSession.ts`.
 */
let epoch = 0;

/** Bump the epoch and return the new value. Call exactly once per teardown,
 *  synchronously, before any `await` — every load already in flight at that
 *  point captured the OLD epoch and will discard on resolve; every load
 *  started after this call (e.g. a workspace restore's own burst of loads)
 *  captures the NEW epoch and is unaffected. */
export function bumpWorkspaceEpoch(): number {
  epoch += 1;
  return epoch;
}

/** Current epoch value. */
export function getWorkspaceEpoch(): number {
  return epoch;
}
