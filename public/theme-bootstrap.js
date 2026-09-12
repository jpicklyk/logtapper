// Synchronous theme bootstrap — prevents FOUC on cold start.
// Runs before React hydrates; reads localStorage and applies
// data-theme before any CSS paint.
//
// Externalized from index.html (rather than an inline <script>) so it is
// covered by `script-src 'self'` with no CSP exception: Tauri's build-time
// CSP hashing only computes hashes for `<style>` elements and for
// `<script src="http...">` tags, never for the *content* of a bare inline
// `<script>` block (see src-tauri/src/CLAUDE.md's CSP section). A
// same-origin `<script src>` needs no hash or nonce — 'self' already
// covers it.
(function () {
  var t = localStorage.getItem('theme');
  if (!t || t === 'system') {
    t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
