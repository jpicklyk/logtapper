import mitt from 'mitt';
import type { AppEvents } from './events';

export const bus = mitt<AppEvents>();

// ---------------------------------------------------------------------------
// Bus logging
// ---------------------------------------------------------------------------

/** High-frequency bus events to suppress from console output. */
const MUTED_EVENTS = new Set<string>();

const isLoggingEnabled =
  import.meta.env.DEV || localStorage.getItem('logtapper_bus_debug') === '1';

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
