/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { AppShell } from './AppShell';

// The shell now renders `WindowControls`, which calls `getCurrentWindow()` from
// `@tauri-apps/api/window` — that throws outside a Tauri webview, so stub it.
// Every method returns a resolved promise; `isMaximized` reports false so the
// middle control renders as "Maximize".
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() => Promise.resolve(false)),
    onResized: vi.fn(() => Promise.resolve(() => {})),
  }),
}));

// vitest `globals` is off, so @solidjs/testing-library's auto-cleanup never registers.
afterEach(cleanup);
beforeEach(() => localStorage.clear());

const originalWidth = window.innerWidth;

/** jsdom has no matchMedia, so `createTier` reads innerWidth — set it before render. */
function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
}

afterEach(() => setViewportWidth(originalWidth));

function regionsOf(container: Element): string[] {
  return [...container.querySelectorAll('[data-region]')].map(
    (el) => el.getAttribute('data-region') ?? '',
  );
}

describe('AppShell', () => {
  it('lays out all five columns beside the rail on a wide viewport', () => {
    setViewportWidth(2600);
    const { container } = render(() => (
      <AppShell
        workspaceId="ws"
        sessionKind="file"
        slots={{
          viewer: () => <div data-testid="viewer-slot" />,
          presence: () => <div data-testid="presence-slot" />,
        }}
        regionSlots={{ details: () => <div data-testid="editor-tab" /> }}
      />
    ));

    expect(regionsOf(container)).toEqual(['navigator', 'viewer', 'details', 'analyses', 'presence']);
    expect(container.querySelector('nav[aria-label="Surfaces"]')).toBeTruthy();

    // A2's slot lands inside the presence region; E1's extra panel inside details.
    const presence = container.querySelector('[data-region="presence"]');
    expect(presence?.querySelector('[data-testid="presence-slot"]')).toBeTruthy();
    const details = container.querySelector('[data-region="details"]');
    expect(details?.querySelector('[data-testid="editor-tab"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="viewer-slot"]')).toBeTruthy();

    // One resize handle per column that is not the viewer.
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(4);

    // Surfaces with no implementation still render their brief §4 description.
    expect(screen.getByText(/analyzers' understanding of the device/i)).toBeTruthy();
  });

  it('collapses to rail plus viewer on compact and opens a surface as a drawer', () => {
    setViewportWidth(1280);
    const { container } = render(() => (
      <AppShell workspaceId="ws" sessionKind="file" slots={{ viewer: () => <div /> }} />
    ));

    expect(regionsOf(container)).toEqual(['viewer']);
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(0);

    const analyzers = screen.getByRole('button', { name: 'Analyzers' });
    fireEvent.click(analyzers);
    expect(container.querySelector('aside[aria-label="Analyzers"]')).toBeTruthy();

    fireEvent.click(analyzers);
    expect(container.querySelector('aside[aria-label="Analyzers"]')).toBeNull();
  });

  it('on standard and wider an open drawer is a pushed grid column, and the navigator stays', () => {
    setViewportWidth(2000);
    const { container } = render(() => (
      <AppShell workspaceId="ws" sessionKind="file" slots={{ viewer: () => <div /> }} />
    ));
    const shell = container.querySelector('[data-tier]') as HTMLElement;
    const columnsBefore = shell.style.getPropertyValue('--shell-columns');
    expect(columnsBefore.startsWith('var(--shell-rail-w) ')).toBe(true);
    expect(columnsBefore).not.toContain('--shell-drawer-w');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const drawer = container.querySelector('aside[aria-label="Settings"]');
    expect(drawer?.getAttribute('data-placement')).toBe('push');
    expect(shell.style.getPropertyValue('--shell-columns')).toContain('var(--shell-rail-w) var(--shell-drawer-w) ');
    expect(regionsOf(container)).toContain('navigator');
    expect(screen.queryByTestId('drawer-backdrop')).toBeNull();
    // The drawer precedes the regions in the DOM so grid auto-placement puts
    // its column right after the rail.
    const nav = container.querySelector('[data-region="navigator"]');
    expect(drawer && nav && drawer.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(shell.style.getPropertyValue('--shell-columns')).not.toContain('--shell-drawer-w');
  });

  it('on compact the drawer overlays with a backdrop; clicking it or pressing Escape closes', () => {
    setViewportWidth(1280);
    const { container } = render(() => (
      <AppShell workspaceId="ws" sessionKind="file" slots={{ viewer: () => <div /> }} />
    ));
    const shell = container.querySelector('[data-tier]') as HTMLElement;

    fireEvent.click(screen.getByRole('button', { name: 'Analyzers' }));
    expect(container.querySelector('aside[aria-label="Analyzers"]')?.getAttribute('data-placement')).toBe('overlay');
    expect(shell.style.getPropertyValue('--shell-columns')).not.toContain('--shell-drawer-w');
    fireEvent.click(screen.getByTestId('drawer-backdrop'));
    expect(container.querySelector('aside[aria-label="Analyzers"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Analyzers' }));
    expect(container.querySelector('aside[aria-label="Analyzers"]')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('aside[aria-label="Analyzers"]')).toBeNull();
  });

  it('moving the drawer from one rail surface to another swaps its body, not just its title', () => {
    setViewportWidth(1280);
    const { container } = render(() => (
      <AppShell
        workspaceId="ws"
        sessionKind="file"
        slots={{
          viewer: () => <div />,
          'workspace-home': () => <div data-testid="home-body">home</div>,
          export: () => <div data-testid="export-body">export</div>,
        }}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(container.querySelector('aside[aria-label="Workspace"] [data-testid="home-body"]')).toBeTruthy();

    // Same drawer, different surface: the previous body must be gone.
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const drawer = container.querySelector('aside[aria-label="Export"]');
    expect(drawer).toBeTruthy();
    expect(drawer?.querySelector('[data-testid="export-body"]')).toBeTruthy();
    expect(drawer?.querySelector('[data-testid="home-body"]')).toBeNull();
  });

  it('swaps the mode-only surfaces when the focused session is a live stream', () => {
    setViewportWidth(2600);
    const { container } = render(() => (
      <AppShell workspaceId="ws" sessionKind="live" slots={{ viewer: () => <div /> }} />
    ));

    expect(container.querySelector('[data-mode="live"]')).toBeTruthy();
    const navigator = container.querySelector('[data-region="navigator"]');
    expect(navigator?.querySelector('[data-surface="watches"]')).toBeTruthy();
    expect(navigator?.querySelector('[data-surface="stream-controls"]')).toBeTruthy();
    expect(navigator?.querySelector('[data-surface="sections"]')).toBeNull();
    expect(container.querySelector('[data-surface="analyses"]')).toBeNull();
  });
});
