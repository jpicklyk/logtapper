/** @jsxImportSource solid-js */
import './styles/globals.css';
import { render } from 'solid-js/web';
import { createThemeController } from './theme/applyTheme';
import { App } from './App';

// Created before render so data-theme/data-density are correct on <html>
// before the first paint — index.html's inline bootstrap script already set
// a best-effort data-theme synchronously; this reconciles it against the
// live signals (density, prefers-color-scheme changes, user overrides) for
// the rest of the session. See theme/applyTheme.ts.
const theme = createThemeController(document.documentElement);

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// Handed to App so the shell's top-bar theme/density selector drives the one
// controller — a second `createThemeController` would fight this one over
// `data-theme` whenever `prefers-color-scheme` changed.
render(() => <App theme={theme} />, root);
