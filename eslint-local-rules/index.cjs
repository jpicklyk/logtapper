const requireMemo = require('./require-memo.cjs');
const noSideEffectsInUpdater = require('./no-side-effects-in-updater.cjs');

/** @type {import('eslint').ESLint.Plugin} */
module.exports = {
  rules: {
    'require-memo': requireMemo,
    'no-side-effects-in-updater': noSideEffectsInUpdater,
  },
};
