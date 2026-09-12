/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal } from 'solid-js';
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

interface Group {
  label: string;
  artifacts: AnalysisArtifact[];
}

/** Groups artifacts (already newest-first) by their first resolved session
 *  label, in first-seen order; artifacts with no resolvable session land in
 *  a trailing "Unattributed" group. */
function groupBySession(artifacts: readonly AnalysisArtifact[], labels: ReadonlyMap<string, string>): Group[] {
  const order: string[] = [];
  const byLabel = new Map<string, AnalysisArtifact[]>();
  const UNATTRIBUTED = 'Unattributed';
  for (const artifact of artifacts) {
    const attribution = attributeArtifact(artifact, labels);
    const label = attribution.resolved[0]?.label ?? UNATTRIBUTED;
    if (!byLabel.has(label)) {
      order.push(label);
      byLabel.set(label, []);
    }
    byLabel.get(label)!.push(artifact);
  }
  return order.map((label) => ({ label, artifacts: byLabel.get(label)! }));
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

  return (
    <div
      class={styles.card}
      role="button"
      tabIndex={0}
      data-testid="analysis-card"
      onClick={() => props.onOpen()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onOpen();
        }
      }}
      style={{ '--card-accent': severityColor(severity()) } as JSX.CSSProperties}
    >
      <div class={styles.cardHeader}>
        <h4 class={styles.cardTitle}>{props.artifact.title}</h4>
        <button
          type="button"
          class={styles.iconButton}
          title="Delete analysis"
          onClick={(e) => {
            e.stopPropagation();
            props.onDelete();
          }}
        >
          ×
        </button>
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
        <Show when={!props.store.loading() && filtered().length === 0}>
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
                <For each={group.artifacts}>
                  {(artifact) => (
                    <AnalysisCard
                      artifact={artifact}
                      attribution={attributeArtifact(artifact, props.store.labels())}
                      onOpen={() => openReader(artifact.id)}
                      onDelete={() => void props.store.remove(artifact.id)}
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
