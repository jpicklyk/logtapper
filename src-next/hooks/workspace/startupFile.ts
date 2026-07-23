/**
 * The CLI startup file (a double-clicked file association) is delivered by the
 * backend `get_startup_file` command, which `.take()`s it — a second call
 * returns null. Two consumers now need to know it: `useStartupFile` (which loads
 * it, exactly as before) and `useStartupRestore` (which must skip the `.ltw`
 * auto-restore when the user launched by opening a specific file). Memoise the
 * single backend read so both observe the same value without racing over who
 * consumed the `.take()`.
 */
import { getStartupFile } from '../../bridge/commands';

let cached: Promise<string | null> | null = null;

/** Read the CLI startup file at most once per process; subsequent calls share
 *  the memoised result. Never rejects — a failed read resolves to null. */
export function consumeStartupFile(): Promise<string | null> {
  if (!cached) {
    cached = getStartupFile().catch(() => null);
  }
  return cached;
}
