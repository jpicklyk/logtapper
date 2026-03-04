# src-next/events/ — Typed Event Bus

## Architecture

`mitt`-based typed event bus. Singleton `bus` instance created in `bus.ts`. All available events defined in `AppEvents` type map (`events.ts`).

## Public API

| Export | From | Description |
|---|---|---|
| `bus` | `bus.ts` | Singleton mitt instance — `bus.emit()`, `bus.on()`, `bus.off()` |
| `AppEvents` | `events.ts` | Type map defining all event names and payloads |

## Adding a new event

1. Add the event name + payload type to `AppEvents` in `events.ts`
2. Emit via `bus.emit('my:event', payload)` in the producing hook
3. Subscribe via `bus.on('my:event', handler)` in the consuming hook
4. Clean up via `bus.off('my:event', handler)` in useEffect cleanup

## Design rationale (principle #6)

The event bus replaces cross-hook orchestration effects in App.tsx. Hooks react to events independently — no hook depends on another hook's internal state through render-phase effects.
