/** @jsxImportSource solid-js */
/**
 * The shared human + agent action journal, grouped by session.
 *
 * Reads nothing itself — `presenceStore.ts` owns the `getActivity()` fetch and
 * the `onActivity` subscription, so this file is a pure renderer over
 * `entries()` plus the two mappings below (`actionLabel`, `navTargetFor`) that
 * turn a journaled `action`/`summary` pair into something clickable.
 *
 * 500 rows render as plain DOM: the panel is a side column, the list is capped
 * by the store, and virtualizing it would mean a second viewport implementation
 * for no measured win. If that stops being true the store's cap is the knob.
 */
import { For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ActivityEntry, Caller } from '@bridge/types';
import type { NavTarget } from './presenceStore';
import styles from './presence.module.css';

export interface ActivityFeedProps {
  entries: readonly ActivityEntry[];
  /** `sessionId` → display name; the store resolves this from the session list. */
  sessionName: (sessionId: string) => string;
  /** Invoked when a row with a resolvable target is activated. */
  onNavigate?: (target: NavTarget) => void;
  /** Injectable clock for the relative timestamps (tests). */
  now?: () => number;
}

/**
 * Human-readable verb per journaled action. The keys are the exact action
 * names `ServiceCtx::journal` emits — grep `journal(` under
 * `src-tauri/src/services/` before adding one. An unlisted action falls back
 * to its dotted name, which is still readable ("pack.install").
 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'analysis.publish': 'published analysis',
  'analysis.update': 'updated analysis',
  'analysis.delete': 'deleted analysis',
  'bookmark.create': 'created bookmark',
  'bookmark.update': 'updated bookmark',
  'bookmark.delete': 'deleted bookmark',
  'watch.create': 'created watch',
  'watch.cancel': 'cancelled watch',
  'filter.cancel': 'cancelled filter',
  'pipeline.run': 'ran pipeline',
  'session.open': 'opened session',
  'session.close': 'closed session',
  'stream.stop': 'stopped stream',
  'export.run': 'exported',
  'focus.set': 'shared focus',
  'focus.clear': 'cleared focus',
  'nav.request': 'requested navigation',
  'workspace.switch': 'switched workspace',
  'pack.install': 'installed pack',
  'pack.uninstall': 'uninstalled pack',
  'processor.install': 'installed processor',
  'processor.uninstall': 'uninstalled processor',
  'source.add': 'added marketplace source',
  'source.remove': 'removed marketplace source',
  'settings.allowlist': 'changed the open-file allowlist',
  'settings.anonymizer': 'changed the anonymizer',
  'theme.write': 'saved theme',
  'theme.delete': 'deleted theme',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** `line 42: ANR` / `line 42` / `... (line 42)` → 42. */
function parseLine(summary: string): number | undefined {
  const match = /\bline (\d+)/.exec(summary);
  return match ? Number(match[1]) : undefined;
}

/** `bookmark <id>` / `artifact <id>[: title]` / `watch <id>` → the id. */
function parseId(summary: string, keyword: string): string | undefined {
  const match = new RegExp(`^${keyword} ([^:\\s]+)`).exec(summary);
  return match ? match[1] : undefined;
}

/**
 * Where a journaled entry points, or `null` when nothing in the UI can show it
 * (a workspace-scoped action such as `pack.install`, or an action whose
 * summary carries no id). The summaries parsed here are the exact `format!`
 * strings in `src-tauri/src/services/` — a format change there silently
 * downgrades a row to non-clickable rather than breaking it.
 */
export function navTargetFor(entry: ActivityEntry): NavTarget | null {
  const sessionId = entry.sessionId;
  if (!sessionId) return null;
  const base: NavTarget = { sessionId };

  switch (entry.action) {
    case 'bookmark.create': {
      const line = parseLine(entry.summary);
      return line === undefined ? base : { ...base, line };
    }
    case 'bookmark.update':
    case 'bookmark.delete': {
      const bookmarkId = parseId(entry.summary, 'bookmark');
      return bookmarkId ? { ...base, bookmarkId } : base;
    }
    case 'analysis.publish':
    case 'analysis.update':
    case 'analysis.delete': {
      const analysisId = parseId(entry.summary, 'artifact');
      return analysisId ? { ...base, analysisId } : base;
    }
    case 'watch.create':
    case 'watch.cancel': {
      const watchId = parseId(entry.summary, 'watch');
      return watchId ? { ...base, watchId } : base;
    }
    case 'focus.set':
    case 'nav.request': {
      const line = parseLine(entry.summary);
      return line === undefined ? base : { ...base, line };
    }
    case 'pipeline.run':
    case 'session.open':
    case 'session.close':
    case 'stream.stop':
      return base;
    default:
      return null;
  }
}

