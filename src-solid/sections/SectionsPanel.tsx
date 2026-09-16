/** @jsxImportSource solid-js */
import { Show, createEffect, createMemo, createSignal, on, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import { buildSectionTree, filterSections, formatDuration, formatTimestamp } from '@fileinfo';
import type { SectionRow } from '@fileinfo';
import type { SectionsStore } from './sectionsStore';
import { flattenRows, SectionTree } from './SectionTree';
import type { FlatRow } from './SectionTree';
import styles from './sections.module.css';

export interface SectionsPanelProps {
  store: SectionsStore;
  sourceName?: string;
  firstTimestamp?: number | null;
  lastTimestamp?: number | null;
  /**
   * Opens the focused session's info popover (lines, size, time range, the
   * full device block, reopen-as). Rendered as a "File info…" button beside
   * the device model and date span — the place a user looks for it — and in
   * the non-bugreport empty state, so a logcat has the same way in. Absent
   * when nothing is focused.
   */
  onShowFileInfo?: () => void;
}

/** The "File info…" entry point; renders nothing when no session is focused. */
function FileInfoButton(props: { onClick?: () => void }): JSX.Element {
  return (
    <Show when={props.onClick}>
      {(onClick) => (
        <div class={styles.metaActions}>
          <button
            type="button"
            class={styles.infoButton}
            data-testid="sections-file-info"
            title="Lines, size, time range, device details and reopen-as for the focused session"
            onClick={() => onClick()()}
          >
            File info…
          </button>
        </div>
      )}
    </Show>
  );
}

/** The group/parent header row (if any) whose members include `startLine`. */
function containingGroupKey(rows: readonly SectionRow[], startLine: number): string | null {
  for (const row of rows) {
    if (row.kind === 'prefixGroup' && row.sections.some((item) => item.section.startLine === startLine)) {
      return `g-${row.prefix}`;
    }
    if (
      row.kind === 'parent' &&
      (row.section.startLine === startLine || row.children.some((c) => c.section.startLine === startLine))
    ) {
      return `p-${row.section.startLine}`;
    }
  }
  return null;
}

/**
 * The sections navigator: metadata header, filterable/groupable section tree,
 * active-section tracking, and jump/select actions routed through
 * {@link SectionsStore}. Mounts through the shell's `sections` surface slot.
 */
export function SectionsPanel(props: SectionsPanelProps): JSX.Element {
  const [query, setQuery] = createSignal('');
  const [focusedKey, setFocusedKey] = createSignal<string | null>(null);
  let filterInputRef: HTMLInputElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  const filtered = createMemo(() => filterSections(props.store.sections(), query()));
  const tree = createMemo(() => buildSectionTree(filtered(), props.store.sections()));

  const activeStartLine = createMemo(() => {
    const idx = props.store.activeIndex();
    const secs = props.store.sections();
    return idx >= 0 && idx < secs.length ? secs[idx].startLine : -1;
  });

  // Sticky auto-expand: once the cursor lands inside a collapsed group, open
  // it. Mirrors React's `useEffect(() => { if (hasActive) setExpanded(true) })`.
  //
  // Tracking only the group *key* is load-bearing. Reading `isExpanded` in the
  // tracked body subscribed this effect to the same `expanded` signal it
  // writes, so collapsing the group the cursor sits in re-fired the effect and
  // re-expanded it immediately — that group could not be closed at all.
  createEffect(
    on(
      () => containingGroupKey(tree(), activeStartLine()),
      (key) => {
        if (key && !untrack(() => props.store.isExpanded(key))) props.store.toggleExpanded(key);
      },
    ),
  );

  const rows = createMemo<FlatRow[]>(() => flattenRows(tree(), props.store.isExpanded));

  const duration = createMemo(() => formatDuration(props.firstTimestamp, props.lastTimestamp));

  const focusedRow = (): FlatRow | undefined => rows().find((row) => row.key === focusedKey());

  const moveFocus = (delta: number): void => {
    const list = rows();
    if (list.length === 0) return;
    const currentIndex = list.findIndex((row) => row.key === focusedKey());
    const from = currentIndex === -1 ? (delta > 0 ? -1 : 0) : currentIndex;
    const next = Math.min(list.length - 1, Math.max(0, from + delta));
    const key = list[next].key;
    setFocusedKey(key);
    // A hand-escaped attribute match — avoids depending on `CSS.escape`, which
    // some jsdom versions don't provide.
    const escaped = key.replace(/"/g, '\\"');
    containerRef?.querySelector<HTMLElement>(`[data-row-key="${escaped}"]`)?.focus();
  };

  const activateFocused = (): void => {
    const row = focusedRow();
    if (!row) return;
    if (row.type === 'leaf') props.store.jumpTo(row.section);
    else props.store.toggleExpanded(row.key);
  };

  const toggleFocusedCheckbox = (): void => {
    const row = focusedRow();
    if (!row) return;
    if (row.type === 'leaf') props.store.toggle(row.section.startLine);
    else props.store.toggleGroup(row.startLines);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === '/' && document.activeElement !== filterInputRef) {
      event.preventDefault();
      filterInputRef?.focus();
      return;
    }
    if (document.activeElement === filterInputRef) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(-1);
        break;
      case 'Enter':
        event.preventDefault();
        activateFocused();
        break;
      case ' ':
        event.preventDefault();
        toggleFocusedCheckbox();
        break;
      default:
        break;
    }
  };

  // `moveFocus` drives DOM focus via `[data-row-key]`, which `SectionTree.tsx`
  // sets on each row so Up/Down actually moves the browser's focus outline,
  // not just this component's bookkeeping.
  return (
    <div ref={containerRef} class={styles.panel} data-testid="sections-panel" onKeyDown={onKeyDown}>
      <Show
        when={props.store.isBugreportSession()}
        fallback={
          <div class={styles.empty}>
            <p class={styles.emptyText}>Sections apply to bugreports and dumpstates.</p>
            <FileInfoButton onClick={props.onShowFileInfo} />
          </div>
        }
      >
        <Show
          when={props.store.metadata()}
          fallback={
            <div class={styles.metaHeader}>
              <FileInfoButton onClick={props.onShowFileInfo} />
            </div>
          }
        >
          {(meta) => (
            <div class={styles.metaHeader}>
              <FileInfoButton onClick={props.onShowFileInfo} />
              <Show when={meta().manufacturer || meta().deviceModel}>
                <div class={styles.metaRow}>
                  <Show when={meta().manufacturer}>{(v) => <span class={styles.metaMaker}>{v()}</span>}</Show>
                  <Show when={meta().deviceModel}>{(v) => <span class={styles.metaModel}>{v()}</span>}</Show>
                </div>
              </Show>
              <Show when={meta().osVersion || meta().buildType}>
                <div class={styles.metaRow}>
                  <Show when={meta().osVersion}>{(v) => <span class={styles.metaSub}>Android {v()}</span>}</Show>
                  <Show when={meta().buildType}>{(v) => <span class={styles.metaSub}>{v()}</span>}</Show>
                </div>
              </Show>
              <Show when={props.firstTimestamp || props.lastTimestamp}>
                <div class={styles.metaTime}>
                  <span>{formatTimestamp(props.firstTimestamp)}</span>
                  <span> – {formatTimestamp(props.lastTimestamp)}</span>
                  <Show when={duration()}>{(d) => <span class={styles.metaDuration}> ({d()})</span>}</Show>
                </div>
              </Show>
            </div>
          )}
        </Show>

        <Show
          when={!props.store.scanning()}
          fallback={<p class={styles.scanning}>Scanning sections…</p>}
        >
          <div class={styles.filterBar}>
            <input
              ref={filterInputRef}
              type="text"
              class={styles.filterInput}
              placeholder="Filter sections… (/)"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              aria-label="Filter sections by name"
            />
          </div>

          <Show when={props.store.selectionCount() > 0}>
            <div class={styles.filterBanner}>
              <span>
                {props.store.selectionCount()} section{props.store.selectionCount() !== 1 ? 's' : ''} filtered
              </span>
              <button type="button" class={styles.clearButton} onClick={() => props.store.clearSelection()}>
                Clear
              </button>
            </div>
          </Show>

          <Show when={props.store.notice()}>
            {(message) => <div class={styles.notice}>{message()}</div>}
          </Show>

          {/* Without this, a rejected `getSections` rendered as "No sections
              found." — a perfectly good dumpstate reported as empty, with
              nothing retrying because the fetch effect's dependency never
              changed again. */}
          <Show when={props.store.error()}>
            {(message) => (
              <div class={styles.error} role="alert" data-testid="sections-error">
                <span class={styles.errorText}>Could not load sections: {message()}</span>
                <button type="button" class={styles.retryButton} onClick={() => props.store.retry()}>
                  Retry
                </button>
              </div>
            )}
          </Show>

          <Show
            when={rows().length > 0}
            fallback={
              <Show when={!props.store.error()}>
                <p class={styles.empty}>{query() ? 'No sections match.' : 'No sections found.'}</p>
              </Show>
            }
          >
            <SectionTree
              rows={rows()}
              activeStartLine={activeStartLine()}
              focusedKey={focusedKey()}
              isSelected={props.store.isSelected}
              isExpanded={props.store.isExpanded}
              onToggle={props.store.toggle}
              onToggleGroup={props.store.toggleGroup}
              onToggleExpanded={props.store.toggleExpanded}
              onJump={props.store.jumpTo}
              onFocusRow={setFocusedKey}
            />
          </Show>
        </Show>
      </Show>
    </div>
  );
}
