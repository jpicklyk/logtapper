const requireMemo = require('./require-memo.cjs');
const noMapWriteInRender = require('./no-map-write-in-render.cjs');

/** @type {import('eslint').ESLint.Plugin} */
module.exports = {
  rules: {
    'require-memo': requireMemo,
    'no-map-write-in-render': noMapWriteInRender,
  },
};