export function isAgent(caller: Caller): boolean {
  return caller.kind === 'agent';
}

/** Short, stable relative time — the journal is minutes-to-hours old, not days. */
export function relativeTime(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface SessionGroup {
  sessionId: string | null;
  name: string;
  entries: ActivityEntry[];
}

/**
 * Chronological within a group, groups ordered by their newest entry — so the
 * session the agent just touched sits at the top without the rows themselves
 * jumping around.
 */
export function groupBySession(
  entries: readonly ActivityEntry[],
  sessionName: (id: string) => string,
): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const entry of entries) {
    const key = entry.sessionId ?? '';
    let group = groups.get(key);
    if (!group) {
      group = {
        sessionId: entry.sessionId,
        name: entry.sessionId ? sessionName(entry.sessionId) : 'Workspace',
        entries: [],
      };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  const ordered = [...groups.values()];
  for (const group of ordered) group.entries.sort((a, b) => b.id - a.id);
  ordered.sort((a, b) => (b.entries[0]?.id ?? 0) - (a.entries[0]?.id ?? 0));
  return ordered;
}

function CallerBadge(props: { caller: Caller }): JSX.Element {
  const agent = () => isAgent(props.caller);
  const label = () => (agent() ? (props.caller as { client: string }).client : 'you');
  return (
    <span
      class={styles.badge}
      classList={{ [styles.badgeAgent]: agent(), [styles.badgeHuman]: !agent() }}
      data-caller={agent() ? 'agent' : 'human'}
      title={agent() ? `agent: ${label()}` : 'you'}
    >
      {agent() ? '✦' : '●'}
      <span class={styles.badgeText}>{label()}</span>
    </span>
  );
}

export function ActivityFeed(props: ActivityFeedProps): JSX.Element {
  const now = () => (props.now ?? Date.now)();
  const groups = createMemo(() => groupBySession(props.entries, props.sessionName));

  return (
    <div class={styles.feed} data-testid="activity-feed">
      <Show
        when={props.entries.length > 0}
        fallback={<p class={styles.empty}>No activity yet.</p>}
      >
        <For each={groups()}>
          {(group) => (
            <section class={styles.group} data-session={group.sessionId ?? 'workspace'}>
              <header class={styles.groupHeader}>
                <span class={styles.groupName}>{group.name}</span>
                <span class={styles.groupCount}>
                  {group.entries.length} {group.entries.length === 1 ? 'entry' : 'entries'}
                </span>
              </header>
              <ul class={styles.rows}>
                <For each={group.entries}>
                  {(entry) => {
                    const target = navTargetFor(entry);
                    // A thunk, not a stored element: Solid JSX evaluates to a
                    // real DOM node, so reusing one value in both branches
                    // would move the node rather than render it twice.
                    const rowContent = () => (
                      <>
                        <time class={styles.rowTime}>{relativeTime(entry.ts, now())}</time>
                        <CallerBadge caller={entry.caller} />
                        <span class={styles.rowText}>
                          <span class={styles.rowAction}>{actionLabel(entry.action)}</span>{' '}
                          <span class={styles.rowSummary}>{entry.summary}</span>
                        </span>
                      </>
                    );
                    return (
                      <li class={styles.row} data-action={entry.action}>
                        <Show
                          when={target}
                          fallback={<span class={styles.rowInert}>{rowContent()}</span>}
                        >
                          {(resolved) => (
                            <button
                              type="button"
                              class={styles.rowButton}
                              onClick={() => props.onNavigate?.(resolved())}
                            >
                              {rowContent()}
                            </button>
                          )}
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </section>
          )}
        </For>
      </Show>
    </div>
  );
}
