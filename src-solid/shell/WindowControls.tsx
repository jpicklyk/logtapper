/** @jsxImportSource solid-js */
import { createSignal, onCleanup, onMount } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import styles from './windowControls.module.css';

/**
 * Minimise / maximise-restore / close for the app's own top bar.
 *
 * The window carries `WS_CAPTION` in its style bits but renders a **1px**
 * caption (measured: client origin sits 1px below the DWM frame top), so
 * Windows draws no usable title bar and the app would otherwise have no way to
 * be minimised, maximised or closed from its own chrome. React solved this the
 * same way in `src-next/components/Header/Header.tsx`; this is that port, not a
 * new design.
 *
 * Talking to `@tauri-apps/api/window` directly is deliberate and allowed: the
 * eslint boundary for `src-solid/` restricts `@tauri-apps/api/core` and
 * `.../event` (invoke and listen must go through `@bridge`), not the window
 * API, which is not an IPC surface carrying log data. The four permissions used
 * here — minimize, toggle-maximize, is-maximized, close — are already granted
 * in `src-tauri/capabilities/default.json`.
 *
 * Not fullscreen: `core:window:allow-set-fullscreen` is NOT in that capability
 * list, and the middle button of a Windows title bar is maximise/restore
 * anyway. Adding true fullscreen would mean widening the app's permissions.
 */
export function WindowControls() {
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = createSignal(false);

  onMount(() => {
    let disposed = false;
    void appWindow.isMaximized().then((v) => {
      if (!disposed) setMaximized(v);
    });

    // The window can be maximised by a route this component never sees — a
    // double-click on the drag region, the keyboard, or a snap gesture — so the
    // label follows the window rather than the button that was last pressed.
    const unlisten = appWindow.onResized(() => {
      void appWindow.isMaximized().then((v) => {
        if (!disposed) setMaximized(v);
      });
    });

    onCleanup(() => {
      disposed = true;
      void unlisten.then((fn) => fn());
    });
  });

  return (
    <div class={styles.controls}>
      <button
        type="button"
        class={styles.button}
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void appWindow.minimize()}
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M0 5 h10" stroke="currentColor" stroke-width="1" fill="none" />
        </svg>
      </button>

      <button
        type="button"
        class={styles.button}
        aria-label={maximized() ? 'Restore' : 'Maximize'}
        title={maximized() ? 'Restore' : 'Maximize'}
        onClick={() => void appWindow.toggleMaximize()}
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          {maximized() ? (
            <>
              <path d="M2.5 2.5 h5 v5 h-5 z" stroke="currentColor" stroke-width="1" fill="none" />
              <path d="M4 2.5 v-1.5 h5 v5 h-1.5" stroke="currentColor" stroke-width="1" fill="none" />
            </>
          ) : (
            <path d="M1 1 h8 v8 h-8 z" stroke="currentColor" stroke-width="1" fill="none" />
          )}
        </svg>
      </button>

      <button
        type="button"
        class={`${styles.button} ${styles.close}`}
        aria-label="Close window"
        title="Close"
        onClick={() => void appWindow.close()}
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" stroke-width="1" fill="none" />
        </svg>
      </button>
    </div>
  );
}
