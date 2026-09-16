/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import type { JSX } from 'solid-js';
import type { AnalysisArtifact, AnalysisSeverity } from '@bridge/types';
import { severityColor } from '@bridge/types';
import { attributeArtifact } from '@analysisPanel/analysisAttribution';
import type { ArtifactAttribution } from '@analysisPanel/analysisAttribution';
import { AnalysisReader } from './AnalysisReader';
import { AnalysisEditor } from './AnalysisEditor';
import type { AnalysesStore } from './analysesStore';
import styles from './analyses.module.css';

export interface AnalysesPanelProps {
  store: AnalysesStore;
}

type PanelMode = 'list' | 'reading' | 'editing';

const SEVERITY_ORDER: AnalysisSeverity[] = ['Critical', 'Error', 'Warning', 'Info'];

/** The most severe level appearing in any section, or `null`. Mirrors React's
 *  `AnalysisList.tsx` `highestSeverity`. */
function highestSeverity(artifact: AnalysisArtifact): AnalysisSeverity | null {
  for (const level of SEVERITY_ORDER) {
    if (artifact.sections.some((s) => s.severity === level)) return level;
  }
  return null;
}

/** One card's data: the artifact plus the attribution already computed for it. */
interface GroupEntry {
  artifact: AnalysisArtifact;
  attribution: ArtifactAttribution;
}

interface Group {
  label: string;
  entries: GroupEntry[];
}

/** Groups artifacts (already newest-first) by their first resolved session
 *  label, in first-seen order; artifacts with no resolvable session land in
 *  a trailing "Unattributed" group.
 *
 *  The attribution is returned alongside each artifact rather than recomputed
 *  per card: `attributeArtifact` walks every reference of every section, and
 *  calling it again in a tracked JSX position made every `labels()` change
 *  re-walk the whole list twice. */
function groupBySession(artifacts: readonly AnalysisArtifact[], labels: ReadonlyMap<string, string>): Group[] {
  const order: string[] = [];
  const byLabel = new Map<string, GroupEntry[]>();
  const UNATTRIBUTED = 'Unattributed';
  for (const artifact of artifacts) {
    const attribution = attributeArtifact(artifact, labels);
    const label = attribution.resolved[0]?.label ?? UNATTRIBUTED;
    if (!byLabel.has(label)) {
      order.push(label);
      byLabel.set(label, []);
    }
    byLabel.get(label)!.push({ artifact, attribution });
  }
  return order.map((label) => ({ label, entries: byLabel.get(label)! }));
}

function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface CardProps {
  artifact: AnalysisArtifact;
  attribution: ArtifactAttribution;
  onOpen: () => void;
  onDelete: () => void;
}

function AnalysisCard(props: CardProps): JSX.Element {
  const severity = createMemo(() => highestSeverity(props.artifact));
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);

  return (
    <div
      class={styles.card}
      role="button"
      tabIndex={0}
      data-testid="analysis-card"
      onClick={() => props.onOpen()}
      onKeyDown={(e) => {
        // Only when the card itself has focus: this used to swallow Space
        // while focus was on the nested delete button, so that button could
        // never be activated with the keyboard.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onOpen();
        }
      }}
      style={{ '--card-accent': severityColor(severity()) } as JSX.CSSProperties}
    >
      <div class={styles.cardHeader}>
        <h4 class={styles.cardTitle}>{props.artifact.title}</h4>
        {/* An analysis is the most expensive artifact in the app; deleting one
            used to be a single unconfirmed click, unlike a bookmark row. */}
        <Show
          when={confirmingDelete()}
          fallback={
            <button
              type="button"
              class={styles.iconButton}
              title="Delete analysis"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingDelete(true);
              }}
            >
              ×
            </button>
          }
        >
          <button
            type="button"
            class={styles.dangerButton}
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingDelete(false);
              props.onDelete();
            }}
          >
            Confirm
          </button>
          <button
            type="button"
            class={styles.iconButton}
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingDelete(false);
            }}
          >
            Cancel
          </button>
        </Show>
      </div>
      <div class={styles.cardMeta}>
        <span>{relativeTime(props.artifact.createdAt)}</span>
        <span class={styles.metaDivider}>·</span>
        <span>
          {props.artifact.sections.length} section{props.artifact.sections.length !== 1 ? 's' : ''}
        </span>
      </div>
      <Show when={props.attribution.resolved.length > 0 || props.attribution.unresolvedCount > 0}>
        <div class={styles.chipRow}>
          <For each={props.attribution.resolved}>
            {(r) => (
              <span class={styles.sourceChip}>
                {r.label}
                <Show when={r.refCount > 1}> ×{r.refCount}</Show>
              </span>
            )}
          </For>
          <Show when={props.attribution.unresolvedCount > 0}>
            <span class={styles.sourceChipWarning}>{props.attribution.unresolvedCount} unresolved</span>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/**
 * The `analyses` shell surface: title bar + search over the list, grouped by
 * session, and — internally, since there is exactly one shell placement for
 * this surface — the reader and editor views the list opens into.
 */
