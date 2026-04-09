/**
 * Tests for the no-side-effects-in-updater ESLint local rule.
 * Run with: node eslint-local-rules/no-side-effects-in-updater.test.cjs
 *
 * Uses ESLint v9 flat-config RuleTester.
 */
const { RuleTester } = require('eslint');
const rule = require('./no-side-effects-in-updater.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
});

ruleTester.run('no-side-effects-in-updater', rule, {
  valid: [
    // ── Pure updaters (no side effects) ──────────────────────────────

    // Simple state transform
    {
      code: `setConfig((prev) => ({ ...prev, enabled: true }));`,
    },

    // Updater returning previous state
    {
      code: `setItems((prev) => { const next = [...prev, item]; return next; });`,
    },

    // Side effect OUTSIDE the updater (the correct pattern)
    {
      code: `
        const next = transform(prev);
        setConfig(next);
        fetch('/api/save', { body: next });
      `,
    },

    // localStorage outside updater
    {
      code: `
        setExpanded((prev) => new Set([...prev, id]));
        localStorage.setItem('key', 'value');
      `,
    },

    // bus.emit outside updater
    {
      code: `
        setCount((prev) => prev + 1);
        bus.emit('counter:changed');
      `,
    },

    // fetch outside updater
    {
      code: `
        setState((prev) => ({ ...prev, loading: true }));
        fetch('/api/data');
      `,
    },

    // Non-updater setState (direct value, not a function)
    {
      code: `setConfig(newConfig);`,
    },

    // React state setters calling each other inside updater — legitimate
    // React 18+ batches these; they are NOT external side effects
    {
      code: `setNoticeText((prev) => { setNoticePhase('entering'); return 'hello'; });`,
    },

    // Multiple React setters inside updater — still fine
    {
      code: `setSearch((prev) => {
        setCurrentMatchIndex(0);
        setScrollToLine(42);
        setJumpPaneId('pane-1');
        return { ...prev, query: 'test' };
      });`,
    },

    // Bridge/IPC functions called outside updater
    {
      code: `
        setConfig(next);
        setAnonymizerConfig(next);
        saveWorkspaceState(state);
      `,
    },
  ],

  invalid: [
    // ── invoke() inside updater ──────────────────────────────────────

    {
      code: `setState((prev) => { invoke('command', args); return prev; });`,
      errors: [{ messageId: 'noSideEffect', data: { name: 'invoke' } }],
    },

    // ── fetch() inside updater ───────────────────────────────────────

    {
      code: `setData((prev) => { fetch('/api'); return prev; });`,
      errors: [{ messageId: 'noSideEffect', data: { name: 'fetch' } }],
    },

    // ── localStorage inside updater ──────────────────────────────────

    {
      code: `setExpanded((prev) => { localStorage.setItem('key', 'val'); return prev; });`,
      errors: [{ messageId: 'noSideEffect', data: { name: 'localStorage.setItem' } }],
    },

    {
      code: `setData((prev) => { sessionStorage.removeItem('key'); return prev; });`,
      errors: [{ messageId: 'noSideEffect', data: { name: 'sessionStorage.removeItem' } }],
    },

    // ── bus.emit inside updater ──────────────────────────────────────

    {
      code: `setCount((prev) => { bus.emit('event', data); return prev + 1; });`,
      errors: [{ messageId: 'noSideEffect', data: { name: 'bus.emit' } }],
    },

    // ── Multiple side effects in one updater ─────────────────────────

    {
      code: `setConfig((prev) => {
        const next = { ...prev, enabled: true };
        invoke('save_config', { config: next });
        localStorage.setItem('config', JSON.stringify(next));
        return next;
      });`,
      errors: [
        { messageId: 'noSideEffect', data: { name: 'invoke' } },
        { messageId: 'noSideEffect', data: { name: 'localStorage.setItem' } },
      ],
    },

    // ── Function expression (not arrow) ──────────────────────────────

    {
      code: `setState(function(prev) { fetch('/api'); return prev; });`,
      errors: [{ messageId: 'noSideEffect', data: { name: 'fetch' } }],
    },
  ],
});

console.log('✓ no-side-effects-in-updater: all tests passed');
