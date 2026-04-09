/**
 * @fileoverview Disallow writes to module-level Maps/Sets/singletons during render.
 *
 * Writing to module-level mutable state (Map.set, Set.add, or singleton.set)
 * during the render phase is unsafe in concurrent React (render without commit)
 * and StrictMode (double render).  Side effects that write external state must
 * live in useEffect, never in the render body.
 *
 * This rule catches the H4 pattern: calling .set() or .add() on a non-local
 * identifier (i.e., not declared within the current function body) at the top
 * level of a component or hook function body — outside any callback, effect,
 * or event handler.
 *
 * Flagged pattern:
 *   // ❌ Top-level call inside function body
 *   someExternalMap.set(key, value);
 *
 * Safe patterns (not flagged):
 *   useEffect(() => { someExternalMap.set(key, value); }, [key]);
 *   const handler = () => { someExternalMap.set(key, value); };
 *   const localMap = new Map(); localMap.set(key, value); // local variable
 *
 * The rule only fires inside .tsx/.ts files under the components/ and hooks/
 * directories (configured in eslint.config.js).
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow writes to module-level Maps/Sets/singletons during the render phase. ' +
        'Move .set()/.add() calls inside useEffect to avoid concurrent-mode and StrictMode issues.',
    },
    messages: {
      mapWriteInRender:
        "Calling '{{ method }}()' on '{{ object }}' during render writes to external mutable state. " +
        'Move this into a useEffect cleanup or callback — never write module-level state during render.',
    },
    schema: [],
  },

  create(context) {
    /**
     * Determines whether a node is nested inside a function that is itself
     * nested inside the top-level function.  In other words, the call is
     * inside a callback / arrow function / useEffect body — not at the
     * direct top level of the component render body.
     *
     * We walk up the ancestor chain.  If we encounter a FunctionExpression or
     * ArrowFunctionExpression before reaching the outermost function, the call
     * is inside a nested closure and is safe.
     */
    function isInsideNestedFunction(node) {
      let current = node.parent;
      let depth = 0;
      while (current) {
        if (
          current.type === 'FunctionDeclaration' ||
          current.type === 'FunctionExpression' ||
          current.type === 'ArrowFunctionExpression'
        ) {
          depth++;
          if (depth >= 2) return true; // nested closure → safe
        }
        current = current.parent;
      }
      return false;
    }

    /**
     * Returns the name of the object on which the method is called, or null.
     * E.g. for `foo.set(k, v)` returns "foo".
     */
    function getObjectName(callNode) {
      const callee = callNode.callee;
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier'
      ) {
        return callee.object.name;
      }
      return null;
    }

    /**
     * Returns the method name being called, or null.
     */
    function getMethodName(callNode) {
      const callee = callNode.callee;
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier'
      ) {
        return callee.property.name;
      }
      return null;
    }

    /**
     * Check whether `name` is declared as a local variable (const/let/var)
     * within the scope chain of `node`, up to but not including module scope.
     * If it is local to the function, the write is safe.
     */
    function isDeclaredLocally(name, node) {
      let scope = context.getScope ? context.getScope() : null;
      // In ESLint v9, use sourceCode.getScope(node) if available.
      if (!scope && context.sourceCode && context.sourceCode.getScope) {
        scope = context.sourceCode.getScope(node);
      }
      while (scope && scope.type !== 'module' && scope.type !== 'global') {
        for (const variable of scope.variables) {
          if (variable.name === name) return true;
        }
        scope = scope.upper;
      }
      return false;
    }

    const MUTATING_METHODS = new Set(['set', 'add', 'delete', 'clear', 'push', 'splice']);

    return {
      CallExpression(node) {
        const method = getMethodName(node);
        if (!method || !MUTATING_METHODS.has(method)) return;

        const objectName = getObjectName(node);
        if (!objectName) return;

        // If the object is a locally declared variable, it's safe.
        if (isDeclaredLocally(objectName, node)) return;

        // If the call is inside a nested function (callback/effect/handler), it's safe.
        if (isInsideNestedFunction(node)) return;

        context.report({
          node,
          messageId: 'mapWriteInRender',
          data: { method, object: objectName },
        });
      },
    };
  },
};
