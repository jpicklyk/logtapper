/** @jsxImportSource solid-js */
import { For, Show, createMemo, createSignal } from 'solid-js';
import type { JSX } from 'solid-js';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { WorkspaceIdentity } from '@bridge/workspaceTypes';
// `'../app'` also matches `App.tsx` on a case-insensitive filesystem and TS
// refuses the program (TS1149) — always import the barrel via `/index`.
import type { AppActions, SessionStore } from '../app/index';
import type { WorkspaceStore } from './workspaceStore';
import styles from './workspaceHome.module.css';

const LTW_OPEN_FILTERS = [{ name: 'LogTapper Workspace', extensions: ['ltw'] }];

type ViewMode = 'grid' | 'list';

/** No slot for a view preference in W1a's `SolidLayout` (columns/collapsed/
 *  tabs/activeTab only), so this is a plain per-viewer localStorage flag —
 *  same as any other UI-only preference, per the task's documented fallback. */
const VIEW_PREF_KEY = 'logtapper.solid.workspaceHomeView';

function readViewPref(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_PREF_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function writeViewPref(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_PREF_KEY, mode);
  } catch {
    /* private mode / quota — the preference is best-effort. */
  }
}

function formatSaved(ws: WorkspaceIdentity): string {
  if (ws.lastAutoSaveAt) return new Date(ws.lastAutoSaveAt).toLocaleString();
  return ws.filePath ? 'Saved' : 'Not saved yet';
}

export interface WorkspaceHomeProps {
  store: WorkspaceStore;
  sessions: SessionStore;
  actions: AppActions;
}

/**
 * The `workspace-home` shell surface: header actions, the recent-workspaces
 * grid/list, and the active workspace's sessions. Matches the structure of
 * `design_docs/canvas/WorkspaceHome.dc.html`, not its pixels — the packs /
 * recent-analyses / presence sections of that board belong to other surfaces
 * already mounted elsewhere in the shell.
 */
