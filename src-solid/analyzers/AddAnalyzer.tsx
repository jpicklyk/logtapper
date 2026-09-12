/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import type { ProcessorSummary } from '@bridge/types';
import { PII_ANONYMIZER_ID } from './analyzerStore';
import type { AnalyzerStore } from './analyzerStore';
import styles from './analyzers.module.css';

const OTHER_GROUP = 'Other';

export interface AddAnalyzerProps {
  store: AnalyzerStore;
  sessionId: string;
  onClose: () => void;
}

/** Catalog minus this session's active chain, grouped by `group`, with search,
 *  per-row add, "Load YAML from file…", and a confirm-gated uninstall for
 *  every row shown here (all of them are non-active by construction). */
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
