/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Caller, ProcessorSummary } from '@bridge/types';
import { CallerBadge, callerClient } from '../ui';
import { PII_ANONYMIZER_ID } from './analyzerStore';
import type { AnalyzerStore } from './analyzerStore';
import styles from './analyzers.module.css';

const OTHER_GROUP = 'Other';

/** Where a catalog row came from: its marketplace source, a pasted/uploaded
 *  file, or the app itself. Built-ins have no provenance to speak of. */
export function provenanceLabel(p: ProcessorSummary): string {
  if (p.builtin) return 'built-in';
  return p.source ? `via ${p.source}` : 'local YAML';
}

/** `ProcessorSummary.installedBy` is the backend's `_installed_by` provenance
 *  string — `"ui"` or `"agent:<client>"` — folded back into the `Caller` shape
 *  `CallerBadge` already understands. Absent (a processor installed before the
 *  field existed, or a built-in) is `null`, not a guess. */
export function installedByCaller(installedBy: string | undefined): Caller | null {
  if (!installedBy) return null;
  if (installedBy === 'ui') return { kind: 'ui' };
  const AGENT_PREFIX = 'agent:';
  if (installedBy.startsWith(AGENT_PREFIX)) return { kind: 'agent', client: installedBy.slice(AGENT_PREFIX.length) };
  return null;
}

/** The agent that installed this row, or `null` when a human did (or nobody
 *  recorded it) — the only case the picker badges. */
function agentInstaller(p: ProcessorSummary): Caller | null {
  const caller = installedByCaller(p.installedBy);
  return caller?.kind === 'agent' ? caller : null;
}

export interface AddAnalyzerProps {
  store: AnalyzerStore;
  sessionId: string;
  onClose: () => void;
}

/** Catalog minus this session's active chain, grouped by `group`, with search,
 *  per-row add, "Load YAML from file…", and a confirm-gated uninstall for
 *  every row shown here (all of them are non-active by construction).
 *
 *  This is the per-session view of the "library" brief §3 demotes under the
 *  Advanced disclosure — it browses and manages whatever is *already
 *  installed*. Browsing and adding curated packs or individual analyzers
 *  *from a marketplace source* lives in the Packs tab (`packs/PacksPanel.tsx`,
 *  under Settings), not here; the hint text below is this file's pointer to
 *  that surface. `store.catalog()` already reflects anything installed from
 *  there without any wiring in this file — `App.tsx` refreshes it via
 *  `analyzerStore.refreshCatalog()` after every Packs-tab mutation. */
export function AddAnalyzer(props: AddAnalyzerProps): JSX.Element {
  const [query, setQuery] = createSignal('');
  const [pendingUninstall, setPendingUninstall] = createSignal<string | null>(null);

  const activeIds = createMemo(() => new Set(props.store.chain(props.sessionId).order));

  const available = createMemo<ProcessorSummary[]>(() => {
    const q = query().trim().toLowerCase();
    return props.store.catalog().filter((p) => {
      if (p.id === PII_ANONYMIZER_ID || activeIds().has(p.id)) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q)
      );
    });
  });

  const grouped = createMemo<Array<[string, ProcessorSummary[]]>>(() => {
    const map = new Map<string, ProcessorSummary[]>();
    for (const p of available()) {
      const key = p.group ?? OTHER_GROUP;
      const bucket = map.get(key);
      if (bucket) bucket.push(p);
      else map.set(key, [p]);
    }
    return [...map.entries()].sort(([a], [b]) => {
      if (a === OTHER_GROUP) return 1;
      if (b === OTHER_GROUP) return -1;
      return a.localeCompare(b);
    });
  });

  const handleAdd = (id: string): void => {
    props.store.add(props.sessionId, id);
  };

  const handleUninstallClick = (id: string): void => {
    setPendingUninstall((cur) => (cur === id ? cur : id));
  };

  const handleConfirmUninstall = (id: string): void => {
    setPendingUninstall(null);
    void props.store.uninstall(id);
  };

  const handleLoadFromFile = (): void => {
    void props.store.installFromFile();
  };

  return (
    <div class={styles.overlay} data-testid="add-analyzer">
      <div class={styles.overlayHeader}>
        <span class={styles.overlayTitle}>Add analyzer</span>
        <button type="button" class={styles.btn} onClick={handleLoadFromFile}>
          Load YAML from file…
        </button>
        <button type="button" class={styles.btn} onClick={() => props.onClose()}>
          Close
        </button>
      </div>
      <div class={styles.overlayBody}>
        <div class={styles.hint}>
          Looking for more? Curated packs by subsystem are under Settings → Packs.
        </div>
        <input
          type="text"
          class={styles.search}
          placeholder="Search analyzers…"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          aria-label="Search analyzers"
        />

        <Show when={available().length === 0}>
          <div class={styles.hint}>
            {props.store.catalog().length === 0 ? 'No processors installed.' : 'No analyzers match.'}
          </div>
        </Show>

        <For each={grouped()}>
          {([group, processors]) => (
            <div class={styles.section}>
              <div class={styles.groupLabel}>{group}</div>
              <For each={processors}>
                {(p) => (
                  <div class={styles.catalogRow} data-testid={`catalog-row-${p.id}`}>
                    <div class={styles.catalogInfo}>
                      <div class={styles.catalogName}>{p.name}</div>
                      <Show when={p.description}>
                        <div class={styles.catalogDesc}>{p.description}</div>
                      </Show>
                      <div class={styles.catalogMeta}>
                        <span>{provenanceLabel(p)}</span>
                        <Show when={agentInstaller(p)} keyed>
                          {(caller) => (
                            <CallerBadge caller={caller} label="Installed" title={`Installed by ${callerClient(caller)}`} />
                          )}
                        </Show>
                      </div>
                    </div>
                    <button type="button" class={`${styles.btn} ${styles.btnPrimary}`} onClick={() => handleAdd(p.id)}>
                      Add
                    </button>
                    <Show when={!p.builtin}>
                      <Show
                        when={pendingUninstall() === p.id}
                        fallback={
                          <button type="button" class={styles.iconBtn} title="Uninstall" onClick={() => handleUninstallClick(p.id)}>
                            Uninstall
                          </button>
                        }
                      >
                        <button
                          type="button"
                          class={`${styles.btn} ${styles.btnDanger}`}
                          onClick={() => handleConfirmUninstall(p.id)}
                        >
                          Confirm
                        </button>
                        <button type="button" class={styles.iconBtn} onClick={() => setPendingUninstall(null)}>
                          Cancel
                        </button>
                      </Show>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
