/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import {
  cancelFilter,
  closeFilter,
  createFilter,
  getFilteredLines,
  getLines,
  searchLogs,
} from '@bridge/commands';
import { onFilterProgress, onSearchProgress } from '@bridge/events';
import type { LogLevel } from '@bridge/types';
import { LEVEL_SHORT } from '@bridge/types';
import { FilterScan } from './filterScan';
import { createSearchRunner } from './search';
import { toSearchQuery } from './queryStore';
import type { QueryMode, QueryStore } from './queryStore';
import type { ViewerController } from '../viewer';
import styles from './QueryBar.module.css';

const LEVELS: readonly LogLevel[] = ['Verbose', 'Debug', 'Info', 'Warn', 'Error', 'Fatal'];

const FILTER_CHIPS: readonly { label: string; hint: string }[] = [
  { label: 'package:', hint: 'Filter by app package name' },
  { label: 'tag:', hint: 'Filter by logcat tag (substring)' },
  { label: 'level:E', hint: 'Filter by level: V D I W E F' },
  { label: 'message:', hint: 'Filter by message text (substring)' },
];

const TOP_TAGS = 8;
const TEXT_DEBOUNCE_MS = 250;
const TIME_DEBOUNCE_MS = 400;

/** True when a bare key press would otherwise type into `target`. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

export interface QueryBarProps {
  sessionId: string;
  store: QueryStore;
  controller: ViewerController;
  /** Gates Ctrl+F focus — false when another pane holds keyboard focus.
   *  Defaults to true: today's shell mounts exactly one query bar at a time. */
  active?: boolean;
  /**
   * Registers this bar's `FilterScan` instance (L4) as the live-stream
   * incremental-match target **for `sessionId`** — App.tsx owns the registry
   * of session → scan (`query/liveFilterBindings.ts`), and this is the one
   * seam that reaches it: a `FilterScan` is otherwise private to whichever
   * `QueryBar` constructs it. Called once from `onMount` with the
   * freshly-constructed `scan`; the returned unbind is invoked from this
   * bar's own `onCleanup` and removes only this session's entry, so a second
   * pane's bar can never displace the capture's (H4). Omitted in tests that
   * don't exercise live streaming.
   */
  bindLiveFilter?: (sessionId: string, scan: FilterScan) => () => void;
}

/**
 * The one query bar: free-text/regex search with level, tag and time chips in
 * `search` mode; the `package:/tag:/level:/message:` mini-language in `filter`
 * mode. Built fresh per mount — the bar lives inside the same
 * `<Show when={store.focused()}>` as `LogViewer` in `App.tsx`, so a session
 * switch tears this instance down and a new one starts from that session's own
 * persisted `QueryState` — inputs **and** engines (`onMount` replays the
 * persisted expression and matches-only flag into them), and both line-set
 * keys it owns are released again from `onCleanup`.
 *
 * `props.bindLiveFilter` (L4, optional) is the seam that lets `App.tsx` bind
 * this bar's private `scan` as the live-stream incremental-match target when
 * `sessionId` is (or becomes) the active capture — see the prop's own doc
 * comment. `FilterScan` itself has no idea a stream exists; this is purely
 * exposing an otherwise-private instance to the one place that needs it.
 */
