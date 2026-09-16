import type { SourceType } from '../bridge/types';

/** Types a user can reopen a file as. Mirrors the labels the backend's
 *  `SourceType::from_label` accepts; `Unknown` is a frontend-only sentinel and
 *  is deliberately not offered. */
export const REOPEN_SOURCE_TYPES: SourceType[] = [
  'Logcat',
  'Kernel',
  'Radio',
  'Events',
  'Bugreport',
  'Dumpstate',
  'Tombstone',
  'ANRTrace',
];

export interface ReopenOption {
  value: string;
  label: string;
  /**
   * True for a placeholder option representing the session's CURRENT source
   * type when that type isn't one of `REOPEN_SOURCE_TYPES` — a custom-parser
   * session (backend `Display`: `Custom(<parser_id>)`), or any other label the
   * reopen control doesn't recognize. Shown so the `<select>` displays the
   * real current state instead of rendering blank (a controlled `<select>`
   * whose `value` matches no `<option>` renders with nothing selected), but
   * not selectable: `SourceType::from_label` rejects a non-built-in label by
   * design, so there is no reopen path back to it.
   */
  disabled?: boolean;
}

/**
 * Builds the `<option>` list for FileInfoPanel's "reopen as" select, given the
 * session's current `sourceType` label.
 *
 * When `sourceType` matches one of the built-in reopen targets, this is just
 * `REOPEN_SOURCE_TYPES` mapped to options. When it doesn't — a custom-parser
 * session's `Custom(<parser_id>)` label is the motivating case — a disabled
 * option for the CURRENT type is prepended, so the select's controlled
 * `value` always matches a real `<option>` and the control shows the actual
 * state instead of a blank/empty-looking select with no visible indication of
 * what type the session is.
 */
export function buildReopenOptions(sourceType: string | undefined | null): ReopenOption[] {
  const known: ReopenOption[] = REOPEN_SOURCE_TYPES.map((t) => ({ value: t, label: t }));
  if (!sourceType || (REOPEN_SOURCE_TYPES as string[]).includes(sourceType)) return known;
  return [{ value: sourceType, label: sourceType, disabled: true }, ...known];
}
