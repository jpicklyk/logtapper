/**
 * Load-cancellation generation keys.
 *
 * `loadFile` claims a generation when it starts and re-checks it when the
 * `load_log_file` IPC returns. A stale generation means the load was superseded,
 * so the result is discarded and the backend session it created is closed.
 *
 * The key decides what "superseded" means. A load without a target tab is a
 * fresh open: it replaces whatever is loading in that pane, so it claims the
 * pane. A load aimed at an existing tab — the shape used by workspace and
 * startup restore — only supersedes an earlier load into that same tab, so it
 * claims the tab.
 *
 * Keying everything by pane meant two restores into sibling tabs of one pane
 * cancelled each other, and the loser also closed the session it had just
 * created. Only the last-initiated load per pane survived; since the restore
 * loop runs active-tab-first, the file under investigation always lost.
 */

/**
 * Separator between pane and tab in a composite key. Built from its char code
 * rather than written as an escape so the source file carries no raw control
 * character. NUL cannot appear in a pane or tab id, so a composite key can
 * never collide with a bare pane key.
 */
const SEP = String.fromCharCode(0);

export function genKeyFor(paneId: string, existingTabId?: string): string {
  return existingTabId ? `${paneId}${SEP}${existingTabId}` : paneId;
}
