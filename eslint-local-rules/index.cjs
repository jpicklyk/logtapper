const requireMemo = require('./require-memo.cjs');

/** @type {import('eslint').ESLint.Plugin} */
module.exports = {
  rules: {
    'require-memo': requireMemo,
  },
};
