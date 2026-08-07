/**
 * Bounded-concurrency task runner for workspace restore's load loop
 * (workspace-restore-performance design, part 2).
 *
 * Runs up to `limit` tasks concurrently, EXCEPT that two tasks sharing the
 * same key never run at the same time — same-key tasks run strictly in the
 * order they were submitted, each waiting for the previous one to settle.
 *
 * This is what lets `restoreCore.ts` parallelize loads that target different
 * panes while still serializing loads that would land on the SAME pane.
 * `useFileSession.loadFile` infers pane occupancy by reading
 * `paneSessionMapRef` synchronously at call start (before any await) and
 * guards against being superseded via a generation key that is also keyed by
 * destination pane (`hooks/useLogViewer/loadGeneration.ts`) — two concurrent
 * calls aimed at the same destination race both of those. Grouping tasks by
 * destination avoids ever creating that race, without having to change
 * `useFileSession`'s inference itself.
 *
 * A task's own failure must not wedge its key's chain for the tasks behind
 * it: chaining `.then(run)` directly onto a rejected predecessor would skip
 * `run` entirely (a rejected promise's `.then` without a rejection handler
 * just re-rejects), so every task is caught before being stored as the next
 * link. `run` is expected to handle its own errors (restoreCore's callers
 * do); this is a backstop, not the primary error path.
 */

export async function runBoundedByKey<T>(
  items: readonly T[],
  keyOf: (item: T, index: number) => string,
  run: (item: T, index: number) => Promise<void>,
  limit: number,
): Promise<void> {
  if (items.length === 0) return;

  // Per-key chain: the task the next same-key task must wait behind. Reads
  // and writes here are all synchronous (no `await` between them), so
  // multiple workers picking up work never interleave mid-update — standard
  // safe JS concurrency without an explicit lock.
  const keyChains = new Map<string, Promise<void>>();
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      const key = keyOf(item, index);
      const prior = keyChains.get(key) ?? Promise.resolve();
      const task: Promise<void> = prior.then(() => run(item, index)).catch((e: unknown) => {
        console.warn('[runBoundedByKey] task failed:', e);
      });
      keyChains.set(key, task);
      await task;
    }
  };

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
