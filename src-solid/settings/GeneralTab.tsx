/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, onMount } from 'solid-js';
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog';
import { BASE_THEMES } from '../theme';
import type { Density, ThemeController, ThemeMode } from '../theme';
import type { SettingsStore } from './settingsStore';
import type { UpdateStore } from './updateStore';
import { McpAgentSetup } from './McpAgentSetup';
import styles from './settings.module.css';
const THEME_MODES: readonly ThemeMode[] = ['system', ...BASE_THEMES];
const DENSITIES: readonly Density[] = ['comfortable', 'compact'];
export interface GeneralTabProps {
  store: SettingsStore;
  /** Optional so a host without a live theme controller (tests) still mounts. */
  theme?: ThemeController;
  /** App-update state; the Updates section is omitted when absent (tests, browser preview). */
  updates?: UpdateStore;
}
/** Mirrors `useMcpStatus`'s `deriveConnState`, inlined against `props.store.mcpStatus` (A2's own poll). */
function bridgeLabel(running: boolean, idleSecs: number | null, enabled: boolean): string {
  if (!running) return enabled ? 'starting…' : 'disabled';
  if (idleSecs === null) return 'ready';
  return idleSecs <= 30 ? 'connected' : 'ready';
}
/**
 * Every store mutation already records its rejection in `store.error()`, which
 * `SettingsPanel` renders as a dismissible alert above the tabs. This only stops
 * the rejection surfacing a second time as an unhandled promise — it is not a
 * swallow: dropping it here would make the failure invisible again (D1-H3).
 */
