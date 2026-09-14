/** @jsxImportSource solid-js */
import { For, Show, createEffect, createMemo, createSignal, on, onMount } from 'solid-js';
import { save } from '@tauri-apps/plugin-dialog';
import type { LiveStreamStore } from './streamStore';
import styles from './StreamControlsPanel.module.css';

export interface StreamControlsPanelProps {
  store: LiveStreamStore;
}

function defaultCaptureName(sourceName: string): string {
  const stem = sourceName.replace(/[^\w.-]+/g, '_') || 'capture';
  return stem.endsWith('.log') ? stem : `${stem}.log`;
}

/**
 * The `stream-controls` shell surface (L1, `shell/surfaces.ts`): device
 * picker, package/tag filter, start/stop, and save-capture. React's
 * equivalent is split across `components/Header/Header.tsx` (device picker)
 * and `components/StreamFilterBar/StreamFilterBar.tsx` (filter); this is one
 * panel because Solid's shell places `stream-controls` as its own navigator
 * surface rather than living in a persistent header bar.
 *
 * Reads and drives exactly one `LiveStreamStore` — no processor/tracker
 * selection UI lives here. `updateProcessors`/`updateTrackers`/
 * `updateTransformers` are exposed on the store for whichever surface owns
 * the live chain to call (none does yet; see implementation-notes on task
 * `fe34022c`), the same scoping choice `createStreamSession`'s filter-AST
 * hooks made for `FilterScan`.
 */
export function StreamControlsPanel(props: StreamControlsPanelProps) {
  onMount(() => void props.store.refreshDevices());

  const [deviceId, setDeviceId] = createSignal<string | undefined>(undefined);
  const [packageFilter, setPackageFilter] = createSignal('');
  const [anonymize, setAnonymizeChecked] = createSignal(false);
  const [startError, setStartError] = createSignal<string | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  // Default to the first device once the list arrives, without ever
  // overriding a choice the user already made.
  createEffect(
    on(
      () => props.store.devices(),
      (found) => {
        if (deviceId() === undefined && found.length > 0) setDeviceId(found[0].serial);
      },
    ),
  );

  const status = () => props.store.status();
  const streaming = createMemo(() => status().phase === 'streaming');
  const starting = createMemo(() => status().phase === 'starting');
  /** The session Save-capture targets: the running stream, or the one that just stopped. */
  const targetSessionId = createMemo(() => {
    const s = status();
    return s.phase === 'streaming' || s.phase === 'stopped' ? s.sessionId : null;
  });

  const start = async (): Promise<void> => {
    setStartError(null);
    await props.store.start(deviceId(), { packageFilter: packageFilter().trim() || undefined });
    const s = status();
    if (s.phase === 'error') setStartError(s.message);
  };

  const toggleAnonymize = async (checked: boolean): Promise<void> => {
    setAnonymizeChecked(checked);
    const sessionId = targetSessionId();
    if (!sessionId) return;
    try {
      await props.store.setAnonymize(sessionId, checked);
    } catch (e) {
      setStartError(String(e));
    }
  };

  const saveCapture = async (): Promise<void> => {
    const sessionId = targetSessionId();
    if (!sessionId) return;
    const s = status();
    const sourceName = s.phase === 'streaming' ? s.sourceName : sessionId;
    setSaveError(null);
    const picked = await save({
      defaultPath: defaultCaptureName(sourceName),
      filters: [{ name: 'Log File', extensions: ['log', 'txt'] }],
    });
    if (typeof picked !== 'string') return;
    setSaving(true);
    try {
      await props.store.saveCapture(sessionId, picked);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class={styles.panel} data-testid="stream-controls">
      <section class={styles.section}>
        <div class={styles.sectionHeader}>
          <span>Device</span>
          <button
            type="button"
            class={styles.linkButton}
            onClick={() => void props.store.refreshDevices()}
            disabled={props.store.devicesLoading()}
          >
            {props.store.devicesLoading() ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <Show when={props.store.devicesError()}>
          <p class={styles.error} role="alert">{props.store.devicesError()}</p>
        </Show>
        <Show
          when={props.store.devices().length > 0}
          fallback={<p class={styles.hint}>No devices found. Connect a device and refresh.</p>}
        >
          <ul class={styles.deviceList}>
            <For each={props.store.devices()}>
              {(d) => (
                <li>
                  <label class={styles.deviceRow}>
                    <input
                      type="radio"
                      name="stream-device"
                      checked={deviceId() === d.serial}
                      onChange={() => setDeviceId(d.serial)}
                      disabled={streaming() || starting()}
                    />
                    <span class={styles.deviceSerial}>{d.serial}</span>
                    <span class={styles.deviceModel}>{d.model}</span>
                    <span class={styles.deviceState} data-state={d.state}>{d.state}</span>
                  </label>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class={styles.section}>
        <label class={styles.fieldLabel} for="stream-package-filter">Package / tag filter</label>
        <input
          id="stream-package-filter"
          class={styles.textInput}
          type="text"
          placeholder="e.g. com.example.app"
          value={packageFilter()}
          onInput={(e) => setPackageFilter(e.currentTarget.value)}
          disabled={streaming() || starting()}
        />
      </section>

      <section class={styles.section}>
        <label class={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={anonymize()}
            onChange={(e) => void toggleAnonymize(e.currentTarget.checked)}
          />
          Anonymize PII while streaming
        </label>
      </section>

      <Show when={startError()}>
        <p class={styles.error} role="alert">{startError()}</p>
      </Show>

      <div class={styles.actions}>
        <Show
          when={!streaming()}
          fallback={
            <button type="button" class={styles.dangerButton} onClick={() => void props.store.stop()}>
              Stop
            </button>
          }
        >
          <button
            type="button"
            class={styles.primaryButton}
            onClick={() => void start()}
            disabled={starting() || !deviceId()}
          >
            {starting() ? 'Starting…' : 'Start capture'}
          </button>
        </Show>
        <button
          type="button"
          class={styles.secondaryButton}
          onClick={() => void saveCapture()}
          disabled={!targetSessionId() || saving()}
        >
          {saving() ? 'Saving…' : 'Save capture…'}
        </button>
      </div>
      <Show when={saveError()}>
        <p class={styles.error} role="alert">{saveError()}</p>
      </Show>
    </div>
  );
}
