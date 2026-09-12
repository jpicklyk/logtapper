/**
 * The Solid frontend's namespace inside a `.ltw` `layout.json` blob.
 *
 * Both frontends persist their shell layout into the *same* `layout` field of
 * the `.ltw` manifest. React owns the blob's top level (eight flat keys —
 * `centerTree`, the pane widths/visibility/tab selections); Solid owns exactly
 * one key, `solid`, and must leave everything else byte-for-byte intact so a
 * workspace saved by Solid still opens in React with its panes where the user
 * left them (and vice versa).
 *
 * That is the whole contract: {@link readSolidLayout} only ever looks at
 * `blob.solid`, and {@link writeSolidLayout} is a read-modify-write that
 * spreads the incoming blob and replaces that single key. Unknown keys —
 * React's eight, a future third frontend's, anything a newer build wrote —
 * survive a Solid save untouched.
 *
 * Versioned by `solid.v`. An unrecognised version reads as `null` (treated as
 * "no Solid layout saved") rather than being coerced, so an older build opening
 * a newer workspace falls back to defaults instead of misreading fields.
 */

/** Current schema version of the `solid` namespace. */
export const SOLID_LAYOUT_VERSION = 1 as const;

/**
 * React's top-level `layout.json` keys, mirrored from
 * `src-next/hooks/workspace/workspacePersistence.ts`'s `PersistedState`.
 *
 * Exported for the compatibility test only — nothing here reads or writes
 * them; they are simply part of "every unknown key survives". Duplicated
 * rather than imported because `workspacePersistence.ts` is not framework-free
 * (it pulls in `components/EditorTab` and therefore React).
 */
export const REACT_LAYOUT_KEYS = [
  'centerTree',
  'leftPaneWidth',
  'leftPaneTab',
  'rightPaneVisible',
  'rightPaneWidth',
  'rightPaneTab',
  'bottomPaneVisible',
  'bottomPaneHeight',
  'bottomPaneTab',
] as const;

/**
 * The Solid shell's persisted layout.
 *
 * `columns`/`collapsed` are S1's shell state (per-region splitter widths and
 * which rails are collapsed); `tabs`/`activeTab` are the tab strip's order and
 * selection, keyed the same way `TabStrip` keys its descriptors (a session's
 * source path for log tabs, the editor tab's own key for editor tabs).
 */
export interface SolidLayout {
  /** Region id → width in px. */
  columns: Record<string, number>;
  /** Ids of regions/rails the user collapsed. */
  collapsed: string[];
  /** Tab keys in strip order. */
  tabs: string[];
  /** The selected tab key, or null when nothing is selected. */
  activeTab: string | null;
}

/** An empty layout — what a workspace with no Solid namespace restores to. */
export function emptySolidLayout(): SolidLayout {
  return { columns: {}, collapsed: [], tabs: [], activeTab: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep only finite numeric entries — a corrupt width must not reach the shell. */
function sanitizeColumns(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, px] of Object.entries(value)) {
    if (typeof px === 'number' && Number.isFinite(px)) out[key] = px;
  }
  return out;
}

function sanitizeStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Read the Solid namespace out of a `.ltw` layout blob.
 *
 * Returns `null` when the blob is absent, is not an object, carries no `solid`
 * key, or carries one at an unrecognised `v`. Never throws — a hand-edited or
 * truncated blob degrades to "no saved layout".
 */
export function readSolidLayout(blob: unknown): SolidLayout | null {
  if (!isRecord(blob)) return null;
  const ns = blob.solid;
  if (!isRecord(ns)) return null;
  if (ns.v !== SOLID_LAYOUT_VERSION) return null;
  return {
    columns: sanitizeColumns(ns.columns),
    collapsed: sanitizeStrings(ns.collapsed),
    tabs: sanitizeStrings(ns.tabs),
    activeTab: typeof ns.activeTab === 'string' ? ns.activeTab : null,
  };
}

/**
 * Read-modify-write the Solid namespace into a `.ltw` layout blob.
 *
 * Every other key of `blob` is carried over by reference — React's eight and
 * anything else present. A non-object blob (null on a first save, or a
 * corrupted one) starts from an empty object rather than being dropped on the
 * floor, so the write always produces a valid blob.
 */
export function writeSolidLayout(blob: unknown, layout: SolidLayout): Record<string, unknown> {
  const base = isRecord(blob) ? blob : {};
  return {
    ...base,
    solid: {
      v: SOLID_LAYOUT_VERSION,
      columns: { ...layout.columns },
      collapsed: [...layout.collapsed],
      tabs: [...layout.tabs],
      activeTab: layout.activeTab,
    },
  };
}
