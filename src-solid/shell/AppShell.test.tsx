/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { AppShell } from './AppShell';
import type { ShellLayoutHandle } from './AppShell';
import type { SessionKind } from './mode';

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

/** jsdom's `createTier` fallback listens for `resize`, so announce the change. */
function resizeTo(width: number) {
  setViewportWidth(width);
  fireEvent(window, new Event('resize'));
}

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

// ── The open drawer is revalidated against tier and mode (review B-H3) ─────

describe('AppShell — an open drawer never outlives its placement', () => {
  it('closes a drawer whose surface has been promoted to its own column', () => {
    setViewportWidth(1280);
    const { container } = render(() => (
      <AppShell
        workspaceId="ws"
        sessionKind="file"
        slots={{ viewer: () => <div />, analyzers: () => <div data-testid="analyzers-body" /> }}
      />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Analyzers' }));
    expect(container.querySelector('aside[aria-label="Analyzers"]')).toBeTruthy();

    // Past 1600px `analyzers` is `R('details')`, so the region loop mounts it.
    // The drawer kept rendering it too: two panels, two sets of effects, two
    // copies of every DOM id inside them, and 380px stolen from the viewer.
    resizeTo(2000);

    expect(container.querySelector('aside[aria-label="Analyzers"]')).toBeNull();
    expect(container.querySelectorAll('[data-surface="analyzers"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="analyzers-body"]')).toHaveLength(1);
    const shell = container.querySelector('[data-tier]') as HTMLElement;
    expect(shell.style.getPropertyValue('--shell-columns')).not.toContain('--shell-drawer-w');
  });

  it('closes a live-only drawer when the capture stops', () => {
    setViewportWidth(1280);
    const [kind, setKind] = createSignal<SessionKind>('live');
    const { container } = render(() => (
      <AppShell workspaceId="ws" sessionKind={kind()} slots={{ viewer: () => <div /> }} />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Watches' }));
    expect(container.querySelector('aside[aria-label="Watches"]')).toBeTruthy();

    // Stopping the stream flips the mode; `watches` does not exist in
    // post-mortem, so its rail glyph goes — and with it any way to close a
    // drawer that used to stay open rendering a live-only surface.
    setKind('file');

    expect(container.querySelector('[data-mode="postmortem"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Watches' })).toBeNull();
    expect(container.querySelector('aside[aria-label="Watches"]')).toBeNull();
  });

  it('does not spring the drawer back open when the window narrows again', () => {
    setViewportWidth(1280);
    const { container } = render(() => (
      <AppShell workspaceId="ws" sessionKind="file" slots={{ viewer: () => <div /> }} />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Analyzers' }));
    resizeTo(2000);
    resizeTo(1280);

    expect(container.querySelector('aside[aria-label="Analyzers"]')).toBeNull();
  });
});

// ── The overlay drawer is a modal sheet (review B-M6) ──────────────────────

describe('AppShell — overlay drawer dialog semantics', () => {
  it('announces itself as a modal dialog and takes focus, then gives it back', () => {
    setViewportWidth(1280);
    const { container } = render(() => (
      <AppShell workspaceId="ws" sessionKind="file" slots={{ viewer: () => <div /> }} />
    ));

    const rail = screen.getByRole('button', { name: 'Analyzers' });
    rail.focus();
    fireEvent.click(rail);

    const drawer = container.querySelector('aside[aria-label="Analyzers"]') as HTMLElement;
    expect(drawer.getAttribute('role')).toBe('dialog');
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    // Focus moved inside — Tab used to continue straight into the log viewer
    // behind the sheet.
    expect(drawer.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(window, { key: 'Escape' });

    // ...and came back to the rail button, not to `document.body`.
    expect(document.activeElement).toBe(rail);
  });

  it('contains Tab inside the sheet', () => {
    setViewportWidth(1280);
    const { container } = render(() => (
      <AppShell workspaceId="ws" sessionKind="file" slots={{ viewer: () => <div /> }} />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Analyzers' }));
    const drawer = container.querySelector('aside[aria-label="Analyzers"]') as HTMLElement;
    const focusables = [...drawer.querySelectorAll<HTMLElement>('button')];
    const last = focusables[focusables.length - 1];

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);

    fireEvent.keyDown(focusables[0], { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('is not a dialog when it is a pushed column', () => {
    setViewportWidth(2000);
    const { container } = render(() => (
      <AppShell workspaceId="ws" sessionKind="file" slots={{ viewer: () => <div /> }} />
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const drawer = container.querySelector('aside[aria-label="Settings"]') as HTMLElement;

    expect(drawer.getAttribute('data-placement')).toBe('push');
    expect(drawer.getAttribute('role')).toBeNull();
    expect(drawer.getAttribute('aria-modal')).toBeNull();
  });
});

// ── The splitter is not inside the scrolling box (review B-M4) ─────────────

describe('AppShell — resize handle placement', () => {
  it('renders the splitter as a sibling of the scroll container', () => {
    setViewportWidth(2600);
    const { container } = render(() => (
      <AppShell
        workspaceId="ws"
        sessionKind="file"
        slots={{ viewer: () => <div /> }}
        regionSlots={{ details: () => <div data-testid="editor-tab" /> }}
      />
    ));

    const region = container.querySelector('[data-region="details"]') as HTMLElement;
    const splitter = region.querySelector('[role="separator"]') as HTMLElement;

    // Direct child of the (non-scrolling) grid item: an absolutely positioned
    // child of the *scrolling* box scrolled out of reach once the column's
    // panels overflowed, and the column could no longer be resized.
    expect(splitter.parentElement).toBe(region);
    const panel = region.querySelector('[data-surface]') as HTMLElement;
    expect(panel.parentElement).not.toBe(region);
    expect(region.contains(panel.parentElement)).toBe(true);
    expect(panel.parentElement?.contains(splitter)).toBe(false);
  });

  it('no longer ships the mode/tier debug text in the status bar', () => {
    setViewportWidth(2600);
    const { container } = render(() => (
      <AppShell
        workspaceId="ws"
        sessionKind="file"
        statusBar={<span>ready</span>}
        slots={{ viewer: () => <div /> }}
      />
    ));

    const footer = container.querySelector('footer') as HTMLElement;
    expect(footer.textContent).toBe('ready');
    expect(footer.textContent).not.toMatch(/postmortem|ultrawide|wide/);
  });
});

// ── S1c: the workspace port's forward reference (region widths + drawer) ──

describe('AppShell — onReady handle for the workspace shellLayout port', () => {
  it('hands back the live region-width store, seedable from a restored blob', () => {
    setViewportWidth(2600);
    let handle!: ShellLayoutHandle;
    render(() => (
      <AppShell
        workspaceId="ws"
        sessionKind="file"
        slots={{ viewer: () => <div /> }}
        onReady={(h) => {
          handle = h;
        }}
      />
    ));

    expect(handle).toBeTruthy();
    expect(handle.widths.toColumns()).toEqual({});

    // A restore seeds the same store the splitters render from.
    handle.widths.applyColumns({ navigator: 333, details: 480 });
    expect(handle.widths.width('navigator')).toBe(333);
    expect(handle.widths.width('details')).toBe(480);
  });

  it('applyDrawer opens a drawer that is valid for the current tier/mode', () => {
    setViewportWidth(1280);
    let handle!: ShellLayoutHandle;
    const { container } = render(() => (
      <AppShell
        workspaceId="ws"
        sessionKind="file"
        slots={{ viewer: () => <div /> }}
        onReady={(h) => {
          handle = h;
        }}
      />
    ));

    expect(container.querySelector('aside[aria-label="Analyzers"]')).toBeNull();
    handle.applyDrawer('analyzers');
    expect(handle.openDrawer()).toBe('analyzers');
    expect(container.querySelector('aside[aria-label="Analyzers"]')).toBeTruthy();
  });

  it('applyDrawer ignores a saved id that no longer opens anything here', () => {
    setViewportWidth(1280);
    let handle!: ShellLayoutHandle;
    render(() => (
      <AppShell
        workspaceId="ws"
        sessionKind="file"
        slots={{ viewer: () => <div /> }}
        onReady={(h) => {
          handle = h;
        }}
      />
    ));

    // Not a real surface id at all.
    handle.applyDrawer('not-a-surface');
    expect(handle.openDrawer()).toBeNull();

    // A real surface id, but one this session's build never renders as a
    // rail/drawer surface on a compact 'file' session — 'viewer' is the
    // always-present region, never a drawer.
    handle.applyDrawer('viewer');
    expect(handle.openDrawer()).toBeNull();

    handle.applyDrawer(null);
    expect(handle.openDrawer()).toBeNull();
  });

  it('hands back the collapse store, seedable from a restored blob', () => {
    setViewportWidth(2600);
    let handle!: ShellLayoutHandle;
    const { container } = render(() => (
      <AppShell
        workspaceId="ws"
        sessionKind="file"
        slots={{ viewer: () => <div />, presence: () => <div data-testid="presence-slot" /> }}
        onReady={(h) => {
          handle = h;
        }}
      />
    ));

    expect(handle.collapse.toEntries()).toEqual([]);

    // An unknown region id in the blob is dropped, not thrown on; the drawer
    // id that shares the array is simply not a `region:` entry.
    handle.collapse.applyEntries(['region:presence', 'region:bogus', 'analyzers']);

    expect(handle.collapse.isCollapsed('presence')).toBe(true);
    expect(handle.collapse.isCollapsed('details')).toBe(false);
    expect(handle.collapse.toEntries()).toEqual(['region:presence']);
    expect(container.querySelector('[data-region="presence"] [data-testid="presence-slot"]')).toBeNull();

    // Round-trip: the entries this produced seed the same state back.
    const entries = handle.collapse.toEntries();
    handle.collapse.applyEntries([]);
    expect(handle.collapse.isCollapsed('presence')).toBe(false);
    handle.collapse.applyEntries(entries);
    expect(handle.collapse.isCollapsed('presence')).toBe(true);
  });
});

// ── Collapsible shell columns ──────────────────────────────────────────────

describe('AppShell — collapsing a region', () => {
  it('unmounts the column\'s surfaces and its splitter, and gives the width back', () => {
    setViewportWidth(2600);
    const { container } = render(() => (
      <AppShell
        workspaceId="ws"
        sessionKind="file"
        slots={{ viewer: () => <div />, analyzers: () => <div data-testid="analyzers-body" /> }}
      />
    ));

    const shell = container.querySelector('[data-tier]') as HTMLElement;
    const details = () => container.querySelector('[data-region="details"]') as HTMLElement;

    expect(details().getAttribute('data-collapsed')).toBe('false');
    expect(details().querySelector('[role="separator"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="analyzers-body"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Details' }));

    expect(details().getAttribute('data-collapsed')).toBe('true');
    // The whole point: a folded column keeps nothing alive behind the strip.
    expect(details().querySelector('[role="separator"]')).toBeNull();
    expect(container.querySelector('[data-testid="analyzers-body"]')).toBeNull();
    expect(details().querySelector('[data-surface="analyzers"]')).toBeNull();
    expect(shell.style.getPropertyValue('--shell-columns')).toContain('var(--shell-collapsed-w)');

    fireEvent.click(screen.getByRole('button', { name: 'Expand Details' }));

    expect(details().getAttribute('data-collapsed')).toBe('false');
    expect(details().querySelector('[role="separator"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="analyzers-body"]')).toBeTruthy();
    expect(shell.style.getPropertyValue('--shell-columns')).not.toContain('var(--shell-collapsed-w)');
  });

  it('moves focus to the control that replaced the one the user pressed', () => {
    setViewportWidth(2600);
    render(() => (
      <AppShell workspaceId="ws-focus" sessionKind="file" slots={{ viewer: () => <div /> }} />
    ));

    // Collapsing unmounts the button that was just activated; leaving focus on
    // the removed node drops it to <body> and a keyboard user loses the shell.
    const collapseBtn = screen.getByRole('button', { name: 'Collapse Agent' });
    collapseBtn.focus();
    fireEvent.click(collapseBtn);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Expand Agent' }));

    // And back the other way when the strip expands the column again.
    fireEvent.click(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Collapse Agent' }));
  });

  it('keeps the collapse per workspace across a remount', () => {
    setViewportWidth(2600);
    const mount = (workspaceId: string) =>
      render(() => (
        <AppShell workspaceId={workspaceId} sessionKind="file" slots={{ viewer: () => <div /> }} />
      ));

    const first = mount('ws-a');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Agent' }));
    expect(
      (first.container.querySelector('[data-region="presence"]') as HTMLElement).getAttribute('data-collapsed'),
    ).toBe('true');
    cleanup();

    // Same workspace: the fold comes back.
    const again = mount('ws-a');
    expect(
      (again.container.querySelector('[data-region="presence"]') as HTMLElement).getAttribute('data-collapsed'),
    ).toBe('true');
    cleanup();

    // A different workspace must not inherit it.
    const other = mount('ws-b');
    expect(
      (other.container.querySelector('[data-region="presence"]') as HTMLElement).getAttribute('data-collapsed'),
    ).toBe('false');
  });
});
