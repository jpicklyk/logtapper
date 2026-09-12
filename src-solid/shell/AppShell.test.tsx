/** @jsxImportSource solid-js */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { AppShell } from './AppShell';

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
  it('lays out all four columns beside the rail on a wide viewport', () => {
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

    expect(regionsOf(container)).toEqual(['navigator', 'viewer', 'details', 'presence']);
    expect(container.querySelector('nav[aria-label="Surfaces"]')).toBeTruthy();

    // A2's slot lands inside the presence region; E1's extra panel inside details.
    const presence = container.querySelector('[data-region="presence"]');
    expect(presence?.querySelector('[data-testid="presence-slot"]')).toBeTruthy();
    const details = container.querySelector('[data-region="details"]');
    expect(details?.querySelector('[data-testid="editor-tab"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="viewer-slot"]')).toBeTruthy();

    // One resize handle per column that is not the viewer.
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(3);

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
