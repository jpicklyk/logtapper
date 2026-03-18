/**
 * @fileoverview Require exported React components to be wrapped in React.memo().
 *
 * Convention 3: Component boundaries must use React.memo to prevent cascading
 * re-renders from parent context consumers.
 *
 * Checks ExportDefaultDeclaration and ExportNamedDeclaration in component files.
 * An export is considered a component if the identifier starts with an uppercase
 * letter. The rule verifies the identifier was assigned via React.memo() or memo().
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require exported React components to be wrapped in React.memo()',
    },
    messages: {
      missingMemo:
        "Exported component '{{ name }}' must be wrapped in React.memo(). " +
        'This prevents cascading re-renders from parent context consumers.',
    },
    schema: [],
  },

  create(context) {
    // Track identifiers assigned via React.memo() or memo() in this file
    const memoWrapped = new Set();

    /**
     * Check if a node is a React.memo() or memo() call expression.
     */
    function isMemoCall(node) {
      if (!node || node.type !== 'CallExpression') return false;
      const callee = node.callee;
      // memo(...)
      if (callee.type === 'Identifier' && callee.name === 'memo') return true;
      // React.memo(...)
      if (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'React' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'memo'
      ) {
        return true;
      }
      return false;
    }

    /**
     * Check if a name looks like a React component (starts with uppercase).
     */
    function isComponentName(name) {
      return typeof name === 'string' && /^[A-Z]/.test(name);
    }

    return {
      // Track: const Foo = React.memo(...) or const Foo = memo(...)
      VariableDeclarator(node) {
        if (
          node.id.type === 'Identifier' &&
          isMemoCall(node.init)
        ) {
          memoWrapped.add(node.id.name);
        }
      },

      // export default Foo  (where Foo should be in memoWrapped)
      // export default React.memo(...)  (inline — always OK)
      ExportDefaultDeclaration(node) {
        const decl = node.declaration;
        if (decl.type === 'Identifier') {
          if (isComponentName(decl.name) && !memoWrapped.has(decl.name)) {
            context.report({ node: decl, messageId: 'missingMemo', data: { name: decl.name } });
          }
        }
        // export default function Foo() {} — not memo-wrapped
        if (
          (decl.type === 'FunctionDeclaration' || decl.type === 'ArrowFunctionExpression') &&
          decl.id &&
          isComponentName(decl.id.name) &&
          !memoWrapped.has(decl.id.name)
        ) {
          context.report({ node: decl.id, messageId: 'missingMemo', data: { name: decl.id.name } });
        }
      },

      // export const Foo = ...  or  export function Foo() {}
      ExportNamedDeclaration(node) {
        if (!node.declaration) return;
        const decl = node.declaration;

        // export function Foo() {}
        if (decl.type === 'FunctionDeclaration' && decl.id && isComponentName(decl.id.name)) {
          if (!memoWrapped.has(decl.id.name)) {
            context.report({ node: decl.id, messageId: 'missingMemo', data: { name: decl.id.name } });
          }
        }

        // export const Foo = ... (check each declarator)
        if (decl.type === 'VariableDeclaration') {
          for (const declarator of decl.declarations) {
            if (
              declarator.id.type === 'Identifier' &&
              isComponentName(declarator.id.name) &&
              !isMemoCall(declarator.init)
            ) {
              // Skip if previously tracked as memo-wrapped (shouldn't happen with
              // export const, but defensive)
              if (!memoWrapped.has(declarator.id.name)) {
                context.report({
                  node: declarator.id,
                  messageId: 'missingMemo',
                  data: { name: declarator.id.name },
                });
              }
            }
          }
        }
      },
    };
  },
};