export function AnalysesPanel(props: AnalysesPanelProps): JSX.Element {
  const [mode, setMode] = createSignal<PanelMode>('list');
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal('');
  const [actionError, setActionError] = createSignal<string | null>(null);

  const sorted = createMemo(() =>
    [...props.store.list()].sort((a, b) => b.createdAt - a.createdAt),
  );

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return sorted();
    return sorted().filter((a) => a.title.toLowerCase().includes(q));
  });

  const groups = createMemo(() => groupBySession(filtered(), props.store.labels()));

  const openReader = (id: string): void => {
    props.store.select(id);
    setMode('reading');
  };

  const openNewDraft = (): void => {
    props.store.captureDraftSeed();
    setEditingId(null);
    setMode('editing');
  };

  const openEditSelected = (): void => {
    setEditingId(props.store.selectedId());
    setMode('editing');
  };

  const handleEditorDone = (artifactId: string): void => {
    props.store.select(artifactId);
    setEditingId(null);
    setMode('reading');
  };

  const handleEditorCancel = (): void => {
    setEditingId(null);
    setMode(props.store.selected() ? 'reading' : 'list');
  };

  // An `analysis-update` `deleted` for the artifact the reader is showing
  // clears `selectedId` in the store; without this the panel sat in
  // 'reading' mode showing "Select an analysis from the list." and a Back
  // button.
  createEffect(
    on(
      () => props.store.selected(),
      (selected) => {
        if (!selected && mode() === 'reading') setMode('list');
      },
      { defer: true },
    ),
  );

  const handleDelete = (artifactId: string): void => {
    // `analysesStore.remove` has no internal catch, so this used to be an
    // unhandled rejection with the card still on screen and no message.
    void props.store.remove(artifactId).then(
      () => setActionError(null),
      (e: unknown) => setActionError(String(e)),
    );
  };

  return (
    <div class={styles.panel} data-testid="analyses-panel">
      <Show when={mode() === 'list'}>
        <header class={styles.header}>
          <span class={styles.headerLabel}>Analyses</span>
          <Show when={props.store.list().length > 0}>
            <span class={styles.headerCount}>{props.store.list().length}</span>
          </Show>
          <button type="button" class={styles.newButton} onClick={openNewDraft}>
            New analysis
          </button>
        </header>
        <input
          class={styles.search}
          type="search"
          placeholder="Search by title…"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          aria-label="Search analyses by title"
        />
        <Show when={props.store.error()}>
          {(message) => (
            <div class={styles.errorBanner} role="alert" data-testid="analyses-error">
              <span class={styles.errorBannerText}>Could not load analyses: {message()}</span>
              <button type="button" class={styles.retryButton} onClick={() => props.store.retry()}>
                Retry
              </button>
            </div>
          )}
        </Show>
        <Show when={actionError()}>
          {(message) => (
            <div class={styles.errorBanner} role="alert" data-testid="analyses-action-error">
              <span class={styles.errorBannerText}>{message()}</span>
              <button type="button" class={styles.retryButton} onClick={() => setActionError(null)}>
                Dismiss
              </button>
            </div>
          )}
        </Show>
        <Show when={!props.store.loading() && !props.store.error() && filtered().length === 0}>
          <p class={styles.empty}>
            {props.store.list().length === 0
              ? 'No analyses yet. Claude can publish analyses via MCP, or start one yourself.'
              : 'No analyses match your search.'}
          </p>
        </Show>
        <div class={styles.groups}>
          <For each={groups()}>
            {(group) => (
              <section class={styles.group}>
                <h5 class={styles.groupLabel}>{group.label}</h5>
                <For each={group.entries}>
                  {(entry) => (
                    <AnalysisCard
                      artifact={entry.artifact}
                      attribution={entry.attribution}
                      onOpen={() => openReader(entry.artifact.id)}
                      onDelete={() => handleDelete(entry.artifact.id)}
                    />
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
      </Show>

      <Show when={mode() === 'reading'}>
        <AnalysisReader store={props.store} onBack={() => setMode('list')} onEdit={openEditSelected} />
      </Show>

      <Show when={mode() === 'editing'}>
        <AnalysisEditor
          store={props.store}
          artifactId={editingId()}
          onDone={handleEditorDone}
          onCancel={handleEditorCancel}
        />
      </Show>
    </div>
  );
}
