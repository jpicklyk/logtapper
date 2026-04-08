import mitt from 'mitt';
import type { AppEvents } from './events';
import { storageGet } from '../utils';

export const bus = mitt<AppEvents>();

/**
 * Emit `session:loaded`, then conditionally emit `session:focused`.
 * If a `layout:pane-session-remap` fires synchronously during session:loaded
 * processing, the remap handler already emits session:focused with the correct
 * pane — so we skip the original (potentially stale) emission.
 */
export function emitSessionLoadedWithFocus(
  loadedPayload: AppEvents['session:loaded'],
  focusedPayload: AppEvents['session:focused'],
): void {
  let remapped = false;
  const onRemap = () => { remapped = true; };
  bus.on('layout:pane-session-remap', onRemap);
  try {
    bus.emit('session:loaded', loadedPayload);
  } finally {
    bus.off('layout:pane-session-remap', onRemap);
  }
  if (!remapped) {
    bus.emit('session:focused', focusedPayload);
  }
}

// ---------------------------------------------------------------------------
// Bus logging
// ---------------------------------------------------------------------------

/** High-frequency bus events to suppress from console output. */
const MUTED_EVENTS = new Set<string>(['selection:changed']);

const isLoggingEnabled =
  import.meta.env.DEV || storageGet('logtapper_bus_debug') === '1';

if (isLoggingEnabled) {
  bus.on('*', (type, payload) => {
    if (MUTED_EVENTS.has(type as keyof AppEvents)) return;
    const label = `%c[bus] %c${type}`;
    if (payload === undefined) {
      console.debug(label, 'color:#888', 'color:#4a9eff;font-weight:bold');
    } else {
      console.debug(label, 'color:#888', 'color:#4a9eff;font-weight:bold', payload);
    }
  });
}
