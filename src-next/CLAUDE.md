# src-next/ — Legacy React frontend (read-only)

> **Legacy.** The shipped frontend is `src-solid/`. This tree is kept only until its
> framework-free modules move to `src-shared/` (see `plans/solid-cutover.md`); do not add
> features here. Run it with `npm run tauri:react`.

All React frontend code lives here. The legacy `src/` directory has been removed. Each subdirectory has its own `CLAUDE.md`; the rules below apply across the whole frontend.

The mandatory isolation principles (context splitting, memoization, selector hooks, action surfaces, barrel exports) are in the root `CLAUDE.md` — read those first.

## React StrictMode (CRITICAL)

`main.tsx` wraps `<App>` in `<React.StrictMode>`, which **double-mounts** every `useEffect` in dev mode. Four consequences, each of which has bitten this codebase:

### 1. Async event listeners leak

Setting up a Tauri listener asynchronously silently leaks it, because cleanup runs before the promise resolves. **Always use this pattern:**

```tsx
useEffect(() => {
  let cancelled = false;
  let unlisten: UnlistenFn | null = null;
  someAsyncListenerSetup((event) => {
    if (cancelled) return;
    handleEvent(event);
  }).then((fn) => {
    if (cancelled) fn();            // cleanup already ran → immediately unregister
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}, [deps]);
```

This applies to ALL Tauri async listener APIs: `listen()`, `once()`, `onDragDropEvent()`, etc.

### 2. `requestAnimationFrame` cleanup breaks

Double-mount means effect → cleanup → effect. If the cleanup calls `cancelAnimationFrame`, the first rAF is cancelled before it fires. **Never return `cancelAnimationFrame` from a useEffect cleanup.** Either omit cleanup (let stale rAFs fire harmlessly behind a ref guard) or avoid rAF entirely — prefer a `programmaticScrollRef` flag to distinguish programmatic from user-initiated scrolls (see `LogViewer.tsx`).

### 3. `setState` updaters run twice — never emit bus events inside them

StrictMode calls updater functions twice to detect impurities, so any `bus.emit` inside a `setState(fn)` callback fires twice. Pre-compute the payload from a ref, call `setState`, then emit.

### 4. `useMemo` factories run twice — never create disposable resources in them

React 19 StrictMode calls the factory twice, creates two instances, and keeps the second. If the factory creates an object with `dispose()`, registry registration, or any side effect, the first instance leaks — or worse, in-flight async operations resolve against the disposed first instance and silently discard results.

```tsx
// WRONG — creates two DataSources, disposes the first
const ds = useMemo(() => createDataSource({ ... }), [deps]);

// CORRECT — useEffect runs once per committed mount, cleanup on unmount
const [ds, setDs] = useState<DataSource | null>(null);
useEffect(() => {
  const instance = createDataSource({ ... });
  setDs(instance);
  return () => instance.dispose();
}, [deps]);
```

Applies to any object with `dispose()`, `destroy()`, `unsubscribe()`, `close()`, or that registers with an external registry. Pure data structures (Map, Set, arrays, plain objects) remain safe in `useMemo`.