export function WorkspaceHome(props: WorkspaceHomeProps): JSX.Element {
  const [view, setView] = createSignal<ViewMode>(readViewPref());
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal('');
  const [confirmingDeleteId, setConfirmingDeleteId] = createSignal<string | null>(null);
  const [deleteFile, setDeleteFile] = createSignal(false);
  const [actionError, setActionError] = createSignal('');

  const setViewMode = (mode: ViewMode): void => {
    setView(mode);
    writeViewPref(mode);
  };

  const handleOpenWorkspace = async (): Promise<void> => {
    const selected = await openDialog({ multiple: false, filters: LTW_OPEN_FILTERS });
    if (typeof selected !== 'string') return;
    try {
      await props.store.openWorkspace(selected);
    } catch (e) {
      setActionError(String(e));
    }
  };

  const handleNewWorkspace = (): void => {
    setActionError('');
    void props.store.newWorkspace().catch((e: unknown) => setActionError(String(e)));
  };

  const handleSwitch = (id: string): void => {
    if (id === props.store.activeId()) return;
    setActionError('');
    void props.store.switchWorkspace(id).catch((e: unknown) => setActionError(String(e)));
  };

  const startRename = (ws: WorkspaceIdentity, e: MouseEvent): void => {
    e.stopPropagation();
    setConfirmingDeleteId(null);
    setRenamingId(ws.id);
    setRenameValue(ws.name);
  };

  const commitRename = (id: string): void => {
    const value = renameValue().trim();
    setRenamingId(null);
    if (!value) return;
    setActionError('');
    void props.store.rename(id, value).catch((e: unknown) => setActionError(String(e)));
  };

  const startDelete = (id: string, e: MouseEvent): void => {
    e.stopPropagation();
    setRenamingId(null);
    setDeleteFile(false);
    setConfirmingDeleteId(id);
  };

  const confirmDelete = (id: string): void => {
    const isActive = id === props.store.activeId();
    setConfirmingDeleteId(null);
    setActionError('');
    void props.store
      .delete(id, { deleteFile: deleteFile(), force: isActive })
      .catch((e: unknown) => setActionError(String(e)));
  };

  const focusedSessionId = createMemo(() => props.sessions.focusedId());
  const sessionCount = createMemo(() => props.sessions.order().length);

  return (
    <div class={styles.home} data-testid="workspace-home">
      <header class={styles.header}>
        <div class={styles.headerTitle}>
          <span class={styles.activeName} data-testid="active-workspace-name">
            {props.store.active()?.name ?? 'No workspace'}
          </span>
          <Show when={props.store.dirty()}>
            <span class={styles.dirtyDot} title="Unsaved changes" />
          </Show>
        </div>
        <div class={styles.headerActions}>
          <button type="button" class={styles.actionButton} onClick={() => void props.actions.openFileDialog()}>
            Open file…
          </button>
          <button type="button" class={styles.actionButton} onClick={() => void handleOpenWorkspace()}>
            Open workspace…
          </button>
          <button type="button" class={styles.actionButton} onClick={handleNewWorkspace}>
            New workspace
          </button>
          <div class={styles.viewToggle} role="group" aria-label="Layout">
            <button
              type="button"
              class={styles.viewButton}
              classList={{ [styles.viewButtonActive]: view() === 'grid' }}
              aria-pressed={view() === 'grid'}
              onClick={() => setViewMode('grid')}
            >
              Grid
            </button>
            <button
              type="button"
              class={styles.viewButton}
              classList={{ [styles.viewButtonActive]: view() === 'list' }}
              aria-pressed={view() === 'list'}
              onClick={() => setViewMode('list')}
            >
              List
            </button>
          </div>
        </div>
      </header>

      <Show when={actionError()}>
        <div class={styles.error} role="alert">
          {actionError()}
        </div>
      </Show>

      <section class={styles.section}>
        <h3 class={styles.sectionLabel}>Recent workspaces</h3>
        <Show when={props.store.list().length > 0} fallback={<div class={styles.empty}>No workspaces yet.</div>}>
          <div
            class={view() === 'grid' ? styles.grid : styles.list}
            data-testid={`workspace-${view()}`}
          >
            <For each={props.store.list()}>
              {(ws) => (
                <div
                  class={styles.card}
                  classList={{ [styles.cardActive]: ws.id === props.store.activeId() }}
                  data-testid="workspace-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSwitch(ws.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') handleSwitch(ws.id);
                  }}
                >
                  <div class={styles.cardHeader}>
                    <Show
                      when={renamingId() === ws.id}
                      fallback={
                        <span class={styles.cardName} onDblClick={(e) => startRename(ws, e)}>
                          {ws.name}
                        </span>
                      }
                    >
                      <input
                        class={styles.renameInput}
                        value={renameValue()}
                        autofocus
                        aria-label={`Rename ${ws.name}`}
                        onClick={(e) => e.stopPropagation()}
                        onInput={(e) => setRenameValue(e.currentTarget.value)}
                        onBlur={() => commitRename(ws.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(ws.id);
                          else if (e.key === 'Escape') setRenamingId(null);
                        }}
                      />
                    </Show>
                    <Show when={ws.id === props.store.activeId()}>
                      <span class={styles.activeBadge}>Active</span>
                    </Show>
                  </div>
                  <div class={styles.cardPath}>{ws.filePath ?? ws.autoSavePath ?? 'Unsaved'}</div>
                  <div class={styles.cardMeta}>
                    <span>{formatSaved(ws)}</span>
                    <Show when={ws.id === props.store.activeId()}>
                      <span>
                        {sessionCount()} session{sessionCount() === 1 ? '' : 's'}
                      </span>
                    </Show>
                  </div>
                  <div class={styles.cardActions}>
                    <button
                      type="button"
                      class={styles.iconButton}
                      title="Rename workspace"
                      onClick={(e) => startRename(ws, e)}
                    >
                      Rename
                    </button>
                    <Show
                      when={confirmingDeleteId() === ws.id}
                      fallback={
                        <button
                          type="button"
                          class={styles.iconButton}
                          title="Delete workspace"
                          onClick={(e) => startDelete(ws.id, e)}
                        >
                          Delete
                        </button>
                      }
                    >
                      <label class={styles.deleteFileLabel} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={deleteFile()}
                          onChange={(e) => setDeleteFile(e.currentTarget.checked)}
                        />
                        Also delete .ltw
                      </label>
                      <button
                        type="button"
                        class={styles.dangerButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          confirmDelete(ws.id);
                        }}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        class={styles.iconButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmingDeleteId(null);
                        }}
                      >
                        Cancel
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>

      <section class={styles.section}>
        <h3 class={styles.sectionLabel}>Sessions in this workspace</h3>
        <Show
          when={sessionCount() > 0}
          fallback={
            <div class={styles.empty}>
              No sessions in this workspace.{' '}
              <button
                type="button"
                class={styles.inlineLink}
                data-testid="sessions-empty-open-file"
                onClick={() => void props.actions.openFileDialog()}
              >
                Open file…
              </button>
            </div>
          }
        >
          <div class={styles.sessionList}>
            <For each={props.sessions.order()}>
              {(id) => {
                const entry = createMemo(() => props.sessions.byId(id));
                return (
                  <Show when={entry()}>
                    {(e) => (
                      <div
                        class={styles.sessionRow}
                        classList={{ [styles.sessionRowFocused]: id === focusedSessionId() }}
                        data-testid="session-row"
                      >
                        <span class={styles.sessionName}>{e().load.sourceName}</span>
                        <span class={styles.sessionKind}>{e().kind}</span>
                        <span class={styles.sessionLines}>{e().totalLines.toLocaleString()} lines</span>
                        <Show when={id === focusedSessionId()}>
                          <span class={styles.focusedMarker}>Focused</span>
                        </Show>
                        <div class={styles.sessionActions}>
                          <button type="button" class={styles.iconButton} onClick={() => props.actions.focus(id)}>
                            Focus
                          </button>
                          <button
                            type="button"
                            class={styles.iconButton}
                            onClick={() => void props.actions.close(id).catch(() => undefined)}
                          >
                            Close
                          </button>
                        </div>
                      </div>
                    )}
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
      </section>
    </div>
  );
}
