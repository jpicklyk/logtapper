/** @jsxImportSource solid-js */
import { For, Show, createMemo, onMount } from 'solid-js';
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog';
import { BASE_THEMES } from '../theme/applyTheme';
import type { Density, ThemeController, ThemeMode } from '../theme/applyTheme';
import type { SettingsStore } from './settingsStore';
import styles from './settings.module.css';
const THEME_MODES: readonly ThemeMode[] = ['system', ...BASE_THEMES];
const DENSITIES: readonly Density[] = ['comfortable', 'compact'];
export interface GeneralTabProps {
  store: SettingsStore;
  /** Optional so a host without a live theme controller (tests) still mounts. */
  theme?: ThemeController;
}
/** Mirrors `useMcpStatus`'s `deriveConnState`, inlined against `props.store.mcpStatus` (A2's own poll). */
function bridgeLabel(running: boolean, idleSecs: number | null, enabled: boolean): string {
  if (!running) return enabled ? 'starting…' : 'disabled';
  if (idleSecs === null) return 'ready';
  return idleSecs <= 30 ? 'connected' : 'ready';
}
export function GeneralTab(props: GeneralTabProps) {
  onMount(() => {
    props.store.refreshAllowlist();
    props.store.refreshFileAssociations();
  });
  const status = createMemo(() => props.store.mcpStatus());
  const running = createMemo(() => status()?.running ?? false);
  const addDir = async (): Promise<void> => {
    const result = await openDirectoryDialog({ directory: true, multiple: false }).catch(() => null);
    if (typeof result === 'string') await props.store.addAllowDir(result).catch(() => undefined);
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
        <div class={styles.row}>
          <div class={styles.label}>
            <span>HTTP Bridge</span>
            <span class={styles.labelHint}>Runs a local server on port 40404 for AI agent integration.</span>
          </div>
          <input type="checkbox" checked={running()} disabled={props.store.mcpBridgePending()} onChange={(e) => void props.store.setMcpBridgeEnabled(e.currentTarget.checked).catch(() => undefined)} />
        </div>
        <div class={styles.statusRow}>
          <span class={styles.statusDot} style={{ '--status-color': running() ? 'var(--success)' : 'var(--text-dimmed)' }} />
          <span>Bridge: {bridgeLabel(running(), status()?.idleSecs ?? null, running())}</span>
        </div>
        <div class={styles.row}>
          <div class={styles.label}>
            <span>Allow agents to read raw (un-anonymized) log text</span>
            <span class={styles.labelHint}>Off by default: agents read PII replaced by stable tokens such as {'<EMAIL-1>'}.</span>
          </div>
          <input type="checkbox" checked={status()?.agentRawAccess ?? false} disabled={props.store.agentRawAccessPending()} onChange={(e) => void props.store.setAgentRawAccess(e.currentTarget.checked).catch(() => undefined)} />
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
                <input type="checkbox" checked={allowlist().allowAll} onChange={(e) => void props.store.setAllowAll(e.currentTarget.checked).catch(() => undefined)} />
              </div>
              <div class={styles.list}>
                <For each={allowlist().allowedDirs}>
                  {(dir) => (
                    <div class={styles.listRow}>
                      <span class={styles.listRowPath} title={dir}>{dir}</span>
                      <button type="button" class={styles.iconBtn} title="Remove directory" onClick={() => void props.store.removeAllowDir(dir)}>×</button>
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
                <input type="checkbox" checked={entry.registered} onChange={(e) => void props.store.setFileAssociation(entry.ext, e.currentTarget.checked)} />
              </div>
            )}
          </For>
          <button type="button" class={styles.button} onClick={() => props.store.openDefaultAppsSettings()}>Windows Default Apps</button>
        </div>
      </Show>
    </div>
  );
}