function reported(p: Promise<unknown>): void {
  void p.catch(() => undefined);
}
/** One line under the version: what the updater last did. Errors get their own alert below. */
function updateStatusLine(updates: UpdateStore): string {
  const v = updates.available()?.version;
  switch (updates.status()) {
    case 'idle': return 'Checks for updates shortly after launch.';
    case 'checking': return 'Checking…';
    case 'up-to-date': return 'Up to date.';
    case 'available': return `Version ${v} is available.`;
    case 'downloading': {
      const p = updates.progress();
      if (p === null) return 'Downloading…';
      if (p.total !== null && p.total > 0) return `Downloading… ${Math.min(100, Math.round((p.received / p.total) * 100))}%`;
      return `Downloading… ${(p.received / 1_048_576).toFixed(1)} MB`;
    }
    case 'restarting': return 'Restarting to finish the update…';
    case 'error': return v ? `Version ${v} is available.` : 'Could not check for updates.';
  }
}
export function GeneralTab(props: GeneralTabProps) {
  onMount(() => {
    props.store.refreshAllowlist();
    props.store.refreshFileAssociations();
  });
  const status = createMemo(() => props.store.mcpStatus());
  const running = createMemo(() => status()?.running ?? false);
  /** No `McpStatus` yet: the backend's answer is unknown, so the security toggle
   *  below must not claim one (M6). */
  const statusUnknown = createMemo(() => status() === null);
  /** Under anonymizer mode `None` agents already read raw text, so the
   *  raw-access checkbox has nothing left to grant: shown, disabled, explained. */
  const anonymizerOff = createMemo(() => props.store.anonymizerMode() === 'none');
  const addDir = async (): Promise<void> => {
    const result = await openDirectoryDialog({ directory: true, multiple: false }).catch(() => null);
    if (typeof result === 'string') reported(props.store.addAllowDir(result));
  };
  return (
    <div class={styles.panel} data-testid="general-tab">
      <Show when={props.theme}>
        {(theme) => (
          <div class={styles.section}>
            <div class={styles.sectionTitle}>Appearance</div>
            <div class={styles.row}><span>Theme</span>
              <select class={styles.select} value={theme().mode()} onChange={(e) => theme().setMode(e.currentTarget.value as ThemeMode)}>
                <For each={THEME_MODES}>{(m) => <option value={m}>{m}</option>}</For>
              </select>
            </div>
            <div class={styles.row}><span>Density</span>
              <select class={styles.select} value={theme().density()} onChange={(e) => theme().setDensity(e.currentTarget.value as Density)}>
                <For each={DENSITIES}>{(d) => <option value={d}>{d}</option>}</For>
              </select>
            </div>
          </div>
        )}
      </Show>
      <div class={styles.section}>
        <div class={styles.sectionTitle}>MCP Integration</div>
        <McpAgentSetup store={props.store} />
        <div class={styles.row}>
          <div class={styles.label}>
            <span>HTTP Bridge</span>
            <span class={styles.labelHint}>Runs a local server on port 40404 for AI agent integration.</span>
          </div>
          <input type="checkbox" checked={running()} disabled={props.store.mcpBridgePending()} onChange={(e) => reported(props.store.setMcpBridgeEnabled(e.currentTarget.checked))} />
        </div>
        <div class={styles.statusRow}>
          <span class={styles.statusDot} style={{ '--status-color': running() ? 'var(--success)' : 'var(--text-dimmed)' }} />
          <span>Bridge: {bridgeLabel(running(), status()?.idleSecs ?? null, props.store.mcpBridgeEnabled())}</span>
        </div>
        <div class={styles.row}>
          <div class={styles.label}>
            <span>Allow agents to read raw (un-anonymized) log text</span>
            <Show
              when={!anonymizerOff()}
              fallback={
                <span class={styles.warningText} data-testid="agent-raw-access-off-hint">
                  The anonymizer is off — agents already read raw text.
                </span>
              }
            >
              <span class={styles.labelHint}>Off by default: agents read PII replaced by stable tokens such as {'<EMAIL-1>'}.</span>
            </Show>
          </div>
          <input
            type="checkbox"
            data-testid="agent-raw-access"
            ref={(el) => {
              // `indeterminate` is a DOM property with no attribute; an effect is
              // the only way to keep it bound to the "status not known yet" state.
              createEffect(() => { el.indeterminate = statusUnknown(); });
            }}
            checked={status()?.agentRawAccess ?? false}
            disabled={statusUnknown() || anonymizerOff() || props.store.agentRawAccessPending()}
            aria-busy={statusUnknown() || props.store.agentRawAccessPending()}
            title={
              statusUnknown()
                ? 'Waiting for the backend to report the current setting…'
                : anonymizerOff()
                  ? 'The anonymizer is off — agents already read raw text'
                  : undefined
            }
            onChange={(e) => reported(props.store.setAgentRawAccess(e.currentTarget.checked))}
          />
        </div>
      </div>
      <div class={styles.section}>
        <div class={styles.sectionTitle}>MCP File Access</div>
        <span class={styles.labelHint}>Directories an agent may open files from via logtapper_open_file.</span>
        <Show when={props.store.allowlist()}>
          {(allowlist) => (
            <>
              <div class={styles.row}>
                <span>Allow any path</span>
                <input type="checkbox" checked={allowlist().allowAll} onChange={(e) => reported(props.store.setAllowAll(e.currentTarget.checked))} />
              </div>
              <div class={styles.list}>
                <For each={allowlist().allowedDirs}>
                  {(dir) => (
                    <div class={styles.listRow}>
                      <span class={styles.listRowPath} title={dir}>{dir}</span>
                      <button type="button" class={styles.iconBtn} title="Remove directory" onClick={() => reported(props.store.removeAllowDir(dir))}>×</button>
                    </div>
                  )}
                </For>
              </div>
              <button type="button" class={styles.linkBtn} onClick={() => void addDir()}>+ Add directory</button>
            </>
          )}
        </Show>
      </div>
      <Show when={props.store.fileAssociations().length > 0}>
        <div class={styles.section}>
          <div class={styles.sectionTitle}>File Associations</div>
          <For each={props.store.fileAssociations()}>
            {(entry) => (
              <div class={styles.row}>
                <span>{entry.label} (.{entry.ext}){entry.isDefault ? ' — default' : ''}</span>
                <input type="checkbox" checked={entry.registered} onChange={(e) => reported(props.store.setFileAssociation(entry.ext, e.currentTarget.checked))} />
              </div>
            )}
          </For>
          <button type="button" class={styles.button} onClick={() => props.store.openDefaultAppsSettings()}>Windows Default Apps</button>
        </div>
      </Show>
      <Show when={props.updates}>
        {(updates) => {
          const busy = () => updates().status() === 'checking' || updates().status() === 'downloading' || updates().status() === 'restarting';
          const installing = () => updates().status() === 'downloading' || updates().status() === 'restarting';
          return (
            <div class={styles.section} data-testid="updates-section">
              <div class={styles.sectionTitle}>Updates</div>
              <Show
                when={updates().managedBy()}
                fallback={
                  <>
                    <div class={styles.row}>
                      <div class={styles.label}>
                        <span data-testid="app-version">LogTapper {updates().currentVersion() ?? ''}</span>
                        <span class={styles.labelHint} data-testid="update-status">{updateStatusLine(updates())}</span>
                      </div>
                      <button type="button" class={styles.button} disabled={busy()} onClick={() => reported(updates().check())}>
                        Check for updates
                      </button>
                    </div>
                    <Show when={updates().available()}>
                      {(info) => (
                        <>
                          <div class={styles.row}>
                            <div class={styles.label}>
                              <span>Install version {info().version}</span>
                              <span class={styles.labelHint}>Downloads and verifies the update, then restarts LogTapper.</span>
                            </div>
                            <button type="button" class={styles.primaryButton} disabled={installing()} data-testid="install-update" onClick={() => reported(updates().install())}>
                              Install and restart
                            </button>
                          </div>
                          <Show when={updates().progress()}>
                            {(p) => (
                              // Two elements, not one with `value={… ? n : undefined}`:
                              // `HTMLProgressElement.value = undefined` throws in
                              // Chromium ("non-finite double"), Solid runs this render
                              // effect synchronously inside the store's `setProgress`,
                              // and the exception escaped `install()` before it set
                              // `downloading` — the first Install click did nothing
                              // (found live on 2026-09-21; jsdom does not enforce it).
                              <Show
                                when={p().total !== null && p().total! > 0}
                                fallback={<progress class={styles.progress} data-testid="update-progress" />}
                              >
                                <progress class={styles.progress} data-testid="update-progress" value={p().received} max={p().total!} />
                              </Show>
                            )}
                          </Show>
                          <Show when={info().notes}>
                            {(notes) => <pre class={styles.releaseNotes} data-testid="release-notes">{notes()}</pre>}
                          </Show>
                        </>
                      )}
                    </Show>
                    <Show when={updates().error()}>
                      {(message) => <div class={styles.error} role="alert" data-testid="update-error">{message()}</div>}
                    </Show>
                  </>
                }
              >
                {(manager) => (
                  <div class={styles.row} data-testid="updates-managed">
                    <div class={styles.label}>
                      <span data-testid="app-version">LogTapper {updates().currentVersion() ?? ''}</span>
                      <span class={styles.labelHint}>
                        Updates are managed by {manager() === 'scoop' ? 'Scoop' : manager()} — run `{manager()} update logtapper`
                      </span>
                    </div>
                  </div>
                )}
              </Show>
            </div>
          );
        }}
      </Show>
    </div>
  );
}