export function QueryBar(props: QueryBarProps) {
  // A one-time snapshot at mount, deliberately non-reactive. CONTRACT: the
  // parent MUST mount this component under `<Show when={sessionId} keyed>` (see
  // `App.tsx`) so a session switch remounts it; a non-keyed Show does not
  // re-run its child on a truthy→truthy change and would leave this instance
  // bound to the first session forever.
  const sessionId = untrack(() => props.sessionId);
  const controller = untrack(() => props.controller);
  const initial = untrack(() => props.store.state(sessionId));

  const scan = new FilterScan({
    commands: { createFilter, getFilteredLines, cancelFilter, closeFilter, getLines },
    listen: onFilterProgress,
  });
  const runner = createSearchRunner({
    controller,
    listen: onSearchProgress,
    commands: { searchLogs },
  });
  onCleanup(() => {
    scan.dispose();
    runner.dispose();
  });

  // The rendered index space: filter mode's scan and search mode's "matches
  // only" toggle both narrow through the same two controller line-set keys.
  createEffect(() => {
    controller.setLineSet(sessionId, 'filter', scan.lines());
  });

  const [mode, setMode] = createSignal<QueryMode>(initial.mode);
  const [textDraft, setTextDraft] = createSignal(initial.text);
  const [isRegex, setIsRegex] = createSignal(initial.isRegex);
  const [caseSensitive, setCaseSensitive] = createSignal(initial.caseSensitive);
  const [minLevel, setMinLevel] = createSignal<LogLevel | null>(initial.minLevel);
  const [tags, setTags] = createSignal<string[]>(initial.tags ?? []);
  const [startDraft, setStartDraft] = createSignal(initial.startTime ?? '');
  const [endDraft, setEndDraft] = createSignal(initial.endTime ?? '');
  const [matchesOnly, setMatchesOnlyLocal] = createSignal(initial.matchesOnly);
  const [exprDraft, setExprDraft] = createSignal(initial.expr);

  let textInputRef: HTMLInputElement | undefined;
  let exprInputRef: HTMLInputElement | undefined;
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  let timeTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(textTimer);
    clearTimeout(timeTimer);
  });

  const commitSearch = (): void => {
    props.store.update(sessionId, {
      text: textDraft(),
      isRegex: isRegex(),
      caseSensitive: caseSensitive(),
      minLevel: minLevel(),
      tags: tags().length > 0 ? tags() : null,
      startTime: startDraft() || null,
      endTime: endDraft() || null,
    });
    const value = textDraft().trim();
    if (!value) {
      runner.run(sessionId, null);
      return;
    }
    runner.run(sessionId, toSearchQuery(props.store.state(sessionId)));
  };

  const scheduleSearch = (): void => {
    clearTimeout(textTimer);
    textTimer = setTimeout(commitSearch, TEXT_DEBOUNCE_MS);
  };

  const scheduleTime = (): void => {
    clearTimeout(timeTimer);
    timeTimer = setTimeout(commitSearch, TIME_DEBOUNCE_MS);
  };

  const commitExpr = (expr: string): void => {
    setExprDraft(expr);
    props.store.update(sessionId, { expr });
    void scan.setExpression(sessionId, expr || null);
  };

  const toggleMode = (next: QueryMode): void => {
    setMode(next);
    props.store.update(sessionId, { mode: next });
  };

  const toggleMatchesOnly = (): void => {
    const next = !matchesOnly();
    setMatchesOnlyLocal(next);
    props.store.update(sessionId, { matchesOnly: next });
    runner.setMatchesOnly(next);
  };

  const toggleLevel = (level: LogLevel): void => {
    setMinLevel((current) => (current === level ? null : level));
    commitSearch();
  };

  const toggleTag = (tag: string): void => {
    setTags((current) => (current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag]));
    commitSearch();
  };

  const insertFilterChip = (label: string): void => {
    const input = exprInputRef;
    const current = exprDraft();
    const start = input?.selectionStart ?? current.length;
    const prefix = start > 0 && current[start - 1] !== ' ' ? ' ' : '';
    const next = (current.slice(0, start) + prefix + label + current.slice(start)).trimStart();
    setExprDraft(next);
    input?.focus();
  };

  const clearSearch = (): void => {
    setTextDraft('');
    clearTimeout(textTimer);
    commitSearch();
  };

  const clearFilter = (): void => {
    commitExpr('');
  };

  const topTags = createMemo<string[]>(() => {
    const byTag = runner.summary()?.byTag ?? {};
    return Object.keys(byTag)
      .sort((a, b) => byTag[b] - byTag[a])
      .slice(0, TOP_TAGS);
  });

  const hitLabel = createMemo<string>(() => {
    const list = runner.hits();
    const phase = runner.phase();
    if (phase === 'idle') return '';
    if (list.length === 0) {
      if (phase === 'done') return 'No matches';
      // A rejected `search_logs` (an invalid regex, say) used to leave the bar
      // reading "Searching…" forever with nothing anywhere explaining why —
      // filter mode surfaced the equivalent rejection correctly (M7). The
      // message itself renders below, in the same slot filter mode uses.
      if (phase === 'error') return 'Search failed';
      return 'Searching…';
    }
    return `${runner.current() + 1} / ${list.length}`;
  });

  onMount(() => {
    // This bar is keyed on its session and remounts on every focus switch, so
    // mount is also "restore" — and restoring the *inputs* without restoring
    // the engines is M2: the expression sat in the box over an unfiltered
    // viewer, and the already-lit "Matches only" button turned narrowing OFF
    // on its first click (the toggle's appearance came from the persisted
    // state; `SearchRunner`'s own flag still started false).
    runner.setMatchesOnly(initial.matchesOnly);
    if (initial.expr.trim()) void scan.setExpression(sessionId, initial.expr);

    // Registered here rather than in the component body: binding during render
    // writes another owner's state from inside a render function (L4, the
    // project's "side effects belong in onMount/createEffect" rule).
    const unbindLiveFilter = untrack(() => props.bindLiveFilter)?.(sessionId, scan);
    onCleanup(() => {
      unbindLiveFilter?.();
      // Both keys this bar owns are released on the way out (M2). Disposing
      // the engines only tears down *their* state: without this the last
      // published narrowing stayed on the controller for a session that no
      // longer has a bar, so returning to it showed a viewer still narrowed to
      // a match set nothing could navigate or clear.
      controller.setLineSet(sessionId, 'search', null);
      controller.setLineSet(sessionId, 'filter', null);
    });
  });

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const isActive = props.active ?? true;
      if (isActive && (e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        (mode() === 'search' ? textInputRef : exprInputRef)?.focus();
        return;
      }
      const inThisBar = e.target === textInputRef || e.target === exprInputRef;

      if (inThisBar && e.key === 'Enter' && mode() === 'search') {
        e.preventDefault();
        if (e.shiftKey) runner.prev();
        else runner.next();
        return;
      }
      if (inThisBar && e.key === 'Escape') {
        e.preventDefault();
        if (mode() === 'search') clearSearch();
        else clearFilter();
        controller.focus();
        return;
      }
      // Bare n/N navigate the viewer's matches while the bar's own inputs are
      // NOT focused — mirrors most log/text viewers' "jump to next hit" without
      // forcing a refocus into the search box first.
      if (isActive && !inThisBar && mode() === 'search' && !isEditable(e.target)) {
        if (e.key === 'n') { e.preventDefault(); runner.next(); }
        else if (e.key === 'N') { e.preventDefault(); runner.prev(); }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  });

  return (
    <div class={styles.bar} data-mode={mode()} data-session-id={sessionId}>
      <div class={styles.modeSwitch} role="group" aria-label="Query mode">
        <button
          type="button"
          classList={{ [styles.modeBtn]: true, [styles.modeBtnActive]: mode() === 'search' }}
          onClick={() => toggleMode('search')}
        >
          Search
        </button>
        <button
          type="button"
          classList={{ [styles.modeBtn]: true, [styles.modeBtnActive]: mode() === 'filter' }}
          onClick={() => toggleMode('filter')}
        >
          Filter
        </button>
      </div>

      <Show when={mode() === 'search'}>
        <div class={styles.row}>
          <input
            ref={textInputRef}
            class={styles.input}
            type="text"
            placeholder="Search logs… (Ctrl+F)"
            value={textDraft()}
            onInput={(e) => { setTextDraft(e.currentTarget.value); scheduleSearch(); }}
          />
          <button
            type="button"
            classList={{ [styles.toggle]: true, [styles.toggleActive]: isRegex() }}
            title="Regular expression"
            onClick={() => { setIsRegex((v) => !v); commitSearch(); }}
          >
            .*
          </button>
          <button
            type="button"
            classList={{ [styles.toggle]: true, [styles.toggleActive]: caseSensitive() }}
            title="Case sensitive"
            onClick={() => { setCaseSensitive((v) => !v); commitSearch(); }}
          >
            Aa
          </button>
          <button
            type="button"
            classList={{ [styles.toggle]: true, [styles.toggleActive]: matchesOnly() }}
            title="Show matches only"
            onClick={toggleMatchesOnly}
          >
            Matches only
          </button>
          <Show when={hitLabel()}>
            <span class={styles.matchCount}>{hitLabel()}</span>
          </Show>
          <button
            type="button"
            class={styles.navBtn}
            title="Previous match (Shift+Enter)"
            disabled={runner.hits().length === 0}
            onClick={() => runner.prev()}
          >
            ‹
          </button>
          <button
            type="button"
            class={styles.navBtn}
            title="Next match (Enter)"
            disabled={runner.hits().length === 0}
            onClick={() => runner.next()}
          >
            ›
          </button>
        </div>

        <div class={styles.row}>
          <div class={styles.chips}>
            <For each={LEVELS}>
              {(level) => (
                <button
                  type="button"
                  classList={{ [styles.chip]: true, [styles.chipActive]: minLevel() === level }}
                  title={level}
                  onClick={() => toggleLevel(level)}
                >
                  {LEVEL_SHORT[level] ?? level[0]}
                </button>
              )}
            </For>
            <For each={topTags()}>
              {(tag) => (
                <button
                  type="button"
                  classList={{ [styles.chip]: true, [styles.chipActive]: tags().includes(tag) }}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              )}
            </For>
          </div>
          <div class={styles.timeWrap}>
            <input
              class={styles.timeInput}
              type="text"
              placeholder="HH:MM"
              value={startDraft()}
              onInput={(e) => { setStartDraft(e.currentTarget.value); scheduleTime(); }}
            />
            <span class={styles.timeSep}>–</span>
            <input
              class={styles.timeInput}
              type="text"
              placeholder="HH:MM"
              value={endDraft()}
              onInput={(e) => { setEndDraft(e.currentTarget.value); scheduleTime(); }}
            />
          </div>
        </div>
        {/* The search engine's own failures land in the same slot filter mode
            puts parse/backend errors in (M7) — nothing rendered `runner.error()`
            before, so a rejected `search_logs` was invisible. */}
        <Show when={runner.error()}>
          {(message) => <div class={styles.parseError}>{message()}</div>}
        </Show>
      </Show>

      <Show when={mode() === 'filter'}>
        <div class={styles.row}>
          <div class={styles.chips}>
            <For each={FILTER_CHIPS}>
              {(chip) => (
                <button
                  type="button"
                  class={styles.chip}
                  title={chip.hint}
                  onClick={() => insertFilterChip(chip.label)}
                >
                  {chip.label}
                </button>
              )}
            </For>
          </div>
        </div>
        <div class={styles.row}>
          <input
            ref={exprInputRef}
            class={styles.input}
            type="text"
            placeholder="package:com.example  tag:MyTag  level:E | message:crash"
            value={exprDraft()}
            spellcheck={false}
            onInput={(e) => setExprDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitExpr(exprDraft()); }
            }}
          />
          <Show when={scan.phase() === 'scanning'}>
            <span class={styles.matchCount}>
              {scan.matched().toLocaleString()} / {scan.total().toLocaleString()}
            </span>
          </Show>
          <Show when={scan.phase() === 'done'}>
            <span class={styles.matchCount}>{scan.matched().toLocaleString()} matches</span>
          </Show>
        </div>
        <Show when={scan.parseError() ?? scan.error()}>
          {(message) => <div class={styles.parseError}>{message()}</div>}
        </Show>
      </Show>
    </div>
  );
}
