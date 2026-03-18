/**
 * Tests for the require-memo ESLint local rule.
 * Run with: node eslint-local-rules/require-memo.test.cjs
 *
 * Uses ESLint v9 flat-config RuleTester (languageOptions, not parserOptions).
 */
const { RuleTester } = require('eslint');
const rule = require('./require-memo.cjs');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
});

ruleTester.run('require-memo', rule, {
  valid: [
    // Component pre-assigned to React.memo() then default-exported
    {
      code: `const Foo = React.memo(function Foo() { return null; }); export default Foo;`,
    },
    // Named export with React.memo() inline in the const
    {
      code: `export const Foo = React.memo(function Foo() { return null; });`,
    },
    // memo() shorthand (identifier form)
    {
      code: `const memo = require('react').memo; export const Foo = memo(function Foo() { return null; });`,
    },
    // Lowercase export — not a component (no uppercase start)
    {
      code: `export const helper = () => 42;`,
    },
    // Re-export without declaration — rule does not flag specifier re-exports
    {
      code: `export { Foo } from './Foo';`,
    },
    // Default export of an anonymous arrow function — no id, rule does not flag
    {
      code: `export default () => null;`,
    },
    // Component wrapped via memo() call (lowercase alias)
    {
      code: `const memo = require('react').memo; export const Foo = memo(() => null);`,
    },
  ],
  invalid: [
    // Default export of an identifier that was NOT wrapped in memo
    {
      code: `function Foo() { return null; } export default Foo;`,
      errors: [{ messageId: 'missingMemo' }],
    },
    // Named export const not wrapped in memo — arrow function
    {
      code: `export const Foo = () => null;`,
      errors: [{ messageId: 'missingMemo' }],
    },
    // Named export function declaration (not memo-wrapped)
    {
      code: `export function Foo() { return null; }`,
      errors: [{ messageId: 'missingMemo' }],
    },
    // Default export of a named function declaration — FunctionDeclaration with id
    {
      code: `export default function Foo() { return null; }`,
      errors: [{ messageId: 'missingMemo' }],
    },
    // Multiple declarators: first is not memo-wrapped, second is
    {
      code: `export const Bar = () => null, Baz = React.memo(() => null);`,
      errors: [{ messageId: 'missingMemo' }],
    },
  ],
});

console.log('All require-memo tests passed.');
