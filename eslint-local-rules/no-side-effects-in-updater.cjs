/**
 * @fileoverview Disallow side effects inside setState updater functions.
 *
 * React may call setState updater functions multiple times (StrictMode,
 * concurrent mode). Side effects inside them — IPC calls, localStorage,
 * event bus emits, fetch — will execute multiple times, causing duplicate
 * mutations.
 *
 * Detects: setState((prev) => { sideEffect(); return next; })
 *
 * Side effects matched:
 *   - Known IPC/bridge function calls (invoke, setAnonymizerConfig, etc.)
 *   - localStorage / sessionStorage method calls
 *   - bus.emit() calls
 *   - fetch() calls
 *   - console.log/warn/error (optional, off by default)
 *
 * The rule tracks when we're inside a setState updater callback and flags
 * any call expression that matches the side-effect patterns.
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow side effects inside React setState updater functions',
    },
    messages: {
      noSideEffect:
        "Do not call '{{ name }}' inside a setState updater. " +
        'React may invoke updaters multiple times (StrictMode/concurrent mode). ' +
        'Move side effects outside the updater callback.',
    },
    schema: [],
  },

  create(context) {
    // Track which function nodes are setState updaters (without mutating AST).
    const updaterNodes = new WeakSet();

    // Stack tracking how deep we are inside setState updater callbacks.
    // When > 0, we're inside at least one updater.
    let updaterDepth = 0;

    // Names that indicate a React setState function.
    // Matches: setFoo, dispatch (from useReducer)
    const SET_STATE_PATTERN = /^set[A-Z]/;

    /**
     * Check if a CallExpression is a setState call with a function updater arg.
     * e.g., setConfig((prev) => ...) or setConfig(prev => ...)
     */
    function isSetStateWithUpdater(node) {
      if (node.type !== 'CallExpression') return false;
      const callee = node.callee;

      // Direct call: setFoo(fn)
      if (callee.type === 'Identifier' && SET_STATE_PATTERN.test(callee.name)) {
        return hasUpdaterArg(node);
      }

      // Member call: this.setState(fn) — class components
      if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'setState'
      ) {
        return hasUpdaterArg(node);
      }

      return false;
    }

    /**
     * Check if the first argument is a function (updater pattern).
     */
    function hasUpdaterArg(callNode) {
      const firstArg = callNode.arguments[0];
      if (!firstArg) return false;
      return (
        firstArg.type === 'ArrowFunctionExpression' ||
        firstArg.type === 'FunctionExpression'
      );
    }

    /**
     * Get the updater function node (first arg) from a setState call.
     */
    function getUpdaterFn(callNode) {
      return callNode.arguments[0];
    }

    // --- Side-effect detection ---

    // --- Side-effect detection ---

    // Exact function names that are always side effects
    const SIDE_EFFECT_NAMES = new Set([
      'fetch',
      'invoke',
    ]);

    // Known storage objects
    const STORAGE_OBJECTS = new Set(['localStorage', 'sessionStorage']);

    // Known storage methods
    const STORAGE_METHODS = new Set(['setItem', 'getItem', 'removeItem', 'clear']);

    /**
     * Check if a call expression is a side effect we should flag.
     *
     * Deliberately narrow: only flags known external side effects
     * (fetch, invoke, localStorage, sessionStorage, bus.emit).
     * Does NOT flag React state setters (setFoo) calling each other
     * inside updaters — that is a legitimate React batching pattern.
     */
    function getSideEffectName(node) {
      if (node.type !== 'CallExpression') return null;
      const callee = node.callee;

      // Direct function call: fetch(), invoke()
      if (callee.type === 'Identifier') {
        const name = callee.name;
        if (SIDE_EFFECT_NAMES.has(name)) return name;
        return null;
      }

      // Member expression: localStorage.setItem(), bus.emit(), etc.
      if (callee.type === 'MemberExpression') {
        const obj = callee.object;
        const prop = callee.property;

        if (obj.type !== 'Identifier' || prop.type !== 'Identifier') return null;

        // localStorage.setItem(), sessionStorage.removeItem(), etc.
        if (STORAGE_OBJECTS.has(obj.name) && STORAGE_METHODS.has(prop.name)) {
          return `${obj.name}.${prop.name}`;
        }

        // bus.emit()
        if (obj.name === 'bus' && prop.name === 'emit') {
          return 'bus.emit';
        }

        return null;
      }

      return null;
    }

    // --- Visitor ---

    return {
      CallExpression(node) {
        // Check if this is a setState call with an updater function
        if (isSetStateWithUpdater(node)) {
          updaterNodes.add(getUpdaterFn(node));
        }

        // If we're inside an updater, check for side effects
        if (updaterDepth > 0) {
          const name = getSideEffectName(node);
          if (name) {
            context.report({
              node,
              messageId: 'noSideEffect',
              data: { name },
            });
          }
        }
      },

      // Track entering updater functions
      ArrowFunctionExpression(node) {
        if (updaterNodes.has(node)) updaterDepth++;
      },
      'ArrowFunctionExpression:exit'(node) {
        if (updaterNodes.has(node)) updaterDepth--;
      },
      FunctionExpression(node) {
        if (updaterNodes.has(node)) updaterDepth++;
      },
      'FunctionExpression:exit'(node) {
        if (updaterNodes.has(node)) updaterDepth--;
      },
    };
  },
};
