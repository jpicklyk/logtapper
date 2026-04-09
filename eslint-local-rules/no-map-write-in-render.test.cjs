/**
 * Tests for the no-map-write-in-render ESLint local rule.
 * Run with: node eslint-local-rules/no-map-write-in-render.test.cjs
 *
 * Uses ESLint v9 flat-config RuleTester.
 */
const { RuleTester } = require('eslint');
const rule = require('./no-map-write-in-render.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
});

ruleTester.run('no-map-write-in-render', rule, {
  valid: [
    // .set() inside useEffect callback — safe
    {
      code: `
        import { useEffect } from 'react';
        function Component() {
          useEffect(() => {
            externalMap.set('key', 42);
          }, []);
        }
      `,
    },
    // .set() on a locally declared Map — safe
    {
      code: `
        function Component() {
          const localMap = new Map();
          localMap.set('key', 42);
        }
      `,
    },
    // .set() inside an event handler — safe (nested function)
    {
      code: `
        function Component() {
          const handleClick = () => {
            externalMap.set('key', 42);
          };
        }
      `,
    },
    // .set() inside a cleanup callback — safe
    {
      code: `
        function Component() {
          useEffect(() => {
            return () => {
              externalMap.set('key', 0);
            };
          }, []);
        }
      `,
    },
    // .get() is a read — safe (not in MUTATING_METHODS)
    {
      code: `
        function Component() {
          const val = externalMap.get('key');
        }
      `,
    },
    // Computed property call — not flagged (rule only checks non-computed member expressions)
    {
      code: `
        function Component() {
          externalMap['set']('key', 42);
        }
      `,
    },
  ],
  invalid: [
    // Direct .set() on external identifier at top level of component body
    {
      code: `
        function Component({ sessionId }) {
          externalMap.set(sessionId, 42);
        }
      `,
      errors: [{ messageId: 'mapWriteInRender' }],
    },
    // .add() on external Set
    {
      code: `
        function Component() {
          externalSet.add('value');
        }
      `,
      errors: [{ messageId: 'mapWriteInRender' }],
    },
    // Conditional .set() in render body is still flagged
    {
      code: `
        function Component({ sessionId }) {
          if (sessionId) {
            externalMap.set(sessionId, 0);
          }
        }
      `,
      errors: [{ messageId: 'mapWriteInRender' }],
    },
  ],
});

console.log('All no-map-write-in-render tests passed.');
