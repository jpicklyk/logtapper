/** @jsxImportSource solid-js */
import { createSignal, For, Show } from 'solid-js';
import { open } from '@tauri-apps/plugin-dialog';
import { getLines, loadLogFile } from '@bridge/commands';
import styles from './App.module.css';

/**
 * Scaffold hello page. Opens a file through the same dialog + `load_log_file`
 * pair the React app uses (`context/index.tsx` → `openFileDialog`), then reads
 * the head of the session through `get_lines`.
 */
export function App() {
  const [status, setStatus] = createSignal('');
  const [error, setError] = createSignal('');
  const [lines, setLines] = createSignal<string[]>([]);

  const openFile = async () => {
    setError('');
    const selected = await open({
      multiple: false,
      filters: [
        { name: 'Log Files', extensions: ['log', 'txt', 'zip', 'gz', 'lts'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (typeof selected !== 'string') return;

    setStatus('Loading…');
    setLines([]);
    try {
      const [result] = await loadLogFile(selected);
      const page = await getLines({
        sessionId: result.sessionId,
        mode: { mode: 'Full' },
        offset: 0,
        count: 5,
        context: 0,
        processorId: null,
        search: null,
      });
      setStatus(`${result.sourceName} — ${page.totalLines} lines`);
      setLines(page.lines.map((l) => l.raw));
    } catch (e) {
      setStatus('');
      setError(String(e));
    }
  };

  return (
    <main class={styles.page}>
      <h1>LogTapper — Solid scaffold</h1>
      <button type="button" onClick={openFile}>Open file…</button>
      <Show when={status()}><p>{status()}</p></Show>
      <Show when={error()}><p class={styles.error}>{error()}</p></Show>
      <Show when={lines().length > 0}>
        <pre class={styles.lines}><For each={lines()}>{(l) => <div>{l}</div>}</For></pre>
      </Show>
    </main>
  );
}
