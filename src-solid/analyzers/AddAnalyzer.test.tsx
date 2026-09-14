/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import type { ProcessorSummary } from '@bridge/types';
import { AddAnalyzer } from './AddAnalyzer';
import type { AnalyzerStore, SessionChainSnapshot } from './analyzerStore';

afterEach(cleanup);

function proc(id: string, overrides: Partial<ProcessorSummary> = {}): ProcessorSummary {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: `description for ${id}`,
    tags: [],
    builtin: false,
    processorType: 'reporter',
    group: null,
    varsMeta: [],
    deprecated: false,
    hasSchema: true,
    trackerSections: [],
    sourceTypes: [],
    ...overrides,
  };
}

function fakeStore(catalog: ProcessorSummary[], activeOrder: string[] = []): AnalyzerStore {
  const chain: SessionChainSnapshot = { order: activeOrder, disabled: [], active: activeOrder };
  return {
    catalog: () => catalog,
    chain: () => chain,
    add: vi.fn(),
    installFromFile: vi.fn(() => Promise.resolve()),
    uninstall: vi.fn(() => Promise.resolve()),
  } as unknown as AnalyzerStore;
}

describe('AddAnalyzer', () => {
  it('lists the catalog minus the active chain and the pinned anonymizer', () => {
    const store = fakeStore(
      [proc('p1'), proc('p2'), proc('__pii_anonymizer', { builtin: true })],
      ['p2'],
    );
    render(() => <AddAnalyzer store={store} sessionId="s1" onClose={vi.fn()} />);
    expect(screen.getByTestId('catalog-row-p1')).toBeTruthy();
    expect(screen.queryByTestId('catalog-row-p2')).toBeNull();
    expect(screen.queryByTestId('catalog-row-__pii_anonymizer')).toBeNull();
  });

  it('filters by the search box', () => {
    const store = fakeStore([proc('usb-finder', { name: 'USB finder' }), proc('wifi-tracker', { name: 'Wifi tracker' })]);
    render(() => <AddAnalyzer store={store} sessionId="s1" onClose={vi.fn()} />);
    fireEvent.input(screen.getByLabelText('Search analyzers'), { target: { value: 'usb' } });
    expect(screen.getByTestId('catalog-row-usb-finder')).toBeTruthy();
    expect(screen.queryByTestId('catalog-row-wifi-tracker')).toBeNull();
  });

  it('adds a row through the store', () => {
    const store = fakeStore([proc('p1')]);
    render(() => <AddAnalyzer store={store} sessionId="s1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Add'));
    expect(store.add).toHaveBeenCalledWith('s1', 'p1');
  });

  it('loads a YAML file through the store', () => {
    const store = fakeStore([]);
    render(() => <AddAnalyzer store={store} sessionId="s1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Load YAML from file…'));
    expect(store.installFromFile).toHaveBeenCalled();
  });

  it('confirms before uninstalling, and Cancel backs out without calling the store', () => {
    const store = fakeStore([proc('p1')]);
    render(() => <AddAnalyzer store={store} sessionId="s1" onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('Uninstall'));
    expect(store.uninstall).not.toHaveBeenCalled();
    expect(screen.getByText('Confirm')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Confirm')).toBeNull();
    expect(store.uninstall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Uninstall'));
    fireEvent.click(screen.getByText('Confirm'));
    expect(store.uninstall).toHaveBeenCalledWith('p1');
  });

  it('offers no uninstall button for a built-in processor', () => {
    const store = fakeStore([proc('builtin-thing', { builtin: true })]);
    render(() => <AddAnalyzer store={store} sessionId="s1" onClose={vi.fn()} />);
    expect(screen.queryByText('Uninstall')).toBeNull();
  });

  describe('provenance', () => {
    it('names the marketplace source, or "local YAML" when there is none, or "built-in"', () => {
      const store = fakeStore([
        proc('curated', { source: 'official' }),
        proc('pasted'),
        proc('builtin-thing', { builtin: true }),
      ]);
      render(() => <AddAnalyzer store={store} sessionId="s1" onClose={vi.fn()} />);
      expect(screen.getByTestId('catalog-row-curated').textContent).toContain('via official');
      expect(screen.getByTestId('catalog-row-pasted').textContent).toContain('local YAML');
      expect(screen.getByTestId('catalog-row-builtin-thing').textContent).toContain('built-in');
    });

    it('badges only the rows an agent installed, naming the client', () => {
      const store = fakeStore([
        proc('by-agent', { installedBy: 'agent:claude' }),
        proc('by-human', { installedBy: 'ui' }),
        proc('unrecorded'),
      ]);
      render(() => <AddAnalyzer store={store} sessionId="s1" onClose={vi.fn()} />);
      const badge = screen.getByTestId('catalog-row-by-agent').querySelector('[data-caller]');
      expect(badge?.getAttribute('data-caller')).toBe('agent');
      expect(badge?.getAttribute('title')).toBe('Installed by claude');
      expect(badge?.textContent).toBe('Installed');
      expect(screen.getByTestId('catalog-row-by-human').querySelector('[data-caller]')).toBeNull();
      expect(screen.getByTestId('catalog-row-unrecorded').querySelector('[data-caller]')).toBeNull();
    });
  });
});
