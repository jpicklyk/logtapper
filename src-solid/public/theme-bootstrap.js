// Synchronous theme bootstrap — prevents FOUC on cold start. Runs
// before Solid mounts; reads localStorage and applies data-theme
// before any CSS paint. Reads the same 'logtapper-theme' key as
// src-solid/theme/applyTheme.ts's createThemeController (and
// the React app's ThemeContext STORAGE_KEY), so both UIs
// resolve to the same theme. Kept in sync with the four base themes
// applyTheme.ts knows about ('system' resolves via prefers-color-scheme,
// same as the live controller that takes over right after this runs).
//
// Externalized from index.html (rather than an inline <script>) so it is
// covered by `script-src 'self'` with no CSP exception — see the
// matching comment in public/theme-bootstrap.js (react app) and
// src-tauri/src/CLAUDE.md's CSP section.
(function () {
  var BASE_THEMES = ['dark', 'light', 'dark-hc', 'light-hc'];
  var t = localStorage.getItem('logtapper-theme');
  if (!t || t === 'system' || BASE_THEMES.indexOf(t) === -1) {
    t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', t);

  var d = localStorage.getItem('logtapper-density');
  document.documentElement.setAttribute('data-density', d === 'compact' ? 'compact' : 'comfortable');
})();
