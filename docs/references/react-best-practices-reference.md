# React Best Practices Reference (2024-2026 / React 18 & 19)

Compiled from 30+ authoritative sources including react.dev, Kent C. Dodds, Dan Abramov, developerway.com, TkDodo, patterns.dev, and practitioner articles.

---

## Table of Contents

1. [Hook Reference](#1-hook-reference)
2. [useEffect Deep Dive](#2-useeffect-deep-dive)
3. [Memoization Strategy](#3-memoization-strategy)
4. [Custom Hooks Patterns](#4-custom-hooks-patterns)
5. [State Management Architecture](#5-state-management-architecture)
6. [Component Architecture](#6-component-architecture)
7. [Performance Architecture](#7-performance-architecture)
8. [Common Architectural Mistakes](#8-common-architectural-mistakes)
9. [Event-Driven Patterns](#9-event-driven-patterns)
10. [React 19 Specific Changes](#10-react-19-specific-changes)
11. [React Compiler](#11-react-compiler)
12. [Testing Architecture](#12-testing-architecture)
13. [Decision Checklists](#13-decision-checklists)

---

## 1. Hook Reference

### Quick Selection Guide

| Need | Hook |
|---|---|
| Component state (simple) | `useState` |
| Component state (complex transitions) | `useReducer` |
| Pass data through tree | `useContext` |
| DOM node access | `useRef` |
| Mutable instance variable (no render) | `useRef` |
| Subscribe to external system | `useEffect` + cleanup |
| Measure DOM before paint | `useLayoutEffect` |
| Cache expensive calculation | `useMemo` |
| Stable function for memo'd child | `useCallback` |
| Keep UI responsive during slow render | `useTransition` |
| Defer non-critical value rendering | `useDeferredValue` |
| External store subscription (concurrent-safe) | `useSyncExternalStore` |
| Unique accessible DOM IDs | `useId` |
| Instant feedback while async runs | `useOptimistic` (R19) |
| Form submission lifecycle | `useActionState` (R19) |
| Read parent form pending state | `useFormStatus` (R19) |
| Read promise or context conditionally | `use()` (R19) |
| CSS-in-JS injection (library authors only) | `useInsertionEffect` |
| Expose imperative API from child | `useImperativeHandle` |
| DevTools label for custom hook | `useDebugValue` |

### useState

The default for 90% of state needs.

**Common mistakes:**
- Expecting immediate state after calling setter — state is a snapshot; new value on next render
- Not using functional updates when new state depends on previous: `setCount(prev => prev + 1)`
- Treating like class `setState` — `useState` replaces entirely, does not shallow-merge
- Storing derived values in state (calculate them during render instead)
- Not using lazy initialization: `useState(() => expensiveOp())` runs only once

**Performance:** Calling `setState` with same value (by `Object.is`) bails out without re-rendering.

### useReducer

For complex state where multiple related fields update together or update logic needs isolation.

**When to use over useState:**
- State has multiple related sub-values (form, game state)
- Next state depends on previous state across multiple actions
- Update logic should be testable in isolation (reducers are pure)
- Multiple action types modify the same state

**Common mistakes:**
- Mutating state instead of returning a new object
- Forgetting to spread existing state on partial updates
- Expecting synchronous updates after `dispatch`
- Using for simple boolean toggles (useState is simpler)

### useContext

Reads a value from React context. For theme, auth, locale, or data many unrelated components need.

**Common mistakes:**
- Provider at same level as consumer (must be above)
- Creating new object literal inline without memoizing:
  ```tsx
  // Wrong — new object every render
  <AuthContext value={{ user, login }}>

  // Correct
  const ctxValue = useMemo(() => ({ user, login }), [user, login]);
  <AuthContext value={ctxValue}>
  ```
- Putting everything in a single context — changes to any field re-render all consumers
- **Split contexts by change frequency**

### useRef

Mutable "box" that persists across renders, does NOT trigger re-renders.

**Two use cases:**
1. DOM access: `const ref = useRef(null); <input ref={ref} />`
2. Mutable storage: timer IDs, previous values, cancel flags, scroll positions

**Common mistakes:**
- Storing values that should appear on screen (use `useState` for that)
- Reading/writing `ref.current` during render (breaks purity):
  ```tsx
  // Wrong — during render
  myRef.current = 123;
  return <p>{myRef.current}</p>;

  // Correct — in effects or event handlers
  useEffect(() => { myRef.current = 123; });
  ```
- Expensive initialization: `useRef(new VideoPlayer())` evaluates every render. Use lazy init:
  ```tsx
  const ref = useRef(null);
  if (ref.current === null) { ref.current = new VideoPlayer(); }
  ```

### useTransition

Marks state updates as non-urgent (interruptible) so UI stays responsive.

**When to use:** Tab switching, search filtering, pagination — anything where brief stale content is acceptable.

**Common mistakes:**
- Using for controlled inputs (inputs need immediate updates):
  ```tsx
  // Wrong
  startTransition(() => setText(e.target.value));

  // Correct
  setText(e.target.value); // immediate
  startTransition(() => setSearchResults(filter(e.target.value)));
  ```
- State updates after an `await` are NOT in the transition:
  ```tsx
  startTransition(async () => {
    await fetch(...);
    startTransition(() => setState(val)); // must wrap again
  });
  ```

**vs. useDeferredValue:** Use `useTransition` when you control the state setter; `useDeferredValue` when you receive a value you can't control.

### useDeferredValue

Defers rendering a value — shows old value until browser has time for the new one.

```tsx
const deferredQuery = useDeferredValue(query);
// React 19: initial value for first render
const deferredQuery = useDeferredValue(query, '');
```

**When to use:** Search inputs where input updates instantly but results list is expensive.

**Not for:** Debouncing network requests (use explicit debounce). Has no `isPending` indicator.

### useSyncExternalStore

Subscribes to external stores in a concurrent-rendering-safe way.

```tsx
const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot?);
```

**Common mistakes:**
- `getSnapshot` returning new object each call (React throws "should be cached")
- Defining `subscribe` inline (new function every render = constant resubscription)
- Different values between `getServerSnapshot` and `getSnapshot` on first client render

### useLayoutEffect

Like `useEffect` but fires synchronously after DOM mutations, before browser paint.

**When to use:** Measuring DOM layout (`getBoundingClientRect()`) to adjust UI before user sees it.

**Rule:** If code doesn't need to block the paint, use `useEffect`. Heavy computation here delays the paint.

### useId

Generates stable, globally unique IDs consistent across server/client.

**When to use:** `<label htmlFor>`, ARIA attributes. NOT for list keys.

### useImperativeHandle

Customizes the value exposed via a ref. Rarely needed.

```tsx
useImperativeHandle(ref, () => ({ focus, scrollIntoView }), [deps]);
```

Only expose what callers legitimately need.

---

## 2. useEffect Deep Dive

### The Core Rule

`useEffect` is for synchronizing with external systems. Every legitimate use has a matching cleanup. If you cannot identify the cleanup, the code probably doesn't belong in an Effect.

### "You Might Not Need an Effect" — 8 Anti-Patterns

**1. Transforming data for rendering**
```tsx
// Wrong — double render
useEffect(() => { setFullName(first + ' ' + last); }, [first, last]);

// Correct — calculate during render
const fullName = first + ' ' + last;
```

**2. Caching expensive computations**
```tsx
// Wrong
useEffect(() => { setFiltered(filterTodos(todos, tab)); }, [todos, tab]);

// Correct
const filtered = useMemo(() => filterTodos(todos, tab), [todos, tab]);
```

**3. Resetting state when a prop changes**
```tsx
// Wrong — renders with stale state then updates
useEffect(() => { setComment(''); }, [userId]);

// Correct — key change resets all state
<Profile key={userId} userId={userId} />
```

**4. Adjusting state when props change**
```tsx
// Wrong
useEffect(() => { setSelection(null); }, [items]);

// Correct — calculate during render
const selection = items.find(i => i.id === selectedId) ?? null;
```

**5. Chained effects (cascading state updates)**
```tsx
// Wrong — 3 renders for one event
useEffect(() => { if (card?.gold) setGoldCount(c => c+1); }, [card]);
useEffect(() => { if (goldCount > 3) setRound(r => r+1); }, [goldCount]);

// Correct — one event handler, one render
function handleCard(card) {
  setCard(card);
  const newGold = card.gold ? goldCount + 1 : goldCount;
  setGoldCount(newGold > 3 ? 0 : newGold);
  setRound(newGold > 3 ? round + 1 : round);
}
```

**6. Notifying parent on state change**
```tsx
// Wrong
useEffect(() => { onChange(isOn); }, [isOn]);

// Correct — call both in the event handler
function handleClick() {
  const next = !isOn;
  setIsOn(next);
  onChange(next);
}
```

**7. POST requests from state changes**
```tsx
// Wrong
useEffect(() => { if (payload) post('/api', payload); }, [payload]);

// Correct — in the event handler directly
function handleSubmit() { post('/api', { firstName, lastName }); }
```

**8. Handling events inside effects**
```tsx
// Wrong — fires on mount/reload, not just user action
useEffect(() => { if (product.isInCart) showNotification('Added!'); }, [product]);

// Correct — in the event handler
function handleBuy() { addToCart(product); showNotification('Added!'); }
```

### Race Conditions in Async Effects

**Ignore-flag pattern:**
```tsx
useEffect(() => {
  let ignore = false;
  fetchBio(person).then(result => {
    if (!ignore) setBio(result);
  });
  return () => { ignore = true; };
}, [person]);
```

**AbortController pattern (preferred — cancels the request):**
```tsx
useEffect(() => {
  const controller = new AbortController();
  fetch(url, { signal: controller.signal })
    .then(r => r.json())
    .then(data => setData(data))
    .catch(err => { if (err.name !== 'AbortError') setError(err); });
  return () => controller.abort();
}, [url]);
```

### Dependency Array Rules

| Array form | Runs |
|---|---|
| `[]` | Once after mount |
| `[a, b]` | After mount and whenever `a` or `b` change |
| omitted | After every render — almost always wrong |

**Rules:**
- Every reactive value used inside the effect must be listed
- If a dependency causes unwanted re-runs, restructure the code — never suppress the linter
- Objects/functions created in render body are new references every render; move inside effect, memoize, or extract primitives

**State-updater trick to remove state from deps:**
```tsx
// Wrong — count in deps, effect re-runs constantly
useEffect(() => {
  const id = setInterval(() => setCount(count + 1), 1000);
  return () => clearInterval(id);
}, [count]);

// Correct — updater form needs no dep on count
useEffect(() => {
  const id = setInterval(() => setCount(c => c + 1), 1000);
  return () => clearInterval(id);
}, []);
```

### Tauri Async Listener Pattern (StrictMode-safe)

```tsx
useEffect(() => {
  let cancelled = false;
  let unlisten: UnlistenFn | null = null;
  someAsyncListenerSetup((event) => {
    if (cancelled) return;
    handleEvent(event);
  }).then((fn) => {
    if (cancelled) fn();          // cleanup already ran
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}, [deps]);
```

---

## 3. Memoization Strategy

### Three Legitimate Use Cases for useMemo

1. **Genuinely expensive computations** (>=1ms measured with `console.time`)
2. **Referential stability for React.memo children** — preserves reference identity
3. **Stabilizing hook dependencies** — prevents unnecessary effect re-triggers

### The Only Legitimate Use Case for useCallback

A function is passed to a `React.memo`-wrapped component, OR is a dependency of another hook. **If neither is true, `useCallback` adds cost with no benefit.**

### Measuring Before Memoizing

```tsx
console.time('filterTodos');
const result = filterTodos(todos, tab);
console.timeEnd('filterTodos');
// If < 1ms on real device with CPU throttling, skip useMemo
```

Always profile in production build on representative hardware. Dev mode is 2-5x slower.

### useMemo Common Mistakes

- Omitting dependency array (recalculates every render)
- Arrow function returning object without parens: `useMemo(() => { key: val }, [])` returns undefined
- Creating objects with lifecycle/dispose semantics (React 19 StrictMode double-invokes factory)
- Calling inside loops (extract a sub-component instead)

### Composition Patterns That Reduce Memoization Needs

- **Accept children as JSX:** `<Wrapper><ExpensiveChild /></Wrapper>` — child only re-renders if its own props change
- **Keep state local** — hoisting state wraps unrelated components in unnecessary re-renders
- **Pure rendering logic** — if re-rendering causes visual bugs, fix the bug; don't memo to hide it

---

## 4. Custom Hooks Patterns

### When to Extract

- Same `useState`/`useEffect` pattern appears in 2+ components
- Writing an Effect — wrapping in a custom hook makes intent explicit
- Hide implementation and expose domain-level API: `const isOnline = useOnlineStatus()`
- Enable future migration to better primitive without changing consumers

Do NOT extract for: wrapping a single `useState` call, minor duplication.

### Naming Conventions

- Must start with `use` + capital letter: `useFormInput`, `useChatRoom`
- Functions that call no hooks must NOT use `use` prefix
- Name after the concrete use case, not lifecycle pattern:
  ```tsx
  // Bad — generic lifecycle wrapper
  function useMount(fn) { useEffect(fn, []); }

  // Good — specific and searchable
  function useOnlineStatus() { ... }
  function useWindowSize() { ... }
  ```

### State is NOT Shared — Logic Is

Each invocation of a custom hook is independent. Two components calling `useOnlineStatus()` each get their own state. They synchronize because they subscribe to the same browser event, not because they share state.

### Composition Pattern

Custom hooks re-run with every render and receive latest values:
```tsx
const cities = useData(`/api/cities?country=${country}`);
const areas = useData(city ? `/api/areas?city=${city}` : null);
```

### State Reducer Pattern (Kent C. Dodds)

Invert control of state transitions to the consumer:
```tsx
function useToggle({ reducer = toggleReducer } = {}) {
  const [state, dispatch] = useReducer(reducer, { on: false });
  return { on: state.on, toggle: () => dispatch({ type: 'toggle' }) };
}
```

### Testing Custom Hooks

Use `renderHook` from `@testing-library/react`:
```tsx
const { result } = renderHook(() => useCounter());
act(() => result.current.increment());
expect(result.current.count).toBe(1);
```

Design hooks to accept dependencies for injection in tests:
```tsx
function useData(url, { fetcher = fetch } = {}) { ... }
```

---

## 5. State Management Architecture

### When to Use What

The guiding principle: **start with the simplest thing that works, escalate only when demonstrated need.**

**Local State (useState / useReducer)**
- Data confined to a single component or subtree
- Forms, hover states, toggles, transient UI interactions
- Prefer `useReducer` when state variables are co-dependent

**React Context**
- Reserve for 1-2 truly app-wide concerns: auth, theme, locale
- Beyond that, you accumulate "Providers Hell"
- **The cascading re-render problem:** when any value changes, every consumer re-renders

**Context Splitting by Change Frequency**
- High-frequency state (streaming, typing) must never share context with low-frequency (user profile, callbacks)
- Move stable callbacks to a dedicated ActionsContext
- Wrap every provider value in `useMemo`
- If adding selectors to a monolithic context, you're re-inventing Zustand — just use Zustand

### External Libraries Decision Framework (2025)

| Library | When |
|---|---|
| **TanStack Query** | Any server/remote data — cache lifetime, stale/refetch, server mutations |
| **Zustand** | Shared client state across multiple unrelated subtrees. Selector-based subscriptions |
| **Jotai** | Atomic fine-grained state with derived atoms and complex interdependencies |
| **XState** | Explicit state machines for complex formally-specifiable flows |
| **Redux Toolkit** | Large teams (5+) requiring strict action logging and time-travel debugging |
| **nuqs** | URL-parameter state — searchable, shareable, bookmark-safe |
| **React Context** | 1-2 app-wide stable concerns |
| **Local state** | Everything else |

### Server State vs Client State Separation

The most impactful architectural shift in 2024-2025. Server state has different lifecycle semantics: cache, staleness, background refetch, error retry. Bundling it into Redux or Zustand is a category error. TanStack Query manages its own global state and eliminates duplicate fetches automatically.

---

## 6. Component Architecture

### Container/Presentational — Still Relevant?

The pattern is largely superseded by custom hooks. The underlying principle (separating data logic from rendering) remains valid; the mechanism changed. Extract a custom hook for data logic, not a wrapper component.

### Composition Over Configuration

- Prefer compound components (`<Menu>` + `<Menu.Item>`) over large configuration prop objects
- Accept `children` as JSX — wrappers can update state without re-rendering children
- Configuration props are fine for leaf UI primitives; they become anti-patterns in compound feature components

### Component Size and Single Responsibility

- A component should do exactly one thing
- Size is a proxy: a 500-line component with one clear responsibility is fine; a 50-line component mixing concerns is not
- When props exceed 5-7, consider splitting or compound patterns

### Render Props vs Hooks vs HOCs (Current Consensus)

- **Hooks** — primary mechanism for logic reuse (replaced most HOC/render prop use cases)
- **HOCs** — still valid for cross-cutting concerns (auth guards, error boundaries, analytics instrumentation)
- **Render props** — effectively superseded by hooks; remain useful for render delegation (`renderItem` patterns)

### Nested Component Declarations — NEVER

```tsx
function Parent() {
  // WRONG — Child recreated every render, full unmount/remount
  function Child() { ... }
  return <Child />;
}
```

React treats the new function reference as a new component type. Move definitions to module scope.

---

## 7. Performance Architecture

### React.memo — When It Helps

**Helps when:**
- Component re-renders frequently with same props
- Render is computationally non-trivial
- Props are primitives or memoized objects/functions

**Hurts when:**
- Props include un-memoized functions/objects (defeats comparison)
- Component renders rarely or renders fast
- No profiling was done first

### Systematic Re-render Optimization Order

Three root causes produce the vast majority of unnecessary re-renders:

1. **Cascading context re-renders** — monolithic context with mixed-frequency state -> split contexts
2. **Unstable references in props** — inline object literals and arrow functions -> `useMemo`/`useCallback`
3. **State placed too high** — state owned by grandparent only leaf needs -> colocate

Address these structurally before applying `React.memo`. Memoization on a poorly architected state tree treats the symptom.

### State Colocation (Kent C. Dodds)

When state that changes frequently is placed low in the tree, React doesn't need to check subtrees that don't consume it. This is structurally superior to `React.memo` — eliminates traversal rather than short-circuiting it.

### Virtualization for Large Lists

- Implement when lists exceed several hundred items
- `react-window` (lighter, same author as react-virtualized)
- `react-virtuoso` (variable item heights, dynamic content)
- Profile first; don't add by default

### Code Splitting

- Route-based splitting is the first and highest-ROI optimization
- Component-level splitting for heavyweight widgets not in critical path
- Don't over-split — async boundaries add loading states that must be designed for
- React 19.2 `<Activity>` component for pre-rendering inactive panes

### React DevTools Profiler

1. Record an interaction; examine the flame graph
2. Identify components that render repeatedly without prop changes
3. Verify renders exceed 16ms (one frame at 60fps)
4. Apply memoization only to confirmed problems
5. Re-measure to confirm improvement

---

## 8. Common Architectural Mistakes

### Prop Drilling vs Over-Contexting

**Prop drilling:** passing props through intermediaries that never use them. Solutions: state colocation, composition (`children`), or Context/store when truly needed.

**Over-contexting:** putting everything in Context to avoid drilling. Causes cascading re-renders, Providers Hell, non-reusable components.

Resolution: colocation hierarchy — local state -> Context close to consumers -> Zustand for truly global.

### God Components

Single component owning data fetching, business logic, multiple state domains, and all rendering. Decompose by extracting:
- Custom hooks for each logical state domain
- Presentational leaf components for distinct UI sections
- Thin orchestration layer composing them

### useEffect Orchestration Chains

The most destructive React anti-pattern:
```
useEffect A sets stateX when queryResult changes
  -> useEffect B sets stateY when stateX changes
    -> useEffect C dispatches when stateY changes
```

**Problems:** Multiple render cycles per event, impossible causality, subtle ordering bugs.

**Fixes:**
- Eliminate derived state — calculate in render
- Use typed event bus for cross-component orchestration
- Use React 19 `useActionState` / Actions for async mutation flows
- Use `useEffectEvent` to break illegitimate dependencies

### Derived State Anti-Pattern

```tsx
// WRONG — synchronization bugs, doubles render cycles
const [items, setItems] = useState([]);
const [filteredItems, setFilteredItems] = useState([]);
useEffect(() => { setFilteredItems(items.filter(pred)); }, [items, pred]);

// CORRECT — derive during render
const [items, setItems] = useState([]);
const filteredItems = items.filter(pred);
```

**Kent C. Dodds' golden rule:** Store minimal state, derive everything else. State is for user input and API responses; everything else is a derived view.

### Premature Abstraction

Creating reusable abstractions before 2+ concrete use cases exist. The cost: abstractions lock in an API before requirements are understood. Wait for the second genuine use case.

### Lifting State Too High

Form input values, hover states, toggle flags, scroll positions in Redux/Zustand when they are strictly local. Every keystroke flows through the global system. Rule: global state is for data multiple unrelated subtrees must read or write.

---

## 9. Event-Driven Patterns

### When Event Bus > Prop Callbacks

| Situation | Mechanism |
|---|---|
| Cross-subtree communication | Event bus |
| One-to-many (one action triggers many reactions) | Event bus |
| Ephemeral fire-and-forget notifications | Event bus |
| Hook-to-hook orchestration | Event bus |
| Parent-to-child in clear hierarchy | Prop callback |
| One screen / one subtree | Prop callback |
| Persistent shared state | Zustand/Context |

### Hybrid Architecture (Recommended)

Use Zustand/Context for persistent state; event bus for ephemeral cross-cutting events. They are complementary.

### mitt Implementation

- ~200 bytes, zero dependencies, TypeScript generics for typed events
- Create single shared instance (module singleton)
- Always unsubscribe in `useEffect` cleanup (StrictMode double-mounts leak listeners):
  ```tsx
  useEffect(() => {
    const handler = (payload) => handleEvent(payload);
    bus.on('my:event', handler);
    return () => bus.off('my:event', handler);
  }, []);
  ```

### Trade-offs

| Advantage | Risk |
|---|---|
| Decoupled emitters/subscribers | Harder to trace than call stacks |
| No prop drilling | Memory leaks without cleanup |
| No state management boilerplate | Implicit contracts |
| Ideal for cross-cutting concerns | Not for persistent state (no read-at-mount) |

---

## 10. React 19 Specific Changes

### New Hooks and APIs

**Actions** — The central new concept. An "Action" is an async function React manages automatically, tracking pending state, handling errors, reverting optimistic updates on failure.

**use()** — Reads a Promise (suspending until resolved) or Context value. Unlike all other hooks, can be called conditionally, in loops, and after early returns. Promises must come from outside render (not created inline).

**useActionState** — Returns `[data, submitAction, isPending]`. The action receives `(previousState, formData)`. Replaces manual useState+useEffect async patterns.

**useOptimistic** — Shows optimistic UI immediately while async mutation is in-flight. Automatically reverts when mutation settles.

**useFormStatus** — Reads pending state of nearest ancestor `<form>` without prop drilling. Must be called inside a component rendered inside the form.

**useDeferredValue with initialValue** — Optional second argument returned on first render while deferred value is scheduled.

**useTransition with async** — Accepts async functions; transition stays pending for entire async duration.

### Breaking Changes

**ref as a prop (forwardRef deprecated):**
```tsx
// React 19
function MyInput({ placeholder, ref }) {
  return <input placeholder={placeholder} ref={ref} />;
}
```

**Ref callback cleanup functions:**
```tsx
<div ref={(node) => {
  doSetup(node);
  return () => doCleanup(node); // NEW
}} />
```

**`<Context>` as provider** — `<Context.Provider>` deprecated:
```tsx
<ThemeContext value="dark">{children}</ThemeContext>
```

**Document metadata in components** — `<title>`, `<meta>`, `<link>` auto-hoisted to `<head>`.

### Removed APIs

| Removed | Migration |
|---|---|
| `propTypes` / `defaultProps` on function components | TypeScript / ES6 defaults |
| String refs | `useRef` / callback refs |
| `ReactDOM.render()` | `createRoot().render()` |
| `ReactDOM.findDOMNode()` | DOM refs |
| `react-test-renderer/shallow` | RTL |

### StrictMode Behavior (React 19) — CRITICAL

- **Double-invokes** render bodies, useState/useMemo/useReducer initializers, reducers
- **For useMemo:** Calls factory twice, keeps second instance. First instance leaks if it has lifecycle semantics
- **Double-mounts effects:** setup -> cleanup -> setup
- **Double-invokes ref callbacks** (new in 19)

**NEVER create disposable resources in useMemo:**
```tsx
// WRONG — StrictMode creates two, leaks the first
const ds = useMemo(() => new DataSource(config), [config]);

// CORRECT
const [ds, setDs] = useState(null);
useEffect(() => {
  const instance = new DataSource(config);
  setDs(instance);
  return () => instance.dispose();
}, [config]);
```

### TypeScript Breaking Changes

- `useRef()` requires argument (use `useRef(null)` or `useRef(undefined)`)
- `ReactElement["props"]` is now `unknown` instead of `any`
- Global `JSX` namespace removed
- Ref callbacks returning values produce TypeScript error

### RSC Note for Tauri

React Server Components are irrelevant for Tauri apps. RSC requires server rendering infrastructure. All React code in Tauri is client components only.

---

## 11. React Compiler

### What It Does

Build-time Babel plugin (stable 1.0, October 2025) that auto-inserts `useMemo`, `useCallback`, and `React.memo` where values are safe to memoize.

### What It Can Auto-Memoize

- Component return values (equivalent to `React.memo`)
- All hook dependency values (replaces `useMemo`)
- Function callbacks (replaces `useCallback`)
- Inline object/array/JSX props

### What It CANNOT Fix

1. **Side effects in render body** — `bus.emit()`, `fetch()`, mutations
2. **Reads from external mutable state** — module-level caches, Maps, globals
3. **Violations of Rules of React**
4. **Context optimization** — splitting contexts by change frequency still required
5. **State architecture decisions** — colocation, state lifting still necessary

### Guidance with Compiler Enabled

- Manual `useMemo`/`useCallback`/`React.memo` become unnecessary for pure performance optimization
- Retain when stable reference is needed for correctness (not just performance)
- For new code: don't add memoization by default; add after profiling

### Adoption

- Gradual: enable per-file with `"use memo"` directive
- Opt-out per-component with `"use no memo"` directive

---

## 12. Testing Architecture

### Philosophy: Test Behavior, Not Implementation

React Testing Library (RTL) design: write tests resembling how software is used. Query by accessible role, text, label — not class names or internal state.

Do NOT mock `useState`, `useReducer`, or React internals.

### Testing Hooks

- **Single-use hooks:** Test through the component that uses them
- **Reusable hooks:** Use `renderHook` from `@testing-library/react`

### Key RTL Practices

- Query by accessible semantics (`getByRole`, `getByLabelText`, `getByText`)
- Use `userEvent` over `fireEvent` (simulates real browser event sequences)
- `screen` queries over destructuring from `render()`
- Test visible output and side effects, not internal state
- For async: `await waitFor(() => ...)` or `findBy*` queries

### What Not to Test

- Implementation details (which hook manages which state)
- Snapshot tests of large component trees (low signal, break on unrelated changes)
- Mocked React internals

---

## 13. Decision Checklists

### State Placement

1. Can this be derived from existing state? -> derive in render, no state needed
2. Is this only used by one subtree? -> `useState`/`useReducer` in that subtree
3. Is this remote/server data? -> TanStack Query
4. Is this URL-synchronized? -> nuqs
5. Is this auth/theme/locale (app-wide, stable)? -> React Context
6. Is this shared client state across multiple unrelated subtrees? -> Zustand

### Re-render Optimization Order

1. Colocate state closer to consumers (free, most effective)
2. Split Context by change frequency (structural fix)
3. Memoize unstable prop references (targeted fix)
4. Apply `React.memo` (last resort, profile-verified only)

### useEffect Usage Test

- Is this synchronizing derived state? -> move to render body
- Is this triggering another state update? -> combine into one update or use event bus
- Is this fetching server data? -> replace with TanStack Query
- Is this setting up an external subscription? -> appropriate use, add cleanup

### Component Responsibility Test

- Does this component fetch data AND render UI? -> extract a hook for data
- Does this component manage 3+ independent state domains? -> decompose into focused subcomponents
- Does this component accept 7+ props? -> introduce compound pattern or split

---

## Sources

### React Official
- [React v19 Blog Post](https://react.dev/blog/2024/12/05/react-19)
- [React 19 Upgrade Guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide)
- [React Compiler Documentation](https://react.dev/learn/react-compiler)
- [Built-in React Hooks](https://react.dev/reference/react/hooks)
- [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
- [Reusing Logic with Custom Hooks](https://react.dev/learn/reusing-logic-with-custom-hooks)
- [StrictMode Reference](https://react.dev/reference/react/StrictMode)

### Expert Blogs
- [Kent C. Dodds — State Colocation](https://kentcdodds.com/blog/state-colocation-will-make-your-react-app-faster)
- [Kent C. Dodds — Don't Sync State, Derive It](https://kentcdodds.com/blog/dont-sync-state-derive-it)
- [Kent C. Dodds — State Reducer Pattern](https://kentcdodds.com/blog/the-state-reducer-pattern-with-react-hooks)
- [TkDodo — Ref Callbacks, React 19 and the Compiler](https://tkdodo.eu/blog/ref-callbacks-react-19-and-the-compiler)
- [developerway.com — React State Management 2025](https://www.developerway.com/posts/react-state-management-2025)
- [developerway.com — React Compiler](https://www.developerway.com/posts/react-compiler-soon)

### Architecture & Patterns
- [patterns.dev — Container/Presentational](https://www.patterns.dev/react/presentational-container-pattern/)
- [makersden.io — State Management Trends 2025](https://makersden.io/blog/react-state-management-in-2025)
- [SitePoint — React Architecture Best Practices](https://www.sitepoint.com/react-architecture-best-practices/)
- [LogRocket — React.memo Explained](https://blog.logrocket.com/react-memo/)

### Community
- [DEV Community — React 19 Concurrency Deep Dive](https://dev.to/a1guy/react-19-concurrency-deep-dive-mastering-usetransition-and-starttransition-for-smoother-uis-51eo)
- [DEV Community — Event-Driven Architecture for React](https://dev.to/nicolalc/event-driven-architecture-for-clean-react-component-communication-fph)
- [FreeCodeCamp — React 19 New Hooks](https://www.freecodecamp.org/news/react-19-new-hooks-explained-with-examples/)
